# ADR 0052: Quiescent obsolete-lab mineral evacuation

## Status

Accepted

## Context

ADR 0050 permits one empty external lab to leave an RCL8 layout while lab work is quiescent, and ADR
0051 first evacuates an energy-only target to the canonical committed replacement lab. A target
containing one mineral kind still cannot converge. Destroying it would waste up to 3,000 units,
while using the replacement lab as a sink would contaminate the post-removal cluster. A terminal can
also change through its separate send authority, which the lab-quiescence view does not cover.

`IndustryDirector` already owns current lab assignment and stock-policy composition.
`LogisticsPlanner` already owns resource-specific lab drains into general-purpose inventory. The
layouts owner, `ConstructionPlanner`, V3 leases and agents, removal arbiter/executor, and bounded
receipt retain the remaining commitment, command, and reconciliation authorities.

## Decision

- `IndustryDirector` extends its current lab-migration view with one exact active owned-storage ID.
  Exactly one active storage must be observed; an inactive, absent, duplicate, or terminal-only
  endpoint publishes no destination. Layout policy does not select an inventory endpoint.
- `ConstructionPlanner` extends only ADR 0050's quiescent path. A mineral target must be active,
  zero-cooldown, zero-energy, contain one exact positive non-energy resource of at most 3,000 units,
  and retain every RCL8, safety, assignment, cluster, and unrelated-lab-endpoint proof.
- The industry-published storage must have an exact 1,000,000-unit general-purpose Store, at most 64
  canonical resource rows, and enough aggregate free capacity for the complete amount.
- Layouts owner-local schema V12 adds a mineral variant to the one optional lab evacuation per room:
  source and post-removal replacement-lab IDs, destination storage ID, resource type, amount,
  destination resource baseline, start tick, and exclusive 150-tick expiry. V1–V11 migrate without
  invented mineral terms; V11 energy terms retain their existing representation and flow identity.
- On following ticks, matching quiescent industry evidence authorizes one externally funded
  `optional-growth` mineral flow through the sole `LogisticsPlanner`, V3 contract, lease, agent, and
  executor path. The obsolete lab's ordinary source and refill projections are suppressed. The
  storage sink uses its existing aggregate-capacity reservation key.
- Lost current authorization removes the persisted flow from same-tick agent execution. Mineral
  delivery is accepted only while the source type is unchanged, destination stock has not fallen
  below its baseline, and aggregate free capacity holds the remaining source amount.
- Removal requires fresh zero-energy/zero-mineral target evidence, destination stock at least the
  persisted baseline plus amount, retired exact flow and endpoints, the same industry-published
  destination, unchanged quiescence/assignment/post-removal cluster, and current colony safety. The
  existing sole removal arbiter, destroy executor, and three-attempt receipt remain unchanged.
- Energy contamination, mixed or malformed Store evidence, terminal-only capacity, destination
  loss/change/consumption, refill, insufficient capacity, active industry, unrelated lab work,
  timeout, cluster/layout drift, threat, controller risk, reserve/workforce loss, or CPU omission
  preserves both labs and authorizes no destroy command.

## Consequences

One mineral-only obsolete lab can converge without losing stock or contaminating the replacement
cluster. The path remains bounded by two migration rooms per tick, 64 persisted records, 64 storage
resource rows, one edge and two nodes per record, 128 removal candidates, and one global destroy
command. Persistent growth is one fixed record per room; no stock mirror, role map, queue, or
history is added.

Energy-plus-mineral targets, terminal destinations, active-work-preserving lab handoff, and multiple
labs remain separate. Rolling back to V11 preserves V12 bytes and fails closed; redeploying V12
resumes bounded evidence.

## Mechanics sources

Reviewed 2026-07-19:

- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 allows ten labs; each
  lab has independent 2,000 energy and 3,000 mineral capacities, holds one mineral type, and applies
  cooldown to reaction/unboost work.
- Official [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage): one RCL4+ owned
  storage provides 1,000,000 units of general-purpose capacity.
- Official [`Store`](https://docs.screeps.com/api/#Store): general-purpose stores accept any
  resource under shared aggregate capacity; resource-specific used and aggregate free capacity
  constrain admission.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled resource
  movement supplies the existing logistics execution boundary.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) and
  [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive): destruction is immediate
  with explicit results, and current RCL determines structure usability.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies RCL8 cluster,
  cooldown, emptying, and storage-drain terminology only. MYRMEX policy remains independently
  source-defined.
