# Phase 1 gate: established RCL2 row

Evidence version: `phase1-gate-rcl2-v2`

This is the final deterministic evidence slice for issue
[#30](https://github.com/ralphschuler/screeps-myrmex/issues/30). Together with the other rows in the
aggregate matrix, it completes the Phase 1 gate.

## Fixed row contract

The deterministic row starts at tick `100` with one visible owned `W1N1` room at RCL2, one idle
spawn, two empty extensions (`400` total room capacity), `300` available energy, one legal
`WORK,CARRY,CARRY,MOVE` worker carrying `50` energy, one existing road construction site, no hostile
creeps, and empty MYRMEX Memory.

The fixed budget is at most `150` total ticks, `500` modeled CPU per tick, `32,768` persistent
Memory bytes, and `0` construction-site placement calls. The row first reaches `400` room energy
while preserving the spawn's `300` reserve and preserves the existing road progress. Its sole worker
is then removed. The runtime must issue exactly one `WORK,CARRY,MOVE` replacement request costing
`200` energy, expose the replacement after normal spawn time, and perform useful work no later than
`50` ticks after death. Before the total tick ceiling, room energy must recover to at least `300`
and road progress must be preserved or advanced. No row threshold is learned from the evidence run.

## Evidence

[`phase1-gate-runtime.test.ts`](../packages/bot/test/phase1-gate-runtime.test.ts) invokes `runTick`
only. The fixture provides mutable Screeps-facing lifecycle state: `spawnCreep`, `spawning`, dynamic
creep discovery and object lookup, spawn-energy consumption, spawn duration, replacement visibility,
and useful-work timestamps. Spawn cost is consumed from extensions before the spawn, proving the
runtime can refill room energy without hiding a permanent `300` spawn reserve behind the mock.

The focused test and aggregate warm, JSON/global-heap-reset, and reordered variants all assert one
spawn call with no duplicate demand, a distinct replacement identity, bounded visibility/useful
work, recovered room energy, and preserved construction progress. The aggregate records non-null
replacement lateness, nonzero spawn utilization, full-row recovery time, replacement outcome fields,
and exact outcome equivalence across all variants.

Reproduce this slice and the checked aggregate with:

```bash
npm exec vitest -- run packages/bot/test/phase1-gate-runtime.test.ts packages/scenario-kit/test/phase1-gate-aggregate.test.ts
npm run check
```

## Mechanics sources

- [Screeps API: Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps API: StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep)
- [Screeps API: StructureSpawn.spawning](https://docs.screeps.com/api/#StructureSpawn.spawning)
- [Screeps API: Creep.harvest](https://docs.screeps.com/api/#Creep.harvest)
- [Screeps API: Creep.transfer](https://docs.screeps.com/api/#Creep.transfer)
- [Screeps API: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps API: StructureExtension](https://docs.screeps.com/api/#StructureExtension)

Official API behavior takes precedence over secondary summaries.

## Later-owned nonblocking risks

- Live hostile-pressure behavior remains unevidenced and belongs to its later combat-validation
  work.
- Rollback and incident behavior remains owned by
  [#108](https://github.com/ralphschuler/screeps-myrmex/issues/108).
