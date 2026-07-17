# ADR 0027: Observer request and command authority

## Status

Accepted

## Context

An RCL8 observer accepts one room observation intent per tick and exposes the target on the next
tick. Intel, remote, expansion, diplomacy, and operations consumers will compete for that slot.
Allowing a consumer to call `observeRoom` directly would bypass shared authorization, deterministic
selection, live validation, result normalization, and next-tick outcome evidence.

The observer foundation already exists as detached `WorldSnapshot` facts and normalized mature
mechanics. Issue #266 needs the authority boundary without activating later target strategy or the
mature-infrastructure runtime gate.

## Decision

- `ObserverArbiter` is the sole request-to-intent authority. It consumes versioned data-only
  requests, separate current authorizations, normalized mechanics, detached observer capabilities,
  current visibility, and bounded pending receipts.
- Requests carry stable identity/revision, issuer, first-request tick, deadline, minimum acceptable
  observation tick, priority, authorization identity/revision, and source snapshot revision.
  Authorization cannot be self-asserted by the request.
- Inputs are capped at 64 requests, 64 authorizations, 128 mature capabilities including at most 32
  observers, and 64 pending attempts. Duplicate, malformed, stale, expired, unauthorized, missing,
  inactive, insufficient-RCL, and out-of-range work fails closed.
- Selection assigns each policy class an initial 101-point band and adds one point per waiting tick,
  then applies deadline, first-request tick, and stable identity. Thus a waiting request can
  overtake any newly submitted class after at most 707 ticks when its deadline permits.
  Deterministic augmenting-path matching keeps observer use work-conserving. Each observer receives
  at most one typed intent per tick; the shared intent channel retains final exclusive-resource
  arbitration under `observer/{observerId}`.
- Normal range uses the official ten-room Chebyshev room distance from source-controlled mechanics.
  A current `PWR_OPERATE_OBSERVER` effect removes that range restriction, matching current engine
  behavior.
- `ObserverExecutor` is the sole `StructureObserver.observeRoom` caller. It revalidates mechanics
  and capability fingerprints, object identity, ownership, activity, origin, RCL8, target syntax,
  range, and active power effect immediately before one call. Documented return codes pass through
  the shared normalized command-result boundary.
- `OK` creates only a serializable pending receipt. Success requires exact target visibility on the
  next tick. No effect retries at most twice after the initial attempt; late, unauthorized, or
  exhausted evidence cancels fail closed.
- Observer telemetry is a fixed-cardinality read-only projection. It owns neither requests nor
  history.
- This slice adds no persistent owner or tick-graph activation. Issue #267 owns composition and the
  owner-local migration that retains pending receipts atomically; until then the records are pure
  bounded data contracts used by tests and future composition.

## Consequences

Reordered requests and JSON round trips produce equivalent arbitration and settlement. Consumers
cannot overwrite another observer command, treat `OK` as vision, or weaken current authorization.
Later target strategies submit the same request contract instead of adding observer-specific
schedulers or executors.

The authority performs bounded sorting and matching over at most 64 requests and 32 observers. It
adds no persistent Memory by itself and authorizes no factory, power-spawn, market, or nuker
command.

## Mechanics sources

- [Official `StructureObserver`](https://docs.screeps.com/api/#StructureObserver)
- [Official `StructureObserver.observeRoom`](https://docs.screeps.com/api/#StructureObserver.observeRoom)
- [Official engine structure API](https://github.com/screeps/engine/blob/master/src/game/structures.js)
- [Official engine observer intent processing](https://github.com/screeps/engine/blob/master/src/processor.js)
- [Screeps Wiki: Vision](https://wiki.screepspl.us/Vision/)
