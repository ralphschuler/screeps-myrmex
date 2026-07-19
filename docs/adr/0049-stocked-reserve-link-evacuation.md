# ADR 0049: Stocked reserve-link evacuation

## Status

Accepted

## Context

ADR 0048 permits replacement-first removal of one empty idle external reserve link only after the
canonical current and ideal link-role projections preserve every source, hub, and controller anchor.
A stocked reserve target remains permanently external even when its exact committed reserve
replacement can hold the complete amount.

Native `StructureLink.transferEnergy` is not suitable for this migration proof: it loses 3% and
gives the sender a distance-based cooldown. The existing `LogisticsPlanner`, V3 contracts, lease
agents, link-role authority, removal arbiter/executor, and bounded destroy receipt already own every
required flow and irreversible command boundary.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. It may persist one reserve-link
  evacuation only after ADR 0048's RCL8 full-allowance, exact source/hub/controller continuity,
  reserve-only target/replacement, workforce, reserve, controller, site-headroom, and no-threat
  evidence passes.
- Both links must be active, zero-cooldown, exact 800-capacity energy-only Stores. The target must
  contain one exact positive energy amount, and the replacement must have capacity for the complete
  amount. An accepted native link transfer or unrelated active logistics endpoint blocks staging.
- The commitment contains source and replacement IDs, amount, replacement baseline, start, and
  exclusive 150-tick expiry. Layouts owner-local schema V9 adds at most one fixed-shape
  `linkEvacuation` per each of 64 records. V1-V8 migrate without invented terms; V8 link-removal
  receipts remain valid.
- On following ticks, the canonical link-role boundary first revalidates current ideal/external
  reserve continuity from fresh observation. Only that exact authorization may project one
  externally bound `optional-growth` budget, one energy edge, two nodes, and two endpoints into the
  sole `LogisticsPlanner`. Active evacuation IDs are excluded from native link-transfer proposals.
  Existing V3 creep contracts perform the only withdraw and transfer commands. If current
  authorization disappears, that active evacuation flow is removed from the agent execution view in
  the same Plan pass. Both physical targets are suppressed from competing ordinary refill
  projections.
- Removal requires fresh exact target emptiness, replacement energy equal to baseline plus amount,
  retirement of the exact flow and both endpoint contracts, unchanged reserve-only classification,
  zero cooldown, no accepted native link transfer, and current colony safety.
- The link removal intent carries the exact observed replacement energy. `StructureDestroyExecutor`
  revalidates target emptiness plus both exact active owned 800-capacity Stores, replacement energy,
  cooldowns, identities, room, commitment, and threat absence immediately before the sole
  `Structure.destroy` call.
- Existing one-global-command arbitration, identity-bound three-attempt backoff, and fresh
  disappearance settlement remain unchanged. Timeout, refill, capacity loss, cooldown, accepted
  transfer, role/layout/RCL drift, unavailable logistics evidence, or partial/lost delivery
  preserves the links and authorizes no destruction.

## Consequences

One stocked obsolete reserve link can converge without native link-transfer loss, discarded energy,
or a second logistics, link, removal, or persistence authority. Planning remains inside the existing
two-room and 128-candidate bounds. Each active evacuation adds at most one flow, two nodes, two
endpoints, one budget, and one fixed persistent record while moving at most 800 energy. An oversized
merged optional-demand batch is dropped before it can displace the already-bounded observed
logistics graph.

Exact replacement-gain evidence intentionally fails closed if other activity changes the replacement
Store. Rolling back to V8 preserves the V9 owner as future data and disables layout work.
Redeploying V9 resumes the bounded commitment.

## Mechanics sources

Reviewed 2026-07-19:

- Official [`StructureLink`](https://docs.screeps.com/api/#StructureLink): RCL8 permits six links;
  capacity is 800 energy; native transfer loses 3% and gives the sender distance-based cooldown.
- Official
  [`StructureLink.transferEnergy`](https://docs.screeps.com/api/#StructureLink.transferEnergy):
  same-room scheduled transfer with explicit ownership, stock, target, capacity, range, argument,
  cooldown, and RCL failures.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled Store
  movement with explicit resource and capacity failures.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate; `OK` reports scheduling; ownership and hostile-room failures are explicit.
- Official [Screeps documentation index](https://docs.screeps.com/).
- Screeps Wiki [`StructureLink`](https://wiki.screepspl.us/StructureLink/) supplies common link-role
  and flow terminology only.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) supplies creep-hauling terminology only.
  MYRMEX policy remains independently source-defined.
