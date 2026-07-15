# Architecture

MYRMEX is a deterministic modular monolith: one deployable bot, one runtime kernel, one CPU
scheduler, one persistent-state authority, one heap-cache authority, and one world-observation
pipeline.

Each tick runs:

`boot → observe → safety → plan → execute → reconcile → telemetry`

## Core integration model

1. `MemoryManager` validates versioned persistent state.
2. `CacheManager` provides disposable, reconstructible heap-derived data.
3. `SegmentManager` schedules large optional data; no survival behavior depends on it.
4. `WorldObserver` creates one immutable snapshot of visible state.
5. Safety and domain planners read snapshots and emit typed contracts or intents.
6. Sole-authority arbiters resolve conflicts for spawn slots, creep actions, movement, structures,
   market actions, and military authorization.
7. Narrow executors alone call Screeps command methods.
8. `Reconciler` applies results through the owning state repositories.
9. `TelemetryService` records bounded decisions, costs, failures, and outcomes.

Gameplay domains never call each other as hidden control flow. They coordinate through typed,
tick-local buffers and persistent contracts with explicit owners. Global heap resets, unavailable
segments, stale vision, command failures, and low CPU must degrade quality without breaking basic
survival.

The complete normative specification—including ownership tables, state machines, cache invalidation,
CPU admission, intent arbitration, failure recovery, module boundaries, and AI-agent implementation
rules—is maintained in
[`docs/architecture.md`](https://github.com/ralphschuler/screeps-myrmex/blob/main/docs/architecture.md).
