# ADR 0016: Layout authority, cache, and construction-site boundary

Status: accepted

## Context

Phase 2 needs deterministic RCL2-RCL8 room plans without giving a planner live `Room` access,
duplicating ColonyDirector policy, persisting reconstructible placement arrays, or allowing optional
planning to issue irreversible commands. Existing/manual structures and the global construction-site
limit also require explicit adoption and later arbitration boundaries.

## Decision

- Add source-defined clean-room `owned-room-layout-v1` and the `phase2.layout` gate, dependent on
  `phase2.colony`; advance runtime config source revision to 19.
- Keep `WorldObserver` authoritative and add detached raw terrain, exits, mineral, all visible
  structures, owned/foreign construction sites, and authoritative global owned-site count.
- Add the distinct bounded `layouts` persistent owner and schema-4 migration. Persist no placements:
  only algorithm revision, anchor, transform, fingerprint, and bounded commitment/blocker metadata.
- Register `layout.compiled.v1` through `CacheManager`, with immutable algorithm, terrain, exact
  ColonyView policy, and normalized-facts dependency stamps.
- Bound planning to two rooms per tick, 256 anchors, eight transforms, and 2,500 flood cells per
  candidate. Existing owned spawn anchors precede canonical geometry candidates.
- Validate terrain/occupancy, resource and controller service access, spawn/logistics connectivity,
  critical existing access, and at least one exit. Primary, road, and rampart are distinct overlap
  layers. Exact and compatible manual structures are adopted deterministically; conflicts are
  bounded and no removal is proposed.
- Publish a plan only when complete. Exhaustion returns a stable blocker and retains the prior
  commitment.
- PR B adds a pure diff and makes `ConstructionSiteArbiter` the sole global/per-room site-slot
  authority. It reserves five slots below the official cap of 100, accepts at most two globally and
  one per room per tick, inspects 64 proposals per room, and pauses rooms at ten active sites.
- Existing/adopted structures and matching owned sites suppress proposals. Unknown/lost rooms,
  foreign or different occupancy, policy/RCL denial, over-allowance, and conflicted commitments fail
  closed. No decision authorizes dismantling.
- The schema-4 layouts owner stores up to 32 attempt receipts per room. Fingerprinted receipts make
  successful expectations and command failures reset-safe without creating retry storms; a new
  layout commitment invalidates them.
- Arbitration emits detached create-site intents only. PR C completes API execution through one
  narrow executor and mandatory receipt reconciliation before the existing atomic root commit.
- Runtime order is observe, colony publication, bounded plan/diff/arbitration, sole live-room
  execution, receipt reconciliation, then root commit. Optional planning may be skipped, but an
  accepted result cannot bypass the mandatory reconciliation tail.
- Existing survival growth consumes all observed owned layout sites and emits one deterministic
  funded build request per site without becoming a placement authority.

## Consequences

- Heap reset and reordered normalized facts reconstruct byte-equivalent commitments and placements.
- RCL counts derive from `ColonyView.rclPolicy.unlocks`, so LayoutPlanner cannot become a second RCL
  policy authority.
- The schema migration adds one empty owner at bounded constant cost. Placement volume consumes heap
  cache capacity, not persistent Memory.
- No code in this slice can call `createConstructionSite`, remove/destroy/dismantle, or retain a
  live `Room`.
- Reordered proposals, rooms, and receipts produce byte-identical decisions, and heap reset cannot
  erase retry suppression because receipts belong to the bounded persistent layout record.

## Sources consulted

- [Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [ConstructionSite](https://docs.screeps.com/api/#ConstructionSite)
- [Room.Terrain](https://docs.screeps.com/api/#Room.Terrain)
- [Control, last updated May 29 2026](https://docs.screeps.com/control.html)
- [Screeps Wiki: Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
