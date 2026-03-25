import os
from pathlib import Path
from typing import List, Tuple

import chromadb
from sentence_transformers import SentenceTransformer

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT_DIR / "data" / "products"
DB_DIR = ROOT_DIR / "python-service" / "chroma_db"
COLLECTION_NAME = "products_kb"


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


def ensure_indexed(force: bool = False) -> int:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    client = chromadb.PersistentClient(path=str(DB_DIR))
    collection = client.get_or_create_collection(name=COLLECTION_NAME)

    if not force and collection.count() > 0:
        return collection.count()

    if force and collection.count() > 0:
        client.delete_collection(COLLECTION_NAME)
        collection = client.get_or_create_collection(name=COLLECTION_NAME)

    docs = read_text_files(DATA_DIR)
    chunks: List[Tuple[str, int, str]] = []
    for filename, text in docs:
        parts = chunk_text(text)
        for idx, part in enumerate(parts):
            chunks.append((filename, idx, part))

    if not chunks:
        return 0

    embeddings = model.encode([chunk[2] for chunk in chunks])
    ids = [f"{chunk[0]}-{chunk[1]}" for chunk in chunks]
    metadatas = [{"source": chunk[0], "index": chunk[1]} for chunk in chunks]
    collection.add(
        ids=ids,
        documents=[chunk[2] for chunk in chunks],
        embeddings=embeddings,
        metadatas=metadatas,
    )
    return len(chunks)


if __name__ == "__main__":
    force_index = os.getenv("RAG_FORCE_REINDEX", "false").lower() == "true"
    total = ensure_indexed(force=force_index)
    print(f"[INDEXER] indexed_chunks={total} force={force_index}")
