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
view when its general-purpose Store has complete aggregate capacity. One funded mineral flow
suppresses the obsolete lab's ordinary source/refill publication; removal waits for fresh lab
emptiness, baseline-plus-amount storage stock, retired work, and unchanged destination, quiescence,
cluster, and safety evidence. A target holding both energy and one mineral kind combines those exact
destinations in one bounded commitment: energy and mineral flows are admitted as an atomic pair, and
removal waits for both destination gains plus complete work retirement. One active reaction may
continue only when the external target has no current or post-removal role, the retained nine labs
keep byte-identical reagent/product/boost IDs, and Industry durably advances only the assignment
fingerprint before any reaction, migration, or destroy command. An empty target proceeds directly. A
positive energy-only target first reuses the existing V13 evacuation: one funded optional-growth
creep flow moves the exact amount to the canonical retained lab while reaction work continues, and
removal waits for fresh target emptiness, baseline-plus-amount replacement energy, retired
flow/endpoints, unchanged handoff evidence, and no pending reaction attempt. A zero-energy target
holding one mineral kind instead reuses the V13 mineral evacuation and exact active storage: one
funded flow moves the complete amount under aggregate capacity, and removal waits for the exact
storage gain, retired flow/endpoints, unchanged destination/handoff evidence, and no pending
attempt. A target holding both forms reuses the V13 mixed record: both existing funded flows are
admitted atomically, reaction work continues, and removal waits for both exact destination gains
plus complete work retirement. Pending predecessor effects settle first; the objective and settled
amount never restart. One existing explicit funded boost may use the same role-identical handoff:
only its assignment fingerprint advances, while creep/body identity, compound, part target,
deadline, and settled parts remain fixed. The rebound tick emits neither staging nor a boost
command; durable prior Industry owner evidence plus a current executable intent or matching pending
attempt enables the retained boost handoff. That current intent and its matching pending effect both
block removal. Existing progress advances once only from exact next-observation body plus
30-mineral/ 20-energy corroboration; partial effects resume and conflicting deltas retain the
commitment. A supplied funded manifest remains non-quiescent until completion even if invalid creep
or objective evidence suppresses its commitment; runtime does not yet produce autonomous boost
manifests. A uniquely reconstructible durable rebound is held without staging, lab command, removal,
or layout revision while retained-lab staging or source-layout evidence is unavailable.
Terminal-only, contaminated, cooling, target-role-assigned, ambiguous, malformed, capacity-lost,
cluster-breaking, or pressured labs remain.

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
