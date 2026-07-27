# ADR 0082: Full-cost remote portfolio authority

## Status

Accepted

## Context

Phase 3 now has segment-backed room intelligence and deterministic threat-aware route estimates, but
no owner decides whether a remote deserves empire capacity. Selecting a room from source revenue
alone can destroy value after body replacement, spawn opportunity, travel latency, hauling,
reservation, roads, repair, expected loss, and CPU are included. The reserved `remotes` Memory owner
has no owner-local schema or consumer.

The first portfolio slice must not become a reservation, mining, hauling, evacuation, diplomacy,
threat-classification, movement, spawn, contract, or command authority. Those outcomes remain in
issues #58–#62.

## Decision

- `RemotePortfolio` in `packages/bot/src/remotes/portfolio.ts` is the sole persistent remote
  lifecycle, full-cost forecast, ranking, and portfolio-capacity authority. Architecture enforcement
  rejects another declaration, raw `remotes` reads outside runtime composition, and owner writes
  outside this class.
- Candidate evidence contains one current/fresh complete `RoomIntelQueryResult`, one ready
  `RoutePlanResult`, and detached controller availability, donor posture, and threat risk supplied
  by their authoritative owners. The portfolio does not inspect or classify player identities.
- Gross revenue is the sum of observed source `energyCapacity`, converted to milli-energy per tick
  over the official 300-tick regeneration interval. Full cost is the checked sum of nine explicit
  milli-energy-per-tick terms: latency, spawn opportunity, body amortization, hauling, reservation,
  roads, repair, expected loss, and CPU shadow cost. Admission requires positive net value.
- The externally supplied capacity envelope is already subordinate to owned-colony survival and
  defense. It caps energy, spawn ticks, milli-CPU, persistent-memory commitment, and funded remote
  count. It is a portfolio reservation, not a second `BudgetLedger`; later consumers still require
  their normal colony grants, contracts, arbiters, and executors.
- Ranking prefers higher net value, adds one bounded retention margin to an existing active remote,
  and uses room then donor identity as stable tie-breakers. Greedy admission reserves every resource
  dimension atomically or none. Pressure sheds the lower-ranked commitment and releases all four
  reservation dimensions in one owner transition.
- Owner-local schema V1 stores at most 32 canonical room records in 16,384 JSON code units. Exact
  `{}` initializes it. Malformed/future state is preserved and unavailable. Each record is one of
  `candidate`, `probing`, `active`, `threatened`, `suspended`, `cooldown`, or `retired`, with a
  bounded reason, forecast, expiry, evidence revision, and optional exact capacity commitment.
  Replaying the same tick is idempotent; future-tick owner evidence fails closed.
- New positive candidates probe for two consecutive evaluations. Any stale/partial/missing intel,
  route loss, donor pressure, controller conflict, non-positive value, capacity loss, or threat
  releases funded capacity. A threat enters `threatened`; safe evidence must pass the fixed
  three-tick suspension interval and two-evaluation cooldown probe before the objective can become
  active again. Vanished sources and expired objectives retire terminally.
- At most eight candidates and 32 transitions are accepted per tick. Rates, capacities, deadlines,
  identities, owner bytes, and threat values have source ceilings. Outputs are immutable funded
  objectives, dispositions, and one fixed-cardinality metrics record. They contain no intent,
  contract, command, live object, raw owner bytes, room-history array, or player identity.

## Consequences

Issue #57 can prove deterministic positive-only admission, hysteresis, pressure shedding, bounded
state, and reset/reorder equivalence without pretending that remote energy is already produced.
Issues #58–#60 may consume funded objectives through existing budget, contract, spawn, movement, and
executor authorities. Issue #61 may impose stricter operational threat evacuation/resumption terms;
it cannot weaken the portfolio's immediate fail-closed release. Issue #62 owns realized rolling
profit attribution, while this owner retains only the latest admission forecast.

The first implementation is request-driven and command-free. Runtime candidate composition waits for
the reservation/mining consumers that can provide actual post-survival grants; an idle scheduled
system would create no game outcome. `RemotePortfolio.stage` is the sole validated owner-write
boundary for that later composition.

Rollback removes the command-free module and its source policy. Because no runtime system consumes
or stages it yet, existing `remotes` bytes remain `{}`; no creep, reservation, contract, command, or
migration cleanup is required.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Source`](https://docs.screeps.com/api/#Source): center-room sources hold 4,000 energy,
  owned/reserved-room sources 3,000, unreserved-room sources 1,500, and sources regenerate every 300
  ticks. Current observed `energyCapacity` therefore determines the revenue basis without guessing
  reservation state.
- Official [`Creep.reserveController`](https://docs.screeps.com/api/#Creep.reserveController) and
  [`StructureController.reservation`](https://docs.screeps.com/api/#StructureController): each
  active `CLAIM` part adds one reservation tick, reservation caps at 5,000 ticks, and reservation
  restores full source capacity. Reservation execution remains issue #58.
- Official [Creeps](https://docs.screeps.com/creeps.html) and
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn): ordinary creeps live 1,500
  ticks, bodies have at most 50 parts, and spawning consumes three ticks per body part. Body and
  spawn opportunity must therefore be explicit amortized costs rather than free remote inputs.
- Official [`StructureRoad`](https://docs.screeps.com/api/#StructureRoad): road build/hit values
  vary by terrain, roads decay every 1,000 ticks, and creep body-part traffic accelerates decay.
  This slice accepts an explicit roads/repair forecast instead of inventing a tile-road planner.
- Official [`Game.cpu`](https://docs.screeps.com/api/#Game.cpu) and
  [CPU limit](https://docs.screeps.com/cpu-limit.html): current limit, tick limit, and bucket are
  distinct; unused CPU accumulates to 10,000 and optional bursts can still be terminated. The
  portfolio consumes only an externally admitted milli-CPU envelope and never self-admits.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [Reservation](https://wiki.screepspl.us/Reservation/),
  [Vision](https://wiki.screepspl.us/Vision/), and [CPU](https://wiki.screepspl.us/CPU/): community
  terminology and operational risk separate vision, miners, haulers, reservation, roads,
  defense/loss, replacement, and CPU trade-offs. The Wiki informed cost categories only; official
  mechanics and current detached evidence govern.

No predecessor-bot or public-bot source was consulted.
