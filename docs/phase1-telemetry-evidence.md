# Phase 1 telemetry evidence

Source version: `runtime-config-source-v12`.

Issue [#39](https://github.com/ralphschuler/screeps-myrmex/issues/39) adds bounded, observer-only
survival status before console rendering in issue #110.

## Outcome evidence

- `TelemetryService` reads immutable settled colony, contract, intent, movement, spawn, growth,
  maintenance, energy, and world evidence; it cannot be gameplay input.
- The status carries config/policy revisions, lifecycle/budget totals, energy flow, threat and
  controller activity, contract/lease evidence, intent/movement blockage, and spawn demand/results.
- Capped detail records are canonically ordered and hashed; equivalent reversed inputs match while
  overflow increments a deterministic drop count.
- The `telemetry` owner stores only a capped hash ring and metadata in the existing reconciliation
  commit. Malformed observer data is rebuilt without changing gameplay owners.
- Tick tests prove the mandatory telemetry tail still runs after a telemetry fault, once Execute and
  Reconcile have completed. No console output belongs to this slice.

## Mechanics sources consulted

- [Screeps documentation: CPU limit](https://docs.screeps.com/cpu-limit.html)
- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps documentation: Global Objects and Memory](https://docs.screeps.com/global-objects.html)
- [Screeps Wiki: CPU](https://wiki.screepspl.us/CPU/)
- [Screeps Wiki](https://wiki.screepspl.us/)
