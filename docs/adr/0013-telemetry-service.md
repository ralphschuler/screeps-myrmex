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

The owner contains only current status metadata, capped hash history, dropped counts, and the safe
reporter aggregation metadata described below. It has no live objects, raw snapshots, planner
inputs, free-form diagnostic text, or gameplay commitments. Malformed telemetry is rebuilt as empty
observer state and cannot invalidate gameplay owners.

The schema-v2 reporter subsection retains only capped opaque fingerprints, fixed reason codes,
counts, reminder ticks, and aggregate recovery progress. First occurrence, reminder, resolution, and
stuck-recovery transitions are derived as bounded tick-local telemetry and cross the renderer
boundary through ReporterStatus schema v2. They are not added to the durable owner as a replay
queue, so this extension does not require a persistent telemetry schema bump.

## Consequences

- Planners and executors never read telemetry as authority; `ConsoleReporter` remains the sole text
  consumer of the redacted status projection.
- Publication stays in the mandatory telemetry tail, so a publisher failure cannot roll back
  Execute, Reconcile, or durable commitments.
- `phase1.telemetry` is source-available under `runtime-config-source-v12`; policy caps bound detail
  cardinality, history entries, and history bytes.
