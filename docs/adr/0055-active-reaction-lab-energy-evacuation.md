# ADR 0055: Active-reaction lab energy evacuation

## Status

Accepted

## Context

ADR 0054 lets Industry durably rebind one reaction onto a role-identical nine-committed-lab
assignment before an empty external lab is removed. The initial handoff still requires an empty
Store, while ADR 0051 permits lab-energy evacuation only when Industry is quiescent. A positive
energy amount in an otherwise unused external lab can therefore let productive reaction work block
committed RCL8 layout convergence indefinitely.

The target's energy is not required by its current or post-removal role because the target occurs in
no reagent, product, or boost role. The existing layouts-owner V13 evacuation, funded logistics
flow, creep lease/execution path, and destroy receipt already express the required resource movement
and irreversible command boundaries.

## Decision

- Industry may derive ADR 0054's reaction-only handoff when the external target is active,
  zero-cooldown, mineral-empty, and either energy-empty or contains one exact energy-only Store
  amount. Lab-specific energy and mineral capacities plus exact Store contents are validated; the
  general Store capacity may be null because labs have resource-specific capacities.
- Mineral or mixed stock, malformed Store evidence, boost commitments, changed roles, pending
  predecessor attempts, and every existing layout or activity blocker remain ineligible for an
  initial rebound. A durable rebound may still be held fail-closed while later observation changes,
  preserving ADR 0054's non-cancellation rule.
- `ConstructionPlanner` may persist ADR 0051's existing fixed V13 energy evacuation only after the
  rebound is `ready`, independently revalidating the source fingerprint, post-removal assignment,
  target identity, zero mineral stock, replacement capacity, current logistics evidence, and colony
  safety. The rebound tick itself still emits no lab or destroy command.
- `LogisticsPlanner` admits that existing energy flow during non-quiescent Industry work only when
  the current migration view contains the exact durable `ready` reaction handoff, matching layouts
  fingerprint, source target, byte-identical role arrays, and retained replacement. A post-handoff
  pending reaction effect retains this flow authorization and endpoint suppression; an
  old-assignment attempt cannot produce the ready view. Generic active Industry and every
  mineral/mixed evacuation still require quiescence.
- Existing V3 contracts, leases, agents, action arbitration, and executors perform the only
  `withdraw` and `transfer` commands. Reaction intents remain independently authorized on retained
  labs; migration does not reserve or execute a lab API slot.
- Removal still requires fresh target emptiness, baseline-plus-amount replacement energy, retired
  exact flow and endpoints, no pending attempt, unchanged durable handoff/layout/roles/safety, and
  the existing one-command `StructureRemovalArbiter` and `StructureDestroyExecutor` path.
- No owner, persistent field, schema version, queue, dependency, command authority, or telemetry
  cardinality is added.

## Consequences

One energy-stocked role-unused external lab can converge to committed geometry without cancelling or
restarting productive reaction work. The first rebound remains non-executable; reset and reordered
observation reproduce the same commitment and evacuation terms. Reaction effects can continue exact
next-observation settlement while creep logistics drains the external target, but a pending effect
blocks destruction.

The path remains bounded by eight Industry rooms, ten labs per room, 64 layout records, the existing
two-room migration window, 64 lab evacuation flows, 128 removal candidates, and one global destroy
command. Rollback requires only reverting code: Industry owner V5 and layouts owner V13 remain
unchanged. Active mineral/mixed evacuation, boost handoff, terminal destinations, multiple labs,
general layout-revision migration, defensive migration, and creep dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-20:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 permits ten labs; each
  lab has separate 2,000-energy and 3,000-mineral capacities.
- Official [`StructureLab.runReaction`](https://docs.screeps.com/api/#StructureLab.runReaction):
  `OK` schedules one reaction; source stock, target capacity, range, cooldown, ownership, and RCL
  remain execution preconditions.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled actions move
  explicit resources and expose resource, capacity, range, ownership, and argument failures.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate and rejects non-ownership or a hostile-creep room.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies established
  cluster, cooldown, refill, drain, and production-switch terminology. MYRMEX policy and authority
  boundaries remain independently source-defined.
