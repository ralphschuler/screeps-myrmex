# ADR 0059: Obsolete-lab boost assignment handoff

## Status

Accepted

## Context

ADR 0054 permits one reaction commitment to advance onto a role-identical assignment over nine
retained committed labs before a role-unused external lab is removed. The cluster fingerprint
includes every observed lab, so the same geometry change also invalidates an otherwise executable
explicit boost commitment even when its reagent, product, and boost lab IDs do not change.

Issue #339 made boost identity and exact next-observation settlement compatible with the expected
body annotation. The remaining reaction-only handoff cancelled boost work as `cluster-changed` or
allowed blocked boost staging to obscure safe migration. Treating that cancellation as quiescence
could also expose the separate idle-lab removal path while a funded boost manifest remained
unresolved.

## Decision

- One existing explicit funded boost commitment may use ADR 0054's handoff only when the current and
  post-removal assignments have byte-identical reagent, product, and boost lab ID arrays and exclude
  the exact external target.
- Industry changes only `assignmentFingerprint`. Objective identity/revision, objective and catalog
  fingerprints, creep identity/body fingerprint, compound, part type/count, deadline, priority, and
  `settledParts` remain unchanged.
- The first rebound is `pending`, emits no staging demand or lab intent, and becomes executable only
  after the rebound fingerprint is present in prior `IndustryOwnerV5` evidence and the retained lab
  path can emit the exact boost intent or already owns its matching pending attempt. A uniquely
  reconstructible blocked rebound remains non-staging and non-executable.
- Pending attempts remain kind-aware. A source-assignment attempt settles before rebinding. The
  first retained-assignment boost intent and its following pending attempt both keep removal
  blocked. Only a later tick after exact target-part, 30-mineral-per-part, and 20-energy-per-part
  settlement may expose the existing removal path.
- Existing boost commitments never advance from a body annotation alone. Composition reconciles the
  matching pending attempt first, projects exact corroborated progress into the policy input once,
  and persists that projection without adding the same delta again. Partial exact effects remain
  resumable; conflicting body/resource deltas retain the unchanged commitment and keep migration
  active. A new manifest with no commitment may still complete from an already satisfied observed
  body because no command effect is being claimed.
- A supplied funded boost manifest remains Industry activity until it completes, even when missing
  or changed creep evidence, malformed inputs, preemption, or another fail-closed disposition
  suppresses its commitment. Quiescent migration cannot reinterpret that unresolved objective as
  idle. Objective over-cap input marks the bounded room projection active without scanning the raw
  manifest batch.
- `ConstructionPlanner` and `LogisticsPlanner` continue to consume the existing kind-neutral ready
  handoff view. Empty and exact energy, mineral, or mixed-stock migration retain all current
  destination, flow-retirement, pending-attempt, layout, role, and colony-safety checks.
- The persisted removal proposal identity `remove-active-reaction-lab-v1` remains unchanged for
  retry and receipt compatibility; it now means the existing active-commitment handoff boundary.
- No runtime boost-manifest producer is added. Runtime composition still receives no autonomous
  boost objective; this slice preserves an explicit objective supplied through the existing public
  contract only.
- No persistent field, owner schema, migration, command authority, queue, dependency, or telemetry
  cardinality is added.

## Consequences

One explicit boost can continue across removal of a role-unused external lab without restarting its
objective or settled progress. The rebound tick is command-free; reset/reordered observation
reproduces the same commitment, and later execution uses only the retained boost lab. A pending
boost effect cannot race structure destruction.

Invalid creep, role, catalog, layout, stock, logistics, or safety evidence fails closed. An operator
or future planner must withdraw an invalid explicit manifest before the room can become quiescent;
this preserves stock and objective safety over migration progress. Rollback requires only reverting
code and checked evidence because `IndustryOwnerV5` and layouts owner V13 remain compatible.

Autonomous boost-manifest production, different role IDs or compounds, mixed-stock terminal
destinations, multiple obsolete labs, general layout-revision migration, defensive migration, and
creep dismantling remain outside this decision and issue #341. ADR 0062 subsequently permits the
mineral-only V14 terminal destination during the same exact ready handoff.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab) and
  [`StructureLab.boostCreep`](https://docs.screeps.com/api/#StructureLab.boostCreep): RCL8 permits
  ten labs; lab capacities are 3,000 mineral and 2,000 energy; the target creep must be adjacent;
  each boosted part costs 30 compound and 20 energy; `OK` schedules the action.
- Official [creep boosts](https://docs.screeps.com/resources.html#Creep-boosts): compound and body
  part determine the effect, and one part accepts one boost.
- Official [game loop](https://docs.screeps.com/game-loop.html) and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): command effects
  require later observation rather than same-tick mutation assumptions.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page) and
  [`StructureLab`](https://wiki.screepspl.us/StructureLab/) provide established cluster, refill,
  boost, and cooldown terminology. Official API contracts govern behavior.
