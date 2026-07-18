# Phase 2 RCL Transition Timing Evidence

Issue [#277](https://github.com/ralphschuler/screeps-myrmex/issues/277) adds the bounded
transition-duration slice of the broader Phase 2 telemetry issue #53. It extends observer evidence
only; `ColonyDirector` and every gameplay authority remain independent of telemetry.

## Outcome contract

A continuously observed owned controller establishes one opaque baseline at its current RCL. An
adjacent increase on the immediately following observed tick records one duration:

```text
transition ticks = completion tick - tick first continuously observed at the prior RCL
```

The persistent and tick-local output uses exactly seven rows aligned with destination RCL2–RCL8.
Each row is:

```text
(samples, total ticks, minimum ticks, maximum ticks, latest ticks, latest tick)
```

At most 64 active tuples retain `(opaque colony reference, RCL, entered tick, last observed tick)`.
RCL8 retains no baseline because it has no next RCL. Tick telemetry omits timing while only a
baseline exists; after completion or evidence loss it publishes one compact latest-row tuple and
cumulative loss counters. The owner retains all seven aggregates. Room names, controller objects,
progress-event logs, and dynamic metric labels are absent.

## Fail-closed continuity

The reducer records no successful transition after:

- a first observation;
- a missing or non-consecutive tick;
- ownership or visibility loss;
- an RCL downgrade;
- a jump of more than one RCL;
- duplicate or malformed opaque identity;
- malformed/future timing state; or
- more than 64 current observations or active persisted baselines.

These conditions reset or drop only observer evidence. Same-tick replay of already reduced state is
idempotent. Multiple same-destination completions on one tick use the maximum duration as the fixed
latest value, removing input-order dependence.

## Persistence and bounds

Phase 2 owner-local schema V2 preserves the existing bounded sample ring and adds RCL timing schema
V1:

- active RCL tracks: at most 64;
- normalized duration aggregates: exactly 7; the owner stores only nonempty rows with fixed
  destination indexes;
- interrupted-track, dropped-observation, and dropped-transition counters: saturating safe integers;
- whole telemetry-owner ceiling: 8,192 UTF-8 bytes.

V1 Phase 2 state upgrades on the next successful telemetry commit without losing valid samples.
Malformed timing state becomes empty timing evidence while valid sample history remains. Under byte
pressure, telemetry drops ordinary hash/sample history, then active timing baselines, then completed
duration aggregates; it never changes gameplay state. Returned timing and the telemetry hash are
reprojected from the fitted owner in the same tick, so evicted evidence is never reported as
retained.

## Deterministic evidence

[`phase2-rcl-transition-results.json`](phase2-rcl-transition-results.json) records:

- byte-equivalent output when controller order is reversed;
- JSON/global-heap reconstruction during an active interval;
- one exact RCL2→RCL3 duration;
- same-tick completion replay without duplication;
- interrupted visibility and a 65-room runtime batch producing no transition;
- V1→V2 baseline-only migration;
- compact owner encode/decode through a Memory reset with no duplicate duration;
- a measured 1,575-byte complete telemetry owner under the 8,192-byte ceiling; and
- architecture checks proving zero telemetry gameplay readers.

Executable checks:

```text
npx vitest run packages/bot/test/phase2-telemetry.test.ts
npx vitest run packages/bot/test/telemetry-service.test.ts
npx vitest run packages/scenario-kit/test/phase2-rcl-transition-gate.test.ts
npm run check
```

Road/container attrition, exact recipe-input accounting, cooldown-utilization windows, numeric soak
thresholds, and the complete Phase 2 gate remain in issues #53 and #54.

## Research receipt

- Official [Control](https://docs.screeps.com/control.html), updated May 29, 2026: energy delivered
  through `Creep.upgradeController` advances RCL; upgrade requirements vary by level; RCL8 has no
  next level and retains a finite downgrade timer.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController) exposes
  current `level`, `progress`, `progressTotal`, and `ticksToDowngrade` observations. It exposes no
  durable transition event, so MYRMEX derives elapsed time only from continuous snapshots.
- Screeps Wiki [Room Control Level](https://wiki.screepspl.us/Room_Control_Level/) supplies
  community progression and maintenance terminology. It notes that a newly claimed room begins at
  RCL1, RCL8 has no next level, and controllers still require maintenance against downgrade.
  Official mechanics remain authoritative.

ADR [0031](adr/0031-bounded-rcl-transition-timing.md) records the persistent observer boundary.
