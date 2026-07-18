# ADR 0035: Temporary road-removal authority

## Status

Accepted

## Context

A complete layout may place an unlocked tower on a tile currently occupied by a road. The existing
fail-closed layout diff correctly rejects the construction site, but without a removal path the
colony can never converge. General automated dismantling remains unsafe: stored, defensive,
critical, replacement-dependent, and path-critical structures require evacuation and build-before-
remove evidence that issue #99 still owns.

A road has no store and removing it does not make its terrain unwalkable. This permits one smaller
outcome without weakening the general migration gate.

## Decision

- `ConstructionPlanner` remains the sole build, repair, and migration-priority policy owner. Its
  bounded migration projection considers only a road that solely occupies a source-planned tower
  tile under the current complete layout commitment and emits one exact current authorization.
- Current visible ownership, safe developing/mature posture, legal workforce, no threat, no
  controller risk, restored protected spawn reserve, progression authorization, RCL allowance, and
  global/room construction-site headroom are mandatory. Any second structure or site on the tile
  blocks removal.
- `StructureRemovalArbiter` is the sole final authority for irreversible owned-structure removal. It
  accepts a proposal only with one exact colony, room, layout, observation, and policy
  authorization. More than 128 proposals or authorizations rejects the complete batch before
  traversal; otherwise canonical ordering admits at most one globally per tick. Current global and
  room construction-site headroom is a removal precondition; this narrow slice does not persist or
  reserve a following-tick site slot.
- Only `StructureDestroyExecutor` may call `Structure.destroy`. It revalidates the current layout
  fingerprint, currently owned room, absence of current hostile creeps, and exact target ID, type,
  room, and position before one call. `OK`, `ERR_NOT_OWNER`, `ERR_BUSY`, unexpected values, vanished
  targets, and adapter faults remain typed tick-local evidence.
- No migration state is persisted. `Structure.destroy` schedules immediate removal; the next fresh
  observation is the only success evidence. If the road remains, all safety inputs are recomputed
  before another authorization.
- The existing site diff, arbiter, executor, receipt reconciliation, and funded build path create
  and complete the tower after the observed road disappears.

## Consequences

One temporary road can no longer deadlock an otherwise valid layout. Reordered observations and heap
reconstruction produce byte-identical selection, and rollback simply removes this narrow path.

The slice intentionally does not authorize non-road removal, stocked-resource evacuation,
replacement-first migration, creep dismantling, defensive migration, or general layout revision
churn. Issue #99 remains open for those outcomes.

## Mechanics sources

- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling; documented results are `OK`, `ERR_NOT_OWNER`, and `ERR_BUSY` when
  hostile creeps are present.
- Official [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite): a replacement must
  exist as a site before creep build work can complete it.
- Official [Screeps documentation index](https://docs.screeps.com/).
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  community stamp/layout and access considerations informed terminology only.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/): structures originate as
  construction sites and are completed through creep build work.
