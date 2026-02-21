# Advanced Final Project — Event-Sourced Tool-Orchestrating Agent

## Architecture Diagram

![architecture](architecture.png)

## Overview
This project implements an event-sourced, CQRS-style tool-orchestrating agent over Kafka. Commands are produced into `user-commands` and `tool-invocation-requests`. Events are appended into `conversation-events`, which acts as the source of truth. Read models (history) are projections built from the event log.

## Event Sourcing + Stateful Stream Processing
- **Event Store**: `conversation-events` topic is the canonical log for reconstructing agent state.
- **CQRS**: commands and events are separated; read models are projections.
- **Orchestrator**: stateful processor with LevelDB backing store; recovers after restart and continues plans.
- **Idempotent workers**: tool workers de-duplicate invocation IDs to avoid double side effects.

## Services
- **user-interface / web gateway**: uses existing UI identifier flow. Produces `UserQueryReceived` commands and waits for `FinalAnswerSynthesized` events.
- **router**: generates orchestration plan (Ollama Llama3 primary, OpenAI fallback).
- **orchestrator**: maintains plan state, emits tool invocation requests.
- **tool workers**: execute tools via Kafka (weather, math, exchange, RAG retrieval, etc.).
- **aggregator + synthesis**: collects results, requests synthesis, publishes final answer event.
- **history-projection**: builds `history.json` from events.

## Kafka Topics
- `user-commands`
- `conversation-events`
- `tool-invocation-requests`
- `synthesis-requests`
- `dead-letter-queue`

## Run Instructions
1. Set env vars:
```
OPENAI_API_KEY=...
WEATHER_API_KEY=...
```
2. Start stack:
```
docker compose up -d
```
3. Start services locally (optional for dev):
```
bun run services
bun --cwd packages/server run dev
bun --cwd packages/client run dev
```

## Benchmarks
See `BENCHMARK.md`.

## Resilience Demos
- **Worker crash**: stop RAG worker mid-plan, restart and resume.
- **Orchestrator crash**: stop orchestrator mid-plan, restart and resume from LevelDB + events.
- **Duplicate events**: resend same ToolInvocationRequested; worker ignores duplicate.

## Trade-offs and Future Improvements
- **Benefits**: auditability, recovery, and clear separation of concerns.
- **Costs**: higher complexity, eventual consistency, harder debugging.
- **Future**: Kafka Streams DSL, schema registry, KSQL, Prometheus/Grafana observability.
