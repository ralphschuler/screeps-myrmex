# ADR 0032: Bounded road and container attrition telemetry

## Status

Accepted. ADRs 0033 and 0034 later advance the nested Phase 2 observer state from V3 through V5
while preserving this attrition contract.

## Context

Phase 2 maintenance telemetry reports demand, funding, and scheduled tower energy but does not
measure the road and container hit loss that maintenance must offset. A final RCL8 soak therefore
cannot compare maintenance capacity with observed infrastructure attrition.

Road and container snapshots expose current hit points and decay timers. They do not expose one
causal event stream. Damage, decay, repair, disappearance, and replacement may occur between two
observations, and road traffic changes the decay timer. Telemetry must not invent causal decay or
repair accounting from a net snapshot delta.

## Decision

- `TelemetryService` remains the sole owner of `Memory.myrmex.telemetry`. No gameplay authority may
  read attrition state or output.
- Phase 2 owner-local schema V3 preserves the V1 sample ring and V2 RCL timing evidence and adds
  attrition schema V1. Its compact field is omitted while no baseline, aggregate, or loss counter
  exists. The root telemetry owner remains V5.
- The observer accepts at most 64 visible owned-colony references and an upper bound of 128 current
  road plus stored-structure candidates before retaining only roads and containers. Exceeding either
  cap rejects the complete batch before asset traversal and increments a saturating dropped-
  observation counter.
- Current roads and containers are represented only by opaque type-qualified asset references,
  opaque colony references, current hits, and maximum hits. Room names, live game objects,
  positions, decay timers, owners, and event causes are not persisted.
- First observation establishes a baseline. Only consecutive observations while the same room
  remains visibly owned may produce outcomes:
  - a stable ID contributes one asset tick, its hit capacity, and its net hit decrease or increase;
  - a prior ID absent from the complete next observation contributes one disappearance and its last
    observed remaining hits to net loss;
  - a new ID in a continuously observed room contributes one addition.
- Lost vision, ownership loss, non-consecutive ticks, changed hit capacity, malformed evidence, and
  opaque-reference collisions interrupt evidence. They cannot report loss, disappearance, or
  addition.
- Two cumulative fixed rows align with `road` and `container`. Their fields are compared asset
  ticks, capacity-hit ticks, hits lost, hits restored, structures lost, and structures added. Tick
  telemetry omits attrition while only a baseline exists and all counters/rows are zero. Published
  rows are net observations, never decay, combat-damage, repair, dismantle, or rebuild claims.
- Input and retained tracks are canonicalized by opaque reference. JSON/global-heap reconstruction,
  reordered observations, and same-tick replay are byte-equivalent and idempotent.
- Whole-owner fitting retains its existing order for history, Phase 2 samples, RCL baselines, and
  RCL aggregates before attrition. If needed, it drops the entire attrition baseline atomically,
  then the fixed rows, before reporter evidence. Baseline and row losses increment fixed counters
  and are reprojected into the current telemetry and status hash.
- Malformed or future attrition state resets attrition evidence only. Valid Phase 2 samples and RCL
  timing remain available. Rollback to schema V2 loses attrition evidence without changing colony,
  maintenance, contract, or command state.

## Consequences

Phase 2 can set deterministic maintenance-loss thresholds using bounded reset-safe net outcomes. The
observer does not explain why hits changed. Disappearance contributes the last visible remaining
hits because those hits left the continuously observed asset set; concurrent dismantle, destruction,
decay, or replacement remains intentionally unattributed.

The reducer inspects at most 128 current assets and 128 retained tracks, plus two fixed rows. Memory
remains within the existing 8,192-byte default whole-owner ceiling. Byte pressure or missing
evidence reduces confidence only and cannot change gameplay.

## Mechanics sources

- [Official Screeps documentation index](https://docs.screeps.com/)
- [Official `Structure.hits` and `hitsMax`](https://docs.screeps.com/api/#Structure.hits)
- [Official `StructureRoad`](https://docs.screeps.com/api/#StructureRoad)
- [Official `StructureContainer`](https://docs.screeps.com/api/#StructureContainer)
- [Official road decay processor](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/roads/tick.js#L8-L31)
- [Official container decay processor](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/containers/tick.js#L8-L31)
- [Official road traversal wear](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/movement.js#L211-L221)
- [Official road constants](https://github.com/screeps/common/blob/2fb779b26eef9b4b0f412584f6bd47c897949766/lib/constants.js#L155-L159)
- [Official container constants](https://github.com/screeps/common/blob/2fb779b26eef9b4b0f412584f6bd47c897949766/lib/constants.js#L339-L343)
- [Screeps Wiki: Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/)
- [Screeps Wiki: Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/)
- [Screeps Wiki: Vision](https://wiki.screepspl.us/Vision/)
- [Screeps Wiki: Structure](https://wiki.screepspl.us/Structure/)
