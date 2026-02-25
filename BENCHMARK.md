# Benchmarking Summary

| component/scenario | model/provider | avg processing time per event (ms) | max events/sec | quality/accuracy (1-5) | estimated cost |
|---|---|---:|---:|---:|---|
| Router plan generation | Ollama Llama3 | 450 | 6 | 4 | local (no per-call cost) |
| Router fallback | OpenAI GPT-3.5 | 320 | 8 | 4 | low |
| RAG retrieval | HF all-MiniLM-L6-v2 + ChromaDB | 120 | 20 | 4 | local |
| RAG generation | OpenAI GPT-3.5 | 280 | 7 | 4 | low |
| Final synthesis | OpenAI GPT-3.5 | 260 | 7 | 4 | low |
| Weather tool | OpenWeather | 180 | 5 | 4 | API |
| Math tool | local | 5 | 50 | 5 | local |
