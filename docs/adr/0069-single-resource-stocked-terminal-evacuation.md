# ADR 0069: Single-resource stocked-terminal evacuation

## Status

Accepted

## Context

Issue #359 permits one active empty external terminal to use active storage as local inventory
continuity before removal. A terminal holding any stock remains in place because destruction creates
a ruin and the current logistics graph does not publish ruin stock. The one-terminal controller
allowance therefore prevents committed terminal geometry from converging.

A terminal can hold 300,000 units and multiple resource kinds. Authorizing that complete problem in
one migration record would exceed the existing bounded 150-tick evacuation evidence and introduce
multi-flow feasibility concerns. The current LogisticsPlanner, funded V3 contracts, lease agents,
and exact active-storage destination already provide a safe narrow path for one small resource row.

## Decision

- `ConstructionPlanner` retains every #359 quiescence, storage-continuity, geometry, site-headroom,
  ownership, lifecycle, reserve, workforce, controller, and threat gate.
- One otherwise eligible terminal may persist a `terminalEvacuation` only when its exact
  300,000-unit general-purpose Store contains one positive canonical resource row totaling at most
  3,000 units. Empty terminals retain #359 behavior; mixed or larger stock remains blocked.
- The record binds terminal and storage IDs, resource type, exact amount, destination baseline,
  start tick, and exclusive 150-tick expiry. The exact active storage must expose a valid
  1,000,000-unit general-purpose Store with complete aggregate capacity.
- Layouts owner-local schema V18 adds at most one fixed-shape terminal evacuation per room. V17
  migrates without inventing terms; older code preserves the future owner and disables layout work.
- On following ticks, one resource-specific `optional-growth` demand enters the sole
  LogisticsPlanner. Its sink uses the storage aggregate-capacity key; the specialized terminal
  source replaces ordinary stock publication, and terminal source/refill projections are suppressed.
  Existing V3 contracts, workforce allocation, agents, and executors perform the only
  `withdraw`/`transfer` commands.
- Any unexpired persisted terminal evacuation suppresses internal sends from or to its room before
  Industry intent publication, including when optional layout planning is unavailable. Expiry ends
  flow authorization and suppression but retains the record as removal-blocking failure evidence.
- Removal requires fresh target emptiness, destination stock exactly baseline plus amount, exact
  flow and endpoint retirement, zero terminal cooldown, unchanged storage/Industry/layout/safety
  evidence, and the existing terminal-to-storage authorization. The existing arbiter, executor, and
  three-attempt receipt remain the sole destroy path.

## Consequences

One small single-resource terminal stock can be preserved and committed terminal geometry can
converge without a new logistics, terminal, storage, movement, command, or Memory-root authority.
The projection adds at most one budget, flow, two nodes, and two endpoints per eligible layout
record and remains inside the 64-record/common logistics caps.

Incoming or mixed stock, amount above 3,000, destination consumption, capacity or identity loss,
unrelated work, send activity, CPU-skipped evidence, threat, or layout drift preserves the terminal
and suppresses active evacuation work. Timeout permanently ends this migration attempt, restores
ordinary terminal service, and retains fail-closed evidence so empty-target removal cannot bypass
missing delivery proof. Storage consumption can delay completion because a successful command is not
delivery proof. Multi-resource and larger terminal evacuation remains outside this decision.

Rollback to V17 code preserves the future layouts owner byte-for-byte and authorizes no migration.
Redeploying V18 resumes the exact bounded terms. No deployment is authorized by this ADR.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/) and
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage), and
  [`Store`](https://docs.screeps.com/api/#Store) define the one-per-room RCL allowances, exact
  300,000/1,000,000 general-purpose capacities, resource rows, and aggregate capacity semantics.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer) define adjacent scheduled
  resource movement and typed failures. Later observation, not `OK`, proves stock movement.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) and engine 4.3.2
  [`structures/_destroy.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/structures/_destroy.js)
  /
  [`room/destroy-structure.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/room/destroy-structure.js)
  define scheduled removal, residual ruins, and hostile-room refusal.
- Screeps Wiki [StructureStorage](https://wiki.screepspl.us/StructureStorage/) and
  [Energy](https://wiki.screepspl.us/Energy/) supply primary-room-inventory and bounded
  creep-hauling terminology only. Official contracts and current engine evidence govern.
