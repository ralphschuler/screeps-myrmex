# Phase 2 layout and construction-site evidence

Issue [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) establishes the complete
layout-to-construction authority chain. Issue
[#284](https://github.com/ralphschuler/screeps-myrmex/issues/284) adds one narrow temporary-road
removal path; parent issue #99 still owns general layout migration and dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `layout.plan` plans at most two visible owned rooms, persists only complete commitments, diffs
   against the same snapshot, invokes pure site arbitration, and lets `ConstructionPlanner` project
   only a road that solely blocks a planned tower.
4. `StructureRemovalArbiter` requires one exact current planner authorization and accepts at most
   one deterministic road removal after proving current global/room site headroom; the following
   observation re-enters ordinary site arbitration.
5. `layout.execute` alone resolves live rooms and targets. `ConstructionSiteExecutor` calls
   `Room.createConstructionSite`; `StructureDestroyExecutor` calls `Structure.destroy` after fresh
   ownership, threat, commitment, ID, type, room, and position checks.
6. `layout.reconcile` converts site results to bounded fingerprinted receipts and stages `layouts`.
7. `state.reconcile` atomically commits layouts with the other staged owners. Removal adds no
   persistent state; only the following observation proves that the road disappeared.
8. A following tick's `growth.contracts` turns each visible owned site into at most one funded build
   contract under existing controller, maintenance, recovery, and reserve precedence.

Planning is optional and fails closed under CPU pressure. Execution and receipt reconciliation are
mandatory tails. Unknown/lost rooms, disabled or blocked gates, denied progression, stale
fingerprints, occupancy conflicts, and global or room pressure authorize no command.

## Fixed bounds

- two planned rooms per tick;
- 256 anchors, eight transforms, and 2,500 flood cells per candidate;
- official site cap 100 with five reserved slots;
- two accepted globally and one per room per tick;
- 64 inspected proposals and ten active sites per room;
- 32 receipts per room;
- at most 128 road-removal candidates and authorizations; over-cap batches fail before traversal;
- one accepted removal globally per tick;
- current global and room site headroom required before removal;
- `OK` expectation retry capped at 32 ticks, `ERR_FULL` at 100, and unexpected faults at 64.

## Outcome evidence

Focused tests cover one-call execution, next-tick duplicate suppression, every documented return
code, adapter isolation, stale/ownership/loss guards, cap pressure, complete/degraded commitments,
durable reset-safe receipts, reorder equivalence, general dismantling exclusion, exact road-only
removal, fresh executor guards, documented destroy results, road-removed-to-tower-eligible
composition, mandatory runtime tails, and mature-structure build publication. `npm run check`
supplies repository-wide format, lint, type, test, documentation, bundle, and package evidence.

## Mechanics sources

- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite)
  documents return codes and the 100-site player cap.
- Official [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) defines the observed
  object consumed by build work.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) defines the narrow
  removal command and its `OK`, `ERR_NOT_OWNER`, and hostile-room `ERR_BUSY` results.
- Official [Control guide](https://docs.screeps.com/control.html) constrains RCL structure access.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  provides community operational context only; MYRMEX remains clean-room and source-defined.
