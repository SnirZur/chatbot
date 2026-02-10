from __future__ import annotations

import os
os.environ["ANONYMIZED_TELEMETRY"] = "FALSE"

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Tuple

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "products"
DB_DIR = Path(__file__).resolve().parent / "chroma_db"
COLLECTION_NAME = "products_kb"


@dataclass
class Chunk:
    text: str
    source: str
    index: int


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


def build_chunks(docs: List[Tuple[str, str]]) -> List[Chunk]:
    chunks: List[Chunk] = []
    for filename, text in docs:
        parts = chunk_text(text)
        for idx, part in enumerate(parts):
            chunks.append(Chunk(text=part, source=filename, index=idx))
    return chunks


def main() -> None:
    os.makedirs(DB_DIR, exist_ok=True)
    client = chromadb.PersistentClient(
        path=str(DB_DIR),
        settings=Settings(anonymized_telemetry=False),
    )
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass

    collection = client.get_or_create_collection(name=COLLECTION_NAME)
    docs = read_text_files(DATA_DIR)
    if not docs:
        raise SystemExit(f"No .txt files found in {DATA_DIR}")

    chunks = build_chunks(docs)
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    embeddings = model.encode([chunk.text for chunk in chunks], show_progress_bar=True)
    ids = [f"{chunk.source}-{chunk.index}" for chunk in chunks]
    metadatas = [
        {"source": chunk.source, "index": chunk.index}
        for chunk in chunks
    ]

    collection.add(
        ids=ids,
        documents=[chunk.text for chunk in chunks],
        embeddings=embeddings,
        metadatas=metadatas,
    )

    print(f"Indexed {len(chunks)} chunks from {len(docs)} documents.")


if __name__ == "__main__":
    main()
