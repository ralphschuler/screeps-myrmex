# Phase 2 layout and construction-site evidence

Issue [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) establishes the complete
layout-to-construction authority chain. Issue
[#284](https://github.com/ralphschuler/screeps-myrmex/issues/284) adds one narrow temporary-road
removal path. Issue [#286](https://github.com/ralphschuler/screeps-myrmex/issues/286) adds one empty
extension-only replacement-first path. Issue
[#288](https://github.com/ralphschuler/screeps-myrmex/issues/288) adds one stocked-extension
energy-evacuation continuation; parent issue #99 still owns other structure migration, general stock
evacuation, and dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `layout.plan` plans at most two visible owned rooms and persists only complete commitments. A
   pure projection restores committed geometry only for compatible external extensions, allowing the
   ordinary diff/site chain to spend spare extension allowance without changing current layout
   usability. `ConstructionPlanner` may then project the temporary-road case, one active empty
   external extension after exact current replacement evidence, or one compact stocked-extension
   evacuation commitment.
4. On the following tick, runtime composition validates that commitment from fresh observation,
   requests one `optional-growth` reservation, and injects one exact source/replacement projection
   into `LogisticsPlanner`. Both ordinary refill sinks are suppressed during acquisition; the empty
   source remains suppressed through delivery. Existing V3 haul contracts and lease agents perform
   only the funded withdraw/transfer path.
5. `StructureRemovalArbiter` requires one exact current planner authorization and accepts at most
   one deterministic road or extension removal after proving current global/room site headroom. A
   stocked target additionally requires fresh empty-source, delivered-replacement, unexpired, and
   retired-flow evidence; the following observation re-enters ordinary site arbitration.
6. `layout.execute` alone resolves live rooms and targets. `ConstructionSiteExecutor` calls
   `Room.createConstructionSite`; `StructureDestroyExecutor` calls `Structure.destroy` after fresh
   ownership, threat, commitment, ID, type, room, and position checks. Extension removal also
   rechecks the target's empty owned Store and exact owned replacement in the room.
7. `layout.reconcile` converts site results to bounded fingerprinted receipts and stages `layouts`.
8. `state.reconcile` atomically commits layouts with the other staged owners. Removal adds no
   persistent state; only the following observation proves that the target disappeared.
9. A following tick's `growth.contracts` turns each visible owned site into at most one funded build
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
- at most 128 road/extension-removal candidates and authorizations; over-cap batches fail before
  traversal;
- one accepted removal globally per tick;
- at most one compact extension evacuation per room across 64 records;
- at most 64 evacuation edges and 128 nodes within existing logistics limits;
- 150-tick exclusive evacuation timeout;
- current global and room site headroom required before removal;
- `OK` expectation retry capped at 32 ticks, `ERR_FULL` at 100, and unexpected faults at 64.

## Outcome evidence

Focused tests cover one-call execution, next-tick duplicate suppression, every documented return
code, adapter isolation, stale/ownership/loss guards, cap pressure, complete/degraded commitments,
durable reset-safe receipts, and reorder equivalence. Composed outcomes prove both the exact
road-removed-to-tower-eligible path and extension site-first convergence: nine RCL3 extensions
produce one canonical desired site and no removal; observing the tenth desired extension authorizes
one empty obsolete target; stocked/shared targets remain; executor replacement/Store drift fails
closed; the next observation exposes only committed capacity and the final desired site. The stocked
continuation proves one exact persisted amount, reset/reorder identity, obsolete-target refill
suppression, externally funded acquire/deliver terms, active-flow removal blocking, observed
replacement gain, and final one-command removal. Existing mandatory runtime-tail and mature-build
tests remain green. `npm run check` supplies repository-wide format, lint, type, test,
documentation, bundle, and package evidence.

## Mechanics sources

- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite)
  documents return codes and the 100-site player cap.
- Official [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) defines the observed
  object consumed by build work.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) defines the narrow
  removal command and its `OK`, `ERR_NOT_OWNER`, and hostile-room `ERR_BUSY` results.
- Official [`StructureExtension`](https://docs.screeps.com/api/#StructureExtension) defines spawn
  energy storage, the 3,000 build-energy cost, and RCL extension counts/capacities.
- Official [`Store`](https://docs.screeps.com/api/#Store) defines the current used/free-capacity
  checks.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer) define the existing scheduled
  acquire/deliver command boundary used by evacuation.
- Official [Control guide](https://docs.screeps.com/control.html) constrains RCL structure access.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  provides community extension-layout/reachability context only; MYRMEX remains clean-room and
  source-defined.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/) confirms the community model that
  structures originate as construction sites and complete through creep build work.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) supplies hauling and extension-filling
  terminology only.
