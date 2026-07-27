# ADR 0084: Budgeted remote source mining and capital

## Status

Accepted

## Context

ADR 0082 admits profitable remote objectives, and ADR 0083 can reserve their controllers, but no
owner projects an active objective into source extraction. The existing `StaticMiningPlanner` is
intentionally limited to visible owned-room sources and source-defined colony layouts. The only
cross-room contract terms are controller-reservation V4, so a profitable remote cannot move a miner
to a stable source position or recover that miner after loss.

Remote containers and roads are capital. A container costs 5,000 energy, holds 2,000 units, and in
an unowned room loses 5,000 hits every 100 ticks. A road's build cost depends on terrain and traffic
accelerates decay. Building either without current vision, remaining positive value, an exact donor
grant, and global site headroom can strand spend after suspension.

## Decision

- `RemoteMiningPlanner` is the sole active-remote-to-source-extraction and remote-capital
  projection. It is pure and request-driven. `RemotePortfolio` retains lifecycle/profit/capacity
  authority; `ContractLedger`, colony population policy, `SpawnBroker`, movement/action arbiters,
  and executors retain work and command authority.
- Inputs are active exact `RemotePortfolioObjective`/candidate pairs, current or fresh complete room
  intel no older than 25 ticks, one ready matching route, detached controller/donor/threat evidence,
  current donor grants, bounded contract planning evidence, and optional current room facts.
  Missing, partial, stale, unsafe, foreign-controller, mismatched-commitment, expired, unsupported,
  or over-cap evidence emits no new work.
- Observed source `energyCapacity` sets throughput. At the official 300-tick regeneration interval
  and two energy per active `WORK`, the policy requests three `WORK`/three `MOVE` for a 1,500-energy
  source and five/five for a 3,000-energy source. Keeper/center 4,000-energy sources are excluded.
  Every source requires its own exact donor `harvesting-filling` grant: 450 or 750 energy and 50
  milli-CPU. The active portfolio commitment must cover all source body energy, spawn ticks, CPU,
  and bounded contract bytes before any source is admitted.
- Contract execution V5 stores only one immutable RoutePlanner room sequence, conservative outbound
  ticks, exact source/work positions, and `container-or-drop` offload policy. Lease agents reuse the
  V4 cardinal border decomposition and existing local path/movement authority. At the work position,
  zero `CARRY` or a full Store deliberately continues harvest so engine overflow becomes dropped
  energy; a container work tile uses the engine's automatic same-tile dropped-resource collection,
  while a full container leaves the overflow dropped. An empty source waits without completing or
  suspending continuous work.
- Replacement lead is route ticks plus three spawn ticks per body part plus a fixed 25-tick margin.
  A route is rejected when outbound travel plus the 300-tick minimum productive window and safety
  margin cannot fit the 1,500-tick life. `ContractLedger.populationView()` classifies V2 and V5
  semantics—not issuer spelling—as stationary, so population projection consumes one eligible actor
  per stationary objective, stops counting a miner at that full lead, and requests one stable
  successor. Death and route interruption release/suspend through existing contract transitions.
- Existing exact work positions remain stable while legal. Otherwise a canonical adjacent selector
  prefers a current container, then plain over swamp, then y/x. Borders, walls, incompatible
  structures/sites, and private foreign ramparts fail closed.
- Capital requires current-tick detached room vision. A container proposal needs remaining forecast
  profit above its 5,000-energy build plus the source-policy 0.5-energy/tick remote upkeep estimate.
  A road candidate must carry the current route revision, exact source/position/terrain, and bounded
  expected body-part uses; the planner prices the official plain/swamp build cost against explicit
  fatigue-value savings. Missing road-use evidence emits no road. Capital also fits the remaining
  portfolio energy envelope and receives a separate exact `optional-growth` donor grant, but no
  capital authorization exists until the corresponding extraction grant is active.
- Funded capital emits stable `LayoutSiteProposal` data plus a matching typed authorization. The
  existing `ConstructionSiteArbiter` retains the 95-site usable ceiling, two-global/one-room tick
  limits, stable precedence, and receipt backoff. Remote proposals use priority 1,000, after owned
  progression. `ConstructionSiteExecutor` remains the sole `createConstructionSite` caller and now
  revalidates either an exact neutral controller or an exact reservation username also proven to be
  the current bot identity immediately before the call. Controller drift fails without a command.
- Planner bounds are eight objectives, eight sources each, sixteen road candidates and eight capital
  proposals per objective, 512 donor-budget rows, 256 contract rows, 32 transitions, 16 route rooms,
  4,096 code units per contract, and 1,024 portfolio Memory code units per source. Larger suspension
  sets make deterministic 32-transition progress over later ticks rather than discarding the batch.
  Outputs use fixed reason codes and aggregate counters without player or room labels in metrics.
- Expected harvest command failures use `ContractLedger`'s bounded history. At most three command
  failures retry with capped exponential backoff. Actor death and route loss are not command
  attempts. Heap reset loses no task, retry, route, budget, or capital identity.

## Consequences

A funded profitable remote can now produce a spawnable replacement-aware mining contract, traverse
its room route, continue via container/drop fallback, and submit only funded positive-value
container/road capital through the sole global site authority. Collection reorder and heap reset do
not change the outcome. Suspension, source loss, controller drift, route change, site pressure, or
budget loss stops new capital and suspends or replaces exact work without another queue, role, route
cache, or persistent owner.

The planner remains request-driven because autonomous candidate discovery and runtime portfolio
grant composition are not yet scheduled. Issue #60 consumes extraction through the sole
LogisticsPlanner; this slice does not claim delivered energy or completed capital-site construction.
Issue #61 owns stricter evacuation, and issue #62 owns realized rolling profit. Road candidates are
absent unless a current route consumer supplies bounded use evidence; no speculative road network is
inferred. Existing remote sites remain engine state; authorization loss stops new proposals without
adding a second persistent site or cancellation owner.

Rollback removes the request-driven planner, V5 terms, remote site authorization, and tests.
Existing V5 contracts must expire or be cancelled before deploying older code. No root-Memory or
remotes-owner schema migration is required.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Source`](https://docs.screeps.com/api/#Source): unreserved 1,500, owned/reserved 3,000,
  center/keeper 4,000 capacity and 300-tick regeneration.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest),
  [creep movement](https://docs.screeps.com/creeps.html),
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn), and
  [constants](https://docs.screeps.com/api/#Constants): two energy per `WORK`, adjacent harvest,
  body costs, 1,500-tick ordinary life, fatigue, and three spawn ticks per body part.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer),
  [`Resource`](https://docs.screeps.com/api/#Resource), and
  [`Creep.repair`](https://docs.screeps.com/api/#Creep.repair): container cost/capacity/remote
  decay, dropped-resource decay, and repair conversion.
- Official [`StructureRoad`](https://docs.screeps.com/api/#StructureRoad): terrain-dependent build,
  hit, natural-decay, and traffic-wear terms.
- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) and
  [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite): neutral-room road/container
  placement, global site pressure, result codes, and site removal.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/),
  [Reservation](https://wiki.screepspl.us/Reservation/), and
  [Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/): community terminology and
  operational guidance for dedicated miners, replacement, overflow, reservation, and avoiding
  speculative roads.

Official contracts govern. No predecessor-bot or public-bot source was consulted.
