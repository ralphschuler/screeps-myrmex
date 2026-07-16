# Phase 1 gate: established RCL2 row

Evidence version: `phase1-gate-rcl2-v1`

This is one disjoint evidence slice for issue
[#30](https://github.com/ralphschuler/screeps-myrmex/issues/30). It does not claim the Phase 1 gate
is complete.

## Fixed row contract

The deterministic row starts at tick `100` with one visible owned `W1N1` room at RCL2, one idle
spawn, two empty extensions (`400` total room capacity), `300` available energy, one legal
`WORK,CARRY,MOVE` worker with two CARRY parts carrying `50` energy, one existing road construction
site, no hostile creeps, and empty MYRMEX Memory.

The fixed budget is at most `150` ticks, `500` modeled CPU per tick, `32,768` persistent Memory
bytes, and `0` construction-site placement calls. The row must finish with room energy `400`, the
spawn reserve still `300`, both extensions full, positive progress on `road-site`, and exactly one
pre-existing construction site. No row threshold is learned from the evidence run.

## Evidence

[`phase1-gate-runtime.test.ts`](../packages/bot/test/phase1-gate-runtime.test.ts) invokes `runTick`
only. It asserts transfer execution to the observed extensions, build execution against the observed
road site, active existing growth/maintenance reservation evidence, the protected `300` spawn
reserve, and the absence of construction-site placement. The fixture exposes no
`createConstructionSite` implementation, so placement cannot be smuggled into the scenario.

Reproduce this slice with:

```bash
npm exec vitest -- run packages/bot/test/phase1-gate-runtime.test.ts
```

## Mechanics sources

- [Screeps API: Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps API: Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable)
- [Screeps API: Creep.transfer](https://docs.screeps.com/api/#Creep.transfer)
- [Screeps API: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps API: Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [Screeps API: StructureExtension](https://docs.screeps.com/api/#StructureExtension)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)
- [Screeps Wiki: Construction Sites](https://wiki.screepspl.us/Construction_Sites/)

Official API behavior takes precedence over the Wiki summary.

## Remaining issue #30 rows

- Fresh RCL1 cold boot, zero-creep recovery, harvest, delivery, replacement, and RCL2 progression.
- Sole-worker death, heap reset, and duplicate-contract/command suppression.
- Busy-spawn and insufficient-energy denial with recovery after the blocker clears.
- Blocked-path and stale-target bounded outcomes.
- Hostile-pressure suppression and recovery after threat removal.
- Constrained-CPU safety, spawn, execution, reconciliation, and telemetry preservation.
- Reordered/reset canonical-equivalence replay and production-bundle exclusion of `scenario-kit`.
- Full matrix budgets, hashes, telemetry/persistent-growth measurements, and remaining-risk review.
