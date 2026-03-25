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
- `synthesis-requests`
- `dead-letter-queue`
- `schema-registry`

## Services
- **Web UI / Gateway**: uses the existing UI identifier flow. Produces `UserQueryReceived` commands and waits for `FinalAnswerSynthesized` events.
- **Router**: generates orchestration plans (Ollama Llama3 primary, OpenAI GPT‑3.5 fallback).
- **Orchestrator**: stateful plan processor; emits tool invocation commands and events.
- **Tool Workers**: math, exchange, weather, RAG retrieval (Python), LLM inference (Node), synthesis (Node).
- **Aggregator**: gathers results and requests synthesis.
- **History Projection**: builds `history.json` from events.
- **Metrics**: computes end‑to‑end latency, per‑tool latency, throughput, and best‑effort consumer lag.

## Run Instructions
1. Set environment variables (in `.env` or your shell):
```
OPENAI_API_KEY=...
WEATHER_API_KEY=...
```
2. Start the stack:
```
docker compose up -d
```
3. Ensure the Ollama model exists (one time):
```
docker compose exec ollama ollama pull llama3
```
4. Generate Prisma client for Docker runtime:
```
bunx --cwd packages/server prisma generate
```
5. Web gateway API is available on port 3000:
```
http://localhost:3000
```
6. Open the UI (default Vite dev server):
```
bun --cwd packages/client run dev
```
7. (Optional) run the server locally instead of Docker:
```
bun --cwd packages/server run dev
```
Review endpoints (`/api/products/:id/reviews`) require Prisma + DB. Set
`ENABLE_REVIEWS=true` and configure `DATABASE_URL` if you want them enabled.
If you run the server locally and change Prisma schema, regenerate client:
```
bunx --cwd packages/server prisma generate
```

## Benchmarking
See `BENCHMARK.md` for a detailed table. Key metrics captured by the metrics service:
- End‑to‑End Latency (UserQueryReceived → FinalAnswerSynthesized)
- Latency per Tool (ToolInvocationRequested → ToolInvocationResulted)
- Throughput (events/sec)
- Consumer Lag (best‑effort)


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
orchestrator.ts makes a recovery. Resilience achieved: Service restarts → reads events from Kafka → rebuilds state → continues where it left off
2. RECOVERY CAPABILITY - Replay & Reconstruct
Any service can reconstruct the ENTIRE conversation history from Kafka
Use Cases:
Scenario, new service joins, service crashes, need to debug, analytics, machine Learning
3. AUDITABILITY  - Complete Audit Trail
Immutable Record of Everything:
Every action is permanently recorded with timestamp:



The system uses Kafka as the Source of Truth to manage distributed state without relying on volatile memory or external databases:
Orchestrator (Persistent State)
Stores plan execution state in LevelDB (backed by Kafka events)
Tracks: stepIndex, intermediate results, and status
On crash: Automatically recovers running plans from disk and resumes exactly where it left off
Each event updates state: PlanGenerated → ToolInvocationResulted → step completion
Aggregator (Ephemeral State)
Uses in-memory Maps to cache tool results and user inputs
When PlanCompleted arrives: compiles all cached results into synthesis request
On crash: Simply replays events from Kafka to rebuild Maps (no data loss)
Why This Is Resilient
Kafka keeps every event (immutable log) → state can always be rebuilt
Local storage is optional → services can recover by replaying events
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





