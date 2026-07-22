# Strategy

MYRMEX is a hard target with disciplined expansion. It does not attack everyone; it makes hostile
behavior predictably unprofitable and uses force when the strategic return exceeds the complete
cost.

## Strategic Objective

Maximize durable control and productive capacity under CPU, GCL, spawn, energy, mineral, and
diplomatic constraints.

The bot should compound this loop:

1. stabilize each colony;
2. maximize source utilization and logistics efficiency;
3. operate only profitable remotes;
4. build defense depth and regional intelligence;
5. claim defensible rooms that improve the empire graph;
6. deny adversaries profitable pressure points;
7. project force with budgeted operations and explicit exit conditions.

## Diplomacy

Players occupy one of seven states: self, ally, non-aggression pact, neutral, trespasser, hostile,
or war. Reputation is based on observed events with decay and confidence.

Escalation is predictable: observe, warn, block, evict, deny remotes, retaliate, then wage war.
Configured self, allies, and non-aggression-pact players are authoritative exclusions and are never
targetable. This check occurs before optional reputation, so empty, stale, malformed,
future-assessed, or contradictory reputation cannot weaken it. Invalid observed identities also fail
closed to exclusion.

During Phase 1, a valid unconfigured identity has at most a `local-defense` targeting ceiling.
`local-defense` is not permission to attack: a defense authority must additionally prove a fresh
threat in an owned room. Irreversible offense remains forbidden until a later authorized operation.
Optional reputation may reduce a ceiling but cannot raise it. The engine's hostile collections mean
“not owned,” not “diplomatically authorized,” and area-effect actions must preserve configured
exclusions.

## Economy

Phase 2 uses a read-only complete-colony policy projection. RCL2-RCL7 progression requires stable
checks for threat, recovery, bootstrap, constrained CPU, controller risk, protected reserve, and
complete spawn-pool capacity. Unknown vision authorizes nothing. RCL8 cannot claim maturity from
level alone: it requires current canonical layout, source, logistics, link, maintenance, resource,
lab, and mature-industry health. Missing or stale direct evidence returns an established mature room
to recovery while an incomplete room remains developing; telemetry never authorizes that transition.
Recovery may rebuild committed owned sites through the existing layout, budget, contract, and
executor chain, but it cannot reopen controller upgrading or unrelated optional growth.

A complete production layout requires one distinct semantic service on a legal adjacent work tile
for every observed owned source and proves that each tile is reachable from the planned
spawn-connected flood. Static terrain, Source objects, private foreign ramparts, or current/future
nonwalkable structures that leave no legal tile fail before candidate search; no planned layer may
overlap a Source, and geometry that disconnects a source or incomplete service assignment rejects
that candidate. If compatible adoption relocates the spawn, the committed origin must pass the same
bounded reachability proof. Degraded planning preserves an eligible prior commitment and emits no
placements, so migration cannot authorize sites or removal from stranded geometry. Executable local
movement uses the same current rampart passability rule: a private foreign rampart blocks the static
path matrix, while an owned or public rampart remains walkable. A blocked lease suspends with no
movement intent instead of repeatedly approaching an impassable tile. When changed public state
changes effective tile passability, it receives a different reconstructible traversal revision. This
still does not prove dynamic congestion, deadlock recovery, room routing, or broad layout-wide
traffic access.

Layout convergence is destructive only under explicit narrow authority. Current engine-compatible
roads and ramparts use the ordinary construction-site chain: a planned primary structure can retain
a co-located road/rampart, and planned road/rampart layers can cover another buildable structure.
Any current site or incompatible primary occupancy remains blocked, and no road is destroyed merely
to build planned geometry. Phase 2 may use spare extension allowance to build committed capacity,
then remove one active obsolete extension only after the room reaches full allowance with exactly
allowance minus one active extensions on committed geometry and an exact owned replacement remains.
A stocked target first persists one bounded evacuation, reserves exact source/replacement capacity
in the sole logistics graph, and suppresses ordinary refill of both targets during acquisition.
Empty-source suppression continues through delivery. Removal waits for fresh empty-source,
delivered-replacement, and retired-flow evidence. Current site headroom is required; the executor
rechecks target stock and replacement identity; only fresh observation proves removal. Stored
structures other than this one extension, defensive, critical, foreign, unknown, and multiply
occupied structures remain excluded. General migration remains fail-closed. One source-container
exception removes an unshared, unselected container beside exactly one source only while a different
exact committed source-container remains the selected reachable service for that source. An empty
target is directly eligible; a stocked target persists one bounded source-specific handoff and
reuses the exact resource-manifest logistics path before removal. The stationary mining identity and
work position do not change; selected, sole, ambiguous, or replacementless containers remain. A
separate general-container exception first spends spare allowance on committed non-service capacity,
then persists one bounded target handoff. An empty target suppresses refill and waits for every
active logistics endpoint naming it to retire. An exact energy-only target whose amount fits the
replacement additionally uses the sole funded logistics flow. A target containing one non-energy
kind or two to eight resource kinds instead persists one compact binary-ordered manifest and uses
one distinct funded flow per kind; energy as the only manifest row remains invalid so its legacy
identity cannot be duplicated. Both stocked paths suppress the target source and both refill sinks,
and require fresh empty-target, every delivered replacement gain, and retired flow/endpoint evidence
before removal. Canonical general positions adjacent to a source, over-eight-kind or malformed
stock, selected source-service targets, capacity loss, and unavailable contract evidence fail
closed. Other stocked structures and rooms without exact replacement evidence remain untouched.
Every authorized extension/container/tower/link destroy result persists one exact per-room receipt:
success waits for fresh target disappearance, failures back off and stop after three attempts, and a
blocked room leaves the global removal slot available to another eligible room. Tower convergence
first uses spare allowance to build committed geometry. An active empty obsolete tower may be
removed only at full allowance of at least two, with exactly allowance minus one active committed
towers and one exact active committed replacement retaining at least the 10 energy required for an
immediate defense action. A stocked target first persists one exact 150-tick evacuation only when
that replacement can hold all target energy. The sole logistics authority moves it under funded
optional growth; target refill is suppressed, replacement capacity is reserved once, and removal
waits for fresh empty-target, delivered-replacement, and retired-flow/endpoint evidence. A sole,
over-capacity, inactive, underfunded, threatened, or pressured tower remains. At RCL8, link
convergence similarly spends spare allowance through the ordinary build chain. It may remove only
one active external reserve link after canonical current/ideal role evidence proves all source, hub,
and controller anchors remain exact and active, the missing anchor plus target and exact replacement
are reserve capacity, both links have exact 800-capacity energy-only stores at zero cooldown, and no
accepted native link transfer names either. An empty target is directly removable. A stocked target
first persists one bounded exact evacuation only when the replacement can hold all energy; the sole
funded creep-logistics path moves it without native link-transfer loss. Removal then requires exact
target emptiness, baseline-plus-amount replacement energy, retired flow/endpoints, unchanged reserve
roles, and zero cooldown. Cooling, malformed, productive-role, incomplete, or pressured links
remain. RCL8 lab convergence also spends spare allowance through the ordinary build chain. One
active empty zero-cooldown external lab may be removed only when nine active labs already occupy
distinct committed positions, the current industry projection has no commitment, pending attempt,
intent, or staging demand, no unrelated logistics endpoint names any room lab, and those nine exact
labs still form a valid reaction cluster. An otherwise eligible energy-only target first persists
one 150-tick evacuation when the canonical exact replacement has complete independent energy
capacity. The sole funded creep-logistics path suppresses both labs' ordinary source/refill
publication; removal waits for fresh target emptiness, baseline-plus-amount replacement energy,
retired flow/endpoints, and unchanged quiescence, cluster, and safety evidence. A zero-energy target
holding one mineral kind may instead use the exact active owned storage published by the industry
view when its general-purpose Store has complete aggregate capacity. If no active storage exists, a
quiescent mineral-only target or one under an exact durable `ready` reaction or boost handoff may
use one exact active idle terminal with complete 300,000-unit aggregate capacity. Industry
suppresses every internal send from or to that room while the V14 terminal commitment exists. One
funded mineral flow suppresses the obsolete lab's ordinary source/refill publication; removal waits
for fresh lab emptiness, baseline-plus-amount destination stock, retired work, and unchanged
destination, quiescence or handoff, cluster, and safety evidence. A current boost intent or matching
pending effect allows evacuation to continue but blocks removal. While quiescent, a target holding
both energy and one mineral kind may use that same terminal for mineral while energy still moves to
the retained lab. Both flows are admitted as an atomic pair, and removal waits for both destination
gains plus complete work retirement. Exact durable reaction and explicit-boost handoffs may reuse
that mixed terminal pair. One active reaction may continue only when the external target has no
current or post-removal role, the retained nine labs keep byte-identical reagent/product/boost IDs,
and Industry durably advances only the assignment fingerprint before any reaction, migration, or
destroy command. An empty target proceeds directly. A positive energy-only target first reuses the
existing V13 evacuation: one funded optional-growth creep flow moves the exact amount to the
canonical retained lab while reaction work continues, and removal waits for fresh target emptiness,
baseline-plus-amount replacement energy, retired flow/endpoints, unchanged handoff evidence, and no
pending reaction attempt. A zero-energy target holding one mineral kind instead reuses the V13
mineral evacuation and exact active storage. Only when no active storage exists, the same reaction
or boost handoff may reuse the V14 exact idle-terminal destination under current no-send evidence.
One funded flow moves the complete amount under aggregate capacity, and removal waits for the exact
destination gain, retired flow/endpoints, unchanged destination/handoff evidence, and no pending
attempt. A target holding both forms reuses the V13 mixed record: both existing funded flows are
admitted atomically, reaction work continues, and removal waits for both exact destination gains
plus complete work retirement. When no active storage exists, that exact durable reaction or
explicit-boost handoff may persist the V14 mixed terminal record instead; energy still moves to the
retained lab, mineral moves to the terminal, and a matching pending effect retains both flows while
blocking removal. If mineral arrives first, the exact terminal remains reserved while the energy leg
finishes. Pending predecessor effects settle first; the objective and settled amount never restart.
One existing explicit funded boost may use the same role-identical handoff: only its assignment
fingerprint advances, while creep/body identity, compound, part target, deadline, and settled parts
remain fixed. The rebound tick emits neither staging nor a boost command; durable prior Industry
owner evidence plus a current executable intent or matching pending attempt enables the retained
boost handoff. That current intent and its matching pending effect both block removal, and any
unresolved explicit boost keeps removal closed until exact settlement. Existing progress advances
once only from exact next-observation body plus 30-mineral/20-energy corroboration; partial effects
resume and conflicting deltas retain the commitment. A supplied funded manifest remains
non-quiescent until completion even if invalid creep or objective evidence suppresses its
commitment; runtime does not yet produce autonomous boost manifests. A uniquely reconstructible
durable rebound is held without staging, lab command, removal, or layout revision while retained-lab
staging or source-layout evidence is unavailable. Contaminated, cooling, target-role-assigned,
ambiguous, malformed, capacity-lost, cluster-breaking, or pressured labs remain.

Spawn convergence begins only at RCL7, where redundant service exists. Source-defined committed
spawn positions replace compatible external geometry for ordinary site planning. At full allowance,
one active idle external spawn may be removed only when exactly allowance minus one active spawns
occupy committed positions, current SpawnBroker evidence selects neither migration spawn and leaves
an idle retained spawn executable, and no unrelated assigned/active endpoint names either migration
spawn. A stocked target first persists one exact 150-tick amount/baseline handoff and uses the sole
funded V3 Logistics, workforce, lease, arbiter, and executor chain. Target refill is suppressed;
replacement refill remains suppressed until acquisition empties the target, then may restore gain
consumed from the room-wide spawn-energy pool. No survival or ordinary-logistics lease may bypass
currently suppressed migration endpoints; only the exact current authorized V3 flow is re-admitted,
and owner-term loss retires its orphaned contract. Removal waits for fresh target emptiness,
baseline-plus-amount replacement energy, exact flow/endpoint retirement, unchanged safety and
geometry, and live minimum-energy revalidation. Observed disappearance exposes the final committed
site. A busy, selected, sole/replacementless, endpoint-bound, expired, unsafe, capacity-lost, or
drifted spawn remains. [ADR 0067](adr/0067-stocked-obsolete-spawn-evacuation.md) records the stocked
handoff.

Terminal convergence accepts a bounded inter-room-service outage only to restore the sole committed
RCL6+ terminal. One active empty zero-cooldown external terminal is eligible only while exact active
storage preserves local inventory service, Industry's current terminal-work projection is quiescent,
and no terminal-bound lab evacuation or Logistics endpoint remains. Current send proposals mark both
source and destination rooms active; an unattributable active/backoff send receipt fails the
complete view closed. The sole removal arbiter admits the narrow `terminal → storage` continuity
form, and fresh execution rechecks exact 300,000/1,000,000-unit general-purpose Stores before
destruction. Stocked, cooling, active-work, storage-unavailable, unsafe, or drifted terminals
remain. Observed disappearance exposes the committed terminal through the ordinary
site/funding/build chain. [ADR 0068](adr/0068-empty-obsolete-terminal-relocation.md) records this
intentional outage.

One otherwise eligible terminal holding exactly one resource kind and at most 3,000 units may first
persist one 150-tick evacuation into that same exact active storage. The sole funded V3 Logistics
path moves the stock while internal sends from or to the room and competing terminal source/refill
work remain suppressed during the unexpired attempt. Fresh target emptiness, storage exactly at
baseline plus amount, retired flow/endpoints, zero cooldown, unchanged quiescence, and every
existing safety term are mandatory before removal. Mixed/larger stock, destination consumption or
capacity loss, unrelated work, pressure, or uncertainty preserves the terminal and suppresses active
work. Timeout restores ordinary terminal service but remains removal-blocking evidence.
[ADR 0069](adr/0069-single-resource-stocked-terminal-evacuation.md) records this bound.

A terminal holding two through eight resource kinds may use the same path only when the canonical
manifest totals at most 3,000 units. Each row binds its exact amount and storage baseline, receives
a distinct funded V3 flow, and shares one aggregate storage-capacity reservation. Every currently
active row admits atomically; completed rows leave the group so asymmetric delivery remains
resumable. Removal requires every exact destination gain plus complete manifest flow/endpoint
retirement. Refill, consumption, overgain, malformed/reordered terms, bounded overflow, or partial
authorization keeps removal closed.
[ADR 0070](adr/0070-mixed-resource-stocked-terminal-evacuation.md) records this composition.

Storage convergence accepts the inverse bounded local-inventory outage only at RCL6-RCL8. The pure
projection retains compatible external storage at RCL4-RCL5, then restores the committed storage
position once policy unlocks one terminal. One sole active external storage may be removed only when
its exact 1,000,000-unit Store is empty, one active exact 300,000-unit terminal remains, the
committed tile is clear, and every colony/site safety gate passes. The Logistics gate must be
effective with one exact current healthy room row; current assigned/active work, same-tick projected
V3 requests, and durable lab or terminal evacuation destinations naming the storage block removal.
The arbiter's exact `storage → terminal` form and live executor checks preserve terminal continuity
while accepting a temporary capacity contraction until the existing 30,000-energy build chain
restores storage. Stocked, pre-RCL6, work-bound, unsafe, or uncertain storage remains.
[ADR 0071](adr/0071-empty-obsolete-storage-relocation.md) records this boundary.

One otherwise eligible storage containing exactly one resource kind and at most 3,000 units may
first persist one exclusive 150-tick evacuation into that terminal. Current terminal work must be
quiescent and aggregate terminal capacity must hold the complete amount. On following ticks, one
funded `optional-growth` V3 Logistics flow replaces ordinary publication at both endpoints while
internal sends involving the room are suppressed. Partial delivery is resumable; removal requires
fresh storage emptiness, terminal stock exactly at baseline plus amount, retired exact flow and both
endpoints, and every unchanged geometry, Logistics, colony, and terminal-safety term. Refill,
consumption, contention, drift, pressure, or uncertainty preserves the storage. Timeout restores
ordinary storage/terminal Logistics and send service but remains removal-blocking. Mixed stock may
use the same path only when it contains two through eight canonical resource rows and remains within
the same 3,000-unit total. Each incomplete row receives a distinct funded V3 flow, all rows share
one aggregate terminal-capacity reservation, and the complete current set admits atomically before
and after funding. Asymmetric delivery resumes only the incomplete subset; removal waits for every
exact terminal gain and every flow/endpoint to retire. More than eight kinds is not admitted. One
single resource or canonical two-to-eight-resource manifest totaling 3,001–6,000 units instead uses
exactly two aggregate batches: the first 3,000 units in binary resource order followed by the exact
remainder. Every current row has a distinct resource- and batch-qualified funded flow and budget
identity under one nonrenewing 300-tick deadline; a boundary-crossing row cannot reuse retired work.
The second batch cannot publish until fresh per-resource first-batch delivery and complete
prior-work retirement advance the durable cursor. Suppression remains continuous, and removal still
requires every complete original terminal gain plus final work retirement. Once a matching
successful receipt plus fresh owned-room evidence proves the exact storage absent, the exact active
terminal quiescent, and every original gain conserved, that fulfilled handoff stops suppressing the
terminal in the same planning tick. Stale, unknown, present, threatened, unreceipted, malformed, or
drifted evidence remains fail-closed and cannot clear the durable receipt or evacuation on the next
tick. The terminal therefore remains ordinary local inventory service while one committed storage
site is eligible for the existing growth-contract/build path. Storage-specific evidence models the
complete build cost, while the generic production row separately proves that execution authority;
fresh observation restores the active storage.
[ADR 0072](adr/0072-single-resource-stocked-storage-evacuation.md) records the scalar bound;
[ADR 0073](adr/0073-mixed-resource-stocked-storage-evacuation.md) records the manifest composition;
[ADR 0074](adr/0074-two-batch-single-resource-stocked-storage-evacuation.md) records the scalar
sequential extension; and
[ADR 0075](adr/0075-two-batch-mixed-resource-stocked-storage-evacuation.md) records its mixed
composition.

A source-defined layout algorithm revision never discards active migration evidence into ordinary
planning. Layouts V25 isolates every fully validated older-algorithm record from gameplay. Only one
quiescent record in a visible, progression-authorized, unthreatened colony with legal workforce,
restored reserve, no controller risk, and complete current source/access proof may advance. The
handoff tick emits no construction, removal, evacuation, or dismantle command; existing bounded
convergence resumes no earlier than the next tick. Active, unsafe, stale-vision, or blocked evidence
remains fail-closed. [ADR 0076](adr/0076-command-free-stale-layout-revision-handoff.md) records this
revision boundary.

Every owned room has one survival lifecycle and one local ledger. A bootstrapping or recovering
colony with a spawn but no legal `WORK`/`CARRY`/`MOVE` worker derives exactly one recovery
objective, which the ledger explicitly funds or blocks. Threat and recovery preempt optional growth;
losing vision preserves state but authorizes no new work, while current visible ownership loss ends
the colony and releases its local commitments.

Local spending follows a fixed survival order: emergency spawning, defense, replacement,
harvesting/filling, controller survival, critical maintenance, then optional growth. Current energy,
spawn time, and kernel-admitted CPU are conserved before priority is considered. Only emergency
spawning, defense, and replacement may consume protected spawn energy; every later category must
leave the remaining tranche intact.

Static mining assigns one deterministic primary extraction commitment per visible owned source. Once
persisted, its legal reachable work position outranks newly observed alternate containers or sites.
Losing the selected container first keeps the same mining terms and degrades to dropped energy. A
switch then requires a different exact legal/reachable container plus fresh visible ownership, no
threat or controller risk, legal workforce, and restored protected reserve. The same safety gate may
switch a still-existing selected exact container only when another exact candidate strictly precedes
it under the existing route, terrain, and coordinate ordering; worse or equal alternates cannot
cause churn, and another source's persisted service is never a candidate for theft. The layout-owned
issuance coordinate advances exactly once, while `ContractLedger` atomically replaces the same
source and funding binding with its next sequence; the current-tick predecessor remains executable
and no duplicate or durable zero-contract state is allowed. Useful `WORK` is capped by source
regeneration throughput, replacement remains ahead of optional growth, and missing or unavailable
offload infrastructure degrades to dropped energy rather than stalling extraction. Container state
is evidence only for #47 hauling and #49 repair, while a nearby link is only a candidate until #48
authorizes link commands.

Logistics uses one canonical resource-flow admission model across fresh visible owned rooms. Spawn
and extension supply, survival towers, and controller supply are mandatory before optional storage
or later-phase consumers. Observed source amounts and sink capacities are reserved once; mixed
resources never share an inferred capacity, and stale, vanished, full, empty, inactive, or unknown
facts fail closed. CARRY/MOVE recommendations converge from admitted flow, round-trip ticks, and a
bounded planning horizon rather than independent haul opportunities.

PR A remains data-only normalization and planning. PR B adds funded haul contracts, population,
lease execution/reconciliation, and runtime activation; PR C adds telemetry, composed evidence, and
gate activation. Terminal sends and link commands remain outside local hauling, with #48 owning link
execution and #49 owning container repair. The exact official Store, storage, terminal, transfer,
withdraw, Wiki Maturity Matrix, and Wiki Energy guidance consulted for this policy is recorded in
[ADR 0018](adr/0018-logistics-planner-authority.md).

Spawn decisions use one deterministic broker across every eligible local spawn. Emergency recovery
precedes replacement, which precedes upgrading and construction; stable deadline, body-cost, and
identity tie-breakers remove observation-order accidents. Multiple spawns share the room's one
current spawn/extension energy pool. At the default 300-energy recovery budget, MYRMEX schedules one
200-energy `WORK,CARRY,MOVE` survivor and releases the unused 100 instead of treating the grant as
actual cost. A scheduled command is remembered through the colony ledger until observation confirms
the exact generated creep name or a bounded expectation expires, so a heap reset cannot immediately
duplicate the order. Recovery names are stable across attempts and never suffixed; only explicit
caller-selected name bases use bounded suffix retries.

Complete-colony telemetry is observer-only. It reports fixed controller, reserve, spawn,
construction, source, logistics, link, maintenance, resource, lab, mature-infrastructure, and
observer outcomes plus a bounded aggregate window. Adjacent-RCL timing requires continuous per-tick
ownership observation; a gap, downgrade, multi-level jump, malformed identity, or reset without
valid owner state establishes a new baseline instead of claiming progression. Completed durations
aggregate into seven fixed RCL2–RCL8 rows from opaque colony references. Consecutive complete
owned-room observations similarly report only bounded road/container net hit loss/restoration and
visible disappearance/addition; gaps, ownership loss, over-cap input, and byte eviction establish a
new baseline, and no snapshot delta is labeled as decay, damage, repair, or replacement. Fixed
extractor, link, terminal, lab, and factory rows separately measure visible active structure-ticks
and positive-cooldown structure-ticks. A tick gap makes the retained utilization window explicitly
non-continuous; power-spawn and observer slots remain authority outcomes, and forbidden Phase 2
nuker launches do not dilute economy utilization. Modeled stages remain distinct: a funded repair
cap is not settled hit progress, planned terminal transaction energy is not observed destination
stock, cooldown is not proof of useful output, and lab/factory/power output requires exact next-
observation settlement. Missing history reduces evidence and can never authorize work or RCL8
maturity.

The final Phase 2 evidence boundary is fixed before its soak. One unboosted two-source colony must
reach RCL8 within 1,820,000 ticks while averaging at least nine controller energy per tick, then
supply a 15,000-tick steady-state window with at least 13,500 sustaining ticks and a final
1,500-tick continuous sustaining interval. Source uptime, CPU, reserves, flow identities, bounded
state, industry exercise, and injected recovery use the numeric limits in
[`phase2-gate-thresholds.md`](phase2-gate-thresholds.md). These are test policy, not runtime inputs;
telemetry and the scenario evaluator cannot authorize gameplay.

Remote and claim decisions use full-cost accounting. Energy delivered is reduced by spawn
amortization, road upkeep, reservation cost, expected hostile loss, replacement latency, and a CPU
shadow price. Losing remotes are suspended automatically.

Work enters execution as an idempotent capability contract with an owner, stable BudgetLedger
binding, success condition, deadline, expiry, and lease policy. A matching current active
reservation must authorize funding and assignment, and one binding backs at most one active
contract; a released, consumed, expired, or missing grant suspends known work and removes its lease.
Grant revision renewal preserves the same logical contract. Unknown vision authorizes no new
assignment but does not pretend that a commitment was revoked. A bounded central allocator prefers
survival work and the smallest sufficient actor while accounting for travel, remaining lifetime, and
switching cost. Contract state survives creep death and heap reset; it is not duplicated as a
permanent per-creep role or task.

Claims are scarce portfolio slots. A room must improve energy potential, graph connectivity,
defensibility, mineral coverage, or strategic reach enough to repay bootstrap and defense cost.

## Defense

Defense is layered: vision, threat scoring, evacuation, ramparts, tower focus, local defenders,
regional reinforcement, boosts, and safe mode. MYRMEX preserves terminal and spawn energy reserves
before optional industry or upgrading.

Current unowned creeps are not automatically threats. Configured exclusions are applied first, then
fresh local offensive capability may move a colony into threatened posture. Clearing that evidence
enters recovery before optional growth resumes.

## Industry stock balancing

At RCL6 and above, visible owned minerals receive finite source-controlled minimum, target, and
maximum bands. Extraction is proposed only for the mineral's funded target deficit and available
shared storage capacity. Internal sends move resources from colonies above target to colonies below
minimum, while terminal cooldown, destination capacity, protected energy, configured transaction
cost, and shared colony funding can defer the transfer. Failed sends use bounded durable backoff;
completed sends become eligible again only after observed destination stock changes.

Lab staging is contamination-first and budget-bound. Industry may request finite reagent, product,
boost-compound, or energy levels, but Logistics alone admits the corresponding local haul against
current stock and shared capacity. An incompatible mineral is drained before another mineral enters
the lab. Survival, defense, spawn supply, and mandatory logistics preempt every lab demand; missing
funding or exact owned endpoint facts defer staging without market use.

Reaction and boost staging share one policy. Explicit funded boost manifests preempt discretionary
reaction objectives; otherwise the policy selects one bounded canonical forward dependency chain.
Commitments survive reset but remain bound to current cluster and catalog fingerprints. Exact
staging completion yields `ready`, not a command. Active reaction completion requires later executor
evidence and re-observation rather than an unrelated increase in aggregate stock. A boost binds the
creep's immutable ID, name, and body-part counts; its expected boost annotation is settled only when
the exact target-part increase and matching 30-mineral/20-energy-per-part deltas are observed.

Factory and power processing follow the same funded-readiness rule. Their current capability status,
together with observer and capped nuker capability, contributes direct RCL8 health without making
industry the colony lifecycle owner. One factory call produces one complete recipe batch; operated
power processing is admitted only for the complete effect-adjusted amount and its
50-energy-per-power cost. `OK` remains pending until the next exact store and factory cooldown
observation. Missing funding, mechanics drift, conflicting deltas, or exhausted retries cannot claim
production. Exact settled effects report fixed energy-input, non-energy resource-input, and output
units: forward/reverse reaction ratios remain distinct, boosts consume mineral and energy without
becoming reaction output, and factory/power costs come from their accepted source mechanics.
Pending, retry, cancelled, failed, or conflicting attempts contribute zero. Source stock minima,
terminal energy, and current lab fills remain protected before mature logistics can stage work. The
shared observer authority is runtime-composed, but Phase 2 emits no target strategy; nuke launch
remains forbidden.

## Military Operations

Every operation declares an objective, owner, target, intelligence freshness requirement, body and
boost manifest, staging room, maximum energy/spawn/CPU budget, success criteria, retreat condition,
timeout, and diplomatic authorization.

Owned-room defense, remote evacuation, hostile-remote denial, and combat intelligence precede
sieges, boosted formations, nukes, strongholds, power operations, or cross-shard campaigns.

## Funded Population Scaling

Static extraction assigns one stationary commitment to each independently viable owned source.
Container, site, RCL, decay, destruction, fullness, and link-candidate state affect offload quality,
not legal extraction: miners continue with drop fallback and never issue hauling, repair, or link
transfer commands. Five WORK parts cap normal-source throughput at the official regeneration rate.

Funded population scales from normalized productive capability-part ticks rather than role counts.
Mandatory defense, replacement, spawn supply, controller safety, and critical maintenance retain
precedence; threat, recovery, bootstrap, constrained CPU, controller risk, reserve collapse, and
saturated spawn capacity suspend discretionary population. Expiring workers stop counting at the
exact replacement lead, and stable funded identities suppress duplicate commitments across reset.
