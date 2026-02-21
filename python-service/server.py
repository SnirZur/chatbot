from __future__ import annotations

import os
from pathlib import Path
from typing import List

# disable telemetry in underlying libraries (prevents telemetry capture() errors)
os.environ.setdefault("DISABLE_TELEMETRY", "1")
os.environ.setdefault("CHROMA_DISABLE_TELEMETRY", "1")
os.environ.setdefault("CHROMA_TELEMETRY_ENABLED", "0")
os.environ.setdefault("TELEMETRY_DISABLED", "1")

import chromadb
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "products"
DB_DIR = Path(__file__).resolve().parent / "chroma_db"
COLLECTION_NAME = "products_kb"

app = FastAPI()

_model: SentenceTransformer | None = None
_collection = None


class SearchRequest(BaseModel):
    query: str


class SearchResponse(BaseModel):
    chunks: List[str]


def load_collection():
    global _collection
    os.makedirs(DB_DIR, exist_ok=True)
    client = chromadb.PersistentClient(path=str(DB_DIR))
    _collection = client.get_or_create_collection(name=COLLECTION_NAME)


def ensure_indexed() -> None:
    if _collection is None:
        load_collection()
    if _collection.count() > 0:
        return

    from index_kb import build_chunks, read_text_files

    docs = read_text_files(DATA_DIR)
    if not docs:
        raise RuntimeError("No product documents found for indexing.")

    chunks = build_chunks(docs)
    model = get_model()
    embeddings = model.encode([chunk.text for chunk in chunks])
    ids = [f"{chunk.source}-{chunk.index}" for chunk in chunks]
    metadatas = [
        {"source": chunk.source, "index": chunk.index}
        for chunk in chunks
    ]

    _collection.add(
        ids=ids,
        documents=[chunk.text for chunk in chunks],
        embeddings=embeddings,
        metadatas=metadatas,
    )


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return _model


@app.on_event("startup")
async def startup_event():
    load_collection()
    ensure_indexed()


@app.post("/search_kb", response_model=SearchResponse)
async def search_kb(request: SearchRequest) -> SearchResponse:
    ensure_indexed()
    model = get_model()
    query_embedding = model.encode([request.query])
    results = _collection.query(
        query_embeddings=query_embedding,
        n_results=3,
    )
    documents = results.get("documents", [[]])
    chunks = documents[0] if documents else []
    return SearchResponse(chunks=chunks)
