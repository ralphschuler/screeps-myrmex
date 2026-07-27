# ADR 0083: Budgeted remote controller reservation

## Status

Accepted

## Context

ADR 0082 admits profitable remote objectives but intentionally issues no colony budget, creep
contract, movement, or command. A remote source produces only its lower unreserved capacity unless
its neutral controller is reserved. Reservation work must start early enough to cover spawn and
route latency without permanently occupying spawn time or creating a second remote task system.

The existing `ContractLedger`, workforce allocation, `SpawnBroker`, movement/action arbitration, and
`CreepActionExecutor` already own executable creep work. `RoutePlanner` already supplies a bounded
room sequence and conservative outbound estimate, but local movement previously had no narrow way to
consume that sequence at room borders.

## Decision

- `RemoteReservationPlanner` is a pure, request-driven projection from active
  `RemotePortfolioObjective` plus its exact current/fresh candidate evidence. It owns no persistent
  state. It emits a normal `harvesting-filling` `BudgetRequest`, then emits one
  `WorkContractRequest` only after an exact active donor-colony grant proves the 1,300-energy and
  100-milli-CPU envelope. The portfolio's existing 12-spawn-tick commitment remains the abstract
  preemption gate; `SpawnBroker` still selects and settles the exact live slot.
- Source policy requests two `CLAIM` and two `MOVE` parts. The 1,300-energy, four-part body costs 12
  spawn ticks and has the official 600-tick claim-creep lifetime. Reservation becomes due when
  current ticks are at or below outbound route ticks plus spawn ticks plus a 25-tick replacement
  margin. Work stops at 450 observed reservation ticks. Estimated actions account for one natural
  decay tick by using `CLAIM parts - 1` net growth.
- Current/fresh complete intel no older than 25 ticks, one active portfolio objective, a ready
  matching route, a healthy donor, zero admitted threat risk, a neutral or authoritatively
  self-reserved controller, positive remaining objective time, and complete budget capacity are
  mandatory. Foreign-owned, foreign or policy-protected reservations, stale/partial/missing intel,
  route loss, donor pressure, threat, timeout, or insufficient portfolio/grant capacity fail closed.
- Contract execution terms V4 retain only the target controller, donor origin, immutable ordered
  RoutePlanner room sequence, conservative outbound ticks, 450-tick completion target, and optional
  source-owned sign text. They add no route cache or movement owner.
- A leased reserver follows that room sequence one room at a time. Inside each visible room it uses
  the existing local path service toward one canonical legal border tile. At the border it emits one
  ordinary movement intent for the exact cardinal room transition. `MovementArbiter` admits only an
  adjacent-room, coordinate-preserving border crossing, and `MovementExecutor` remains the sole
  caller of `Creep.move`.
- While the lease is `assigned`, an optional bounded sign uses the same one-primary-action path.
  Successful signing advances the normal contract to `active`; later ticks issue
  `reserveController`. This avoids two commands in one primary-action intent. Sign text is capped at
  the official 100 code units.
- `CreepActionExecutor` is the sole caller of `reserveController` and `signController`. Fresh local
  observation rechecks `CLAIM`, movement capability, controller type, ownership, and
  self-reservation before an intent exists.
- Expected command failure suspends work through the existing typed reconciliation path.
  `ContractLedger` exposes only bounded reservation retry evidence derived from its existing
  history. The planner applies capped exponential backoff and leaves the exact contract durably
  suspended after three command attempts until normal expiry. Reserver death or route interruption
  is not counted as a command attempt and may reuse the same funded contract when current evidence
  becomes safe again.
- Fixed-cardinality planner metrics and reason codes report objective, due, budget, contract,
  suspension, completion, and retry totals without room or player labels.

## Consequences

Profitable active remotes can now obtain a budgeted, spawnable reserver contract and execute
signing, cross-room approach, and reservation through existing authorities. Heap reset loses no task
state: portfolio, colony budget, contract, and observed controller facts remain the only durable
inputs. Collection reordering does not change requests, transitions, or outcomes.

The planner remains request-driven because Phase 3 has no autonomous candidate-discovery source yet.
Issue #59 may consume the same funded remote objectives for mining; it may not duplicate
reservation, route, movement, contract, spawn, or action authority. Exact tile routing across
multiple rooms is still decomposed into current-room local searches; a missing legal exit suspends
rather than inventing a cross-room path.

Rollback removes the reservation planner, V4 reservation terms, cardinal border admission, and the
new action cases. Existing V4 contracts then become future/invalid execution evidence and must be
allowed to expire or be cancelled before deploying the rollback. No new Memory owner or root schema
migration exists.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Creep.reserveController`](https://docs.screeps.com/api/#Creep.reserveController): range
  one, active `CLAIM` requirement, one reservation tick per part, 5,000-tick cap, and documented
  result codes.
- Official [`Creep.signController`](https://docs.screeps.com/api/#Creep.signController) and
  [`StructureController.sign`](https://docs.screeps.com/api/#StructureController.sign): range one
  and 100-code-unit public sign bound.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController) and
  [`StructureController.reservation`](https://docs.screeps.com/api/#StructureController.reservation):
  distinct ownership/reservation username and remaining-tick evidence.
- Official [Creeps](https://docs.screeps.com/creeps.html),
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn), and
  [constants](https://docs.screeps.com/api/#Constants): 600-energy `CLAIM`, 50-energy `MOVE`, three
  spawn ticks per body part, and 600-tick claim-creep life.
- Official [game loop](https://docs.screeps.com/game-loop.html): accepted commands settle into the
  following world observation.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [StructureController](https://wiki.screepspl.us/StructureController/), and
  [Vision](https://wiki.screepspl.us/Vision/): community reservation, decay, remote, and visibility
  terminology. Official API contracts govern.

No predecessor-bot or public-bot source was consulted.
