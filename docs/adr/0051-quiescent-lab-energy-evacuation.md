# ADR 0051: Quiescent obsolete-lab energy evacuation

## Status

Accepted

## Context

ADR 0050 permits one empty external lab to leave an RCL8 layout only while the industry-owned lab
view is quiescent and nine exact committed labs retain a valid cluster. An otherwise eligible lab
containing energy cannot use that path. Destroying it would waste up to 2,000 energy, while
retaining it indefinitely prevents committed geometry from converging.

The layouts owner, `ConstructionPlanner`, `LogisticsPlanner`, V3 leases and agents,
structure-removal arbiter/executor, and reset-safe removal receipt already own the required
commitment, resource, command, and reconciliation boundaries.

## Decision

- `ConstructionPlanner` extends only ADR 0050's quiescent lab path. A positive target must contain
  exact energy only, have null mineral type and zero mineral amount, remain active at zero cooldown,
  and retain every RCL8, safety, assignment, post-removal-cluster, and unrelated-endpoint proof.
- The canonical post-removal cluster's first member remains the exact replacement identity. Its
  independent lab-energy capacity must hold the complete target amount.
- Layouts owner-local schema V11 adds one optional fixed-shape lab evacuation per room: source and
  replacement IDs, amount, replacement energy baseline, start tick, and exclusive 150-tick expiry.
  V1–V10 migrate without invented evacuation evidence; older code preserves V11 as future data and
  authorizes no layout work.
- On following ticks, current matching quiescent industry evidence authorizes one externally funded
  `optional-growth` energy flow through the sole `LogisticsPlanner`, V3 contract, lease, agent, and
  executor path. The specialized projection suppresses both labs' ordinary sources and refill sinks
  so observed stock and replacement capacity are reserved once.
- If current quiescence or graph admission is lost, runtime excludes the persisted evacuation flow
  from agent execution in the same tick. No layout-owned creep command or second logistics authority
  is introduced.
- Removal requires fresh zero-energy/zero-mineral target evidence, replacement energy at least the
  persisted baseline plus amount, retired exact flow and endpoints, current quiescence, unchanged
  assignment and valid post-removal cluster, and current colony safety. The existing sole removal
  arbiter, destroy executor, and three-attempt receipt remain unchanged.
- Mineral stock, malformed Store evidence, refill or consumption drift, insufficient capacity,
  active industry, unrelated logistics work, timeout, cluster/replacement/layout drift, threat,
  controller risk, reserve/workforce loss, or CPU omission preserves both labs and authorizes no
  destroy command.

## Consequences

One energy-only obsolete lab can converge without energy loss or interruption of reaction, reverse,
boost, staging, or pending-settlement work. The flow remains bounded by 64 layout records, one edge
and two nodes per record, the existing two-room migration window, 128 removal candidates, and one
global destroy command. Persistent growth is one fixed record per room; no stock mirror, role map,
queue, or history is added.

Mineral evacuation and active-work-preserving lab handoff remain separate because they require
mineral destination/contamination policy or stable commitment reassignment. Rolling back to V10
preserves V11 bytes and fails closed; redeploying V11 resumes bounded evidence.

## Mechanics sources

Reviewed 2026-07-19:

- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): labs have independent 2,000
  energy and 3,000 mineral capacities, RCL8 allows ten, and reaction behavior is cooldown-bound.
- Official [`Store`](https://docs.screeps.com/api/#Store): resource-specific used and free capacity
  constrain exact admission.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled resource
  movement supplies the existing logistics execution boundary.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate and returns explicit ownership and hostile-room failures.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive): current RCL
  determines structure usability.
- Official [Screeps documentation index](https://docs.screeps.com/).
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) and
  [`Energy`](https://wiki.screepspl.us/Energy/) supply operational terminology only. MYRMEX policy
  remains independently source-defined.
