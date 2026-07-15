# Architecture

MYRMEX is a deterministic modular monolith: one deployable bot, one runtime kernel, one CPU
scheduler, one persistent-state authority, one heap-cache authority, and one world-observation
pipeline.

Each tick runs:

`boot → observe → safety → plan → execute → reconcile → telemetry`

## Core integration model

1. `MemoryManager` validates versioned persistent state.
2. `RuntimeConfigAuthority` resolves source defaults and one validated operational candidate into a
   recursively immutable planner view.
3. `CacheManager` provides disposable, reconstructible heap-derived data.
4. `SegmentManager` schedules large optional data; no survival behavior depends on it.
5. `WorldObserver` creates one immutable snapshot of visible state.
6. `ColonyDirector` owns the room-survival lifecycle and `BudgetLedger` conserves local energy,
   spawn time, and kernel-admitted CPU before downstream work is funded.
7. Safety and domain planners read snapshots and explicit outputs, then emit typed contracts or
   intents.
8. Sole-authority arbiters resolve conflicts for spawn slots, creep actions, movement, structures,
   market actions, and military authorization.
9. Narrow executors alone call Screeps command methods.
10. `Reconciler` applies results through the owning state repositories.
11. `TelemetryService` records bounded decisions, costs, failures, and outcomes.

The executable substrate uses schema-v3 transactional Memory. The v2-to-v3 migration adds the
dedicated `config` owner, and interrupted historical v1-to-v2 migrations remain resumable before
chaining into v3. Runtime configuration is resolved during bounded Boot preflight and enters
`TickContext`; the raw candidate does not. Invalid candidates are rejected atomically, and malformed
or future config owners are preserved while source defaults keep the runtime safe. Fixed migration
metadata has a separate narrow transient allowance, but every projected final root must pass the
normal persistent cap; diagnostic evidence never displaces valid owner state.

Feature availability and prerequisites are source-controlled. Operational Memory may only disable a
known gate, never activate incomplete work. Only the proved `phase1.colony` gate is available under
source v2; downstream gates remain unavailable. Configured self, ally, and NAP identities are
checked before optional reputation and always remain excluded from targeting.

The schema-v3 `colonies` owner has an exact owner-local schema for durable lifecycle and bounded
ledger commitments. Exact `{}` initializes it. Malformed or future non-empty owners are preserved
and authorize no work. Losing room vision preserves state but authorizes nothing new; current
visible ownership loss enters terminal lost state and releases local reservations.

The Phase 0 substrate also provides one immutable tick-local world snapshot, recovery-aware CPU
admission, mandatory Execute/Reconcile/Telemetry tail systems, typed arbitration, a reconstructible
CacheManager, and a bounded deterministic replay matrix. Its versioned evidence is maintained in
`docs/phase0-evidence.md`; the Phase 1 config and colony contracts are in
`docs/phase1-config-evidence.md` and `docs/phase1-colony-evidence.md` in the repository.

Gameplay domains never call each other as hidden control flow. They coordinate through typed,
tick-local buffers and persistent contracts with explicit owners. Global heap resets, unavailable
segments, stale vision, command failures, and low CPU must degrade quality without breaking basic
survival.

The complete normative specification—including ownership tables, state machines, cache invalidation,
CPU admission, intent arbitration, failure recovery, module boundaries, and AI-agent implementation
rules—is maintained in
[`docs/architecture.md`](https://github.com/ralphschuler/screeps-myrmex/blob/main/docs/architecture.md).
