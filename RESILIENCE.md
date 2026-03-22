# Resilience Evidence

This repository includes two forms of resilience evidence:

1. `EXECUTION_LOG.md`
   Captured end-to-end scenarios from a full stack run, including worker recovery,
   orchestrator recovery, and duplicate handling.

2. `RESILIENCE_LOG.txt`
   Deterministic local evidence generated from `scripts/generate_resilience_log.ts`.
   This validates the replay and idempotency logic without requiring Docker.

## Evidence Mapping

- Worker crash + recovery:
  See `EXECUTION_LOG.md` section `execution Worker Crash + Recovery`.
- Orchestrator crash + replay-backed recovery:
  See `EXECUTION_LOG.md` section `execution Orchestrator Crash + Recovery`.
- Duplicate event handling:
  See `EXECUTION_LOG.md` section `execution Duplicate Handling`.
- Deterministic replay/idempotency proof:
  See `RESILIENCE_LOG.txt`.

## Reproducing The Deterministic Log

```bash
bun scripts/generate_resilience_log.ts > RESILIENCE_LOG.txt
```

## Reproducing The Live Docker Drill

```bash
bun scripts/resilience_drill.ts
```

This live drill uses Docker Compose to bring up a minimal Kafka-backed stack and
verifies:

- worker pause and recovery
- orchestrator crash and replay-backed recovery
- duplicate invocation safety
