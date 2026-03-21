# Advanced Final Project — Event-Sourced Tool-Orchestrating Agent

## Architecture Diagram

![architecture](architecture.png)

## Overview
This project implements an event-sourced, CQRS-style tool-orchestrating agent over Kafka. Commands are produced into `user-commands` and `tool-invocation-requests`. Events are appended into `conversation-events`, which acts as the source of truth. Read models (history) are projections built from the event log.

## Event Sourcing + Stateful Stream Processing
- **Event Store**: `conversation-events` is the canonical log for reconstructing agent state and auditability.
- **CQRS**: commands and events are separated; projections are built from events only.
- **Stateful Orchestrator**: maintains plan state in LevelDB and recovers after restart.
- **Idempotent Workers**: tool workers de-duplicate `invocationId` to avoid double effects.
- **Schema validation + DLQ**: all producers/consumers validate against JSON schemas and send invalid messages to `dead-letter-queue`.
- **Schema registry topic**: JSON schemas are published to `schema-registry` on startup and cached by services.

## Kafka Topics
- `user-commands`
- `conversation-events`
- `tool-invocation-requests`
- `final-synthesis-requests`
- `dead-letter-queue`
- `schema-registry`

## Services
- **Web UI / Gateway**: packaged in Docker (`web-gateway` + `client`). Produces `UserQueryReceived` commands and waits for `FinalAnswerSynthesized` events.
- **Router**: generates orchestration plans (Ollama Llama3 primary, OpenAI GPT‑3.5 fallback).
- **Orchestrator**: stateful plan processor; emits tool invocation commands and events.
- **Tool Workers**: math, exchange, weather, RAG retrieval (Python), LLM inference (Node), synthesis (Node).
- **Aggregator**: gathers results and requests synthesis.
- **History Projection**: builds a conversation history projection in LevelDB (`.state/history`) from events.
- **Metrics**: computes end‑to‑end latency, per‑tool latency, throughput, and best‑effort consumer lag.
- **RAG Indexer**: standalone indexing job (`scripts/index_products.py`) also executed as `rag-indexer` in Compose.

## Run Instructions
1. Set environment variables (in `.env` or your shell):
```
OPENAI_API_KEY=...
WEATHER_API_KEY=...
```
2. Start the full stack (Kafka + Node services + Python workers + web gateway + client):
```
docker compose up -d
```
3. Ensure the Ollama model exists (one time):
```
docker compose exec ollama ollama pull llama3
```
4. Verify running services:
```
docker compose ps
```
5. Open the UI:
```
http://localhost:5137
```
6. API health check:
```
curl http://localhost:3000/api/kafka/health
```

### Standalone indexing command
You can run indexing independently of the worker:
```
python scripts/index_products.py
```

## Benchmarking
See `BENCHMARK.md` for a detailed table. Key metrics captured by the metrics service:
- End‑to‑End Latency (UserQueryReceived → FinalAnswerSynthesized)
- Latency per Tool (ToolInvocationRequested → ToolInvocationResulted)
- Throughput (events/sec)
- Consumer Lag (best‑effort)

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
| Complete plan | multiple | 25203.3 | 0.04 | 4 | low |

## Resilience Drills
Detailed recovery and duplicate-handling procedures are documented in `RESILIENCE.md`.


**Analysis and Conclusions**
Justification: Kafka as Event Store with Event Sourcing
1. RESILIENCE  - System Can Survive Failures
The Problem Without Event Sourcing:
If the orchestrator crashes mid-plan, you lose all state. Next restart = lost context.
Kafka Solution:
Topics with Event Sourcing:     
 [1] UserQueryReceived              
 [2] PlanGenerated                
 [3] ToolInvocationRequested - step 0 
 [4] ToolInvocationResulted - step 0 
 [5] ToolInvocationRequested - step 1   Service crashes here!
 [6] ToolInvocationResulted - step 1  (But event already recorded)
 [7] PlanCompleted                  
 [8] FinalAnswerSynthesized 
orchestrator.ts makes a recovery. Resilience achieved: Service restarts → replays `conversation-events` from Kafka into its LevelDB projection → resumes the next unfinished step
2. RECOVERY CAPABILITY - Replay & Reconstruct
Any service can reconstruct the ENTIRE conversation history from Kafka
Use Cases:
Scenario, new service joins, service crashes, need to debug, analytics, machine Learning
3. AUDITABILITY  - Complete Audit Trail
Immutable Record of Everything:
Every action is permanently recorded with timestamp:



The system uses Kafka as the Source of Truth to manage distributed state without relying on volatile memory or external databases:
Orchestrator (Persistent State)
Replays `conversation-events` on startup and stores the rebuilt execution state in LevelDB
Tracks: stepIndex, intermediate results, and status
On crash: Rebuilds state from Kafka, then resumes or completes any unfinished plan transition
Each event updates state: PlanGenerated → ToolInvocationResulted → step completion
Aggregator (Persistent Projection)
Uses LevelDB to store user input, tool results, and whether synthesis was already requested
When PlanCompleted arrives: compiles the persisted results into a synthesis request
On restart: continues from its projection without recomputing prior events
Why This Is Resilient
Kafka keeps every event (immutable log) → state can always be rebuilt
Local storage is a projection cache → authoritative recovery path remains Kafka replay
No external DB dependency → eliminates single point of failure
Idempotent processing → duplicate events don't cause corruption
Result: Distributed, scalable, crash-resilient state management with full audit trail. 



CQRS splits work into commands (requests sent to Kafka) and events (outcomes produced by services).
 Writers never read state, readers build their own views from the event log.
 Result: scalable, auditable, and every change is recorded.

Idempotency ensures each message is handled once even if delivered multiple times.
 Consumers check and skip duplicates (processed sets, result checks).
This lets retries and restarts happen safely.

Together they make asynchronous, distributed system reliable and fault‑tolerant.



Event Sourcing Trade‑offs 
Added Complexity - Building and reasoning about systems that record every change as an event is more involved . we had to design event schemas, manage offsets, and write replay/compaction logic.

Debugging can be harder - Instead of inspecting “current state” we often need to replay streams or stitch together projections to understand a bug. Tools help, but developer mental model is heavier.

Eventual Consistency - Different services see updates at different times. We must design for stale reads and make operations idempotent, which complicates API semantics.

Still, for a distributed, resilient backend like ours, those costs buy replayability, auditability and fault tolerance—trade‑offs taken consciously and successfully.



 few sensible enhancements as the system matures:
Kafka Streams / DSL - Libraries such as kafka‑streams or node-rdkafka-streams let you express filters, maps, joins and windowed aggregations declaratively.
We already publish schemas manually; a proper registry (Confluent, Apicurio, etc.) can enforce compatibility, provide REST lookup and generate client code.
KSQL (now ksqlDB) could be used alongside the registry to write SQL‑like queries over your conversation-events topic 
Export Kafka client metrics (latency, throughput, consumer lag) to Prometheus.
Dashboards in Grafana let you spot slow consumers or stuck offsets.
Add structured logging (JSON) and distributed tracing (OpenTelemetry) so you can trace a conversation through all services.
Compaction/retention policies on conversation-events to limit storage while keeping recent history.
Separate command & event topics (CQRS pattern) with log‑compaction for state stores.


