# ADR 0073: Mixed-resource stocked obsolete-storage evacuation

## Status

Accepted

## Context

ADR 0072 permits one obsolete external storage containing exactly one resource kind and at most
3,000 units to evacuate into an active terminal before the existing `storage → terminal` removal
path. A mature RCL6–RCL8 room remains blocked when the same bounded stock is split across multiple
resource kinds. Immediate destruction would strand those resources in a ruin outside the current
Logistics graph.

The layouts owner, sole LogisticsPlanner, funded V3 contract/lease/executor path, current Industry
terminal-work evidence, canonical resource ordering, and exact removal authority already provide the
required owners. This decision composes those authorities for two through eight resource kinds; it
does not increase the 3,000-unit total.

## Decision

- Every ADR 0071 and ADR 0072 geometry, colony, site, Logistics-health, endpoint,
  terminal-quiescence, and destination gate remains mandatory.
- `ConstructionPlanner` may persist one storage evacuation manifest only when the sole active
  external exact-capacity storage contains two through eight canonical positive resource rows
  totaling at most 3,000 units and the exact active terminal has complete aggregate free capacity.
- Layouts owner-local schema V22 stores one binary-ordered tuple of resource, amount, and terminal
  baseline per row. The existing V21 scalar form remains unchanged. V21 migration invents no
  manifest; V21 code treats V22 as future, preserves its bytes, and authorizes no layout work.
- Beginning after persistence, each currently incomplete row receives one distinct externally funded
  `optional-growth` V3 flow. Every terminal sink shares one aggregate Store-capacity reservation.
  The complete current row set must pass Logistics admission and colony funding atomically; a prefix
  cannot execute.
- Completed rows leave the current atomic group so asymmetric delivery can continue. Ordinary
  observed and custom source/sink work at both structures remains suppressed, and every internal
  send involving the room remains blocked while the record is unexpired.
- Owner loss, future-owner fallback, missing funding, or current evidence drift removes executable
  authorization from every prefixed orphan contract or lease. Expiry restores ordinary endpoint and
  send service but remains removal-blocking evidence.
- Removal requires fresh storage emptiness, every terminal resource at its exact baseline plus
  amount, every manifest flow retired, no assigned or active primary/counterpart naming either
  endpoint, current terminal quiescence, and every unchanged ADR 0071 safety term.
- `StructureRemovalArbiter`, `StructureDestroyExecutor`, and the fixed reset-safe three-attempt
  receipt remain the sole removal authorities.

## Consequences

One safe RCL6–RCL8 room may move at most 3,000 aggregate units across two through eight resource
kinds over at most 150 ticks, then accept the same temporary storage-service outage and capacity
contraction as ADR 0071. The existing construction chain restores committed storage geometry.

Persistent cost remains one optional bounded record per room across at most 64 layouts records.
Runtime cost is at most eight flows, budgets, and resource pairs per record and 64
storage-evacuation flows globally. No root owner, queue, route, history, planner, executor, package,
dependency, or game command authority is added.

More than eight kinds, stock above 3,000 units, partial graph admission or funding, refill,
destination consumption or overgain, capacity or identity loss, send or endpoint contention,
timeout, pressure, CPU skip, and observation uncertainty preserve the storage. Rollback to V21
pauses all V22 layout work without rewriting the owner; redeploying V22 resumes exact terms. Larger
or continuous evacuation, uninterrupted storage/terminal service, defensive migration, and creep
dismantling remain outside this decision.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal), and
  [`Store`](https://docs.screeps.com/api/#Store) define the 1,000,000/300,000-unit general-purpose
  Stores and aggregate used/free-capacity queries that require one shared terminal-capacity
  reservation across resource rows.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer) define resource-specific
  scheduled movement; later exact observation, not `OK`, proves delivery.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) and engine 4.3.2
  [`structures/_destroy.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/structures/_destroy.js)
  /
  [`room/destroy-structure.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/room/destroy-structure.js)
  confirm scheduled destruction and residual Store contents in a ruin; fresh complete emptiness
  remains mandatory.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Energy`](https://wiki.screepspl.us/Energy/) provide inventory and hauling terminology only;
  official contracts and engine evidence govern.
