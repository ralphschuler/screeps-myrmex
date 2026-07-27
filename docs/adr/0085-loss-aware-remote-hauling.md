# ADR 0085: Loss-aware routed remote hauling

## Status

Accepted

## Context

ADR 0084 lets profitable remotes extract into containers or dropped piles, but the production
logistics graph observes only owned rooms and V3 hauling is local-room-only. A remote can therefore
spend mining energy without delivering income. Naive remote hauling also overstates value when
round-trip capacity, drop decay, loaded movement, sink pressure, replacement latency, death, route
change, and expected loss are omitted.

The hauling outcome must extend `LogisticsPlanner`, not create a second flow, population, movement,
route, task, command, or persistent-state authority. It must also avoid treating a dead hauler's
vanished cargo as delivered energy.

## Decision

- `projectRemoteHauling` is a graph-only adapter inside the sole LogisticsPlanner boundary. It
  consumes exact active `RemotePortfolioObjective`/candidate evidence, matching active remote-mining
  dispositions, current remote and donor observations, independently ready donor-to-remote and
  remote-to-donor `RoutePlanner` results, detached predicted-loss evidence, and donor budget
  receipts. It owns no queue, route cache, contract state, actor role, command, or Memory subtree.
- Current/fresh complete intel no older than 25 ticks, a healthy donor, zero threat risk, current
  vision at both endpoints, one active exact mining source, and two directionally valid routes are
  mandatory. Threat, stale or partial intel, route drift, timeout, missing stock, full owned sinks,
  and malformed or over-cap input fail closed with fixed reason codes.
- Pickup prefers current dropped energy on the miner work tile, then its current container. Dropped
  stock is reduced before admission by the official `ceil(amount/1000)` per-tick decay over the
  acquire estimate. Delivery prefers active owned storage, then terminal; complete sink pressure
  publishes no flow. `LogisticsPlanner` still reserves source stock and aggregate Store capacity
  exactly once.
- `LogisticsPlanner` sizes a routed flow from observed source production, acquire plus delivery
  travel, and predicted loss. Required cargo is `ceil(production * roundTrip / (1 - loss))`; one
  unboosted `CARRY` holds 50, and each loaded `CARRY` receives one `MOVE`. More than 25 pairs fails
  closed rather than silently under-hauling. Current pickup amount and sink capacity then cap one
  cycle.
- Every source consumes its energy, spawn-tick, milli-CPU, and Memory dimensions from the active
  portfolio envelope once. It then requests an exact donor `harvesting-filling` budget for the body
  energy and 50 milli-CPU. No edge or contract exists before an exact active grant. Body spawn time
  remains an explicit forecast and later passes through population policy and `SpawnBroker`'s sole
  exact slot authority.
- Contract execution terms V6 extend the existing two-stage logistics identity with immutable
  acquire and delivery room sequences, exact endpoint IDs/positions, recommended body, and the
  delivery sink baseline. `ContractLedger` remains the sole persistence, lease, population, and
  lifecycle owner. Local path planning and cardinal border intents consume the active stage's route;
  `MovementArbiter` and `CreepActionExecutor` remain sole command authorities.
- Delivery settles only from fresh stock gain at the exact still-owned storage/terminal above the
  persisted cycle baseline, capped by the same live actor's observed cargo reduction. Cargo
  disappearance or unrelated sink gain alone can never claim delivery. A dead actor with undelivered
  cargo retires that stage as failed, rebases the sink, and advances a bounded replacement cycle. A
  full sink retains loaded delivery work without authorizing another pickup. If remote vision or the
  pickup disappears after acquisition, an already-loaded actor may continue toward a current owned
  sink; no new acquisition is authorized until the remote flow is admitted again.
- Route, pickup, sink, production, travel, or predicted-loss identity changes create a new stable
  flow identity. The old stage retires before the successor can use the same donor binding. Every
  successful or failed cycle advances the monotonic issuer sequence before another pickup can enter
  ContractLedger. Expected action rejection becomes one ordinary typed suspension; current evidence
  and donor funding are required before reauthorization.
- Bounds are eight objectives, eight mining sources per objective, 512 budget receipts, 16 rooms per
  route leg, 25 `CARRY`/`MOVE` pairs, and existing 128-node/256-edge/128-flow Logistics and
  ContractLedger limits. Metrics are fixed counters plus bounded per-source dispositions with no
  player identity or unbounded label.

## Consequences

A funded profitable remote can now produce one capacity-aware routed pickup/delivery contract, spawn
an exact hauler, collect container or decay-adjusted dropped energy, and deliver it through the
existing authorities. Under-capacity actors cannot lease exact work; exact and larger actors can.
Full sinks, route change, actor death, hostile interruption, reset, and input reorder remain bounded
and deterministic.

This leaf proves delivery mechanics and loss-aware capacity, not strict evacuation/resumption or
realized rolling profitability. Issue #61 owns threat evacuation and cautious resumption; issue #62
owns persistent per-remote realized accounting. The adapter remains request-driven pending later
autonomous candidate/grant composition.

Rollback requires suspending or expiring every V6 contract before older code is deployed. V6 adds no
root or owner-local schema version, but older parsers reject its strict execution shape and
therefore fail the contracts owner closed.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Creep.pickup`](https://docs.screeps.com/api/#Creep.pickup),
  [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw), and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled actions,
  required `CARRY`, partial amount behavior, and empty/full/range/target result codes.
- Official [`Store`](https://docs.screeps.com/api/#Store): one `CARRY` provides 50 general-purpose
  capacity and shared Store free capacity must not be reserved twice.
- Official [`Resource`](https://docs.screeps.com/api/#Resource): a dropped pile loses
  `ceil(amount/1000)` units per tick.
- Official [creep movement](https://docs.screeps.com/creeps.html#Movement) and
  [constants](https://docs.screeps.com/api/#Constants): ordinary 1,500-tick life, loaded `CARRY`
  fatigue, empty `CARRY` weight exemption, body cost, and three spawn ticks per part.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/): community
  terminology and operational guidance for dedicated miners/haulers, round-trip sizing, replacement,
  roads, invaders, and player disruption.

Official contracts govern. Wiki formulas are comparative operational guidance only. No predecessor
or public-bot source was consulted.
