# Phase 1 spawn-blocker recovery evidence

Evidence version: `phase1-spawn-blocker-v1`  
Issue: [#30](https://github.com/ralphschuler/screeps-myrmex/issues/30)  
Test: `packages/scenario-kit/test/phase1-spawn-blockers.test.ts`

## Scope

This bounded slice covers one local RCL1 recovery demand (`worker-a`) and one owned spawn
(`spawn-a`) through the existing `SpawnBroker` and `SpawnExecutor` authorities. It does not add a
runtime authority, persistence schema, dependency, or scenario-kit import to `packages/bot`.

Fixed inputs are:

| Item                 | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| Room and spawn       | `W1N1`, `spawn-a` / `SpawnA`                          |
| Tick sequence        | `42100`, `42101`, `42102`, `42103`                    |
| CPU budget per tick  | `4` modeled units; `2` used                           |
| Recovery body        | `[work, carry, move]`                                 |
| Recovery energy cost | `200`                                                 |
| Energy sequence      | `300`, `100`, `300`, `300`                            |
| Persistence budget   | one durable `SpawnExpectation`, bounded to one entry  |
| Heap resets          | between denial and recovery, and again after recovery |

The reproduction command is:

```bash
npx vitest run packages/scenario-kit/test/phase1-spawn-blockers.test.ts
```

## Deterministic results

At tick `42100`, the observed spawn has `spawning !== null`. The broker returns a deferred
`no-idle-spawn` decision with retry tick `42103`; no selection reaches the executor and no
`spawnCreep` command is issued.

At tick `42101`, the spawn is idle but room energy is `100`, below the fixed body cost of `200`. The
broker returns a deferred `insufficient-energy` decision with retry tick `42105`; no command is
issued.

At tick `42102`, the blockers are clear. The broker selects `worker-a` exactly once and the executor
records exactly one scheduled command. The next tick sees the durable expectation and returns
`expectation-pending`, so it issues no duplicate command, including after a heap reset.

The test compares warm, reset, and reordered-input runs. Reset and reordered runs must have equal
outcomes, final world, and outcome hash. The transcript hash may differ because heap-reset metadata
is intentionally included there. The complete run has exactly one `spawnCreep` command.

## Mechanics references

- [StructureSpawn.spawnCreep API](https://docs.screeps.com/api/#StructureSpawn.spawnCreep): busy
  spawns return `ERR_BUSY` (`-4`) and insufficient room energy returns `ERR_NOT_ENOUGH_ENERGY`
  (`-6`).
- [Screeps constants](https://docs.screeps.com/api/#constants): official return-code definitions.
- [Spawning creeps](https://wiki.screepspl.us/Spawning/): spawn occupancy and energy mechanics used
  by the fixed replay inputs.

## Remaining #30 rows

- Live deployed validation across the target shard and room remains outstanding.
- Executor-level live return-code recovery for an adapter that returns `ERR_BUSY` or
  `ERR_NOT_ENOUGH_ENERGY` after broker admission remains outstanding.
- ColonyDirector/BudgetLedger exact reservation settlement for this blocker sequence remains to be
  composed with the live runtime gate.
- Multi-room and multi-spawn contention, including cross-room energy accounting, remains outside
  this one-demand slice.
- Production deploy, rollback, and incident evidence for the complete Phase 1 gate remains
  outstanding.

## Production runtime composition

The aggregate `runTick` timeline composes this focused broker/executor row with one busy-spawn
observation, one protected low-energy observation, persistent Memory and telemetry bounds, hostile
and constrained-CPU intervals, sole-worker death, and bounded replacement. Warm, heap-reset, and
reordered variants combine the focused and production-runtime hashes.
