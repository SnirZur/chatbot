# Resilience Drills

This document records the concrete failure-handling drills the system is designed to pass and the observable evidence each drill should produce.

## 1. Worker Crash + Recovery

Goal: prove that an in-flight plan can continue after a worker returns.

Procedure:
1. Start the stack with `docker compose up -d`.
2. Stop one worker, for example `docker compose stop rag-retriever-worker`.
3. Send a query that requires that worker.
4. Observe that `ToolInvocationRequested` is present in `conversation-events` but no matching `ToolInvocationResulted` appears while the worker is stopped.
5. Restart the worker with `docker compose start rag-retriever-worker`.
6. Observe the same `conversationId` continue to `ToolInvocationResulted`, then either the next tool request or `PlanCompleted`.

Expected evidence:
- No new plan is created.
- The original `conversationId` continues.
- Duplicate `ToolInvocationResulted` is not emitted after the restart.

## 2. Orchestrator Crash + Recovery

Goal: prove replay-backed orchestrator recovery for an interrupted plan.

Implementation basis:
- On startup, the orchestrator replays `conversation-events` from Kafka before subscribing for live traffic.
- Replayed state is stored in `.state/orchestrator`.
- Any plan that is incomplete after replay is resumed from the next unfinished step.

Procedure:
1. Start the stack with `docker compose up -d`.
2. Send a multi-step query so that `PlanGenerated` and at least one `ToolInvocationRequested` are emitted.
3. Stop the orchestrator after the plan starts but before the final answer is synthesized: `docker compose stop orchestrator`.
4. While the orchestrator is down, let already-requested workers finish and emit their `ToolInvocationResulted` events.
5. Restart the orchestrator with `docker compose start orchestrator`.
6. Observe that the orchestrator replays `conversation-events`, rebuilds state, and emits only the missing follow-up transition:
   - the next `ToolInvocationRequested`, or
   - `PlanCompleted` if all tool results were already present.

Expected evidence:
- Recovery uses the original `conversationId`.
- The resumed transition is emitted once.
- Placeholder replacement still uses the previously recorded tool results.

## 3. Duplicate Invocation Handling

Goal: prove duplicate-safe tool execution.

Procedure:
1. Produce the same `ToolInvocationRequested` command twice with the same `invocationId`.
2. Watch the matching worker logs and the `conversation-events` topic.

Expected evidence:
- The worker accepts the first message and records the `invocationId`.
- The duplicate request is ignored.
- Only one `ToolInvocationResulted` event is emitted for that `invocationId`.

## 4. Evidence Sources

Use these sources during grading:
- `conversation-events` topic contents
- worker/orchestrator container logs
- persisted state under `.state/`
