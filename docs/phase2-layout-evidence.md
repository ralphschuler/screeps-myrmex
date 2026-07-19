# Phase 2 layout and construction-site evidence

Issue [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) establishes the complete
layout-to-construction authority chain. Issue
[#284](https://github.com/ralphschuler/screeps-myrmex/issues/284) adds one narrow temporary-road
removal path. Issue [#286](https://github.com/ralphschuler/screeps-myrmex/issues/286) adds one empty
extension-only replacement-first path. Issue
[#288](https://github.com/ralphschuler/screeps-myrmex/issues/288) adds one stocked-extension
energy-evacuation continuation. Issue
[#290](https://github.com/ralphschuler/screeps-myrmex/issues/290) adds one empty redundant
source-container removal while preserving the exact selected service. Issue
[#292](https://github.com/ralphschuler/screeps-myrmex/issues/292) adds one replacement-first empty
general-container handoff with logistics-target retirement. Issue
[#294](https://github.com/ralphschuler/screeps-myrmex/issues/294) extends it with one exact
energy-only evacuation. Issue [#296](https://github.com/ralphschuler/screeps-myrmex/issues/296)
extends the same handoff to a bounded mixed-resource manifest; parent issue #99 still owns other
structure migration, single non-energy stock, source-service switching, and dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `layout.plan` plans at most two visible owned rooms and persists only complete commitments. A
   pure projection restores committed geometry only for compatible external extensions, allowing the
   ordinary diff/site chain to spend spare extension allowance without changing current layout
   usability. `ConstructionPlanner` may then project the temporary-road case, one active empty
   external extension after exact current replacement evidence, one compact stocked-extension
   evacuation commitment, one empty unselected source container with a different exact selected
   service for the same source, or one compact general-container handoff after exact committed
   replacement capacity exists. An energy-only general target persists its exact amount and the
   replacement's current energy. A target with two to eight kinds persists binary-ordered compact
   resource/amount/replacement-baseline tuples; a single non-energy kind, malformed stock, or
   insufficient aggregate capacity fails closed.
4. On the following tick, runtime composition validates each stocked commitment from fresh
   observation, requests one distinct `optional-growth` reservation per resource kind, and injects
   exact source/replacement projections into `LogisticsPlanner`. Specialized sources replace the
   target's ordinary source nodes, all replacement sinks share one aggregate-capacity key, and
   ordinary refill sinks cannot compete. Existing V3 haul contracts and lease agents perform only
   the funded withdraw/transfer path.
5. An empty general-container handoff suppresses the obsolete target's ordinary refill and retires
   assigned/active V3 work that still names it. A stocked handoff instead supplies one exact flow
   per resource and suppresses the target source plus both endpoint refill sinks. Removal waits for
   fresh empty-target, every delivered replacement gain, and retired exact-flow/endpoint evidence.
   Unavailable contract views, capacity loss, refill, threat, timeout, drift, or a projection above
   64 flows fail closed without a prefix. `StructureRemovalArbiter` then requires one exact current
   planner authorization and accepts at most one deterministic road, container, or extension removal
   after proving current global/room site headroom. The following observation re-enters ordinary
   site arbitration.
6. `layout.execute` alone resolves live rooms and targets. `ConstructionSiteExecutor` calls
   `Room.createConstructionSite`; `StructureDestroyExecutor` calls `Structure.destroy` after fresh
   ownership, threat, commitment, ID, type, room, and position checks. Extension removal also
   rechecks the target's empty owned Store and exact owned replacement in the room. Container
   removal rechecks the target's empty Store and exact active same-room semantic-service
   replacement; room control supplies destruction authority because containers are neutral.
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
- at most 128 road/container/extension-removal candidates and authorizations; over-cap batches fail
  before traversal;
- one accepted removal globally per tick;
- layouts owner-local schema V2 migrates V1 empty/energy records and makes rollback fail closed;
- at most one compact extension evacuation and one compact general-container handoff per room across
  64 records;
- general-container evacuation is capped by the official 2,000 capacity and either one legacy energy
  pair or two to eight compact mixed-resource tuples; fresh replacement evidence is capped at 64
  Store rows;
- at most 64 extension edges and 64 general-container resource edges, each with two nodes; mixed
  projection overflow rejects the complete migration graph before the common logistics caps;
- empty general-container handoffs add only bounded sink-suppression IDs;
- 150-tick exclusive evacuation and general-container handoff timeouts;
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
replacement gain, and final one-command removal. The container continuation proves one exact
selected source service survives removal of one empty unshared adjacent container, static-mining
identity/work position remain unchanged, reordered/reset input is byte-identical, unsafe or stocked
variants fail closed, and next observation emits no repeated removal. The general-container
continuation proves spare-allowance site-first replacement, persisted one-tick suppression, active-
target retirement, unavailable-contract refusal, source-adjacent-placement refusal, reset/reorder
identity, one exact destroy call, preserved source service, and one final committed site. Its
stocked continuation proves paired exact energy/baseline persistence and legacy empty-handoff
parsing. The mixed continuation proves canonical two-kind persistence under Store/structure reorder
and JSON reconstruction, distinct funded resource flows sharing aggregate replacement capacity,
complete-projection overflow refusal, active/incomplete removal blocking, every observed replacement
gain, endpoint retirement, and one exact destroy call. Existing mandatory runtime-tail and mature-
build tests remain green. `npm run check` supplies repository-wide format, lint, type, test,
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
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer) defines the
  walkable 2,000-capacity, 5,000-build-cost structure, five-room allowance, and same-tile drop
  collection.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest) requires source adjacency
  and drops harvest when no carry capacity is available.
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
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) supplies stationary
  miner/source-container terminology only.
