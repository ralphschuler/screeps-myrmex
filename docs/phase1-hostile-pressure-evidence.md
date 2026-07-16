# Phase 1 Hostile-Pressure Evidence

Evidence version: `phase1-hostile-pressure-v1`

Issue: [#30](https://github.com/ralphschuler/screeps-myrmex/issues/30)

## Bounded row

`packages/scenario-kit/test/phase1-hostile-pressure-recovery.test.ts` replays one owned `W1N1` room
for three consecutive ticks: normal work, hostile pressure arrival, and pressure removal. During
pressure, `planDefense` emits one deterministic `tower.attack` intent. The shared arbiter caps
submissions, accepted commands, and budget at one, and `executeDefenseIntents` is the only command
boundary. Optional work is suspended during pressure and normal work resumes after the hostile is
removed.

The row runs warm, heap-reset, and reordered-input variants. Reset and reordered variants must match
the warm domain outcomes and final world, while the reset transcript must retain its reset marker.
No duplicate command is permitted.

Fixed thresholds are three replay ticks, `3` CPU budget units per tick, and exactly `2` modeled CPU
units used per tick. The row has no persistent Memory or telemetry writer, so it does not claim
those broader #30 measurements.

## Reproduction

```bash
npx vitest run packages/scenario-kit/test/phase1-hostile-pressure-recovery.test.ts
```

## Mechanics foundation

- [Screeps API: StructureTower](https://docs.screeps.com/api/#StructureTower) documents tower attack
  and the tower command boundary exercised by the replay.
- [Screeps defense guide](https://docs.screeps.com/defense.html) documents tower defense posture and
  tower action energy costs.
- [Screeps API: StructureController.activateSafeMode](https://docs.screeps.com/api/#StructureController-activateSafeMode)
  documents the separate safe-mode legality boundary; this row deliberately does not request it.

## Remaining #30 rows

- Fresh RCL1 bootstrap from one `300/300` spawn through harvest, delivery, replacement, and RCL2.
- Established RCL2 recovery with two extensions, `300/400` energy, a source, and critical-site
  progress.
- Cold boot, zero-creep recovery, sole-worker death, busy spawn, and insufficient energy.
- Blocked path and stale-target recovery composed with the full matrix.
- Constrained CPU proof preserving safety, spawning, execution, reconciliation, and telemetry while
  optional growth defers.
- Fixed persistent-Memory, telemetry, spawn-utilization, energy-flow, replacement-lateness,
  controller-margin, and recovery-duration measurements.
- Complete matrix hashes, exact production-bundle exclusion proof, and clean-checkout
  `npm run check`.
- Remaining risks and the complete matrix evidence required before #44 is unblocked.

This file proves only the hostile-pressure row. It does not claim that #30 is complete.

## Production runtime composition

The aggregate gate joins this focused defense row to a three-tick hostile interval observed by
production `runTick`. It records the `threatened` colony posture, clears pressure, resumes economic
delivery, and carries shared persistent Memory, telemetry, controller, energy-flow, and replacement
measurements through warm, heap-reset, and reordered variants. This remains deterministic evidence,
not a live MMO hostile-pressure claim.
