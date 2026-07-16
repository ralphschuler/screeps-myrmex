# Phase 1 economy evidence

Issue [#26](https://github.com/ralphschuler/screeps-myrmex/issues/26) enables `phase1.economy` at
`runtime-config-source-v7`. Its dependency audit reopened the issue after the original in-range
fixture hid three production gaps: allocation had no out-of-range travel evidence, partial cargo
ended a harvest batch, and harvest telemetry counted contract quantity instead of energy.

## Authority and flow invariants

The bounded `EconomyPlanner` selects nearest visible energy sources and active owned spawn/extension
sinks with stable endpoint-demand identities and admits at most one reservation per observed
endpoint per tick. The identity deliberately omits a creep ID: `WorkforceAllocator` may assign any
eligible worker without leaving an actor-shaped ghost contract. Requests use only `ColonyDirector`'s
`harvesting-filling` category and claim no room energy or spawn interval. The protected
emergency-recovery reserve therefore remains unavailable to ordinary filling work.

`ContractPlanningView` still supplies stable renewal and endpoint-retirement evidence.
`ContractExecutionView` now supplies only the actual lease holder's current harvest/transfer phase.
A partial worker retains harvest until full; after delivery starts, it retains transfer until empty.
Phase-inactive endpoint contracts suspend so their issuer coordinate can be reused on later cycles;
only confirmed visible target disappearance retires them. A temporary zero-worker interval keeps
endpoint demand suspended so the next recovery worker can resume it. Continuous fill omits the
optional `Creep.transfer` amount and therefore offers the assigned worker's complete available
cargo. This reconstructs the batch after a heap reset without role Memory or another task authority.

`contracts.reconcile` obtains route evidence through a runtime-owned adapter to the existing
`LocalPathPlanningService`. In-range work costs no search; out-of-range work uses cached or bounded
local paths. PathFinder route cost is converted to a conservative travel duration using current
fatigue, active `MOVE`, total non-`MOVE` body weight, and the documented 1/5 path-cost versus 2/10
fatigue scales. Cold searches are admitted in 0.5 scheduler-CPU increments only after preserving the
contract or agent system's base estimate. The adapter memoizes no more than the allocator's 4,096
pair cap and fails closed for cross-room, deferred, malformed, or absent routes. Survival's 1,500
assignment-cost ceiling leaves deadline and TTL checks authoritative even with the conservative
travel bound. `WorkforceAllocator` remains pure and never receives `PathFinder`, live room objects,
or Memory.

## Composed outcome

`survival-flow-runtime.test.ts` starts with absent MYRMEX Memory, one owned RCL1 300/300 spawn, two
separated sources, and zero creeps. It predeclares and proves these deadlines:

- exactly one 200-energy `WORK,CARRY,MOVE` worker is scheduled at tick 100;
- the nine-tick worker is visible by tick 110;
- an out-of-range source is reached and first harvested by tick 130;
- the worker carries a full 50-energy batch before first delivery by tick 220;
- a second source supplies another full batch, the spawn is restored to at least 200 energy, then a
  worker death triggers one new `WORK,CARRY,MOVE` recovery spawn which harvests and delivers again.

The fixture applies one unboosted `WORK` harvest as exactly 2 energy, applies WCM fatigue between
executed moves, temporarily fills the only sink, makes it disappear once between observation and
command resolution, depletes and removes the first source, resets runtime modules/reconstructible
caches while round-tripping JSON Memory, reverses source order, and then proves deterministic
second-source delivery. Every tick checks this closed synthetic equation:

```text
initial spawn energy + harvested source delta + tracked temporary sink injection
  = current spawn energy + creep cargo + successful spawn cost
```

The fixture intentionally suppresses the engine's spawn auto-regeneration and places source
regeneration beyond the scenario window; this is stricter evidence for source-derived delivery, not
a claim that those external engine inflows do not exist. No tick has more than one worker lease,
assignment, active economy reservation, or submitted primary action/movement decision. A
deterministic nonzero CPU clock also proves:

```text
cumulative kernel CPU / cumulative scheduled delivered energy <= 1 CPU per energy
```

## Energy status semantics

`EnergyFlowTelemetry` now uses energy units throughout. `requested` is the beginning-of-tick active
spawn/extension deficit in owned rooms; `unmet` is its residual after successfully scheduled
delivery. `carried` and `dropped` are beginning-of-tick stock gauges. `harvested` and `delivered`
are current-tick scheduled estimates clamped by observed source/store facts; an `OK` receipt proves
scheduling, not a resolved end-of-tick delta. Harvest is exact for Phase 1's unboosted worker. If a
scheduled actor has boosted `WORK`, `harvestedIsLowerBound` explicitly marks the reported base yield
as a lower bound because the bounded body projection does not retain compounds. Full cross-domain
settled accounting remains the Phase 1 gate's responsibility in issue #30.

Reproduce the repair evidence with:

```bash
npm exec vitest -- run packages/bot/test/survival-flow.test.ts packages/bot/test/workforce-allocator.test.ts packages/bot/test/local-path-travel.test.ts packages/bot/test/energy-flow.test.ts packages/bot/test/survival-flow-runtime.test.ts
```

Mechanics consulted: official [`Source`](https://docs.screeps.com/api/#Source),
[`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest),
[`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer),
[`Creep.move`](https://docs.screeps.com/api/#Creep.move),
[`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn),
[`Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable), and
[`Store`](https://docs.screeps.com/api/#Store) documentation, plus the Screeps Wiki
[`Energy`](https://wiki.screepspl.us/Energy/) overview. Official API behavior takes precedence.
