# Phase 3 SegmentManager Evidence

Issue [#100](https://github.com/ralphschuler/screeps-myrmex/issues/100) establishes the sole typed
RawMemory-segment substrate required by Phase 3 intelligence, routes, portfolio accounting, and the
phase gate. This substrate does not select remotes or satisfy the Phase 3 exit outcome by itself.

## Observable outcome

A typed logical write cannot replace the last verified generation until a later active tick re-reads
and validates the copy. Interrupted owner commits leave only an orphan or idempotently rewritable
pending copy. Corrupt current bytes are quarantined; a previous verified generation becomes readable
only after normal next-tick activation. Optional segment absence remains `loading`, `missing`, or
`corrupt` and never becomes fabricated fresh data.

Runtime composition initializes owner-local schema V1 from exact `{}`, ingests available bytes in
Boot, reconciles writes and activation before the sole root commit, and emits fixed-cardinality
status. Future owner-local schemas remain byte-preserved and unavailable. Malformed current
manifests recover to an empty optional store without blocking boot-critical systems.

## Authority and storage contract

- Sole class: `packages/bot/src/segments/segment-manager.ts` — `SegmentManager`.
- Sole raw API boundary: only that file may reference `RawMemory` segment members.
- Persistent owner: existing root `segments`; owner-local schema V1, no root schema change.
- Consumer interface: bounded typed store registration over logical store/key identities.
- Read states: `ready`, `loading`, `missing`, `corrupt`.
- Publication: allocated → active write → persisted pending receipt → later active verification →
  current/predecessor handoff.
- Runtime systems: `segments.ingest` (Boot, operational, 0.25 CPU estimate) and `segments.reconcile`
  (Reconcile, operational, 0.25 CPU estimate).
- Boot, Safety, Execute, root reconciliation, and telemetry do not depend on optional segment
  readiness.

## Fixed budgets

| Resource                         |              Bound |
| -------------------------------- | -----------------: |
| Physical segment IDs             |     100 (`0`–`99`) |
| Active segments per tick         |                 10 |
| Logical manifest entries         |                 32 |
| Registered typed stores per tick |                 32 |
| Quarantine receipts              |                100 |
| Manifest JSON code units         |             64,000 |
| One raw segment string           | 100,000 code units |
| Typed reads per tick             |                 64 |
| Typed read code units per tick   |            200,000 |
| Pending verification code units  |            100,000 |
| Write offers per tick            |                 32 |
| Admitted writes per tick         |                  2 |
| Raw write code units per tick    |            200,000 |
| Compaction steps per tick        |                  8 |
| Pending generation lifetime      |           10 ticks |
| Quarantine reuse delay           |            5 ticks |

The manifest retains no payload, route, room snapshot, or live object. `offered` means admitted to
this tick's bounded priority arbitration, not durably queued; clients re-offer until the typed read
is ready. Fixed telemetry packs 20 named numeric status/count fields according to
`SEGMENT_TELEMETRY_INDEX`; it exposes neither logical identities nor physical IDs and remains inside
the frozen Phase 1 telemetry-byte gate. Access evidence advances at a 25-tick persistence interval
instead of forcing per-read Memory churn.

## Executable proof matrix

| Outcome                                                        | Executable evidence                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Empty manifest and one-tick-ahead activation                   | `packages/bot/test/segment-manager.test.ts`                            |
| Typed write, active-only raw mutation, later verification      | `packages/bot/test/segment-manager.test.ts`                            |
| Two generations and last-valid predecessor                     | `packages/bot/test/segment-manager.test.ts`                            |
| Corrupt-current/pending overlap preserves predecessor          | `packages/bot/test/segment-manager.test.ts`                            |
| Impossible envelope cannot evict a full valid manifest         | `packages/bot/test/segment-manager.test.ts`                            |
| Interrupted root publication cannot replace current            | bot unit test and `packages/scenario-kit/test/phase3-segments.test.ts` |
| Checksum corruption, quarantine, delayed fallback              | bot unit test and Phase 3 replay                                       |
| Reordered consumers and priority pressure                      | bot unit test and Phase 3 replay                                       |
| Warm/reset semantic equivalence                                | `packages/scenario-kit/test/phase3-segments.test.ts`                   |
| Malformed recovery and future-owner preservation               | bot manager/runtime tests                                              |
| Runtime Boot/Reconcile composition and bounded telemetry       | `packages/bot/test/segment-runtime.test.ts`                            |
| Raw owner isolation from aggregate state                       | `packages/bot/test/state-transactions.test.ts`                         |
| Exact canonical authority; direct and aliased bypass rejection | `scripts/test/architecture-boundaries.test.mjs`                        |

The replay uses ten consecutive ticks and 0.25 modeled CPU per tick. Warm and reset/reordered runs
produce equal worlds, ordered outcomes, and semantic hashes. It includes stable generation
publication, a raw write whose owner commit is interrupted, idempotent continuation, candidate
publication, current corruption, delayed predecessor activation, and exact fallback.

## Research findings

Reviewed 2026-07-26:

- Official [Screeps documentation](https://docs.screeps.com/) and
  [`RawMemory`](https://docs.screeps.com/api/#RawMemory): segments are asynchronous, strings save at
  tick end, and each segment has a documented 100 KB limit.
- Official
  [`RawMemory.setActiveSegments`](https://docs.screeps.com/api/#RawMemory.setActiveSegments): IDs
  are 0–99, at most ten are active, requested data appears next tick, and a later call replaces the
  prior activation request.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [Memory](https://wiki.screepspl.us/Memory/), and
  [Global reset](https://wiki.screepspl.us/Global_reset/): persistent-vs-heap terminology and reset
  guidance. The Wiki's inactive-write note is explicitly undocumented, so the implementation writes
  only an active segment.

Official contracts govern. No predecessor-bot source or public-bot implementation was consulted.

## Failure and rollback

- Raw API unavailable: typed service denies writes and optional systems continue.
- Inactive known data: `loading`; activation is requested within the ten-slot priority plan.
- Unknown logical data: `missing`.
- Corrupt current/pending bytes: quarantine; no publication from failed verification.
- Missing/corrupt predecessor: `corrupt`; consumers rebuild or defer.
- Pending generation that cannot write or verify: bounded timeout and quarantine.
- Manifest pressure: predecessor compaction, then optional/oldest same-class eviction; opening IDs
  are not reusable until a later tick proves that removal committed.
- Future owner schema: preserve bytes and report unavailable.
- Malformed current owner: rebuild empty optional state and increment bounded recovery evidence.

Rollback may remove the two runtime systems and typed service. Existing schema-V1 owner bytes and
raw segments remain inert under old code because the root owner was already reserved. Re-enabling
this implementation reconstructs service from the retained manifest; unindexed raw orphan bytes are
never trusted.
