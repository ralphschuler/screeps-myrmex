# Phase 2 Outcome Telemetry Evidence

Issue [#275](https://github.com/ralphschuler/screeps-myrmex/issues/275) adds the deterministic
bounded direct-outcome foundation for the broader Phase 2 telemetry issue #53. Later slices add RCL
timing, infrastructure attrition, exact settled industry accounting, and now fixed cooldown-
utilization windows. `TelemetryService` remains an observer and is not an input to `ColonyDirector`
or any domain planner.

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
  transaction energy, and exact settled lab/factory/power energy input, non-energy resource input,
  and output units;
- current and rolling visible active/cooling structure-ticks plus utilization basis points for five
  fixed extractor, link, terminal, lab, and factory rows, with explicit retained-window continuity;
  this projection is omitted while no current or retained active slot exists;
- one fixed admitted/deferred/failed row for each of eleven Phase 2 authorities; and
- three explicit accounting identities with signed residuals.

Settled industry accounting aggregates are optional compact tuples aligned with exported
`INDUSTRY_SETTLEMENT_ACCOUNTING_FIELDS` order `(energy input, resource input, resource output)`;
they are omitted when no exact effect settled. Attribution already present in bounded domain
receipts and opaque `TelemetryDetail` records remains available without adding room, objective,
contract, budget, or player-controlled metric labels. The Phase 2 aggregate itself has no dynamic
label set. Authority tuples use the exported `PHASE2_AUTHORITY_IDS` order and fields
`(admitted, deferred, failed, energy, resource units, CPU milli-units, spawn ticks)`. Identity
tuples use `PHASE2_FLOW_IDENTITY_IDS` and fields `(balanced, residual)`. The rolling tuple uses the
exported `PHASE2_WINDOW_FIELDS` order. These fixed schemas preserve the existing 8,192-byte
tick-telemetry gate without abbreviating units or creating dynamic keys.

## Modeled accounting boundaries

| Flow                          | Evidence                                                                 | Boundary                                                              |
| ----------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Source extraction             | reset-safe current/previous source energy and regeneration observations  | first observation after lost history reports zero delta               |
| Logistics                     | cumulative funded-flow pickup, delivery, and loss deltas                 | stock movement outside a tracked flow is not invented                 |
| Links                         | successful executor sent, delivered, and loss amounts                    | rejected/failed commands contribute no delivered energy               |
| Maintenance                   | requested/funded creep caps and scheduled tower energy                   | a funded creep cap is budget evidence, not settled hit progress       |
| Terminal                      | source-policy planned transaction energy and settled command disposition | the planned amount is not reported as observed destination stock      |
| Labs/factory/power processing | exact existing next-observation settlement receipts                      | only exact effects contribute input/output; every other state is zero |

The checked identities are:

```text
logistics requested = scheduled + shortfall
successful link sent = delivered + transfer loss
maintenance requested cap >= funded cap
```

A nonzero or invalid residual is visible gate evidence. Telemetry never repairs or authorizes the
underlying work.

## Rolling window and bounds

Telemetry owner schema V5 now contains owner-local Phase 2 schema V5. It preserves the V2 bounded
RCL timing and V3 road/container net-attrition state documented in
[`phase2-rcl-transition-evidence.md`](phase2-rcl-transition-evidence.md) and
[`phase2-attrition-evidence.md`](phase2-attrition-evidence.md). Each fixed sample retains only tick,
harvested energy, logistics/link delivery, exact settled industry energy input, non-energy resource
input and output, authority failures, reserve violations, measured domain milli-CPU, and five
logical cooldown `(active, cooling)` rows. Persistent rows align with exported
`PHASE2_SAMPLE_FIELDS`; their cooldown field is omitted when all five rows are zero, and nested
schema V5 makes that a canonical zero observation. Tick-local windows align with
`PHASE2_WINDOW_FIELDS`. V1–V3 samples are dropped and counted during V4 migration because absent
recipe inputs cannot safely become zero. V4 samples are dropped during V5 migration because absent
cooldown observations likewise cannot become zero; timing and attrition evidence remain independent
and are preserved.

- hard sample maximum: 64;
- effective sample maximum: configured telemetry history count;
- default whole-owner byte ceiling: 8,192 UTF-8 bytes;
- authority rows: exactly 11;
- accounting identities: exactly 3;
- cooldown rows: exactly 5, with per-kind candidate caps `(64, 384, 64, 640, 64)` across at most 64
  owned rooms;
- dynamic Phase 2 labels: zero;
- malformed state: discarded as observer history only;
- road/container baseline: at most 128 opaque assets across 64 visible owned colonies and two fixed
  aggregate rows;
- byte pressure: old Phase 2 samples, RCL baselines/aggregates, and then attrition baselines/rows
  are evicted and counted before reporter health evidence.

The measured CPU input currently includes mining, logistics, tower-maintenance, and spawn command
receipts that expose CPU directly. It is a lower-bound domain measurement, not total tick CPU; the
kernel report remains authoritative for total system and phase CPU.

## Deterministic evidence

[`phase2-telemetry-results.json`](phase2-telemetry-results.json) records:

- byte-equivalent output under reordered input properties and normalized runtime collections;
- JSON Memory reconstruction of the rolling state;
- exact logistics, link, maintenance, and industry input/output values;
- fixed authority order and outcome counts;
- a six-tick replay with a four-sample retained window and deterministic dropped count; and
- production bounds and the zero telemetry-decision-input invariant.

[`phase2-industry-accounting-results.json`](phase2-industry-accounting-results.json) additionally
proves fixed forward/reverse/boost, factory, and power settlement projections; zero non-settled
accounting; V3-to-V4 conservative sample migration; and reset/reorder equivalence.

[`phase2-cooldown-utilization-results.json`](phase2-cooldown-utilization-results.json) proves the
fixed five-row order, current and rolling basis-point values, reset/reorder/same-tick equivalence,
explicit gap detection, V4-to-V5 conservative sample migration, and production bounds.

Executable checks:

```text
npx vitest run packages/bot/test/phase2-telemetry.test.ts
npx vitest run packages/bot/test/telemetry-service.test.ts
npx vitest run packages/scenario-kit/test/phase2-telemetry-gate.test.ts
npx vitest run packages/scenario-kit/test/phase2-industry-accounting-gate.test.ts
npx vitest run packages/scenario-kit/test/phase2-cooldown-utilization-gate.test.ts
npm run check
```

The scenarios prove direct outcomes, exact settled industry accounting, and bounded cooldown
utilization. Issue #277 separately proves bounded reset-safe RCL transition duration, and issue #279
proves bounded reset-safe road/container net attrition. Issue #53 fixes the numeric pass/fail
contract in [`phase2-gate-thresholds.md`](phase2-gate-thresholds.md) and its machine-readable
manifest. Issue #54 still owns the full RCL2–RCL8 progression and steady-state measurements; no soak
result or Phase 2 pass is claimed here.

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
- Official [`StructureLab.runReaction`](https://docs.screeps.com/api/#StructureLab.runReaction) and
  [`reverseReaction`](https://docs.screeps.com/api/#StructureLab.reverseReaction) schedule opposite
  reagent/product effects; source-controlled `LAB_REACTION_AMOUNT` is five.
- Official [`StructureFactory.produce`](https://docs.screeps.com/api/#StructureFactory.produce)
  schedules one source-controlled recipe batch only when all components are present.
- Official
  [`StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower)
  consumes power plus source-controlled energy; `POWER_SPAWN_ENERGY_RATIO` is 50.
- Official [`StructureExtractor`](https://docs.screeps.com/api/#StructureExtractor),
  [`StructureLink`](https://docs.screeps.com/api/#StructureLink),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`StructureLab`](https://docs.screeps.com/api/#StructureLab), and
  [`StructureFactory`](https://docs.screeps.com/api/#StructureFactory) define five-tick extraction,
  distance-dependent sender, ten-tick send, reaction-dependent, and recipe-dependent cooldowns.
  Their numeric `cooldown` properties expose current lockout, not proof of useful output.
- Official
  [`StructureObserver.observeRoom`](https://docs.screeps.com/api/#StructureObserver.observeRoom) and
  power processing expose no numeric cooldown. Their command-slot outcomes remain separate.
- Screeps Wiki [CPU](https://wiki.screepspl.us/CPU/), [Energy](https://wiki.screepspl.us/Energy/),
  [Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/),
  [StructureLink](https://wiki.screepspl.us/StructureLink/),
  [StructureLab](https://wiki.screepspl.us/StructureLab),
  [StructureFactory](https://wiki.screepspl.us/StructureFactory), and
  [Power](https://wiki.screepspl.us/Power) provide community terminology and staging/throughput
  guidance. They do not define a gameplay authorization or engine maturity flag.

ADRs [0030](adr/0030-phase2-outcome-telemetry.md),
[0033](adr/0033-exact-settled-industry-accounting.md), and
[0034](adr/0034-bounded-cooldown-utilization-telemetry.md) record the persistent observer, exact
accounting, and cooldown-window boundaries. The threshold declaration adds no runtime authority,
owner, schema, or telemetry reader; its validator and evaluator remain development-only in
`@myrmex/scenario-kit`.
