# ADR 0081: Threat-aware room-route planning authority

## Status

Accepted

## Context

Phase 3 remote economics need a stable room route before they can price travel, hauling, road
exposure, risk, or replacement latency. `Game.map.findRoute` exposes current map connectivity, but
its callback does not provide room intelligence, diplomacy, threat freshness, terrain-derived travel
time, or MYRMEX CPU and result-size budgets. `IntelService` deliberately classifies only a
caller-supplied route and cannot select one.

A route implementation must not become another world observer, diplomacy resolver, threat model,
movement authority, remote portfolio, or persistent registry. Heap reset and collection ordering
must not change its selected result.

## Decision

- `RoutePlanner` in `packages/bot/src/world/routes/planner.ts` is the sole room-route selection,
  cost, and body-dependent travel-estimate authority. Architecture enforcement rejects another class
  with that name outside the canonical path.
- `observeRouteTopology` is a bounded world adapter for caller-selected `Game.map.describeExits` and
  `Game.map.getRoomStatus` reads. It canonicalizes at most 64 rooms and emits data only. It does not
  call `findRoute`, select a candidate, or expose the live map object to planning.
- `projectRouteRoomEvidence` combines that topology with one `IntelService` query result and
  caller-supplied authoritative diplomacy relation and threat score. It never classifies a player
  identity or treats the engine's hostile collection as diplomatic authorization.
- The planner searches the supplied directed room graph with canonical neighbors. Queue precedence
  is fresh-and-safe, then fresh-but-over-risk, then stale/partial/unknown; within a class it uses
  total policy cost, hop count, and the complete lexical route as deterministic tie-breakers.
  `closed` rooms always block. `novice` and `respawn` rooms block unless the explicit source policy
  admits protected-room transit.
- Entering a room pays one immutable source-policy base cost, highway discount, terrain-sample cost,
  relation penalty, and bounded threat penalty. Operational Memory cannot broaden these terms and no
  gameplay gate is added before a remote candidate owner exists. A successful route excludes the
  origin and includes the destination. Unsafe, stale, disconnected, expired, CPU-denied,
  search-exhausted, cost-denied, and result-size-denied outcomes remain typed and command-free.
- Travel estimation uses 50 modeled crossing steps per entered room. Terrain evidence is normalized
  into road/plain/swamp steps. For each direction, active unboosted `MOVE` parts remove two fatigue
  per tick; non-`MOVE`/non-`CARRY` parts plus explicitly loaded `CARRY` parts determine weight. The
  result is a conservative surface-group upper bound for outbound ticks, return ticks, round-trip
  capacity throughput, and abstract road body-part-step exposure. Exact tile routing, boosts,
  dynamic occupancy, and tactical movement remain with later refinement and the existing movement
  authority.
- `world.route-plan.v1` is the sole reconstructible heap cache. It holds at most 64 plans for 25
  ticks. Topology, intel, diplomacy, threat, and policy revisions are complete dependency stamps.
  Every cache hit revalidates the current route chain, freshness, status, cost, risk, and travel
  estimate before use. Corrupt, stale, or mismatched values become misses.
- Hard bounds are eight valid requests per tick, 64 evidence rooms per request, four exits per room,
  16 entered route rooms, 64 expanded search states, a 50,000-tick deadline horizon, 8,192 encoded
  plan code units, and 250 milli-CPU of admitted cold-search allowance. Request-specific limits may
  only reduce these ceilings.
- The planner creates no budget, reservation, contract, intent, command, persistent Memory field, or
  telemetry history. Energy and spawn-time budgets are not applicable to this data-only slice. Later
  remote owners must run it inside their existing scheduler and portfolio budgets.

## Consequences

Remote scoring and cross-room movement can consume one immutable route plan and identical travel
terms without implementing competing route caches. Current map status, stale dynamic evidence, risk,
and CPU pressure fail closed before a plan is usable. Reset loses only optional cache quality; the
same detached evidence recomputes the same decision.

The route is an economic room-level estimate, not an executable tile path. `PathFinder` refinement,
portal expeditions, cross-shard routing, tactical breach paths, remote admission, and movement
commands remain later or explicitly excluded work. A later policy revision is required before
boosted or exact mixed-tile fatigue settlement can replace the conservative estimate.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Game.map`](https://docs.screeps.com/api/#Game.map),
  [`Game.map.describeExits`](https://docs.screeps.com/api/#Game.map.describeExits),
  [`Game.map.findRoute`](https://docs.screeps.com/api/#Game.map.findRoute), and
  [`Game.map.getRoomStatus`](https://docs.screeps.com/api/#Game.map.getRoomStatus): cardinal room
  exits, route callback entry costs, `Infinity` exclusion, no-path results, and
  normal/closed/novice/respawn status.
- Official [`PathFinder.search`](https://docs.screeps.com/api/#PathFinder.search): room callbacks,
  bounded operations/rooms, terrain costs, and explicit incomplete results. MYRMEX does not treat a
  partial path as a valid route.
- Official [creep movement](https://docs.screeps.com/creeps.html#Movement): road/plain/swamp fatigue
  factors, two fatigue removed by each active unboosted `MOVE`, and empty `CARRY` parts adding no
  weight.
- Official [Novice Areas](https://docs.screeps.com/start-areas.html#Novice-Areas): protected sectors
  can be isolated, so status alone is not transit authorization.
- Screeps Wiki [Map](https://wiki.screepspl.us/Map/) and
  [Pathfinding](https://wiki.screepspl.us/Pathfinding/): highway and room/tile path terminology.
- Screeps Wiki [Vision](https://wiki.screepspl.us/Vision/) and
  [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/): current vision, route,
  reservation, hauling, invader, and player-pressure concerns are distinct evidence domains.

Official contracts govern. No predecessor-bot or public-bot source was consulted.
