#!/usr/bin/env python3
import os
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "src" / "python"))

    from rag_indexing import ensure_indexed

    force_index = os.getenv("RAG_FORCE_REINDEX", "false").lower() == "true"
    total = ensure_indexed(force=force_index)
    print(f"[INDEXER] indexed_chunks={total} force={force_index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
