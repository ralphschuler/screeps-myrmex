# Phase 2 Road and Container Attrition Evidence

Issue [#279](https://github.com/ralphschuler/screeps-myrmex/issues/279) adds bounded reset-safe road
and container net-attrition evidence to the broader Phase 2 telemetry issue #53. `TelemetryService`
remains observer-only.

## Outcome contract

For roads and containers in currently visible owned rooms, the observer retains only opaque asset
and colony references plus current and maximum hits. A first observation is a baseline. A
consecutive complete observation may report:

- net hit decrease or increase for a stable structure ID;
- disappearance of a prior ID, including its last visible remaining hits as net loss; and
- addition of a new ID while the room remained continuously visible and owned.

These are adjacent-snapshot outcomes. They are not evidence that decay, combat damage, repair,
dismantling, or rebuilding caused the change. `ticksToDecay` remains a current world fact but is not
persisted or used to label a cause.

The fixed rows align with exported `PHASE2_ATTRITION_ASSET_TYPES` order (`road`, `container`) and
use this field order:

```text
asset ticks, capacity-hit ticks, hits lost, hits restored, structures lost, structures added
```

Capacity-hit ticks supply bounded exposure for the final soak without introducing a dynamic asset
label. Tick telemetry omits the attrition field while only a baseline exists and every row/counter
is zero, preserving the existing 8,192-byte tick-output gate.

## Continuity and failure behavior

The following establish a fresh baseline and cannot produce attrition:

- first observation;
- non-consecutive ticks;
- missing vision or visible ownership loss;
- changed hit capacity for one stable ID;
- malformed/future state or observation;
- more than 64 visible owned colonies or 128 candidate stored structures/roads;
- duplicate or colliding opaque colony/asset references; and
- whole-owner byte eviction of the prior baseline.

A same-tick replay cannot recreate byte-evicted RCL or attrition baselines. Reordered world facts
and JSON/global-heap reconstruction remain byte-equivalent.

## Persistence and bounds

Telemetry owner V5 now contains Phase 2 owner-local schema V5. V4 preserves the RCL timing state and
attrition schema V1 from V3, omits the compact attrition field while no baseline or evidence exists,
and adds exact industry-accounting sample fields. V5 adds fixed cooldown-utilization sample rows
without changing attrition state:

- current observation cap: an upper bound of 128 road plus stored-structure candidates and 64
  colonies;
- retained baseline cap: 128 opaque tracks and 64 opaque colonies;
- aggregate cardinality: exactly two fixed rows;
- default whole-owner cap: 8,192 UTF-8 bytes;
- dynamic labels, room names, live objects, and causal labels: zero;
- gameplay consumers: zero.

Byte fitting removes history, Phase 2 samples, RCL baselines, and RCL aggregates before the complete
attrition baseline and fixed rows, then proceeds to reporter evidence. Every loss is reflected in a
fixed saturating interruption/drop counter before the fitted telemetry and status hash are
published. Malformed attrition state resets only attrition evidence; valid samples and RCL timing
survive.

## Deterministic evidence

[`phase2-attrition-results.json`](phase2-attrition-results.json) records:

- reset/reorder and same-tick replay equivalence;
- one road net decrease, visible disappearance, and addition;
- one container net restoration;
- a visibility interruption that preserves aggregate rows and reports no fabricated loss;
- over-cap rejection before element traversal;
- V2-to-V5 owner migration with empty attrition omitted and legacy samples conservatively dropped
  because they lack exact recipe inputs and cooldown observations;
- a JSON Memory reset retaining exact runtime road/container rows, redacted identities, a matched
  fitted status hash, and a measured 1,070-byte owner; and
- fixed cardinality and zero causal-label bounds.

Repository architecture checks separately prove zero telemetry gameplay readers; this scenario does
not hardcode that assertion.

Executable checks:

```text
npx vitest run packages/bot/test/phase2-attrition.test.ts
npx vitest run packages/bot/test/phase2-telemetry.test.ts
npx vitest run packages/bot/test/telemetry-service.test.ts
npx vitest run packages/scenario-kit/test/phase2-attrition-gate.test.ts
npm run check
```

## Research receipt

Official API pages were rechecked on July 18, 2026; their HTTP metadata was last modified May
29, 2026.

- Official [`Structure.hits` and `hitsMax`](https://docs.screeps.com/api/#Structure.hits) expose
  current and maximum hit points, not the reason for a change.
- Official [`StructureRoad`](https://docs.screeps.com/api/#StructureRoad) documents road decay and
  `ticksToDecay`. Current engine source additionally shows that creep traversal advances the decay
  timer, so wall-clock cadence alone is not causal proof.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer) documents 5,000
  hit decay and owned/unowned cadence. Current engine source uses controller presence when resetting
  the next decay time.
- Current official engine processors for
  [roads](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/roads/tick.js#L8-L31),
  [containers](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/containers/tick.js#L8-L31),
  and
  [movement wear](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/movement.js#L211-L221)
  constrain the non-causal adjacent-snapshot model.
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/),
  [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [Vision](https://wiki.screepspl.us/Vision/), and [Structure](https://wiki.screepspl.us/Structure/)
  provide community maintenance and unknown-vision terminology only.

ADR [0032](adr/0032-road-container-attrition-telemetry.md) records the persistent observer boundary.
