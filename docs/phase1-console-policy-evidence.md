# Phase 1 console policy evidence

Source version: `runtime-config-source-v15`.

Issue [#130](https://github.com/ralphschuler/screeps-myrmex/issues/130) defines fixed console
reporter caps and a pure redacted status projection for the renderer in issue #131. Issue
[#187](https://github.com/ralphschuler/screeps-myrmex/issues/187) carries the existing bounded
reporter and recovery transitions through that projection and renderer.

## Outcome evidence

- Reporter limits are source-controlled and cannot become gameplay authority or persistent state.
- The projection is created only after the final kernel report, so it can expose bounded CPU and
  fault evidence without restructuring reconciliation or telemetry persistence. Reporter aggregation
  consumes the settled kernel health snapshot available at Reconcile rather than inferring health
  from console output; the final report remains the current-tick fault surface.
- Raw shard values and telemetry identifiers are opaque references; only fixed codes and scalars
  cross into the renderer input.
- A null telemetry result becomes a bounded unavailable observer view and does not alter the tick.
- Reporter status schema v2 carries `first`, `reminder`, and `resolved` signal transitions plus the
  fixed `stuck` recovery transition. New health evidence emits `first`, unchanged evidence emits a
  reminder only when its bounded backoff is due, and disappearance emits one `resolved` transition.
- Aggregation accepts only health settled before the single Reconcile commit. Failures in
  `state.reconcile` or `telemetry.minimum` remain visible in the final current-tick fault status but
  are not misrepresented as durable first/reminder/resolution transitions.
- `TelemetryService` persists only capped health metadata. Transitions are immutable tick-local
  output; there is no durable replay queue and a later tick never replays a transition omitted by
  the per-tick cap.
- Recovery progress is stored only in the telemetry owner. Unchanged recovery evidence emits a fixed
  `recovery-progress-unchanged` report with an opaque blocker reference after the configured window;
  a successful spawn, harvest, delivery, changed evidence, or recovery completion clears it.
- Recovery tracking uses the fixed `bootstrapping` and `recovering` colony state counts, not only
  Memory migration status. This keeps normal zero-creep recovery observable while Memory is ready;
  migration recovery remains visible as a tick-local runtime condition.
- Reminder timing is bounded exponential backoff. It is observer evidence only: no retry, command,
  or gameplay admission path reads it.
- Equivalent hostile fault signals are deduplicated by opaque fingerprint before the
  retained-cardinality cap is applied. Reordered high-cardinality input therefore cannot multiply
  retained entries or console events.
- Projection accepts only the schema-v2 transition shapes. Signal fingerprints and recovery blocker
  references are opaque, reasons are fixed safe codes, counters and ticks are bounded scalars, and
  unknown fields or player-controlled strings are dropped or redacted before rendering.
- Transition lines are eligible even outside the heartbeat cadence. `first`, `reminder`, and
  recovery `stuck` are warnings; `resolved` is informational. Rendering still obeys `silent` mode,
  catches sink failures, and cannot affect gameplay receipts or commands.
- An optional observer diagnostic request accepts only `debug` or `trace` and the fixed `recovery`,
  `blockers`, and `faults` categories. Its duration is anchored in the versioned config receipt and
  expires exactly at the recorded tick; it cannot change reporter caps or redaction.

## Fixed defaults

| Limit                          | Source default |
| ------------------------------ | -------------: |
| Immediate transitions per tick |              2 |
| Reporter fingerprint policy    |             64 |
| Durable owner safety ceiling   |             24 |
| Initial reminder delay         |       10 ticks |
| Maximum reminder delay         |      160 ticks |
| Unchanged recovery window      |       25 ticks |
| Console lines per tick         |              3 |
| Console bytes per tick         |          1,536 |

The console line and byte ceilings apply to the combined transition, heartbeat, and diagnostic
candidates. Transition selection is deterministic, and the limits do not authorize persistence or
retries.

## Synthetic console examples

```text
[MYRMEX][INFO][shard:deadbeef][t=100] mode=normal cpu=0/20000 bucket=9000 observer=ready colony=developing objectives=2 recovery=false spawnDemand=0 harvested=10 delivered=10 unmet=0 blockers=0 faults=0
[MYRMEX][WARN][shard:deadbeef][t=101] mode=recovery cpu=0/20000 bucket=700 observer=ready colony=bootstrapping objectives=1 recovery=true spawnDemand=1 harvested=0 delivered=0 unmet=50 blockers=1 faults=0
[MYRMEX][WARN][shard:deadbeef][t=102] reporter signal kind=first fingerprint=reporter-transition:cafebabe count=1 reason=spawn-unavailable
[MYRMEX][WARN][shard:deadbeef][t=127] reporter recovery kind=stuck owner=colony blocker=reporter-blocker:feedface blockerReason=spawn-unavailable lastProgress=102 reminderAt=137 reason=recovery-progress-unchanged
[MYRMEX][INFO][shard:deadbeef][t=128] reporter signal kind=resolved fingerprint=reporter-transition:cafebabe count=1 reason=spawn-unavailable
```

## Mechanics sources consulted

- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.notify](https://docs.screeps.com/api/#Game.notify)
- [Screeps documentation: Debugging](https://docs.screeps.com/debugging.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
