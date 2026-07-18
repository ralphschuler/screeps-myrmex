# ADR 0030: Phase 2 bounded outcome telemetry

## Status

Accepted. ADR 0031 later advances the nested Phase 2 observer state from V1 to V2 while preserving
this sample-ring and direct-outcome contract.

## Context

The complete-colony authorities expose bounded direct status and command receipts, but Phase 2 had
no single deterministic observer projection for progression, reserves, utilization, flow accounting,
or gate inputs. Persisting separate domain histories would duplicate ownership. Using telemetry to
repair missing domain evidence would also make the observer a gameplay authority.

## Decision

- `TelemetryService` remains the sole owner of `Memory.myrmex.telemetry`. Runtime composition passes
  current settled layout and link receipts alongside the existing colony, spawn, mining, logistics,
  maintenance, and industry evidence.
- One fixed Phase 2 projection reports controller progress and downgrade margin, room/spawn
  reserves, construction backlog, source and logistics outcomes, successful link flow, maintenance
  budget and scheduled tower energy, planned terminal transaction energy, and settled
  lab/factory/power output.
- Eleven fixed authority rows—colony, spawn, mining, logistics, layout, links, maintenance,
  resources, labs, mature infrastructure, and observer—report admitted, deferred, and failed counts.
  Energy, generic resource units, spawn ticks, and measured milli-CPU remain distinct budget units.
  Compact tuples align with exported fixed field/identity orders so the complete tick summary
  remains below the existing 8,192-byte telemetry gate without dynamic or ambiguous keys.
- Three modeled identities are explicit: requested logistics equals scheduled plus shortfall;
  successful link sent energy equals delivered plus transfer loss; funded maintenance never exceeds
  its requested cap. A nonzero residual is evidence, never authorization.
- Telemetry owner schema V5 adds one owner-local Phase 2 schema-V1 sample ring. It retains at most
  64 fixed samples and is also limited by the configured history-entry and 8,192-byte default owner
  ceilings. Each sample contains only tick, selected aggregate outcomes, failures, reserve
  violations, and measured milli-CPU. V1–V4 telemetry owners remain readable and rewrite to V5 on
  the next successful telemetry commit.
- Byte fitting removes old hash and Phase 2 history before reporter fingerprints, recovery state,
  and reset baselines. Dropped-sample counts saturate. Malformed or future Phase 2 state is treated
  as absent observer history; it cannot invalidate gameplay owners.
- `TickTelemetry.phase2` is included in the canonical telemetry hash. Equivalent normalized world
  ordering and a JSON Memory round trip produce byte-equivalent current gate inputs and rolling
  aggregates.
- No planner, director, arbiter, executor, or domain-health adapter may consume telemetry. Current
  direct authority outputs remain the only lifecycle inputs.

## Consequences

Phase 2 now has one bounded outcome vocabulary and reproducible gate-input window without adding a
planner, command path, domain owner, or root-memory migration. A heap reset preserves the window
through Memory; loss or byte eviction of observer history reduces historical evidence and increments
a dropped count but cannot change gameplay.

The accounting intentionally distinguishes observations from modeled boundaries. Source extraction
uses reset-safe source deltas; logistics uses cumulative settled contract deltas; link flow uses
successful command receipts; maintenance creep caps and terminal transaction energy remain planned
budget evidence; lab, factory, and power output require their existing exact settlement receipts.
The Phase 2 exit gate must choose numeric pass thresholds before its soak and must not infer
unmodeled stock movement from these counters.

## Mechanics sources

- [Official CPU limit](https://docs.screeps.com/cpu-limit.html)
- [Official `Game.cpu`](https://docs.screeps.com/api/#Game.cpu)
- [Official Control guide](https://docs.screeps.com/control.html)
- [Official `Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps Wiki: CPU](https://wiki.screepspl.us/CPU/)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)
- [Screeps Wiki: Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/)
