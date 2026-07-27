# Phase 3 Room Intelligence Evidence

Issue [#55](https://github.com/ralphschuler/screeps-myrmex/issues/55) adds bounded, segment-backed
room intelligence and freshness-qualified vision demand. It does not select remotes, compute route
costs, or authorize remote gameplay.

## Observable outcome

A current visible room becomes an immutable V1 record containing validated terrain, sources,
controller and reservation, explicitly complete-or-unavailable mineral evidence, strategic
structures, hostile capability, and the previous-tick scalar event batch. Current vision is
immediately `current`; a verified segment generation becomes `fresh`, `stale`, or `expired` only
against the caller's explicit age and expiry limits. Inactive, missing, corrupt, cross-shard,
future-tick, malformed, and future-schema data is `unknown` and cannot become optimistic freshness.

A stale or unavailable room may produce one stable observer request under an existing observer
authorization, or one data-only scout request under an externally supplied BudgetLedger
authorization. Existing observer arbitration, execution, retry, and next-tick visibility settlement
remain authoritative. Intel emits no game command, route choice, threat decision, remote objective,
spawn body, contract, or budget.

## Authority and data flow

- Current facts: `WorldObserver` remains the sole live-room reader.
- Historical owner: `packages/bot/src/world/intel/service.ts` — `IntelService`.
- Segment boundary: typed store `world.room-intel.v1`; `SegmentManager` alone owns physical IDs, raw
  bytes, activation, copy-on-publish generations, quarantine, fallback, and eviction.
- Payload codec: `packages/bot/src/world/intel/room-intel.ts`.
- Current/query view: immutable `IntelRuntimeResult` on `TickContext` and `TickOutcome`.
- Vision input: `VisionDemandV1` with stable identity, freshness, deadline, priority, and optional
  authorization references.
- Observer output: existing `ObservationRequestV1`; existing observer authority remains final.
- Scout output: `ScoutVisionRequestV1`, data only, with exact external budget ceilings.
- Runtime: operational `world.observe-intel`, after mandatory observation, cadence one, 0.5 CPU
  estimate.
- Persistent Memory: zero new root or owner fields. Only the ADR 0079 manifest references payloads.
- Telemetry: 16 fixed counters on `IntelServiceMetrics`; no identities or payload values.

## Fixed budgets

| Resource                                  |             Bound |
| ----------------------------------------- | ----------------: |
| Encoded room payload                      | 90,000 code units |
| Sources per room                          |                 8 |
| Structures per room                       |               128 |
| Hostile creeps per room                   |                32 |
| Previous-tick events per room             |                64 |
| Visible room inputs                       |           64/tick |
| Visible ingestion window                  |     32 rooms/tick |
| Room write offers                         |            2/tick |
| Unchanged verified-facts rewrite interval |          25 ticks |
| Direct room queries                       |           32/tick |
| Route queries                             |            8/tick |
| Rooms per route                           |                16 |
| Aggregate route-room queries              |           32/tick |
| Vision demands                            |           64/tick |
| Vision-demand identity                    |    145 code units |
| Observer or scout authorizations          |      64 each/tick |
| Maximum accepted freshness/expiry horizon |      50,000 ticks |
| Runtime CPU estimate                      |          0.50 CPU |
| New root-Memory bytes                     |                 0 |
| Runtime commands                          |                 0 |

SegmentManager's inherited limits remain 32 logical entries, ten active segments, 64 reads and
200,000 read code units, two writes and 200,000 write code units, 100,000 code units per segment,
and bounded verification/compaction/quarantine work.

## Executable proof

| Outcome                                                                                                                   | Evidence                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Reordered sources, hostiles, structures, and events produce identical V1 bytes                                            | `packages/bot/test/room-intel.test.ts`            |
| Portal, invader-core, controller/reservation, terrain, source, mineral, hostile, and event facts survive codec round trip | room-intel and world-snapshot tests               |
| Over-cap or unavailable collections become explicit partial evidence                                                      | `packages/bot/test/room-intel.test.ts`            |
| Invalid terrain bytes, body aggregates, and nested priority data fail closed                                              | room-intel and Intel-service tests                |
| Current observation outranks history; ready history classifies fresh/stale/expired                                        | `packages/bot/test/intel-service.test.ts`         |
| Inactive generations remain bounded write candidates; material ownership changes bypass unchanged-fact throttling         | `packages/bot/test/intel-service.test.ts`         |
| Missing, loading, corrupt, cross-shard, future, and invalid inputs fail closed                                            | Intel service and codec tests                     |
| Caller-supplied ordered route receives one bounded aggregate freshness/quality result                                     | `packages/bot/test/intel-service.test.ts`         |
| Fresh demand settles; authorized observer or budgeted scout request is stable across reorder                              | `packages/bot/test/intel-service.test.ts`         |
| Runtime composes `world.observe-intel` without making segment readiness boot-critical                                     | `packages/bot/test/segment-runtime.test.ts`       |
| Warm/reset/reordered replay survives visibility loss, corruption, ownership change, and manifest eviction                 | `packages/scenario-kit/test/phase3-intel.test.ts` |
| RawMemory and command boundaries remain source-enforced                                                                   | `scripts/test/architecture-boundaries.test.mjs`   |

The Phase 3 replay runs 51 consecutive ticks at 0.5 modeled CPU per tick. It first publishes one
visible hostile neutral room, reads it after vision loss, corrupts the current generation, emits one
observer and one budget-bounded scout request, ingests a later reservation-owner change, and then
cycles 33 visible rooms through the 32-entry manifest. Two final no-vision ticks activate and read
that room's retained generation, proving the changed reservation owner survived. Warm and
reset/reordered variants have equal ordered outcomes, final worlds, and semantic hashes. At least
one deterministic eviction occurs, while every tick remains inside segment activation/read/write and
intel query/write caps.

## Research findings

Reviewed 2026-07-27:

- Official [`Room.getEventLog`](https://docs.screeps.com/api/#Room.getEventLog) reports
  previous-tick events, so a V1 record stores `eventsObservedAt = observedAt - 1` rather than
  treating events as current actions.
- Official [`StructureObserver`](https://docs.screeps.com/api/#StructureObserver) makes target-room
  vision available on the next tick. `OK` is therefore pending evidence, as already modeled by the
  observer authority.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController),
  [`StructurePortal`](https://docs.screeps.com/api/#StructurePortal), and
  [`StructureInvaderCore`](https://docs.screeps.com/api/#StructureInvaderCore) constrain the stored
  ownership, reservation, destination, level, decay, and deployment fields.
- Official [`RawMemory`](https://docs.screeps.com/api/#RawMemory) leaves segment mechanics under the
  existing typed manager; Intel stores logical values only.
- Screeps Wiki [Vision](https://wiki.screepspl.us/Vision/) distinguishes browser visibility from
  code-visible `Game.rooms` and confirms observer next-tick/continuous-refresh behavior.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/) identifies vision,
  routing, reservation, hauling, invaders, invader cores, and player pressure as distinct remote
  concerns. MYRMEX stores evidence here and defers every decision to later owners.
- Screeps Wiki [Memory](https://wiki.screepspl.us/Memory/) and
  [Global reset](https://wiki.screepspl.us/Global_reset/) support the persistent-segment versus
  reconstructible-heap lifetime boundary.

No predecessor-bot source or public-bot implementation was consulted.

## Failure and rollback

- Missing vision: preserve only age-qualified historical facts; never infer current absence.
- Inactive/pending segment: `loading`; pending writes are re-offered before new keys.
- Corrupt/malformed/future payload: `corrupt`/`unknown`; SegmentManager quarantines the generation.
- Partial room observation: record remains explicitly partial and cannot satisfy a complete-quality
  consumer.
- CPU skip or service fault: runtime publishes `unavailable` empty intel; gameplay authorities
  receive no fresh authorization.
- Authorization loss/expiry: no observer or scout request; no reservation is persisted by Intel.
- Segment pressure: deterministic existing-manager eviction; a later query reports missing.

Rollback removes the optional runtime system and room codec. No Memory migration is required;
unregistered segment payloads are inert and evictable. Later Phase 3 leaves must treat intel loss as
normal and defer, scout, suspend, or retire according to their own frozen outcomes.
