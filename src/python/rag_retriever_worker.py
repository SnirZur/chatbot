import json
import os
from pathlib import Path
from typing import Dict, List, Tuple

import chromadb
from kafka import KafkaConsumer, KafkaProducer
from sentence_transformers import SentenceTransformer

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092").split(",")

TOPIC_REQUESTS = "tool-invocation-requests"
TOPIC_EVENTS = "conversation-events"
TOPIC_DLQ = "dead-letter-queue"

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "products"
DB_DIR = Path(__file__).resolve().parents[2] / "python-service" / "chroma_db"
COLLECTION_NAME = "products_kb"

producer = KafkaProducer(bootstrap_servers=KAFKA_BROKERS)
consumer = KafkaConsumer(
    TOPIC_REQUESTS,
    bootstrap_servers=KAFKA_BROKERS,
    group_id="rag-retriever-worker",
    auto_offset_reset="earliest",
    enable_auto_commit=True,
)

model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
client = chromadb.PersistentClient(path=str(DB_DIR))
collection = client.get_or_create_collection(name=COLLECTION_NAME)

processed = set()


def read_text_files(directory: Path) -> List[Tuple[str, str]]:
    files = sorted(directory.glob("*.txt"))
    contents: List[Tuple[str, str]] = []
    for file in files:
        text = file.read_text(encoding="utf-8")
        contents.append((file.name, text))
    return contents


def chunk_text(text: str, min_size: int = 600, max_size: int = 1200, overlap: int = 200) -> List[str]:
    normalized = " ".join(text.split())
    chunks: List[str] = []
    start = 0
    while start < len(normalized):
        end = min(start + max_size, len(normalized))
        if end - start < min_size and end < len(normalized):
            end = min(start + min_size, len(normalized))
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(normalized):
            break
        start = max(0, end - overlap)
    return chunks


def ensure_indexed():
    if collection.count() > 0:
        return
    docs = read_text_files(DATA_DIR)
    chunks = []
    for filename, text in docs:
        parts = chunk_text(text)
        for idx, part in enumerate(parts):
            chunks.append((filename, idx, part))
    if not chunks:
        return
    embeddings = model.encode([c[2] for c in chunks])
    ids = [f"{c[0]}-{c[1]}" for c in chunks]
    metadatas = [{"source": c[0], "index": c[1]} for c in chunks]
    collection.add(ids=ids, documents=[c[2] for c in chunks], embeddings=embeddings, metadatas=metadatas)


def send_event(payload: Dict):
    producer.send(TOPIC_EVENTS, json.dumps(payload).encode("utf-8"))


def send_dlq(payload: Dict, error: str):
    producer.send(TOPIC_DLQ, json.dumps({"error": error, "payload": payload}).encode("utf-8"))


ensure_indexed()

for message in consumer:
    try:
        command = json.loads(message.value.decode("utf-8"))
    except Exception:
        continue

    try:
        payload = command.get("payload", {})
        if command.get("commandType") != "ToolInvocationRequested":
            continue
        if payload.get("tool") != "getProductInformation":
            continue

        invocation_id = payload.get("invocationId")
        if invocation_id in processed:
            continue
        processed.add(invocation_id)

        query = str(payload.get("parameters", {}).get("query", ""))
        if not query:
            result = {"chunks": []}
        else:
            embedding = model.encode([query])
            results = collection.query(query_embeddings=embedding, n_results=3)
            documents = results.get("documents", [[]])
            chunks = documents[0] if documents else []
            result = {"chunks": chunks}

        event = {
            "conversationId": command.get("conversationId"),
            "userId": command.get("userId"),
            "timestamp": "{}".format(message.timestamp),
            "eventType": "ToolInvocationResulted",
            "payload": {
                "invocationId": invocation_id,
                "tool": "getProductInformation",
                "stepIndex": payload.get("stepIndex"),
                "result": result,
            },
        }
        send_event(event)
    except Exception as exc:
        send_dlq(command, str(exc))
