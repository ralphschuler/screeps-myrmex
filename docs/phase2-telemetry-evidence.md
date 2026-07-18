# Phase 2 Outcome Telemetry Evidence

Issue [#275](https://github.com/ralphschuler/screeps-myrmex/issues/275) adds the deterministic
bounded direct-outcome foundation for the broader Phase 2 telemetry issue #53. `TelemetryService`
remains an observer and is not an input to `ColonyDirector` or any domain planner.

## Outcome contract

`TickTelemetry.phase2` exposes fixed current-tick records for:

- controller count, RCL8 count, progress, progress total, minimum visible downgrade margin, and
  directly reported sustaining colonies;
- spawn/extension energy stock and capacity, storage and terminal energy, reserve violations, spawn
  busy/idle utilization, scheduled energy, and scheduled spawn ticks;
- owned construction backlog and remaining progress plus layout planning, arbitration, and
  execution;
- source uptime, inferred extraction/waste, logistics lifecycle deltas, successful link
  sent/delivered energy and loss, maintenance budget/scheduled tower energy, planned terminal
  transaction energy, and exactly settled lab/factory/power output;
- one fixed admitted/deferred/failed row for each of eleven Phase 2 authorities; and
- three explicit accounting identities with signed residuals.

Attribution already present in bounded domain receipts and opaque `TelemetryDetail` records remains
available without adding room, objective, contract, budget, or player-controlled metric labels. The
Phase 2 aggregate itself has no dynamic label set. Authority tuples use the exported
`PHASE2_AUTHORITY_IDS` order and fields
`(admitted, deferred, failed, energy, resource units, CPU milli-units, spawn ticks)`. Identity
tuples use `PHASE2_FLOW_IDENTITY_IDS` and fields `(balanced, residual)`. The rolling tuple uses the
exported `PHASE2_WINDOW_FIELDS` order. These fixed schemas preserve the existing 8,192-byte
tick-telemetry gate without abbreviating units or creating dynamic keys.

## Modeled accounting boundaries

| Flow                          | Evidence                                                                 | Boundary                                                         |
| ----------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Source extraction             | reset-safe current/previous source energy and regeneration observations  | first observation after lost history reports zero delta          |
| Logistics                     | cumulative funded-flow pickup, delivery, and loss deltas                 | stock movement outside a tracked flow is not invented            |
| Links                         | successful executor sent, delivered, and loss amounts                    | rejected/failed commands contribute no delivered energy          |
| Maintenance                   | requested/funded creep caps and scheduled tower energy                   | a funded creep cap is budget evidence, not settled hit progress  |
| Terminal                      | source-policy planned transaction energy and settled command disposition | the planned amount is not reported as observed destination stock |
| Labs/factory/power processing | exact existing next-observation settlement receipts                      | pending and retry attempts contribute no output                  |

The checked identities are:

```text
logistics requested = scheduled + shortfall
successful link sent = delivered + transfer loss
maintenance requested cap >= funded cap
```

A nonzero or invalid residual is visible gate evidence. Telemetry never repairs or authorizes the
underlying work.

## Rolling window and bounds

Telemetry owner schema V5 now contains owner-local Phase 2 schema V2. It preserves the V1 fixed
sample ring and adds the bounded RCL timing state documented in
[`phase2-rcl-transition-evidence.md`](phase2-rcl-transition-evidence.md). Each fixed sample retains
only tick, harvested energy, logistics/link delivery, settled industry output, authority failures,
reserve violations, and measured domain milli-CPU.

- hard sample maximum: 64;
- effective sample maximum: configured telemetry history count;
- default whole-owner byte ceiling: 8,192 UTF-8 bytes;
- authority rows: exactly 11;
- accounting identities: exactly 3;
- dynamic Phase 2 labels: zero;
- malformed state: discarded as observer history only;
- byte pressure: old Phase 2 samples, RCL baselines, and completed timing aggregates are evicted and
  counted before reporter health evidence.

The measured CPU input currently includes mining, logistics, tower-maintenance, and spawn command
receipts that expose CPU directly. It is a lower-bound domain measurement, not total tick CPU; the
kernel report remains authoritative for total system and phase CPU.

## Deterministic evidence

[`phase2-telemetry-results.json`](phase2-telemetry-results.json) records:

- byte-equivalent output under reordered input properties and normalized runtime collections;
- JSON Memory reconstruction of the rolling state;
- exact logistics, link, and maintenance identity results;
- fixed authority order and outcome counts;
- a six-tick replay with a four-sample retained window and deterministic dropped count; and
- production bounds and the zero telemetry-decision-input invariant.

Executable checks:

```text
npx vitest run packages/bot/test/phase2-telemetry.test.ts
npx vitest run packages/bot/test/telemetry-service.test.ts
npx vitest run packages/scenario-kit/test/phase2-telemetry-gate.test.ts
npm run check
```

The scenario proves the direct-outcome telemetry contract. Issue #277 separately proves bounded
reset-safe RCL transition duration. Issue #54 still owns full RCL2–RCL8 progression and steady-state
soaks and must set pass/fail thresholds before running them.

## Research receipt

- Official [CPU limit](https://docs.screeps.com/cpu-limit.html), updated May 29, 2026: CPU is
  measured execution time; unused baseline CPU accumulates in a bucket capped at 10,000. CPU use and
  bucket posture are separate facts.
- Official [`Game.cpu`](https://docs.screeps.com/api/#Game.cpu): `limit`, `tickLimit`, `bucket`, and
  `getUsed()` provide current engine measurements.
- Official [Control](https://docs.screeps.com/control.html), updated May 29, 2026: RCL progression
  is energy-driven and RCL8 retains a finite 150,000-tick downgrade timer.
- Official [`Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable) and
  `energyCapacityAvailable` distinguish current spawn-pool stock from installed capacity.
- Screeps Wiki [CPU](https://wiki.screepspl.us/CPU/), [Energy](https://wiki.screepspl.us/Energy/),
  and [Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/) provide community terminology
  and operational framing. They do not define a gameplay authorization or engine maturity flag.

ADR [0030](adr/0030-phase2-outcome-telemetry.md) records the persistent observer boundary.
