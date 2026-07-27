# Phase 3 Remote Controller Reservation Evidence

Issue [#58](https://github.com/ralphschuler/screeps-myrmex/issues/58) turns one active profitable
remote objective into just-in-time, budgeted controller reservation work. It uses the existing
colony ledger, contract/workforce/spawn chain, room-route evidence, movement authority, and creep
action executor. It creates no second budget, queue, role, route cache, or persistent owner.

## Observable outcome

For a current/fresh complete neutral or self-reserved controller, reservation becomes due when:

```text
remaining reservation ticks <= route outbound ticks + 12 spawn ticks + 25 safety ticks
```

The source policy requests `[CLAIM, CLAIM, MOVE, MOVE]`: 1,300 energy, four parts, 12 spawn ticks,
and a 600-tick claim-creep lifetime. Two active `CLAIM` parts add two reservation ticks per
successful action; the forecast subtracts one natural decay tick and therefore models one net tick
of growth per action. Work stops after fresh observation reaches 450 reservation ticks.

The planner first requests an exact donor-colony `harvesting-filling` budget. It emits no contract
until an active grant supplies all 1,300 energy and 100 milli-CPU. Portfolio energy/spawn/CPU/Memory
capacity must already contain the same work. `SpawnBroker` remains the only exact
spawn-slot/body/name arbiter.

A leased reserver follows the immutable RoutePlanner room sequence. It uses the existing local path
service toward a canonical current-room exit, then one exact cardinal border movement intent. In the
target room it optionally signs once while assigned, transitions through normal typed settlement,
and issues `reserveController` while active. Only one primary action is emitted per tick.

## Authority and data flow

- Profitability, lifecycle, and abstract capacity: existing `RemotePortfolio`.
- Current/historical controller facts and freshness: existing `IntelService` result in candidate
  evidence.
- Room sequence, risk, and travel estimate: existing `RoutePlanner` result.
- Controller/diplomacy disposition, threat, and donor health: detached evidence supplied by their
  owners; reservation planning never classifies a player.
- Source policy and pure projection: `packages/bot/src/remotes/reservation-policy.ts` and
  `packages/bot/src/remotes/reservation.ts`.
- Energy/CPU authorization: existing donor `BudgetLedger`; the planner consumes only a detached
  grant.
- Persistent work, lease, and retry history: existing `ContractLedger` using execution terms V4.
- Body/name/slot selection: existing `SpawnBroker` and `SpawnExecutor`.
- Local path and room-border admission: existing local path service and `MovementArbiter`.
- Commands: only `MovementExecutor` calls `move`; only `CreepActionExecutor` calls `signController`
  and `reserveController`.
- Outcomes: existing action reconciliation suspends failed or stale work; the planner applies a
  maximum of three command attempts with capped exponential backoff.
- Telemetry: fixed plan counters and stable dispositions; no dynamic room/player metric labels.

## Fixed budgets

| Resource                                   |               Bound |
| ------------------------------------------ | ------------------: |
| Objectives evaluated per tick              |                   8 |
| Detached budget/contract input rows        |           512 / 256 |
| Reservation contracts/transitions per tick |              8 / 16 |
| Route rooms retained per execution term    |                  16 |
| Reservation body                           | 2 `CLAIM`, 2 `MOVE` |
| Body energy / spawn time                   |    1,300 / 12 ticks |
| Claim-creep lifetime                       |           600 ticks |
| Reservation target / API cap               |   450 / 5,000 ticks |
| Replacement safety                         |            25 ticks |
| Maximum verified-intel age                 |            25 ticks |
| Planner/contract CPU authorization         |       100 milli-CPU |
| Encoded contract request                   |    4,096 code units |
| Sign text                                  |      100 code units |
| Command attempts                           |                   3 |
| Retry delay                                |          2–16 ticks |
| Persistent Memory owner                    |          none added |
| Mineral cost                               |                   0 |

## Executable proof

| Outcome                                                                                            | Evidence                                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| No contract exists before exact post-survival funding                                              | `packages/bot/test/remote-reservation.test.ts`             |
| Spawn, route, decay, target, TTL, and Memory terms remain bounded                                  | remote reservation unit test                               |
| Stale/partial/missing intel, route loss, threat, timeout, and blocked controller fail closed       | remote reservation unit/scenario tests                     |
| Death resumes without counting a command attempt; command faults back off and stop at three        | remote reservation unit test and ContractLedger projection |
| Assigned work signs once; active work reserves; foreign reservation and lost `CLAIM` stop commands | `packages/bot/test/remote-reservation-agent.test.ts`       |
| Route terms produce conservative allocation travel from donor/intermediate/target rooms            | `packages/bot/test/local-path-travel.test.ts`              |
| Only exact adjacent cardinal border transitions reach movement execution                           | `packages/bot/test/movement.test.ts`                       |
| Sole command boundary is source-enforced                                                           | `scripts/test/architecture-boundaries.test.mjs`            |
| Warm and reset/reordered lifecycle outputs and final state are equal                               | `packages/scenario-kit/test/phase3-reservation.test.ts`    |

The seven-tick deterministic replay covers initial funding, contract authorization, simulated
reserver death, route loss, safe resumption, observed target completion, and foreign/policy-blocked
controller evidence. It reconstructs the planner heap twice and reverses objectives and budget rows
without changing semantic outcomes.

## Research findings

Reviewed 2026-07-27. Exact links and material mechanics are recorded in
[ADR 0083](adr/0083-remote-controller-reservation.md). `upgradeBlocked` constrains controller
upgrading and safe mode, not `reserveController`; it is therefore not invented as a reservation
blocker. The undocumented exact return code for attempting a foreign reservation is not relied on:
current controller disposition fails closed before command execution.

The configured search backend was unavailable during this run. Exact official and Wiki pages were
opened directly and returned HTTP 200; no remembered mechanic or secondary bot implementation was
used.

## Failure and rollback

- Objective absent, non-active, or underfunded: emit no contract; suspend existing executable work.
- Missing/stale/partial intel or controller: emit no action and preserve no optimistic fact.
- Foreign-owned, foreign-reserved, allied/policy-protected, or inconsistent controller evidence:
  block before contract/action execution.
- Route unavailable, changed, over-risk, or lacking a legal current-room exit: suspend; never
  improvise a room transition.
- Reserver missing or lacking active `CLAIM`/`MOVE`: suspend and re-fund only while the exact
  objective and grant remain current.
- Expected command failure or adapter fault: suspend, back off exponentially, then remain durably
  suspended after three attempts until normal expiry.
- Target reached: complete active work or cancel work that never became active.
- Heap reset and reordered collections: reconstruct from portfolio, grant, contract, route, and
  observation data; no creep task Memory exists.

Rollback removes the planner, policy, V4 reservation terms, cardinal border admission, action cases,
scenario, ADR, and this evidence. Cancel or expire active V4 reservation contracts before deploying
that rollback. No root or owner-local Memory migration is required.
