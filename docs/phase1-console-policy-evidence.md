# Phase 1 console policy evidence

Source version: `runtime-config-source-v16`.

Issue [#130](https://github.com/ralphschuler/screeps-myrmex/issues/130) defines fixed console
reporter caps and a pure redacted status projection for the renderer in issue #131. Issue
[#187](https://github.com/ralphschuler/screeps-myrmex/issues/187) carries the existing bounded
reporter and recovery transitions through that projection and renderer. Issue
[#188](https://github.com/ralphschuler/screeps-myrmex/issues/188) adds the production-pipeline
stress proof and a source-controlled reporter-input work ceiling.

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
  the report also includes up to three sanitized `domain:reason` details from the bounded blocker
  projection, excluding opaque entity references. A successful spawn, harvest, delivery, changed
  evidence, or recovery completion clears it.
- Recovery tracking uses the fixed `bootstrapping` and `recovering` colony state counts, not only
  Memory migration status. This keeps normal zero-creep recovery observable while Memory is ready;
  migration recovery remains visible as a tick-local runtime condition.
- Reminder timing is bounded exponential backoff. It is observer evidence only: no retry, command,
  or gameplay admission path reads it.
- Equivalent hostile fault signals are deduplicated by opaque fingerprint before the
  retained-cardinality cap is applied. Reordered high-cardinality input therefore cannot multiply
  retained entries or console events.
- At most 2,000 health signals enter aggregation per tick. With the default 64 telemetry details,
  the reducer inspects at most 2,064 candidates; an oversized or accessor-backed input is rejected
  from its array descriptor before any element is read. Sanitization, deduplication, sorting, and
  the omitted-prefix hashes happen once. Byte fitting reuses that prepared batch and never rereads
  source identities.
- The configured 64-fingerprint ceiling is honored when it fits. The shared 8,192-byte telemetry
  owner remains the final bound: history is evicted first and then the oldest reporter entries are
  evicted deterministically. Whenever either the cardinality ceiling or the byte fit omits active
  fingerprints, one retained opaque overflow fingerprint represents the omitted set; a changed
  omitted set therefore emits bounded current evidence without rotating or repeatedly rediscovering
  evicted identities. Current overflow `first` and `reminder` evidence is selected before ordinary
  transitions and a resolution flood.
- Projection reads only the fixed schema-v2 transition field descriptors and never enumerates a
  hostile record. Signal fingerprints and recovery blocker references are opaque, reasons are fixed
  safe codes, counters and ticks are bounded scalars, and unknown fields or player-controlled
  strings are ignored rather than copied across the boundary.
- Transition lines are eligible even outside the heartbeat cadence. `first`, `reminder`, and
  recovery `stuck` are warnings; `resolved` is informational. Rendering still obeys `silent` mode,
  catches sink failures, and cannot affect gameplay receipts or commands.
- A reporter candidate becomes publishable only after its telemetry owner participates in a
  successful root commit. Failed-commit and ownerless fallback telemetry clear recovery progress and
  transition events, so an unpersisted `first` cannot repeat or suppress the later committed first
  observation.
- A thrown telemetry-service call discards only the telemetry transaction. Gameplay owners still
  reconcile, the mandatory minimum system completes with an unavailable observer view, and command
  receipts are unchanged.
- An optional observer diagnostic request accepts only `debug` or `trace` and the fixed `recovery`,
  `blockers`, and `faults` categories. Its duration is anchored in the versioned config receipt and
  is revalidated at projection and rendering, so delayed receipts expire exactly at the recorded
  tick; it cannot change reporter caps or redaction.

## Fixed defaults

| Limit                                     | Source default |
| ----------------------------------------- | -------------: |
| Health signals inspected per tick         |          2,000 |
| Total aggregation candidates per tick     |          2,064 |
| Byte-fit capacity attempts                |             65 |
| Immediate transitions per tick            |              2 |
| Reporter fingerprint policy               |             64 |
| Shared durable telemetry owner bytes      |          8,192 |
| Initial reminder delay                    |       10 ticks |
| Maximum reminder delay                    |      160 ticks |
| Unchanged recovery window                 |       25 ticks |
| Console lines per tick                    |              3 |
| Console UTF-8 bytes per tick              |          1,536 |
| Reconcile system CPU admission estimate   |           1.00 |
| Fallback telemetry CPU admission estimate |           0.50 |

The console line and byte ceilings apply to the combined transition, heartbeat, and diagnostic
candidates. Transition selection is deterministic, and the limits do not authorize persistence or
retries.

The CPU evidence is a deterministic work bound rather than a wall-clock benchmark: the default
pipeline admits and prepares no more than 2,000 health plus 64 detail candidates once. Durable byte
fitting makes at most 65 monotone capacity attempts (64 fingerprints down through zero); each
attempt uses only the prepared omitted-prefix hash plus at most 64 current and 64 prior metadata
entries. The pipeline projects no more than two transitions and renders no more than three lines.
The scheduled aggregation path is admitted under the `state.reconcile` 1.00 CPU estimate; the
ownerless fallback is admitted under the reserved `telemetry.minimum` 0.50 estimate. Projection and
rendering run after the kernel report but traverse only the bounded two-transition, three-category
surfaces.

## Stress evidence matrix

| Fixture                                        | Deterministic evidence                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| 2,000 equivalent signals                       | one retained fingerprint, one `first`, bounded owner and line     |
| 2,000 unique and reversed signals              | one source read each, identical output, 64 retained when they fit |
| 2,001 signals                                  | rejected before element traversal, no transition                  |
| 2,000 equivalent signals, ticks 100-570        | events at 100, 110, 130, 170, 250, 410, and 570 across heap reset |
| Resolution at 571, quiet at 572                | one bounded informational resolution, then no line                |
| Malformed, overflow, future, or accessor state | deterministic rebuild or empty safe fallback                      |
| Rejected root commit                           | no uncommitted transition; next successful tick emits one `first` |
| Resolution flood plus a new signal             | current `first` is selected before bounded resolutions            |
| 65 active signals after a saturated owner      | one stable opaque overflow `first`, no rediscovery flood          |
| 64 maximum-width active signals                | byte-fit overflow emits stable `first` and reminder evidence      |
| Throwing telemetry service                     | gameplay commit and commands unchanged; observer unavailable      |
| Delayed diagnostic at its expiry tick          | no diagnostic crosses projection or rendering                     |

Reproduce the focused evidence from the repository root:

```bash
npm exec vitest run -- packages/bot/test/reporter-pipeline-stress.test.ts packages/bot/test/telemetry-service.test.ts packages/bot/test/reporter-status.test.ts packages/bot/test/console-reporter.test.ts packages/bot/test/tick.test.ts
```

## Synthetic console examples

```text
[MYRMEX][INFO][shard:deadbeef][t=100] mode=normal cpu=0/20000 bucket=9000 observer=ready colony=developing objectives=2 recovery=false spawnDemand=0 harvested=10 delivered=10 unmet=0 blockers=0 faults=0
[MYRMEX][WARN][shard:deadbeef][t=101] mode=recovery cpu=0/20000 bucket=700 observer=ready colony=bootstrapping objectives=1 recovery=true spawnDemand=1 harvested=0 delivered=0 unmet=50 blockers=1 faults=0
[MYRMEX][WARN][shard:deadbeef][t=102] reporter signal kind=first fingerprint=reporter-transition:cafebabe count=1 reason=spawn-unavailable
[MYRMEX][WARN][shard:deadbeef][t=127] reporter recovery kind=stuck owner=colony blocker=reporter-blocker:feedface blockerReason=spawn-unavailable blockerDetails=representative:spawn-unavailable other=action:target-out-of-range lastProgress=102 reminderAt=137 reason=recovery-progress-unchanged
[MYRMEX][INFO][shard:deadbeef][t=128] reporter signal kind=resolved fingerprint=reporter-transition:cafebabe count=1 reason=spawn-unavailable
```

## Mechanics sources consulted

- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.notify](https://docs.screeps.com/api/#Game.notify)
- [Screeps documentation: Debugging](https://docs.screeps.com/debugging.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
