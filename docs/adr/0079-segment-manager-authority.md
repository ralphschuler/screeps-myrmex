# ADR 0079: Typed SegmentManager authority

## Status

Accepted

## Context

Phase 3 room intelligence needs durable data larger than boot-critical `Memory`, but intelligence,
routes, telemetry, and later analysis must not each call `RawMemory` or maintain competing physical
segment registries. Screeps exposes 100 asynchronous segments, only ten of which may be active in
one tick. Activation applies on the following tick, and a later `setActiveSegments` call replaces
the earlier request. A direct in-place overwrite could therefore destroy the last usable payload
before either the bytes or the persistent manifest is known to be durable.

The `segments` root owner was reserved by the existing Memory schema. It had no owner-local schema
or runtime authority.

## Decision

- `SegmentManager` is the sole typed segment registration, activation, read, write, integrity,
  generation, quarantine, compaction, eviction, and physical-ID authority. IDs referenced by the
  opening manifest are not reusable until a later tick proves their removal committed. Only
  `segments/segment-manager.ts` may reference `RawMemory` segment members.
- Consumers register bounded typed stores and use logical `(store ID, key)` identities. They receive
  only `ready`, `loading`, `missing`, or `corrupt` reads; physical IDs and raw strings remain
  private.
- Owner-local schema V1 stores at most 32 logical entries and 100 quarantine receipts. Each entry
  has one verified current generation, one verified predecessor, and one optional pending
  generation. Exact `{}` initializes V1. A future schema is preserved and unavailable. A malformed
  current manifest is rebuilt empty because segment data is optional/reconstructible; boot continues
  and a bounded recovery count is retained.
- `offered` accepts a write only into bounded current-tick priority arbitration; clients re-offer
  until the typed read is ready because payloads are not duplicated into persistent Memory.
- Writes use copy-then-publish:
  1. allocate a different physical segment and request next-tick activation;
  2. write the complete checksummed envelope only while that segment is active;
  3. retain the old current generation and persist `written` evidence;
  4. re-read and verify the pending envelope on a later active tick;
  5. only then publish it as current and retain the predecessor for fallback.
- A raw write followed by root-commit failure is an untrusted orphan or an idempotent rewrite. It
  cannot replace the manifest's last verified generation. Corrupt current data is quarantined and
  falls back only after the predecessor is active and verified.
- Priority is fixed: safety intel, active operations, active colony/remote data, then optional
  analysis; logical identity is the final tie-breaker. Activation is capped at ten segments, typed
  reads at 64/200,000 code units, pending verification at 100,000 code units, write offers at 32,
  admitted writes at two segments/200,000 code units, and compaction at eight steps per tick.
  Optional and oldest same-class entries are evicted first under bounded pressure.
- Runtime composition adds operational `segments.ingest` in Boot and `segments.reconcile` before the
  root commit. A skipped, unavailable, malformed, or future segment service authorizes no fabricated
  freshness and cannot block Observe, Safety, Execute, root reconciliation, or telemetry.
- Fixed-cardinality telemetry packs the named status/count fields into a fixed-order numeric tuple
  indexed by `SEGMENT_TELEMETRY_INDEX`, preserving the closed Phase 1 byte gate. Logical keys, raw
  payloads, and physical segment IDs are not exposed.

## Consequences

Issue #55 can build room intelligence over one existing typed service instead of becoming a second
raw-memory owner. Heap reset reconstructs the service from the owner manifest and active raw bytes.
Segment latency may delay optional planning by multiple ticks, but missing readiness is explicit.

The two-generation protocol temporarily consumes extra physical capacity and trades write throughput
for rollback safety. The manager deliberately does not rely on the Wiki's undocumented
inactive-segment write behavior. Boot-critical state remains in ordinary `Memory`.

## Mechanics sources

Reviewed 2026-07-26:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [`RawMemory`](https://docs.screeps.com/api/#RawMemory) define asynchronous segment storage,
  automatic end-of-tick persistence, and the 100,000-code-unit documented per-segment limit.
- Official [`RawMemory.segments`](https://docs.screeps.com/api/#RawMemory.segments) and
  [`RawMemory.setActiveSegments`](https://docs.screeps.com/api/#RawMemory.setActiveSegments) define
  next-tick availability, IDs 0–99, the ten-active-segment ceiling, and replacement semantics for
  repeated activation calls.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [Memory](https://wiki.screepspl.us/Memory/), and
  [Global reset](https://wiki.screepspl.us/Global_reset/) provide community terminology and reset
  guidance. The Memory page notes that inactive writes currently work but are undocumented and may
  change; MYRMEX does not use that behavior.
