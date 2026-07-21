# ADR 0057: Active-reaction lab mixed-stock evacuation

## Status

Accepted

## Context

ADR 0054 lets Industry durably rebind one reaction onto a role-identical nine-committed-lab
assignment before an unused external lab is removed. ADRs 0055 and 0056 reuse the existing V13
energy-to-lab and mineral-to-storage evacuations while reaction work continues, but each admits only
one resource form. An otherwise role-unused external lab holding both energy and one mineral kind
therefore still blocks committed RCL8 layout convergence.

ADR 0053 already defines one bounded mixed V13 record, two distinct funded logistics flows, atomic
projection, exact delivery evidence, and the irreversible destroy boundary while Industry is
quiescent. The active handoff changes only the evidence under which that existing record may run.

## Decision

- Industry may derive ADR 0054's reaction-only handoff when the external target is active,
  zero-cooldown, and contains exact positive energy plus one exact positive non-energy mineral kind.
  Lab-specific capacities, mineral identity, exact Store rows, and used capacity must agree.
- `ConstructionPlanner` may persist ADR 0053's existing V13 mixed evacuation only after the rebound
  is `ready`. It independently revalidates the durable source fingerprint, byte-identical roles,
  target stock, retained-lab energy capacity, exact active Industry-published storage, complete
  aggregate storage capacity, current logistics evidence, and colony safety. The rebound tick
  remains non-executable.
- `LogisticsPlanner` admits the existing energy and mineral flows during active reaction work only
  when the current migration view contains the exact durable `ready` handoff, matching layout
  fingerprint, source target, retained assignment, replacement lab, and storage destination. The
  fixed projection validates the complete V13 record and admits both flows or neither.
- Existing V3 contracts, leases, agents, action arbitration, and executors perform the only
  `withdraw` and `transfer` commands. Retained labs may continue exact reaction execution and
  settlement. A post-handoff pending reaction effect retains both flows and endpoint suppression but
  blocks removal.
- Removal requires fresh target emptiness, baseline-plus-amount replacement energy,
  baseline-plus-amount storage mineral, both exact flows and every source/replacement/storage
  endpoint retired, no pending reaction attempt, and unchanged destination, durable handoff, layout,
  roles, and colony safety.
- No owner, persistent field, schema version, queue, dependency, command authority, or telemetry
  cardinality is added.

## Consequences

One mixed-stock role-unused external lab can converge to committed geometry without cancelling or
restarting productive reaction work or discarding either resource. The first rebound remains
non-executable; JSON/global reset and reordered observation reproduce the same commitment and atomic
evacuation terms. Independent partial delivery remains resumable, but one completed flow cannot
authorize removal while the other remains.

The path remains bounded by eight Industry rooms, ten labs per room, 64 layout records and total lab
evacuation flows, 128 nodes/endpoints and removal candidates, and one global destroy command. A
33-record mixed batch exceeds the flow ceiling and publishes no prefix. Rollback requires only
reverting code: Industry owner V5 and layouts owner V13 remain unchanged. ADR 0064 subsequently
permits this exact reaction handoff to send mineral to one idle terminal when no active storage
exists while energy still moves to the retained lab. Mixed-terminal boost work, multiple labs,
general layout-revision migration, defensive migration, and creep dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 permits ten labs; each
  lab has separate 2,000-energy and 3,000-mineral capacities, and reaction roles use two reagent
  labs plus range-two output labs.
- Official [`Store`](https://docs.screeps.com/api/#Store) and
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage): storage has one shared
  aggregate capacity across all resources, so the complete mineral amount must fit after other stock
  reservations.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled actions name
  one exact resource and require current source stock, creep capacity, and destination capacity.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate, does not deliver stock to either destination, and rejects invalid ownership or
  hostile-room conditions.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies established
  two-input/multiple-output cluster, refill, drain, and production-switch terminology. MYRMEX policy
  and authority boundaries remain independently source-defined.
