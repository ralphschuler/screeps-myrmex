# Phase 1 spawn return-code evidence

Evidence version: `phase1-spawn-return-code-v1`  
Issue: [#30](https://github.com/ralphschuler/screeps-myrmex/issues/30)  
Runtime test: `packages/bot/test/tick.test.ts`

## Bounded composed row

The composed `runTick` test starts an empty-workforce funded room at tick `70`. The broker admits
the recovery spawn, but the adapter returns Screeps `ERR_NOT_ENOUGH_ENERGY` (`-6`) after admission.
The runtime records a rejected execution, settles the associated reservation as released, and does
not leave a durable expectation that suppresses retry. At tick `80`, an adapter return of `0`
produces exactly one scheduled spawn command.

The executor unit suite separately covers `ERR_BUSY` (`-4`) normalization. Together these tests
prove deterministic post-admission normalization for both named spawn return codes and the composed
insufficient-energy settlement/retry path. They do not claim live Screeps adapter or deployment
evidence.

## Reproduction

```bash
npx vitest run packages/bot/test/tick.test.ts
```

## Mechanics references

- [StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep) defines the
  spawn command and documented return codes.
- [Screeps API constants](https://docs.screeps.com/api/#constants) defines `ERR_BUSY` and
  `ERR_NOT_ENOUGH_ENERGY`.

## Remaining #30 rows

- Live deployment and remote adapter evidence remain non-substitutable.
- The complete matrix still needs observed persistent-memory, telemetry, energy-flow,
  replacement-lateness, controller-margin, and outcome-hash measurements.
- Multi-room contention and hostile/live engine timing remain outside this local composed row.
