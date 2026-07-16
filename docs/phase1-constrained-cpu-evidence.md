# Phase 1 constrained CPU evidence

Evidence version: `phase1-constrained-cpu-v1`

Issue [#30](https://github.com/ralphschuler/screeps-myrmex/issues/30) has one bounded, deterministic
constrained-CPU replay in `packages/scenario-kit/test/phase1-constrained-cpu.test.ts`.

## Fixed row

The replay runs four consecutive ticks at a fixed CPU budget and tick limit of `8`. The CPU bucket
is fixed at `30`, which derives `constrained` mode under a policy whose constrained threshold is
`50`. The mandatory tail reserve is `3`: execute, reconciliation, and `telemetry.minimum` each
consume one modeled unit. Safety and spawn each consume one additional unit, for exactly `5` used
and `3` remaining on every tick.

The runtime kernel admits safety and spawn, skips optional economic growth with stable
`skipReason: "cpu-mode"`, and then runs the mandatory execute, reconciliation, and minimum telemetry
systems. The replay also asks the direct `CpuScheduler`, `CpuTickBudget`, and `deriveCpuMode`
authorities to make the same constrained admission decision.

Warm, heap-reset, and reversed-registration replays have equal outcomes, final worlds, and
`outcomeHash` values. The reset transcript retains its heap-reset marker, so reset identity remains
visible without changing domain results.

## Reproduction

```bash
npm exec vitest -- run packages/scenario-kit/test/phase1-constrained-cpu.test.ts
```

## Mechanics references

- [Screeps CPU limit documentation](https://docs.screeps.com/cpu-limit.html)
- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.cpu.bucket](https://docs.screeps.com/api/#Game.cpu.bucket)

## Remaining #30 rows

- Fresh RCL1 cold boot, zero-creep recovery, harvest, delivery, replacement, and RCL2 progression.
- Sole-worker death, heap reset, and duplicate-contract or duplicate-command suppression.
- Busy-spawn and insufficient-energy denial with recovery after the blocker clears.
- Blocked-path, stale-target, and hostile-pressure recovery in the complete matrix.
- Full persistent-Memory, telemetry, spawn-utilization, energy-flow, replacement-lateness,
  controller-margin, and recovery-duration measurements.
- Complete matrix hashes, production-bundle exclusion of `scenario-kit`, clean-checkout gates, and
  remaining-risk review before #44 is unblocked.

This file proves only the constrained-CPU row. It does not claim that #30 is complete.
