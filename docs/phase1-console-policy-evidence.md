# Phase 1 console policy evidence

Source version: `runtime-config-source-v15`.

Issue [#130](https://github.com/ralphschuler/screeps-myrmex/issues/130) defines fixed console
reporter caps and a pure redacted status projection for the renderer in issue #131.

## Outcome evidence

- Reporter limits are source-controlled and cannot become gameplay authority or persistent state.
- The projection is created only after the final kernel report, so it can expose bounded CPU and
  fault evidence without restructuring reconciliation or telemetry persistence.
- Raw shard values and telemetry identifiers are opaque references; only fixed codes and scalars
  cross into the renderer input.
- A null telemetry result becomes a bounded unavailable observer view and does not alter the tick.
- Recovery progress is stored only in the telemetry owner. Unchanged recovery evidence emits a fixed
  `recovery-progress-unchanged` report with an opaque blocker reference after the configured window;
  a successful spawn, harvest, delivery, changed evidence, or recovery completion clears it.
- Reminder timing is bounded exponential backoff. It is observer evidence only: no retry, command,
  or gameplay admission path reads it.
- An optional observer diagnostic request accepts only `debug` or `trace` and the fixed `recovery`,
  `blockers`, and `faults` categories. Its duration is anchored in the versioned config receipt and
  expires exactly at the recorded tick; it cannot change reporter caps or redaction.

## Synthetic console examples

```text
[MYRMEX][INFO][shard:deadbeef][t=100] mode=normal cpu=0/20000 bucket=9000 observer=ready colony=developing objectives=2 recovery=false spawnDemand=0 harvested=10 delivered=10 unmet=0 blockers=0 faults=0
[MYRMEX][WARN][shard:deadbeef][t=101] mode=recovery cpu=0/20000 bucket=700 observer=ready colony=bootstrapping objectives=1 recovery=true spawnDemand=1 harvested=0 delivered=0 unmet=50 blockers=1 faults=0
```

## Mechanics sources consulted

- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.notify](https://docs.screeps.com/api/#Game.notify)
- [Screeps documentation: Debugging](https://docs.screeps.com/debugging.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
