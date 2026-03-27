import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import chromadb
from jsonschema import Draft7Validator
from kafka import KafkaConsumer, KafkaProducer
from sentence_transformers import SentenceTransformer
from rag_indexing import COLLECTION_NAME, DB_DIR, ensure_indexed

import re
from typing import List



KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092").split(",")

TOPIC_REQUESTS = "tool-invocation-requests"
TOPIC_EVENTS = "conversation-events"
TOPIC_DLQ = "dead-letter-queue"

ROOT_DIR = Path(__file__).resolve().parents[2]

SCHEMA_COMMAND = ROOT_DIR / "src" / "schemas" / "commands" / "toolInvocationRequested.json"
SCHEMA_EVENT = ROOT_DIR / "src" / "schemas" / "events" / "toolInvocationResulted.json"

IDEMPOTENCY_DB = DB_DIR / "idempotency.sqlite3"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_schema(path: Path) -> Draft7Validator:
    with path.open("r", encoding="utf-8") as file:
        schema = json.load(file)
    return Draft7Validator(schema)


COMMAND_VALIDATOR = load_schema(SCHEMA_COMMAND)
EVENT_VALIDATOR = load_schema(SCHEMA_EVENT)


def validate_or_raise(validator: Draft7Validator, payload: Dict[str, Any], label: str) -> None:
    errors = sorted(validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        message = "; ".join(error.message for error in errors)
        raise ValueError(f"Schema validation failed for {label}: {message}")


def ensure_idempotency_db() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(IDEMPOTENCY_DB), isolation_level=None)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS processed_invocations (
            invocation_id TEXT PRIMARY KEY,
            processed_at TEXT NOT NULL
        )
        """
    )
    return conn


def mark_processed_once(conn: sqlite3.Connection, invocation_id: str) -> bool:
    cursor = conn.execute(
        "INSERT OR IGNORE INTO processed_invocations (invocation_id, processed_at) VALUES (?, ?)",
        (invocation_id, utc_now_iso()),
    )
    return cursor.rowcount == 1


producer = KafkaProducer(
    bootstrap_servers=KAFKA_BROKERS,
    value_serializer=lambda value: json.dumps(value).encode("utf-8"),
)
consumer = KafkaConsumer(
    TOPIC_REQUESTS,
    bootstrap_servers=KAFKA_BROKERS,
    group_id="rag-retriever-worker",
    auto_offset_reset="earliest",
    enable_auto_commit=False,
    value_deserializer=lambda value: json.loads(value.decode("utf-8")),
)

model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
client = chromadb.PersistentClient(path=str(DB_DIR))
collection = client.get_or_create_collection(name=COLLECTION_NAME)

PRICE_RE = re.compile(r"^\s*Price:\s*(.+)\s*$", re.IGNORECASE | re.MULTILINE)

def is_pricing_query(query: str) -> bool:
    q = query.lower()
    return ("מחיר" in q) or ("מחירים" in q) or ("price" in q) or ("pricing" in q)

USD_NUMBER_RE = re.compile(r"\$?\s*([\d,]+(?:\.\d+)?)")

def parse_usd_number(price_text: str) -> float | None:
    m = USD_NUMBER_RE.search(price_text or "")
    if not m:
        return None
    return float(m.group(1).replace(",", ""))

def build_price_catalog(root_dir: Path) -> List[Dict[str, Any]]:
    data_dir = root_dir / "data" / "products"
    items: List[Dict[str, str]] = []
    for file in sorted(data_dir.glob("*.txt")):
        text = file.read_text(encoding="utf-8")
        m = PRICE_RE.search(text)
        if not m:
            continue

        base = file.stem.replace("-", " ")
        product = " ".join(w.capitalize() for w in base.split())

        price_text = m.group(1).strip()
        price_usd = parse_usd_number(price_text)

        items.append(
            {
                "product": product,
                "price": price_text,
                "price_usd": price_usd, 
            }
        )
    return items
idempotency_conn = ensure_idempotency_db()


def publish_dlq(payload: Any, error: str) -> None:
    future = producer.send(TOPIC_DLQ, {"error": error, "payload": payload})
    future.get(timeout=10)


def publish_tool_result(event: Dict[str, Any]) -> None:
    future = producer.send(TOPIC_EVENTS, event)
    future.get(timeout=10)


ensure_indexed()

for message in consumer:
    command = message.value
    try:
        validate_or_raise(COMMAND_VALIDATOR, command, "commands/toolInvocationRequested.json")
        payload = command.get("payload", {})
        if payload.get("tool") != "getProductInformation":
            consumer.commit()
            continue

        invocation_id = str(payload.get("invocationId", ""))
        if not invocation_id:
            raise ValueError("Missing invocationId")

        inserted = mark_processed_once(idempotency_conn, invocation_id)
        if not inserted:
            consumer.commit()
            continue

        query = str(payload.get("parameters", {}).get("query", "")).strip()
        if not query:
            result = {"chunks": []}
        elif is_pricing_query(query):
            catalog = build_price_catalog(ROOT_DIR)
            chunks = [f"{item['product']} — {item['price'].rstrip('.')}" for item in catalog]
            result = {"chunks": chunks, "prices": catalog}
        else:
            embedding = model.encode([query])
            matches = collection.query(query_embeddings=embedding, n_results=3)
            documents = matches.get("documents", [[]])
            chunks = documents[0] if documents else []
            result = {"chunks": chunks}

        event = {
            "conversationId": command.get("conversationId"),
            "userId": command.get("userId"),
            "timestamp": utc_now_iso(),
            "eventType": "ToolInvocationResulted",
            "payload": {
                "invocationId": invocation_id,
                "tool": "getProductInformation",
                "stepIndex": payload.get("stepIndex"),
                "result": result,
            },
        }
        validate_or_raise(EVENT_VALIDATOR, event, "events/toolInvocationResulted.json")
        publish_tool_result(event)
        consumer.commit()
    except Exception as exc:
        try:
            publish_dlq(command, str(exc))
            consumer.commit()
        except Exception:
            # Keep offset uncommitted if we cannot route the error safely.
            pass
