# ADR 0031: Bounded RCL transition timing

## Status

Accepted. ADRs 0032, 0033, and 0034 later advance the nested Phase 2 observer state through V5 while
preserving this RCL timing contract.

## Context

Phase 2 telemetry reports current controller progress, downgrade margin, and a short aggregate
outcome window. That evidence cannot answer how many continuously observed ticks an owned colony
needed to advance between Room Controller Levels. Inferring duration from aggregate progress or
treating a gap in visibility as continuous would fabricate gate evidence. Persisting room names or a
transition log without hard bounds would also violate telemetry cardinality and operational-security
constraints.

## Decision

- `TelemetryService` remains the sole telemetry owner. No planner, director, arbiter, executor, or
  domain-health adapter may read RCL timing state or output.
- Phase 2 owner-local schema V2 contains RCL timing schema V1 and retains at most 64 active tuples.
  Each tuple contains only an opaque colony reference, current RCL, the tick that continuous
  observation at that RCL began, and the latest continuously observed tick. Room names and live
  controllers are never retained.
- First observation establishes a baseline only. Exactly one duration is recorded when the same
  opaque colony is observed on every tick and advances by exactly one RCL. Duration is the
  completion tick minus the baseline tick.
- Missing or non-consecutive observation, ownership loss, downgrade, multi-level jump, duplicate
  opaque identity, malformed input, or over-cap input interrupts timing and cannot record success.
  RCL8 retains no active baseline because no next RCL exists.
- Completed normalized evidence uses exactly seven fixed rows aligned with destination RCL2–RCL8.
  Each row stores a saturating sample count, total ticks, minimum, maximum, latest duration, and
  latest tick. The persistent owner encodes only nonempty rows with their fixed destination index so
  empty timing state does not displace reporter evidence. Tick telemetry omits timing while only an
  active baseline exists; after completion or evidence loss it exposes one compact latest-row tuple
  plus cumulative loss counters, while the owner retains all seven aggregates. Multiple completions
  for one destination on the same tick choose the maximum duration as the deterministic latest
  value.
- Same-tick replay is idempotent. Controller observations and active tuples are canonicalized by
  opaque reference, so world iteration order and JSON/global-heap reconstruction do not change state
  or output.
- Existing Phase 2 schema V1 sample state upgrades to V2 on the next successful telemetry commit.
  Malformed or future timing state drops timing evidence only; valid aggregate samples remain
  usable.
- The existing 8,192-byte whole-owner ceiling remains authoritative. Byte fitting evicts ordinary
  history and Phase 2 samples first, then active RCL baselines, then completed RCL aggregates. Every
  timing loss increments a saturating fixed counter before reporter and recovery evidence is
  considered. Tick output and its status hash are reprojected from the fitted owner before return,
  so the observer never reports evicted timing as retained.

## Consequences

The Phase 2 gate can measure reset-safe adjacent-RCL elapsed time without creating gameplay state,
dynamic metric labels, a controller event bus, or another persistent owner. Evidence is deliberately
conservative: any observation discontinuity loses the in-progress interval. A 32-bit
opaque-reference collision becomes duplicate evidence and drops the batch rather than combining
colonies.

The reducer inspects at most 64 current observations and 64 prior baselines plus seven fixed rows.
Rollback to schema V1 loses timing evidence only; controller progression, colony lifecycle,
commands, and domain commitments remain unchanged.

## Mechanics sources

- [Official Screeps documentation index](https://docs.screeps.com/)
- [Official Control guide](https://docs.screeps.com/control.html), updated May 29, 2026
- [Official `StructureController`](https://docs.screeps.com/api/#StructureController)
- [Screeps Wiki index](https://wiki.screepspl.us/)
- [Screeps Wiki: Room Control Level](https://wiki.screepspl.us/Room_Control_Level/)
