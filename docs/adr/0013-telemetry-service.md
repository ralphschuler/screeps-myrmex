# ADR 0013: Bounded telemetry service

Status: accepted

## Context

Phase 1 needs deterministic accounting across colony budgets, contracts, movement, spawning, energy,
recovery, threat, and CPU admission. Domain-owned metrics would create competing durable state and
make reset/reordering behaviour unprovable.

## Decision

`TelemetryService` is the sole authority for the `telemetry` owner. It consumes settled immutable
tick receipts and writes a fixed-schema capped observer history through `MemoryManager`'s single
reconciliation commit. The status surface has bounded typed detail records, fixed aggregate
counters, a canonical hash, and deterministic overflow counters.

The owner contains only current status metadata, capped hash history, and dropped counts. It has no
live objects, raw snapshots, planner inputs, free-form diagnostic text, or gameplay commitments.
Malformed telemetry is rebuilt as empty observer state and cannot invalidate gameplay owners.

## Consequences

- Planners and executors never read telemetry as authority; issue #110 remains the console consumer.
- Publication stays in the mandatory telemetry tail, so a publisher failure cannot roll back
  Execute, Reconcile, or durable commitments.
- `phase1.telemetry` is source-available under `runtime-config-source-v12`; policy caps bound detail
  cardinality, history entries, and history bytes.
