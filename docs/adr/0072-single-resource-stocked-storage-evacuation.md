# ADR 0072: Single-resource stocked obsolete-storage evacuation

## Status

Accepted

## Context

ADR 0071 permits removal of one obsolete external storage only when its exact 1,000,000-unit Store
is empty. A mature RCL6-RCL8 room can therefore remain blocked when that sole storage contains a
small stock: controller allowance prevents the committed replacement, and destruction would strand
resources in a ruin outside the Logistics graph.

The existing layouts owner, sole LogisticsPlanner, funded V3 contract/lease/executor path, current
Industry terminal-work evidence, and exact `storage → terminal` removal authority provide all
required owners. This decision covers only one positive resource kind totaling at most 3,000 units.

## Decision

- Every ADR 0071 geometry, colony, site, Logistics-health, endpoint, and destination gate remains
  mandatory. Stocked staging additionally requires current quiescent terminal-work evidence.
- `ConstructionPlanner` may persist one fixed `storageEvacuation` only for the sole active external
  exact-capacity storage containing exactly one canonical positive resource row of at most 3,000
  units. The sole exact active terminal must have complete aggregate free capacity.
- Layouts owner-local schema V21 records storage ID, terminal ID, resource, amount, terminal
  baseline, start tick, and exclusive 150-tick expiry. V20 migration invents no record. V20 code
  treats V21 as future, preserves its bytes, and authorizes no layout work.
- Beginning after the persistence tick, the sole LogisticsPlanner receives one resource-specific
  edge, two endpoints, and one `optional-growth` budget through the existing V3 contract and lease
  path. The terminal sink uses its aggregate Store-capacity key. Ordinary observed work and every
  competing custom Logistics demand naming either structure are suppressed; only the exact current
  storage-evacuation flow is exempt.
- An unexpired record blocks every internal terminal send from or to the room before send intent
  publication. Drift, lost prerequisites, missing funding, or malformed/overflow evidence removes
  flow and lease authorization while retaining endpoint suppression. A storage-evacuation-prefixed
  contract or lease remains unauthorized when the owner is missing, future, or no longer contains
  its exact terms. Expiry restores ordinary service and send eligibility but remains
  removal-blocking evidence.
- Partial transfer is resumable from fresh source and destination observations. Exact delivery keeps
  one non-executable flow identity long enough for `ContractLedger` reconciliation to retire the
  prior acquire/deliver contract. Removal then requires the storage empty, terminal resource stock
  exactly baseline plus amount, exact flow retirement, and no assigned/active primary or counterpart
  naming either endpoint. Every ADR 0071 safety term and current terminal quiescence must still
  hold.
- `StructureRemovalArbiter`, `StructureDestroyExecutor`, and the fixed reset-safe three-attempt
  receipt remain the sole removal authorities. The executor freshly rechecks the exact empty active
  storage and exact active same-room terminal before the one `Structure.destroy` call.

## Consequences

One safe RCL6-RCL8 room may move at most 3,000 units of one resource over at most 150 ticks, then
accept the same temporary storage-service outage and 1,000,000-to-300,000 capacity contraction as
ADR 0071. The existing build chain restores committed storage geometry.

The persistent cost is one optional fixed record per room across at most 64 layouts records. Runtime
cost is at most one flow, one budget, two nodes, and two endpoints per eligible room within existing
Logistics and 128-removal-candidate bounds. No root owner, queue, route, history, planner, executor,
or gameplay authority is added.

Mixed or over-3,000 stock, source refill, destination consumption/refill, capacity or identity loss,
send contention, endpoint contention, timeout, pressure, CPU skip, observation gaps, and command
failure preserve the storage. Rollback to V20 pauses evacuation and layout work without rewriting
V21. Redeploying V21 resumes the bounded commitment. Broader mixed-stock evacuation remains outside
this decision.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`Store`](https://docs.screeps.com/api/#Store),
  [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw),
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer), and
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) define capacities, resource
  movement, and deferred destruction.
- Official engine 4.3.2
  [`structures/_destroy.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/structures/_destroy.js)
  and
  [`room/destroy-structure.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/room/destroy-structure.js)
  confirm that destruction creates a ruin carrying residual Store contents; MYRMEX therefore
  requires fresh exact emptiness.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Energy`](https://wiki.screepspl.us/Energy/) provide terminology only; official contracts and
  engine evidence govern.
