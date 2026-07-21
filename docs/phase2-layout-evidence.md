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
service. Issue [#310](https://github.com/ralphschuler/screeps-myrmex/issues/310) gives every current
extension/container destroy path one bounded reset-safe receipt. Issue
[#312](https://github.com/ralphschuler/screeps-myrmex/issues/312) restores committed tower geometry
and reuses that receipt for one active empty obsolete tower only after an exact operational
replacement exists. Issue [#314](https://github.com/ralphschuler/screeps-myrmex/issues/314) adds one
exact funded energy-evacuation continuation for a stocked obsolete tower whose operational
replacement has complete capacity. Issue
[#316](https://github.com/ralphschuler/screeps-myrmex/issues/316) restores committed RCL8 link
geometry and removes one empty idle external reserve link only after canonical productive-role and
exact reserve-replacement continuity. Issue
[#318](https://github.com/ralphschuler/screeps-myrmex/issues/318) adds one funded creep-logistics
evacuation continuation for a stocked reserve link whose exact replacement has complete capacity.
Issue [#320](https://github.com/ralphschuler/screeps-myrmex/issues/320) restores committed RCL8 lab
geometry and removes one empty idle external lab only while industry and logistics are quiescent and
the remaining exact labs preserve a valid cluster. Issue
[#322](https://github.com/ralphschuler/screeps-myrmex/issues/322) adds one funded energy-only
quiescent-lab evacuation before that removal. Issue
[#324](https://github.com/ralphschuler/screeps-myrmex/issues/324) adds one funded single-kind
mineral evacuation to the exact active storage published by Industry. Issue
[#326](https://github.com/ralphschuler/screeps-myrmex/issues/326) composes both destinations for one
mixed energy/mineral target through an atomic two-flow projection. Issue
[#330](https://github.com/ralphschuler/screeps-myrmex/issues/330) durably hands one active reaction
to a role-identical nine-committed-lab assignment before empty external-lab removal. Issue
[#333](https://github.com/ralphschuler/screeps-myrmex/issues/333) reuses that exact handoff and the
existing energy evacuation for one stocked target while retained labs continue reaction work. Issue
[#335](https://github.com/ralphschuler/screeps-myrmex/issues/335) does the same for one mineral-only
target and the existing active-storage evacuation. Issue
[#337](https://github.com/ralphschuler/screeps-myrmex/issues/337) composes both existing evacuation
flows atomically for one active mixed target. Issue
[#341](https://github.com/ralphschuler/screeps-myrmex/issues/341) lets one existing explicit funded
boost commitment use the same role-identical handoff while preserving every objective and settled-
part term. Issue [#343](https://github.com/ralphschuler/screeps-myrmex/issues/343) permits one
quiescent mineral-only target to use an exact active idle terminal when no active storage exists and
suppresses internal sends while that destination remains committed. Issue
[#345](https://github.com/ralphschuler/screeps-myrmex/issues/345) reuses that exact V14 destination
for one durable `ready` reaction handoff while preserving storage precedence and every send,
delivery, work-retirement, and removal gate. Parent issue
[#99](https://github.com/ralphschuler/screeps-myrmex/issues/99) still owns other structure migration
and dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `industry.publish` first derives one current bounded lab assignment/quiescence view. Runtime also
   reconstructs at most 64 committed RCL8 lab position sets. Exactly nine active committed labs plus
   one empty, exact energy-only, exact zero-energy single-kind-mineral, or exact mixed external lab
   may produce one reaction or explicit funded boost handoff when current and post-removal reagent/
   product/boost IDs are byte-identical. The first rebound preserves all objective and settlement
   terms, emits no staging or lab intent, and reports `pending`; the same fingerprint in prior
   `IndustryOwnerV5` evidence makes a reaction ready, while a boost additionally requires one
   current executable intent or its matching pending attempt. A supplied boost manifest remains
   active until completion even when fail-closed current evidence suppresses its commitment. A
   durable rebound reports `blocked` without staging, intent, or removal while retained-lab staging
   or source-layout evidence is unavailable, and only when one leave-one-lab-out assignment uniquely
   reproduces its fingerprint and roles. While any state exists, `layout.plan` pins that exact
   durable source fingerprint and suppresses unrelated site proposals; an unavailable/mismatched
   record degrades instead of replanning. It otherwise plans at most two visible owned rooms and
   persists only complete commitments. A pure projection restores committed geometry for compatible
   external extensions, towers, links, and labs, allowing the ordinary diff/site chain to spend
   spare controller allowance without changing current world usability. Tower removal remains
   separate and requires full allowance of at least two, exactly allowance minus one active
   committed towers, one active empty unshared obsolete target, and an exact active committed
   replacement holding at least 10 energy. A stocked target may first persist one exact 150-tick
   energy evacuation only when that replacement can hold the full amount. The diff also follows
   current engine co-location: planned primary geometry may retain existing roads/ramparts, and
   planned road/rampart layers may share another buildable structure; current sites and incompatible
   primary occupancy still block. `ConstructionPlanner` may then project one active empty external
   extension after exact current replacement evidence, one compact stocked-extension evacuation
   commitment, one unselected source container with a different exact selected service for the same
   source, or one compact general-container handoff after exact committed replacement capacity
   exists. Before that migration policy, source-service selection gives one valid persisted position
   continuity precedence over newly observed exact containers and sites; current offload quality may
   degrade without moving static-mining terms. If the selected container is absent, one different
   exact legal/reachable replacement may advance its issuance coordinate only under fresh no-threat,
   no-controller-risk, legal-workforce, and restored-reserve evidence. Under the same safety
   evidence, a current exact selected container may advance only to a different exact candidate that
   strictly precedes it under the existing canonical ordering; worse/equal candidates cannot
   oscillate the selection, and every persisted position remains reserved to its own source across
   overlapping candidate sets. An empty redundant source target remains directly removable; a
   stocked one persists the same bounded handoff plus its source identity. An energy-only target
   persists its exact amount and the replacement's current energy. A target with one non-energy kind
   or two to eight kinds persists binary-ordered compact resource/amount/replacement-baseline
   tuples; energy as the only manifest row, malformed stock, or insufficient aggregate capacity
   fails closed.
4. `links.plan` publishes canonical current-layout role classification and funded transfer
   arbitration. Optional `migration.layout` then runs `ConstructionPlanner` for the same bounded
   two-room window and consumes that public current-tick result. Its stable system ID orders it
   after both `layout.plan` and `links.plan`. Reserve-link removal is RCL8-only: all six owned links
   must be active, exactly five must occupy committed positions, the missing ideal anchor, external
   target, and one exact replacement must all classify as `reserve`, and every source, hub, and
   controller anchor must remain exact. Target and replacement require exact 800-capacity energy-
   only Stores and zero cooldown; no accepted link transfer may name either ID. An empty target is
   directly eligible while a positive target may persist one exact evacuation only when the
   replacement can hold the complete amount and no unrelated V3 endpoint names either ID. Duplicate,
   stale, revision-mismatched, unclassified, malformed, cooling, shared, site-occupied, pressured,
   or incomplete evidence emits no proposal. Lab removal is RCL8-only: all ten owned labs must be
   observed, exactly nine active labs must occupy distinct committed positions, the external target
   must be active, zero-cooldown, unshared, and site-free, and the current industry view must have
   no commitment, pending attempt, intent, staging demand, or demand endpoint. No unrelated active
   logistics endpoint may name any room lab, and deterministic post-removal assignment over the nine
   exact labs must succeed. An empty target remains directly eligible. A positive energy-only target
   persists one 150-tick evacuation only when the canonical exact replacement has complete
   independent energy capacity. A zero-energy target containing one mineral kind may instead persist
   one evacuation when Industry publishes exactly one active owned storage and its exact
   1,000,000-unit general-purpose Store has complete aggregate capacity. If no active storage
   exists, the quiescent mineral-only form or one under an exact durable `ready` reaction handoff
   may use one exact active terminal with complete 300,000-unit capacity and no eligible internal
   send involving the room. A target holding both resources persists both exact destinations,
   amounts, and baselines in one bounded record only when both capacities are complete.
   Non-quiescent removal remains closed except for one exact `ready` reaction or boost handoff: the
   planner independently rederives both assignments, proves the external target has no role, rejects
   pending effects, rejects a current boost intent, rejects active target logistics, and reuses the
   existing reset-safe one-command removal path. A positive energy-only active target persists the
   same V13 amount/replacement-baseline record as the quiescent path. A zero-energy, single mineral
   kind target persists the existing V13 destination/resource/amount/baseline record after exact
   active-storage and aggregate-capacity validation, or reuses the V14 exact idle-terminal
   destination only when no active storage and no eligible internal send exist. A target holding
   both forms persists the existing V13 mixed record only when both destinations have complete
   capacity.
5. On the following tick, runtime composition validates each stocked commitment from fresh
   observation. A reserve-link commitment additionally reuses canonical ideal-link classification to
   prove every productive anchor remains exact and the target/replacement remain reserve capacity;
   its IDs are excluded from native transfer proposals. Lost authorization removes that flow's lease
   before same-tick agent planning. Authorized work requests one distinct `optional-growth`
   reservation per resource kind and injects exact source/replacement projections into
   `LogisticsPlanner`. Specialized sources replace the target's ordinary source nodes, all
   replacement sinks share one aggregate-capacity key, and ordinary refill sinks cannot compete.
   Tower and reserve-link evacuations contribute one energy flow and reserve the exact replacement's
   physical capacity once. A quiescent lab contributes one energy flow to its replacement lab, one
   mineral flow to the Industry-published storage or exact idle terminal, or both distinct
   storage-bound flows for a mixed target. Either general-purpose mineral sink shares its physical
   Store's aggregate-capacity key; the terminal form also suppresses every internal send from or to
   the room until the commitment clears. That terminal form may continue under active work only for
   the exact reaction handoff; boost and mixed terminal forms remain excluded. The obsolete lab
   source/refill is suppressed. A mixed record is validated and admitted as a complete pair before
   either flow is published. Lab work normally requires a current matching quiescent industry view.
   The only exceptions are the energy-only, mineral-only, and mixed records whose current Industry
   view exposes the exact durable `ready` active-commitment handoff, matching source layout and role
   arrays, and retained replacement. A pending post-handoff lab effect retains every applicable
   evacuation flow and suppression while still blocking removal. Lost destination continuity,
   baseline, handoff/quiescence, capacity, or graph admission excludes persisted work from same-tick
   agent execution. Existing V3 haul contracts and lease agents perform only the funded
   withdraw/transfer path.
6. An empty general-container handoff suppresses the obsolete target's ordinary refill and retires
   assigned/active V3 work that still names it. A stocked general or redundant-source handoff
   instead supplies one exact flow per resource and suppresses the target source plus both endpoint
   refill sinks. Removal waits for fresh empty-target, every delivered replacement gain, and retired
   exact-flow/endpoint evidence. A stocked tower uses the same fresh empty-target, baseline-plus-
   amount replacement gain, and retired exact-flow/endpoint gate while preserving at least 10 energy
   in the active committed replacement. A stocked reserve link additionally requires exact target
   emptiness, exact baseline-plus-amount replacement energy, retired flow/endpoints, unchanged
   reserve roles, zero cooldown, and no accepted native link transfer. An energy-only lab requires
   fresh zero energy/mineral, baseline-plus-amount replacement energy, retired flow/endpoints, and
   unchanged quiescence, assignment, post-removal cluster, and safety evidence. A mineral-only lab
   requires fresh emptiness, baseline-plus-amount storage or terminal stock, retired flow/endpoints,
   the same Industry-published destination plus quiescence or exact reaction-handoff evidence and
   cluster/safety evidence, and continued internal-send suppression for a terminal. A mixed lab
   requires both exact destination gains and both flow identities plus source, replacement-lab, and
   storage endpoints to retire. A durable active reaction or boost handoff permits an empty target
   directly, one exact energy-only evacuation, one exact mineral-only evacuation, or one exact mixed
   evacuation. The retained assignment remains executable while the funded creep flows drain the
   target; removal requires every applicable replacement-lab and storage-or-terminal gain, retired
   flow/endpoints, unchanged handoff/destination evidence, and no pending attempt. Exact
   next-observation reaction settlement may continue before target disappearance clears the ordinary
   destroy receipt. Unavailable contract views, capacity loss, consumption, refill, threat, timeout,
   drift, or a projection above 64 flows fail closed without a prefix. Public link-runtime
   arbitration uses source, hub, and controller roles only; neither reserve link can become a
   transfer endpoint in the removal tick. `StructureRemovalArbiter` then requires one exact current
   planner authorization and accepts at most one deterministic container, extension, tower, link, or
   lab removal after proving current global/room site headroom. The following observation re-enters
   ordinary site arbitration.
7. `layout.execute` alone resolves live rooms and targets. `ConstructionSiteExecutor` calls
   `Room.createConstructionSite`; `StructureDestroyExecutor` calls `Structure.destroy` after fresh
   ownership, threat, commitment, ID, type, room, and position checks. Extension removal also
   rechecks the target's empty owned Store and exact owned replacement in the room. Container
   removal rechecks the target's empty Store and exact active same-room semantic-service
   replacement; room control supplies destruction authority because containers are neutral. Tower
   removal rechecks an active empty owned target and the exact active owned same-room replacement's
   minimum 10 energy immediately before the call. Reserve-link removal rechecks both exact owned
   active same-room link identities, exact 800-capacity energy-only Stores, target emptiness, the
   intent-bound replacement energy, and zero cooldown immediately before the call. Lab removal
   rechecks exact 2,000-energy and 3,000-mineral empty capacity, null mineral type, zero cooldown,
   ownership/activity, and one exact active same-room lab.
8. On a selected-service switch only, `layout.handoff-reconcile` reconciles the complete layout
   draft and stages layouts-owner V14 before the root commit. The predecessor remains executable. On
   the following tick, StaticMiningPlanner consumes the durable coordinate; Reconcile atomically
   cancels the predecessor, creates/funds its exact next sequence, and leaves exactly one
   commitment.
9. Ordinary `layout.reconcile` converts site results and every extension/container/tower/link/lab
   destroy result to bounded fingerprinted receipts and stages `layouts`; on the handoff path it
   publishes the already-reconciled draft without a second write. The generic removal receipt binds
   exact target, replacement, type, attempt, code, and next eligibility. `OK`/`TARGET_ABSENT` waits
   for fresh disappearance; other results back off and stop after three attempts. A blocked room
   emits no proposal, so another room may use the unchanged global removal slot.
10. `state.reconcile` atomically commits layouts with the other staged owners. Fresh target absence
    clears the receipt and is the only proof of removal.
11. A following tick's `growth.contracts` turns each visible owned site into at most one funded
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
- at most 128 container/extension/tower/link/lab-removal candidates and authorizations; over-cap
  batches fail before traversal;
- one accepted removal globally per tick;
- layouts owner-local schema V14 migrates V1-V13 records, preserves V3's optional bounded source
  identity and V4's optional source-service issuance coordinate, moves a valid legacy nested receipt
  to the generic field, preserves V6 tower receipts, V7 tower evacuations, V8 link receipts, V9
  reserve-link evacuations, V10 lab receipts, V11 energy evacuations, V12 mineral evacuations, and
  V13 mixed terms, invents no terminal destination, and makes rollback to older code fail closed;
- reserve-link role proof stays within the existing 16-link classification cap and persists no role
  map, transfer receipt, or migration queue;
- at most one compact extension, tower, reserve-link, and lab stock evacuation, one compact
  container handoff, and one fixed-shape three-attempt destroy receipt per room across 64 records;
  retry matching adds no unbounded scan;
- container evacuation is capped by the official 2,000 capacity and either one legacy energy pair or
  one to eight compact resource tuples, with a one-row energy manifest forbidden; fresh replacement
  evidence is capped at 64 Store rows;
- at most 64 extension edges, 64 tower edges, 64 reserve-link edges, 64 total lab stock edges, and
  64 general-container resource edges, each with two nodes; a mixed lab may consume two lab edges,
  and mixed projection overflow rejects the complete migration graph before the common logistics
  caps, and any merged optional-demand overflow preserves the observed graph rather than displacing
  survival nodes;
- empty general-container handoffs add only bounded sink-suppression IDs;
- 150-tick exclusive evacuation and general-container handoff timeouts; lab energy is capped at the
  official 2,000 capacity, lab mineral at 3,000, storage at 1,000,000, terminal at 300,000, and
  exact general-purpose Store observations at 64 resource rows;
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
final desired site. Tower replacement-first convergence proves one operational adopted tower makes a
committed replacement site eligible under spare allowance. Its stocked continuation persists one
exact amount only when that active committed replacement begins with 10 energy and has complete
capacity; one externally funded acquire/deliver flow suppresses obsolete-target refill and reserves
replacement capacity. Quiescent lab convergence proves nine labs including one external target
produce one ordinary committed lab site; observing ten labs with nine exact committed positions,
matching idle industry evidence, no logistics endpoint, and a valid post-removal cluster admits one
destroy. Exact Store/cooldown checks, JSON reset/reordering, pending-success duplicate suppression,
observed disappearance, and final canonical site eligibility pass while active work and drift fail
closed. The energy-only lab continuation persists one exact amount/baseline, publishes one funded V3
flow only under current quiescence, and retains agent execution only while the current logistics
contract projection remains executable. One multi-tick outcome survives partial delivery plus JSON
reset/reordering, then proves fresh target emptiness, replacement gain, retired endpoints, one
command, pending-success duplicate suppression, observed disappearance, and final canonical lab-site
eligibility. The mineral-only continuation persists one exact storage destination, resource, amount,
and baseline under V12; Industry refuses inactive, duplicate, or terminal-only destinations. The V14
extension in [issue #343](https://github.com/ralphschuler/screeps-myrmex/issues/343) preserves
storage precedence but permits one quiescent terminal-only room to persist the exact active idle
terminal. One funded V3 mineral flow uses shared 300,000-unit aggregate capacity, and the Industry
send policy suppresses both source- and destination-room sends while that commitment exists. Partial
transfer plus JSON reset/reorder retains byte-equivalent terms; terminal contention,
activity/capacity/identity drift, or unauthorized active lab work blocks. Fresh target emptiness,
baseline-plus-amount terminal stock, retired endpoints, and unchanged destination admit one destroy.
Issue [#345](https://github.com/ralphschuler/screeps-myrmex/issues/345) extends that exact V14
record to one durable role-identical reaction handoff. The rebound remains command-free; the ready
handoff then publishes one funded flow through reset/reordered observation, retains it through a
pending post-handoff reaction effect, and waits for exact terminal gain plus complete work
retirement before one active-reaction destroy proposal. Storage appearance, send contention, boost
handoff, mixed stock, destination drift, threat, timeout, or malformed evidence fails closed. The
V13 mixed continuation persists both exact amounts, destinations, and baselines, atomically projects
two distinct funded flows, and survives independent partial delivery plus JSON reset/reordering.
Removal waits for both destination gains and complete flow/endpoint retirement; one active flow,
under-delivery, malformed/over-cap storage, consumption, destination drift, timeout, incompatible
active industry, or graph omission blocks removal. The active-reaction outcome preserves objective
identity, batch amount, and prior settled progress across one non-executable rebound tick, JSON
reset, and reordered labs/placements. It then executes only retained lab IDs, permits one empty
external-lab removal, and settles exact `-5/-5/+5` evidence after target loss. Its energy-only
continuation rebinds one exact stocked target, persists the existing V13 amount and baseline, admits
one funded flow during the durable ready handoff, and waits for exact delivery plus flow/endpoint
and pending-attempt retirement before one active-reaction removal proposal. The mineral-only
continuation reuses the same rebound plus V13 active-storage terms, aggregate-capacity flow, exact
storage gain, reset/reorder persistence, and removal gates. The mixed continuation persists the
existing V13 pair after the durable rebound, atomically projects both funded flows, preserves them
through partial delivery and a retained-assignment pending effect, and admits removal only after
both exact gains and complete work retirement. The boost continuation changes only the assignment
fingerprint of one explicit funded commitment, emits no command on the rebound tick, becomes ready
only from prior Industry owner plus executable intent evidence, executes the retained boost lab, and
settles exact body plus 30-mineral/20-energy evidence across reset and reordered labs. Partial exact
progress is applied once and remains resumable; conflicting body/resource deltas retain unchanged
commitment progress and active migration. The current boost intent and its kind matched pending
attempt both block removal, while missing or changed creep evidence keeps the unresolved funded
manifest nonquiescent. Generic active Industry, old assignment effects, malformed target stock,
destination/role/layout drift, retained lab staging, and missing/stale geometry are covered fail
closed; a uniquely reconstructible durable rebound remains byte stable and nonexecutable. A batch of
33 mixed records exceeds the 64-flow ceiling and publishes no prefix. Partial tower delivery
likewise preserves terms until fresh empty-target and replacement gain admit removal. Reserve-link
replacement-first convergence proves one ordinary committed site is built under spare allowance,
then complete canonical current/ideal role evidence retains all source, hub, and controller anchors
while naming only zero-cooldown reserve target/replacement IDs. Public link-runtime evidence keeps
both IDs out of native funded transfers. Fresh canonical continuity authorization gates every
following-tick projection, while oversized optional demand cannot displace observed logistics. The
stocked continuation persists one exact 300-energy commitment, projects one funded V3 creep flow,
preserves terms through partial delivery plus JSON reset/reordering, and blocks removal until exact
target emptiness, replacement gain, retired flow and endpoints, zero cooldown, and no accepted
native transfer. The executor revalidates exact delivered replacement energy; the V9 receipt
suppresses a duplicate after `OK`, and observed disappearance exposes the final committed site. The
container continuation proves one exact selected source service survives removal of one empty
unshared adjacent container, static-mining identity/work position remain unchanged, reordered/reset
input is byte-identical, unsafe or stocked variants fail closed, and next observation emits no
repeated removal. The general-container continuation proves spare-allowance site-first replacement,
persisted one-tick suppression, active-target retirement, unavailable-contract refusal,
source-adjacent-placement refusal, reset/reorder identity, one exact destroy call, preserved source
service, and one final committed site. Its stocked continuation proves paired exact energy/baseline
persistence and legacy empty-handoff parsing. The stocked redundant-source continuation proves
canonical energy and mixed manifests, source/selected-replacement validation, funded projection and
suppression, flow/endpoint retirement, delivery, unchanged static-mining identity/work position,
expiry-without-delivery blocking. Generic removal evidence proves empty and stocked source/general
containers plus extensions share exact identity binding, pending-success observation, capped
three-attempt backoff, reset/reorder equivalence, fresh drift clearing, and another room's progress
between eligibility ticks. The source-service continuity outcome proves that a better exact
alternate and selected-container loss preserve the prior legal tile, one byte-stable mining
contract, and dropped-energy fallback; malformed, ambiguous, conflicting, blocked, reordered, and
reconstructed prior inputs cannot override bounded legal selection. The selected-service handoff
outcome proves a vanished container plus exact replacement advances one coordinate only under
explicit safety. It also proves one strictly better existing exact candidate advances once, while a
worse candidate and the still-existing predecessor cannot cause oscillation, while overlapping
source candidates cannot steal another source's persisted exact service. Layouts V1-V3 migrate
without invented history, and one current-tick predecessor atomically becomes one funded/assigned
next-sequence commitment after reset/reorder without an idempotency or binding conflict. The
resource-manifest continuations prove canonical one-non-energy and two-kind persistence under
Store/structure reorder and JSON reconstruction, distinct funded resource flows sharing aggregate
replacement capacity, singleton-energy refusal, complete-projection overflow refusal,
active/incomplete removal blocking, every observed replacement gain, endpoint retirement, and one
exact destroy call. Existing mandatory runtime-tail and mature-build tests remain green.
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
- Official [`StructureTower`](https://docs.screeps.com/api/#StructureTower) defines the 1/2/3/6
  RCL3/5/7/8 allowances, 1,000 energy capacity, and 10-energy attack/heal/repair action cost.
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab) defines the 3/6/10 RCL6/7/8
  allowances, 50,000 build cost, 2,000 energy and 3,000 mineral capacities, range-two reaction
  geometry, and cooldown behavior; official
  [`StructureLab.runReaction`](https://docs.screeps.com/api/#StructureLab.runReaction) defines the
  scheduled five-unit command and source, target, range, cooldown, activation, and RCL failures.
- Official [`StructureLink`](https://docs.screeps.com/api/#StructureLink) defines the 2/3/4/6
  RCL5/6/7/8 allowances, 5,000 build cost, 800 energy capacity, 3% transfer loss, and distance-based
  sender cooldown;
  [`StructureLink.transferEnergy`](https://docs.screeps.com/api/#StructureLink.transferEnergy)
  defines same-room scheduled transfer and current failure codes.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive) defines the
  current controller-level activation check used at observation and immediately before removal.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest) requires source adjacency
  and drops harvest when no carry capacity is available.
- Official [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage) defines the one
  RCL4+ owned general-purpose store and its 1,000,000-unit capacity.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) defines the one
  RCL6+ owned terminal, its shared 300,000-unit Store, cooldown, and scheduled send boundary.
- Official [`Store`](https://docs.screeps.com/api/#Store) defines resource-specific stock and shared
  general-purpose used/free-capacity checks.
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
- Screeps Wiki [StructureTower](https://wiki.screepspl.us/StructureTower/) supplies tower placement,
  refill-access, and ten-energy action terminology only.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies two-input,
  range-two, cooldown, emptying, and refill terminology only.
- Screeps Wiki [`StructureLink`](https://wiki.screepspl.us/StructureLink/) supplies source, storage,
  controller, and balancing terminology only; MYRMEX role derivation remains source-defined.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/) confirms the community model that
  structures originate as construction sites and complete through creep build work.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) supplies hauling and extension-filling
  terminology only.
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) supplies stationary
  miner/source-container terminology only.
