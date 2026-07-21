# ADR 0056: Active-reaction lab mineral evacuation

## Status

Accepted

## Context

ADR 0054 lets Industry durably rebind one reaction onto a role-identical nine-committed-lab
assignment before an unused external lab is removed. ADR 0055 permits that external lab to contain
energy and reuses the existing energy evacuation while reaction work continues. A zero-energy
external lab holding one mineral kind still blocks convergence even though ADR 0052 already defines
a bounded mineral-to-storage evacuation while Industry is quiescent.

The target has no current or post-removal reagent, product, or boost role. Its mineral is therefore
unrelated to the retained reaction. The layouts-owner V13 mineral record, Industry-published storage
destination, sole LogisticsPlanner, funded V3 lease/executor path, and destroy receipt already own
the required movement and irreversible command boundaries.

## Decision

- Industry may derive ADR 0054's reaction-only handoff when the external target is active,
  zero-cooldown, energy-empty, and contains either no mineral or one exact positive non-energy
  mineral kind. Lab-specific capacities, mineral identity, exact Store rows, and used capacity must
  agree. Energy-plus-mineral stock, duplicate/malformed resource rows, and invalid mineral identity
  remain ineligible for the initial rebound.
- `ConstructionPlanner` may persist ADR 0052's existing V13 mineral evacuation only after the
  rebound is `ready`. It independently revalidates the durable source fingerprint, byte-identical
  roles, target stock, the exact active Industry-published storage, complete aggregate destination
  capacity, current logistics evidence, and colony safety. The rebound tick remains non-executable.
- `LogisticsPlanner` admits that one existing mineral flow during active reaction work only when the
  current migration view contains the exact durable `ready` handoff, matching layout fingerprint,
  source target, retained assignment, and storage destination. Generic active Industry and every
  mixed evacuation still require quiescence.
- Existing V3 contracts, leases, agents, action arbitration, and executors perform the only
  `withdraw` and `transfer` commands. Retained labs may continue exact reaction execution and
  settlement. A post-handoff pending reaction effect retains flow authorization and source
  suppression but blocks removal.
- Removal requires fresh target emptiness, baseline-plus-amount storage stock, retired exact flow
  and endpoints, no pending reaction attempt, and unchanged destination, durable handoff, layout,
  roles, and colony safety. The existing one-command `StructureRemovalArbiter` and
  `StructureDestroyExecutor` remain the only irreversible path.
- No owner, persistent field, schema version, queue, dependency, command authority, or telemetry
  cardinality is added.

## Consequences

One mineral-stocked role-unused external lab can converge to committed geometry without cancelling
or restarting productive reaction work. The first rebound remains non-executable; JSON/global reset
and reordered observation reproduce the same commitment and evacuation terms. Exact active storage
and aggregate capacity are required on every relevant tick. Destination consumption, stock/type
change, mixed contamination, stale evidence, pending predecessor work, boost work, threat, or drift
preserves the lab and authorizes no command.

The path remains bounded by eight Industry rooms, ten labs per room, 64 layout records and
evacuation flows, 128 removal candidates, and one global destroy command. Rollback requires only
reverting code: Industry owner V5 and layouts owner V13 remain unchanged. Active mixed-stock
evacuation, boost-work handoff, terminal destinations, multiple labs, general layout-revision
migration, defensive migration, and creep dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 permits ten labs; each
  lab has separate 2,000-energy and 3,000-mineral capacities, and reaction roles are determined by
  the two input labs and one range-two output lab.
- Official [`Store`](https://docs.screeps.com/api/#Store) and
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage): storage has one shared
  aggregate capacity across all resources, so the complete mineral amount must fit after other stock
  reservations.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled actions name
  one exact resource and require current source stock, creep capacity, and destination capacity.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate, does not deliver stock to storage, and rejects invalid ownership or hostile-room
  conditions.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies established
  two-input/multiple-output cluster, refill, drain, and production-switch terminology. MYRMEX policy
  and authority boundaries remain independently source-defined.
