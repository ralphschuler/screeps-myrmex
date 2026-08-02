# ADR 0006: Movement and primary-action authorities

Status: accepted

## Context

Issue #25 introduces the first creep command path. Movement contention and the Screeps primary
action pipeline cannot be delegated to role code: a later producer could otherwise issue multiple
commands for one actor, claim the same destination, or bypass reconciliation through `moveTo`.

## Decision

`MovementArbiter` is the sole local movement selection authority. It orders proposals by priority,
deadline, stuck age, actor ID, and intent ID; reserves destinations tick-locally; permits reciprocal
swaps; and returns one typed result for every proposal. `CreepActionArbiter` independently admits at
most one scoped primary action per actor. `MovementExecutor` is the sole caller of `Creep.move`, and
`CreepActionExecutor` is the sole caller of harvest, transfer, withdraw, pickup, upgrade, build, and
repair. Structural guards reject direct, aliased, rebound, `call`, `apply`, `moveTo`, and
`moveByPath` bypasses.

The authority stores no persistent queue or creep task Memory. Future lease agents (#38) are only
producers. Issue #112 provides bounded tick-local producer channels plus a reconstructible tagged
static-matrix/local-path cache and a local-only, policy-bounded search seam.
`movement.path-cache.v3` keeps both value kinds behind the same canonical owner while preserving
independent entry TTLs and dependencies. Its shared 240-entry cap leaves bounded headroom for
movement-progress and compiled layout evidence under the production heap limit. The path cache never
holds live objects, occupancy, reservations, or task state; the arbiter applies dynamic reservation
after cache lookup. Expected return codes and adapter faults become typed execution results; they do
not throw across the tick boundary.

Issue #115 supplies the production composition of that seam: Observe publishes a compact detached
terrain/static-structure projection, and the runtime-owned adapter alone converts it to `PathFinder`
objects. Plan systems receive a data-only local-path capability, no engine objects, and use their
CpuScheduler budget for a bounded cold search. Missing terrain, CPU, an incomplete path, or an
adapter failure remains typed path result data.

Issue #488 keeps heap-only recovery evidence attached to a semantic movement episode rather than a
mutable lease revision. Equivalent renewal therefore preserves no-progress age, while observed
movement or a genuinely changed goal resets it. A bounded short-lived actor-goal record in the same
movement-progress cache namespace recognizes repeated A→B→A oscillation. At the existing release
threshold the lease agent emits a typed suspension; `ContractLedger` remains the only authority that
can release work. Cache loss can delay recovery but cannot authorize a command or persist task
state.

## Consequences

- Agents can combine one movement and one admitted primary action, matching the documented distinct
  action pipelines, while the action arbiter prevents conflicting primary work.
- The first implementation has a deterministic local arbitration seam but does not introduce
  multi-room routing, traffic optimization, or role behavior.
- Source revision `runtime-config-source-v5` makes `phase1.movement` available. Issue #38 advances
  to `runtime-config-source-v6` and makes only `phase1.agents` available; later gameplay gates
  remain unavailable.

## Mechanics basis

- [Creep.move](https://docs.screeps.com/api/#Creep-move) moves one square.
- [PathFinder](https://docs.screeps.com/api/#PathFinder) supports a target range for local paths.
- [Creep actions](https://docs.screeps.com/api/) require their documented body parts and ranges.
- [Simultaneous creep actions](https://docs.screeps.com/simultaneous-actions.html) explains the
  primary-action conflict pipeline and independent movement pipeline.
- [Screeps Wiki](https://wiki.screepspl.us/) was consulted for community terminology; official API
  behavior remains authoritative.
