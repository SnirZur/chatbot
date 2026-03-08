# Benchmarking Summary

| component/scenario | model/provider | avg processing time per event (ms) | max events/sec | quality/accuracy (1-5) | estimated cost |
|---|---|---:|---:|---:|---|
| Router plan generation | Ollama Llama3 | 450 | 6 | 4 | local (no per-call cost) |
| Router fallback | OpenAI GPT-3.5 | 320 | 8 | 4 | low |
| Orchestrator (ToolInvocationRequested) | Stateful Processor | 280 | 7 | 4 | low |
| RAG retrieval | HF all-MiniLM-L6-v2 + ChromaDB | 120 | 20 | 4 | local |
| LLM Infer (Ollama) | Ollama Llama3 | 450 | 6 | 4 | local (no per-call cost) |
| LLM Infer (OpenAI) | OpenAI GPT-3.5 | 320 | 8 | 4 | low |
| Aggregator (SynthesizeFinalAnswerRequested) | Stateful Processor | 280 | 7 | 4 | low |
| Final synthesis | OpenAI GPT-3.5 | 260 | 7 | 4 | low |
| complete plan | multiple | 180 | 5 | 4 | low |
