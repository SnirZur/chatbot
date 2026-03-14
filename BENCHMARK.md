# Benchmarking Summary

| component/scenario | model/provider | avg processing time per event (ms) | max events/sec | quality/accuracy (1-5) | estimated cost |
|---|---|---:|---:|---:|---|
| Router plan generation | Ollama Llama3 | 19328.5 | 0.05 | 4 | local (no per-call cost) |
| Router fallback | OpenAI GPT-3.5 | 638.5 | 1.57 | 4 | low |
| Orchestrator (ToolInvocationRequested) | Stateful Processor | 8.3 | 120.00 | 4 | low |
| RAG retrieval | HF all-MiniLM-L6-v2 + ChromaDB | 132.3 | 7.56 | 4 | local |
| LLM Infer (Ollama) | Ollama Llama3 | 12876.5 | 0.08 | 4 | local (no per-call cost) |
| LLM Infer (OpenAI) | OpenAI GPT-3.5 | 1385.0 | 0.72 | 4 | low |
| Aggregator (SynthesizeFinalAnswerRequested) | Stateful Processor | 1.5 | 666.67 | 4 | low |
| Final synthesis | OpenAI GPT-3.5 | 1377.3 | 0.73 | 4 | low |
| complete plan | multiple | 25203.3 | 0.04 | 4 | low |
