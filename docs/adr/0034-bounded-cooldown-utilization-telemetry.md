# ADR 0034: Bounded cooldown-utilization telemetry

## Status

Accepted

## Context

Phase 2 telemetry exposed command outcomes and settled resource flows but could not show whether
cooldown-bearing economy structures spent their observed capacity ready or cooling down. Counting
commands alone would understate distance- and recipe-dependent lockout. Inferring continuous use
across missing telemetry ticks would fabricate soak evidence, while persisting structure identities
would add unnecessary cardinality and operational detail.

Power spawns and observers have exclusive per-tick action slots but no numeric cooldown property.
Nukers have a numeric cooldown, but launching a nuke is forbidden during Phase 2. Combining these
with economy cooldowns would therefore give unlike rows the same name.

## Decision

- `TelemetryService` remains the sole owner of cooldown history. No planner, director, arbiter,
  executor, or domain-health adapter may consume it.
- Five fixed rows align with the exported order `extractor`, `link`, `terminal`, `lab`, and
  `factory`. Each current row counts visible owned active structure-slots and the subset whose
  current numeric cooldown is positive. Inactive or unknown structures contribute no optimistic
  availability.
- Current and rolling rows report
  `(active structure-ticks, cooling structure-ticks, utilization basis points)`. A zero denominator
  reports null utilization. Basis points are floored deterministically. The tick projection is
  omitted while neither current nor retained samples contain an observed active slot.
- The observer accepts at most 64 owned rooms and the corresponding official structure maxima: 64
  extractors, 384 links, 64 terminals, 640 labs, and 64 factories. Exceeding any cap rejects the
  complete cooldown batch before asset traversal and increments the bounded dropped-input count.
- Rolling evidence reuses the existing maximum-64 Phase 2 sample ring. Its `continuous` flag is true
  only when every retained tick from first through last is present. A gap remains explicit and
  cannot claim a continuous soak.
- The root telemetry owner remains V5. Its nested Phase 2 state advances from V4 to V5 and adds one
  compact fixed cooldown-row field to each sample. The field is omitted when all five rows are zero;
  schema V5 makes that a canonical zero observation rather than missing legacy evidence. V4 samples
  are dropped and counted because their absent cooldown observations cannot be reconstructed as
  zero. RCL timing and attrition evidence are preserved.
- Existing configured history and 8,192-byte whole-owner ceilings remain authoritative. Complete
  Phase 2 samples are still the first nested Phase 2 evidence evicted under byte pressure, and the
  fitted tick output is reprojected from retained samples.
- Power-spawn and observer authority outcomes remain in their existing fixed rows. Nuker cooldown is
  excluded until an authorized later-phase launch policy exists.

## Consequences

The final Phase 2 soak can compare fixed cooldown capacity with observed lockout without dynamic
labels, structure identities, command-causality claims, or another persistent owner. Missing vision,
history migration, byte eviction, or tick gaps reduce evidence only and cannot authorize gameplay.

The metric deliberately measures observed lockout, not useful production. A cooling structure may
have executed valuable or wasteful work; settled flow and industry accounting remain the separate
outcome evidence.

Checked reset, reorder, same-tick replay, gap, migration, cardinality, and bound evidence is in
[`phase2-cooldown-utilization-results.json`](../phase2-cooldown-utilization-results.json).

## Mechanics sources

- [Official `StructureExtractor`](https://docs.screeps.com/api/#StructureExtractor)
- [Official `StructureExtractor.cooldown`](https://docs.screeps.com/api/#StructureExtractor.cooldown)
- [Official `StructureLink`](https://docs.screeps.com/api/#StructureLink)
- [Official `StructureLink.cooldown`](https://docs.screeps.com/api/#StructureLink.cooldown)
- [Official `StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal)
- [Official `StructureTerminal.cooldown`](https://docs.screeps.com/api/#StructureTerminal.cooldown)
- [Official `StructureLab`](https://docs.screeps.com/api/#StructureLab)
- [Official `StructureLab.cooldown`](https://docs.screeps.com/api/#StructureLab.cooldown)
- [Official `StructureFactory`](https://docs.screeps.com/api/#StructureFactory)
- [Official `StructureFactory.cooldown`](https://docs.screeps.com/api/#StructureFactory.cooldown)
- [Official `StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower)
- [Official `StructureObserver.observeRoom`](https://docs.screeps.com/api/#StructureObserver.observeRoom)
- [Screeps Wiki: StructureLink](https://wiki.screepspl.us/StructureLink/)
- [Screeps Wiki: StructureLab](https://wiki.screepspl.us/StructureLab/)
- [Screeps Wiki: StructureFactory](https://wiki.screepspl.us/StructureFactory/)
- [Screeps Wiki: Power](https://wiki.screepspl.us/Power/)
