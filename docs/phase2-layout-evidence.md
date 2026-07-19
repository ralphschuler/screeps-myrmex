# Phase 2 layout and construction-site evidence

Issue [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) establishes the complete
layout-to-construction authority chain. Issue
[#308](https://github.com/ralphschuler/screeps-myrmex/issues/308) supersedes #284's temporary-road
removal after current engine verification and routes compatible layered geometry through the
ordinary construction-site chain. Issue
[#286](https://github.com/ralphschuler/screeps-myrmex/issues/286) adds one empty extension-only
replacement-first path. Issue [#288](https://github.com/ralphschuler/screeps-myrmex/issues/288) adds
one stocked-extension energy-evacuation continuation. Issue
[#290](https://github.com/ralphschuler/screeps-myrmex/issues/290) adds one empty redundant
source-container removal while preserving the exact selected service. Issue
[#292](https://github.com/ralphschuler/screeps-myrmex/issues/292) adds one replacement-first empty
general-container handoff with logistics-target retirement. Issue
[#294](https://github.com/ralphschuler/screeps-myrmex/issues/294) extends it with one exact
energy-only evacuation. Issue [#296](https://github.com/ralphschuler/screeps-myrmex/issues/296)
extends the same handoff to a bounded mixed-resource manifest. Issue
[#298](https://github.com/ralphschuler/screeps-myrmex/issues/298) admits exactly one non-energy
manifest row. Issue [#300](https://github.com/ralphschuler/screeps-myrmex/issues/300) reuses that
bounded evacuation for one stocked, unselected redundant source-adjacent container. Issue
[#302](https://github.com/ralphschuler/screeps-myrmex/issues/302) pins a persisted legal/reachable
source-service position until an explicit handoff exists. Issue
[#304](https://github.com/ralphschuler/screeps-myrmex/issues/304) advances one lost selected service
to one exact replacement. Issue [#306](https://github.com/ralphschuler/screeps-myrmex/issues/306)
reuses that handoff when a different existing exact container strictly outranks the selected exact
service. Parent issue #99 still owns other structure migration and dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `layout.plan` plans at most two visible owned rooms and persists only complete commitments. A
   pure projection restores committed geometry only for compatible external extensions, allowing the
   ordinary diff/site chain to spend spare extension allowance without changing current layout
   usability. The diff also follows current engine co-location: planned primary geometry may retain
   existing roads/ramparts, and planned road/rampart layers may share another buildable structure;
   current sites and incompatible primary occupancy still block. `ConstructionPlanner` may then
   project one active empty external extension after exact current replacement evidence, one compact
   stocked-extension evacuation commitment, one unselected source container with a different exact
   selected service for the same source, or one compact general-container handoff after exact
   committed replacement capacity exists. Before that migration policy, source-service selection
   gives one valid persisted position continuity precedence over newly observed exact containers and
   sites; current offload quality may degrade without moving static-mining terms. If the selected
   container is absent, one different exact legal/reachable replacement may advance its issuance
   coordinate only under fresh no-threat, no-controller-risk, legal-workforce, and restored-reserve
   evidence. Under the same safety evidence, a current exact selected container may advance only to
   a different exact candidate that strictly precedes it under the existing canonical ordering;
   worse/equal candidates cannot oscillate the selection, and every persisted position remains
   reserved to its own source across overlapping candidate sets. An empty redundant source target
   remains directly removable; a stocked one persists the same bounded handoff plus its source
   identity. An energy-only target persists its exact amount and the replacement's current energy. A
   target with one non-energy kind or two to eight kinds persists binary-ordered compact
   resource/amount/replacement-baseline tuples; energy as the only manifest row, malformed stock, or
   insufficient aggregate capacity fails closed.
4. On the following tick, runtime composition validates each stocked commitment from fresh
   observation, requests one distinct `optional-growth` reservation per resource kind, and injects
   exact source/replacement projections into `LogisticsPlanner`. Specialized sources replace the
   target's ordinary source nodes, all replacement sinks share one aggregate-capacity key, and
   ordinary refill sinks cannot compete. Existing V3 haul contracts and lease agents perform only
   the funded withdraw/transfer path.
5. An empty general-container handoff suppresses the obsolete target's ordinary refill and retires
   assigned/active V3 work that still names it. A stocked general or redundant-source handoff
   instead supplies one exact flow per resource and suppresses the target source plus both endpoint
   refill sinks. Removal waits for fresh empty-target, every delivered replacement gain, and retired
   exact-flow/endpoint evidence. Unavailable contract views, capacity loss, refill, threat, timeout,
   drift, or a projection above 64 flows fail closed without a prefix. `StructureRemovalArbiter`
   then requires one exact current planner authorization and accepts at most one deterministic
   container or extension removal after proving current global/room site headroom. The following
   observation re-enters ordinary site arbitration.
6. `layout.execute` alone resolves live rooms and targets. `ConstructionSiteExecutor` calls
   `Room.createConstructionSite`; `StructureDestroyExecutor` calls `Structure.destroy` after fresh
   ownership, threat, commitment, ID, type, room, and position checks. Extension removal also
   rechecks the target's empty owned Store and exact owned replacement in the room. Container
   removal rechecks the target's empty Store and exact active same-room semantic-service
   replacement; room control supplies destruction authority because containers are neutral.
7. On a selected-service switch only, `layout.handoff-reconcile` reconciles the complete layout
   draft and stages layouts-owner V4 before the root commit. The predecessor remains executable. On
   the following tick, StaticMiningPlanner consumes the durable coordinate; Reconcile atomically
   cancels the predecessor, creates/funds its exact next sequence, and leaves exactly one
   commitment.
8. Ordinary `layout.reconcile` converts site results to bounded fingerprinted receipts and stages
   `layouts`; on the handoff path it publishes the already-reconciled draft without a second write.
9. `state.reconcile` atomically commits layouts with the other staged owners. Ordinary removals add
   no persistent state. A stocked redundant-source removal retains one compact result receipt in its
   existing handoff for bounded backoff; only following observation proves that the target
   disappeared.
10. A following tick's `growth.contracts` turns each visible owned site into at most one funded
    build contract under existing controller, maintenance, recovery, and reserve precedence.

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
- at most 128 container/extension-removal candidates and authorizations; over-cap batches fail
  before traversal;
- one accepted removal globally per tick;
- layouts owner-local schema V4 migrates V1-V3 records, preserves V3's optional bounded source
  identity, adds one optional safe-integer source-service issuance coordinate, and makes rollback to
  older code fail closed;
- at most one compact extension evacuation and one compact container handoff per room across 64
  records; a source-specific handoff retains at most one three-attempt destroy receipt with capped
  exponential backoff;
- container evacuation is capped by the official 2,000 capacity and either one legacy energy pair or
  one to eight compact resource tuples, with a one-row energy manifest forbidden; fresh replacement
  evidence is capped at 64 Store rows;
- at most 64 extension edges and 64 general-container resource edges, each with two nodes; mixed
  projection overflow rejects the complete migration graph before the common logistics caps;
- empty general-container handoffs add only bounded sink-suppression IDs;
- 150-tick exclusive evacuation and general-container handoff timeouts;
- current global and room site headroom required before removal;
- `OK` expectation retry capped at 32 ticks, `ERR_FULL` at 100, and unexpected faults at 64.

## Outcome evidence

Focused tests cover one-call execution, next-tick duplicate suppression, every documented return
code, adapter isolation, stale/ownership/loss guards, cap pressure, complete/degraded commitments,
durable reset-safe receipts, and reorder equivalence. The compatible-layering outcome proves a
planned tower site is created directly over an existing road, no road-removal proposal or intent is
available, the road remains after the tower is observed, and canonical ramparts can be proposed over
protected structures under reset/reorder equivalence. Extension site-first convergence proves nine
RCL3 extensions produce one canonical desired site and no removal; observing the tenth desired
extension authorizes one empty obsolete target; stocked/shared targets remain; executor
replacement/Store drift fails closed; the next observation exposes only committed capacity and the
final desired site. The stocked continuation proves one exact persisted amount, reset/reorder
identity, obsolete-target refill suppression, externally funded acquire/deliver terms, active-flow
removal blocking, observed replacement gain, and final one-command removal. The container
continuation proves one exact selected source service survives removal of one empty unshared
adjacent container, static-mining identity/work position remain unchanged, reordered/reset input is
byte-identical, unsafe or stocked variants fail closed, and next observation emits no repeated
removal. The general-container continuation proves spare-allowance site-first replacement, persisted
one-tick suppression, active-target retirement, unavailable-contract refusal,
source-adjacent-placement refusal, reset/reorder identity, one exact destroy call, preserved source
service, and one final committed site. Its stocked continuation proves paired exact energy/baseline
persistence and legacy empty-handoff parsing. The stocked redundant-source continuation proves
canonical energy and mixed manifests, source/selected-replacement validation, funded projection and
suppression, flow/endpoint retirement, delivery, unchanged static-mining identity/work position,
expiry-without-delivery blocking, and three-attempt destroy backoff. The source-service continuity
outcome proves that a better exact alternate and selected-container loss preserve the prior legal
tile, one byte-stable mining contract, and dropped-energy fallback; malformed, ambiguous,
conflicting, blocked, reordered, and reconstructed prior inputs cannot override bounded legal
selection. The selected-service handoff outcome proves a vanished container plus exact replacement
advances one coordinate only under explicit safety. It also proves one strictly better existing
exact candidate advances once, while a worse candidate and the still-existing predecessor cannot
cause oscillation, while overlapping source candidates cannot steal another source's persisted exact
service. Layouts V1-V3 migrate without invented history, and one current-tick predecessor atomically
becomes one funded/assigned next-sequence commitment after reset/reorder without an idempotency or
binding conflict. The resource-manifest continuations prove canonical one-non-energy and two-kind
persistence under Store/structure reorder and JSON reconstruction, distinct funded resource flows
sharing aggregate replacement capacity, singleton-energy refusal, complete-projection overflow
refusal, active/incomplete removal blocking, every observed replacement gain, endpoint retirement,
and one exact destroy call. Existing mandatory runtime-tail and mature-build tests remain green.
`npm run check` supplies repository-wide format, lint, type, test, documentation, bundle, and
package evidence.

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
- Screeps engine 4.3.2
  [`checkConstructionSite`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/utils.js#L128-L189),
  [`Creep.build` processing](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/creeps/build.js),
  and current common
  [`OBSTACLE_OBJECT_TYPES`](https://github.com/screeps/common/blob/2fb779b26eef9b4b0f412584f6bd47c897949766/lib/constants.js#L85)
  prove road/rampart co-location without a preceding destroy command.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  provides community extension-layout/reachability context only; MYRMEX remains clean-room and
  source-defined.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/) confirms the community model that
  structures originate as construction sites and complete through creep build work.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) supplies hauling and extension-filling
  terminology only.
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) supplies stationary
  miner/source-container terminology only.
