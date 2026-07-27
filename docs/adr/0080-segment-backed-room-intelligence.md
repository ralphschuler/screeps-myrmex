# ADR 0080: Segment-backed room intelligence and vision demand

## Status

Accepted

## Context

Phase 3 remote decisions need terrain, sources, controller ownership and reservation, strategic
structures, hostile capability, and recent events after direct vision disappears. `WorldSnapshot` is
current-tick only, heap data disappears on reset, and boot-critical `Memory` must not become a
room-snapshot archive. ADR 0079 already makes `SegmentManager` the sole physical RawMemory-segment
authority.

Screeps room events describe the previous tick. Observer commands provide target-room vision on the
next tick and already pass through the Phase 2 `ObserverArbiter` and `ObserverExecutor`. Room
intelligence therefore needs to preserve temporal meaning without becoming a second observer,
scouting, route, threat, diplomacy, or remote-selection authority.

## Decision

- `IntelService` is the sole historical room-intelligence projection. It registers typed logical
  store `world.room-intel.v1` with `SegmentManager`; it never sees physical segment IDs or raw
  strings and adds no root-Memory owner.
- One logical key is one validated room name. Payload schema V1 contains the shard, room and
  observation tick; validated `0|1|2` terrain; bounded sources, controller and mineral facts with
  explicit mineral-observation completeness; bounded structures including portal destination and
  invader-core deployment evidence; bounded hostile capability; and a scalar-only previous-tick
  event batch. It stores no live object, path, route, task, or strategic decision.
- Every payload is canonical, deeply frozen, and at most 90,000 code units. A room admits at most
  eight sources, 128 structures, 32 hostile creeps, and 64 events. Missing observation adapters or
  any over-cap collection is explicit partial evidence, never silent absence. Malformed or future
  payload schemas are corrupt typed reads and authorize no freshness. V1 is the first payload
  schema, so no historical migration is required; a future shape must increment the typed store
  schema and add an explicit bounded rewrite instead of opportunistically interpreting old bytes.
- Current `WorldSnapshot` evidence always outranks segment history. A caller supplies both
  `maximumAge` and `expiresAfter`; room reads report `current`, `fresh`, `stale`, `expired`, or
  `unknown` plus complete/partial quality. Route reads only classify an already ordered caller-
  supplied room sequence. They do not find, score, or select a route.
- Visible ingestion examines a deterministic rotating window of at most 32 rooms. It re-offers
  pending copy-on-write payloads first, admits at most two writes per tick, and rewrites unchanged
  verified facts no more often than every 25 ticks. A material controller, ownership, reservation,
  terrain, source, mineral, structure, hostile, event, or completeness change bypasses that
  interval. Current vision whose generation is inactive remains a lower-priority bounded write
  candidate after pending, material, corrupt, and missing records, so transient evidence can advance
  without starving manifest population. SegmentManager retains activation, generation, corruption,
  quarantine, fallback, compaction, and eviction authority.
- One `VisionDemandV1` projects either an existing authorized `ObservationRequestV1` or a data-only
  scout request. Its identity is capped at 145 code units so every prefixed derived request remains
  inside the existing 160-code-unit observer boundary. Fresh-enough intel satisfies the demand. A
  valid observer authorization is preferred because it consumes no creep energy or spawn time;
  otherwise scout output requires an externally supplied current BudgetLedger authorization with
  explicit energy, spawn-tick, CPU, and deadline ceilings. IntelService mints no budget and issues
  no command.
- Observer requests continue through the sole existing observer arbiter, executor, pending-attempt
  owner, and next-tick settlement path. Scout requests remain data only until a later Phase 3 leaf
  funds and consumes them through the existing contract, spawn, movement, and action authorities.
- Operational `world.observe-intel` runs after current observation with a 0.5 CPU estimate. It
  publishes an immutable tick-local result before observer composition. A skipped/faulted run clears
  that result to explicit `unavailable`; no remote behavior may infer fresh data.
- Sixteen fixed-cardinality counters report visible/query/freshness/quality/write/refresh outcomes
  on `TickOutcome.intel`. They contain no room, player, payload, or physical-segment identity.
  SegmentManager's existing packed telemetry reports the underlying storage work. No earlier-phase
  gameplay or telemetry gate consumes intel.

`phase3.intel` is not a runtime gameplay feature gate. This slice is an optional observer/storage
substrate that authorizes no remote work. CPU admission, segment readiness, explicit query
freshness, and downstream budget authorization are the fail-closed gates.

## Consequences

Later route and remote portfolio owners can request exact freshness-qualified facts without copying
snapshots into Memory or calling RawMemory. Heap reset only loses reconstructible service objects;
the typed manifest and verified generations remain authoritative. Current ownership changes replace
older ownership only after direct vision, while missing vision leaves prior evidence explicitly
aged.

Room records compete inside the existing 32-entry segment manifest. Pressure can evict lower-value
or older same-class records, so every consumer must tolerate `loading`, `missing`, and `corrupt`.
The two-write copy-on-publish protocol means fresh observations may take several ticks to become a
verified historical generation. Current vision remains available immediately.

Rollback removes `world.observe-intel`, its room payload codec, and the snapshot
event/strategic-structure extensions. Existing segment entries become unregistered optional data and
are eventually evictable; no root schema migration or gameplay commitment requires repair.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Room.getEventLog`](https://docs.screeps.com/api/#Room.getEventLog): parsed events are
  actions from the previous tick and expose event kind, object ID, and event-specific scalar data.
- Official [`StructureObserver`](https://docs.screeps.com/api/#StructureObserver):
  `observeRoom(roomName)` schedules visibility for the next tick and reports typed command errors.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController),
  [`StructurePortal`](https://docs.screeps.com/api/#StructurePortal), and
  [`StructureInvaderCore`](https://docs.screeps.com/api/#StructureInvaderCore): controller
  owner/reservation and strategic-structure fields retained by the V1 record.
- Official [`RawMemory`](https://docs.screeps.com/api/#RawMemory): asynchronous segment constraints
  remain owned by ADR 0079's SegmentManager.
- Screeps Wiki [Vision](https://wiki.screepspl.us/Vision/): code has no room object without vision;
  observer vision arrives on the following tick and must be renewed for continuous observation.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/): vision, route,
  reservation, hauling, invader, invader-core, and player-pressure evidence are distinct remote
  concerns. The article supplied terminology and risk context only; no implementation was copied.
- Screeps Wiki [Memory](https://wiki.screepspl.us/Memory/) and
  [Global reset](https://wiki.screepspl.us/Global_reset/): persistent/heap lifetime and reset
  guidance. Undocumented inactive-segment writes remain unused.
