# ADR 0054: Active-reaction lab assignment handoff

## Status

Accepted

## Context

ADR 0050 permits obsolete-lab removal only while Industry is quiescent. The current cluster
fingerprint includes every observed lab ID and position, so removing even an unused external lab
changes that fingerprint. `IndustryDirector` consequently cancels an otherwise valid active reaction
as `cluster-changed`, allowing funded work to block safe committed-layout convergence indefinitely.

At RCL8, one room may already have nine active labs on committed positions plus one empty external
lab. When that external lab participates in no reagent, product, or boost role, the deterministic
assignment over the nine retained labs can have exactly the same role IDs as the current ten-lab
assignment. The assignment identity still changes because the observed geometry changes.

## Decision

- Runtime composition reconstructs at most 64 committed RCL8 lab geometries from the existing
  layouts owner. It passes only room names, durable layout fingerprints, and ten committed positions
  to the existing lab policy; no layout state or planner authority moves into Industry.
- Industry derives a handoff only for exactly nine active committed labs plus one active, empty,
  zero-cooldown external lab. Current and post-removal reagent, product, and boost ID arrays must be
  byte-identical, and the external target must occur in none of them.
- Only one existing reaction or reverse-reaction commitment may use the handoff. Boost commitments
  remain excluded. `IndustryDirector` changes only `assignmentFingerprint`; objective identity and
  revision, objective fingerprint, catalog, chemistry, deadline, priority, batch amount, and settled
  amount remain unchanged.
- The first rebound tick publishes no lab intent and exposes the handoff as `pending`. The existing
  `IndustryOwnerV5` commitment must contain the new fingerprint on a later tick before the handoff
  can be `ready`. A durable rebound remains `blocked`, without staging, lab intent, or removal,
  while retained-lab staging or its source layout evidence is unavailable. Industry recognizes that
  hold only when exactly one visible leave-one-lab-out assignment reproduces the durable fingerprint
  and the same roles. While any handoff state exists, `LayoutPlanner` pins its exact durable source
  fingerprint and emits no unrelated site proposal; if that record cannot be reconstructed, layout
  planning degrades instead of replacing the commitment underneath Industry. No owner field, schema
  version, or second migration state machine is added.
- A pending attempt bound to the old assignment blocks rebinding until it settles. After durable
  rebinding, an attempt bound to the retained assignment continues to exact observation settlement
  even if the external target remains visible because its destroy command failed or awaits
  observation.
- `ConstructionPlanner` may extend ADR 0050's empty-target path only for an exact `ready` handoff.
  It independently recomputes current and post-removal assignments, verifies the durable
  predecessor, target, objective coordinate, retained assignment, no pending attempt, current
  logistics/safety, and exact empty Store. The quiescent evacuation paths from ADRs 0051–0053 remain
  unchanged and active stocked targets remain forbidden.
- `LabExecutor`, `StructureRemovalArbiter`, `StructureDestroyExecutor`, Industry reconciliation, and
  the existing layouts-owner V13 destroy receipt retain their command and settlement authorities. A
  retained-lab reaction and external-lab destroy may execute in one tick only after the handoff was
  durable on the preceding tick.

## Consequences

One active reaction can continue across safe removal of an unused external lab without losing or
restarting settled progress. Reordered observation and JSON/global reset reproduce the same rebound
commitment. A uniquely reconstructible durable rebound also survives temporary staging or source-
layout evidence loss in a non-executable hold. Role changes, boost work, stock, cooldown, pending
predecessor effects, malformed or ambiguous geometry, active target logistics, threat, and pressure
preserve the structure and do not partially rebind work.

The path remains bounded by eight Industry rooms, ten labs per room, 64 committed layout records,
the existing two-room migration window, 128 removal candidates, and one global destroy command.
Rollback requires only reverting code: Industry owner V5 and layouts owner V13 remain unchanged.
Boost handoff, stocked active-lab evacuation, pending-attempt reassignment, terminal destinations,
multiple labs, general layout-revision migration, and creep dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-20:

- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 permits ten labs; a
  reaction uses two input labs within range two of an output lab, produces five units, and applies
  the product-specific cooldown to the output lab.
- Official [`StructureLab.runReaction`](https://docs.screeps.com/api/#StructureLab.runReaction):
  `OK` means scheduled; source resources, target capacity, range, cooldown, activation, ownership,
  and RCL remain command preconditions.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate and reports ownership and hostile-room failures.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies established
  two-input/multiple-output cluster, cooldown, refill, drain, and production-switch terminology.
  MYRMEX policy and handoff rules remain independently source-defined.
