# Phase 3 Threat-Aware Route Evidence

Issue [#56](https://github.com/ralphschuler/screeps-myrmex/issues/56) adds one bounded
route-planning authority over current map topology, freshness-qualified room intelligence,
authoritative relation and threat projections, and explicit request budgets. It does not select or
fund a remote, issue a movement command, or create a persistent reservation.

## Observable outcome

For the same detached evidence, `RoutePlanner` selects the same fresh safe room sequence after input
reordering or heap reset. Highway, terrain, relation, and threat policy affect cost without
weakening freshness or risk gates. A route through stale/partial evidence is `stale-route`; a fresh
route above the request risk ceiling is `unsafe-route`; closed/protected/disconnected graphs return
`no-route`; and CPU, expansion, total-cost, result-size, and deadline denial return bounded typed
outcomes.

A ready plan contains entered room names, total cost, aggregate risk, conservative outbound/return
and round-trip ticks, capacity throughput, terrain steps, and abstract road body-part-step exposure.
The origin is excluded and destination included. No result contains a player identity, live game
object, path, command, budget grant, or persistent commitment.

## Authority and data flow

- Current map facts: `packages/bot/src/world/routes/topology.ts` — bounded caller-selected
  `describeExits`/`getRoomStatus` observation only.
- Historical facts: existing `IntelService`; current/fresh complete evidence is required for a ready
  route.
- Diplomacy/threat: caller supplies only authoritative relation and bounded threat score; routing
  does not inspect or classify identities.
- Policy: immutable `packages/bot/src/world/routes/policy.ts`; operational Memory cannot alter route
  safety/cost terms before a remote candidate owner exists.
- Selection/cost/estimate owner: `packages/bot/src/world/routes/planner.ts` — `RoutePlanner`.
- Heap cache: `world.route-plan.v1`, registered only through
  `packages/bot/src/world/routes/cache.ts`.
- Persistent Memory: none.
- Commands/intents/contracts/reservations: none.
- Telemetry: one fixed `RoutePlanMetrics` record per request with reason, expansions, considered
  edges, cache hits, route-room count, cost, and risk.

The authority is request-driven rather than a static tick system because issue #57 does not yet
produce remote candidates. A later admitted owner supplies requests and its existing scheduler CPU
allowance; adding an idle system now would produce no outcome and create a second work owner.

## Fixed budgets

| Resource                         |            Bound |
| -------------------------------- | ---------------: |
| Valid requests per tick          |                8 |
| Evidence rooms per request       |               64 |
| Exits per room                   |                4 |
| Entered route rooms              |               16 |
| Expanded search states           |               64 |
| Threat-risk scalar               |           10,000 |
| Deadline horizon                 |     50,000 ticks |
| Encoded plan                     | 8,192 code units |
| Cold-search admission            |    250 milli-CPU |
| Route cache entries              |               64 |
| Route cache TTL                  |         25 ticks |
| Modeled crossing steps per room  |               50 |
| Persistent Memory                |          0 bytes |
| Energy/spawn/mineral expenditure |                0 |
| Runtime commands                 |                0 |

Request budgets may reduce expansion, route-room, risk, total-cost, and result-size ceilings. CPU
below the fixed cold-search estimate still permits a validated cache hit but cannot start search.

## Executable proof

| Outcome                                                                                | Evidence                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Current `Game.map` exits/status are bounded, sorted, and detached                      | `packages/bot/test/route-planner.test.ts`                            |
| Intel terrain plus authoritative relation/threat become immutable route evidence       | `packages/bot/test/route-planner.test.ts`                            |
| Fresh safe highway route outranks a shorter over-risk route across reorder/reset       | bot unit test and `packages/scenario-kit/test/phase3-routes.test.ts` |
| Threat revision invalidates cache; a later risk breach returns `unsafe-route`          | `packages/bot/test/route-planner.test.ts`                            |
| Stale, closed, protected, CPU-denied, cost-denied, and expired requests fail closed    | `packages/bot/test/route-planner.test.ts`                            |
| Unboosted body/load and road/plain/swamp evidence produce bounded travel/throughput    | `packages/bot/test/route-planner.test.ts`                            |
| Warm and reset/reordered runs produce equal decisions and semantic hashes              | `packages/scenario-kit/test/phase3-routes.test.ts`                   |
| Cache pressure evicts exactly at its 64-entry bound without changing route correctness | `packages/scenario-kit/test/phase3-routes.test.ts`                   |
| Another `RoutePlanner` declaration is source-rejected                                  | `scripts/test/architecture-boundaries.test.mjs`                      |

The replay executes 14 consecutive ticks. It selects a safe highway/allied route around current
hostile risk, returns typed unsafe and stale outcomes, rejects closed and novice transit, then
admits eight plans per tick until 72 unique plans produce eight deterministic evictions at the
64-entry bound. Reset/reordered variants have equal outcomes, final worlds, and semantic hashes
while transcript hashes differ.

## Research findings

Reviewed 2026-07-27. Material sources and mechanics are recorded in
[ADR 0081](adr/0081-threat-aware-route-planner.md). The implementation follows official `Game.map`,
`PathFinder`, room-status, and movement contracts; Wiki highway, pathfinding, vision, and
remote-harvesting guidance supplies terminology and risk context only.

No predecessor-bot or public-bot implementation was consulted.

## Failure and rollback

- Missing/malformed map facts: topology observation is unavailable; no partial prefix is trusted.
- Missing, stale, expired, partial, corrupt, or future intel: no ready plan.
- Closed/protected room or disconnected graph: no route.
- Risk above request ceiling: no usable plan or reservation.
- CPU/search/cost/result-size/deadline denial: typed deferral; no retry state is stored.
- Cache loss/corruption/expiry/revision mismatch: bounded recomputation from detached evidence.
- Heap reset: empty cache only; route outcome remains deterministic.

Rollback removes `world/routes`, its tests, ADR, and evidence references. No Memory migration,
segment cleanup, contract cancellation, or live command rollback is required. Issue #57 must remain
blocked until another accepted route authority is available.
