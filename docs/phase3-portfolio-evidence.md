# Phase 3 Remote Portfolio Evidence

Issue [#57](https://github.com/ralphschuler/screeps-myrmex/issues/57) adds one bounded, command-free
`RemotePortfolio` authority. It admits only positive full-cost objectives within an externally
survival-preempted capacity envelope; it does not yet reserve a controller, spawn or move a creep,
mine, haul, evacuate, or claim delivered profit.

## Observable outcome

For current/fresh complete room intelligence and one ready route, gross revenue is observed source
capacity divided over the official 300-tick regeneration interval. Nine explicit forecast terms are
subtracted: latency, spawn opportunity, body amortization, hauling, reservation, roads, repair,
expected loss, and CPU shadow cost.

A candidate with positive net value probes before becoming active. Equal candidates resolve by
canonical room/donor identity. An active objective receives one fixed retention margin, but a
materially better candidate can still displace it. Energy, spawn-time, CPU, Memory, and funded-count
capacity admit atomically. Threat, stale/partial/missing intel, no ready route, controller conflict,
donor pressure, non-positive value, or capacity loss releases the complete commitment. Safe evidence
must pass suspension and cooldown probes before resumption. Fresh source disappearance and expiry
retire the objective.

The output contains immutable funded objectives, one disposition per retained room, and fixed
counters/totals. It contains no player identity, live object, game command, intent, creep contract,
colony grant, movement path, or realized-profit history.

## Authority and data flow

- Current/historical room facts: existing `IntelService`; the portfolio consumes only typed query
  results.
- Route selection/travel/risk: existing `RoutePlanner`; the portfolio consumes only one ready typed
  result whose origin/destination match the donor/remote.
- Diplomacy, threat, and donor survival: existing owners supply detached controller disposition,
  risk, and donor posture; the portfolio does not derive them.
- Source policy: `packages/bot/src/remotes/policy.ts`; operational Memory cannot broaden it.
- Lifecycle, score, ranking, and capacity owner: `packages/bot/src/remotes/portfolio.ts`.
- Persistence: owner-local V1 in reserved `remotes`; exact `{}` initializes it, and malformed/future
  bytes remain unavailable. `RemotePortfolio.stage` is its only write boundary.
- Budget semantics: the portfolio envelope is abstract post-survival capacity, not a duplicate
  `BudgetLedger`. Every later executable consumer still needs existing grants and authorities.
- Telemetry: one fixed-cardinality tick result with state counts, released commitments, aggregate
  revenue/cost/profit, and four reserved-resource totals.

The authority remains request-driven. Runtime candidate/grant composition is intentionally deferred
until issue #58 or a later operational consumer can supply executable post-survival authorization.

## Fixed budgets

| Resource                                 |              Bound |
| ---------------------------------------- | -----------------: |
| Candidate evaluations per tick           |                  8 |
| Persistent records                       |                 32 |
| State transitions per tick               |                 32 |
| Owner-local JSON code units              |             16,384 |
| Identity code units                      |                128 |
| Candidate deadline horizon               |       50,000 ticks |
| Threat-risk scalar                       |             10,000 |
| Sources per remote                       |                  8 |
| Observed source capacity                 |       4,000 energy |
| Any cost rate                            | 1,000,000,000 mE/t |
| Any abstract capacity dimension          |  1,000,000,000,000 |
| Per-objective Memory commitment          |  16,384 code units |
| Probe / suspension / resumption evidence |    2 / 3 / 2 ticks |
| Runtime game commands                    |                  0 |
| Runtime energy/spawn/mineral expenditure |                  0 |

The caller may reduce every capacity envelope. Persistent owner size is checked after canonical
lowest-value unfunded-candidate and oldest-terminal eviction; committed records are never silently
evicted.

## Executable proof

| Outcome                                                                                    | Evidence                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Official source-capacity revenue minus all nine costs admits only positive value           | `packages/bot/test/remote-portfolio.test.ts`                            |
| Equal score and reversed inputs produce one canonical winner with no partial reservation   | bot unit test and `packages/scenario-kit/test/phase3-portfolio.test.ts` |
| Active retention is hysteretic but yields to a materially better candidate                 | `packages/bot/test/remote-portfolio.test.ts`                            |
| Energy, spawn-time, CPU, Memory, and funded-count limits each fail atomically              | `packages/bot/test/remote-portfolio.test.ts`                            |
| Threat and pressure release capacity; cooldown/resumption are explicit and idempotent      | bot unit test and Phase 3 scenario                                      |
| Stale/partial/missing intel, route loss, donor brownout, and controller conflict fail shut | `packages/bot/test/remote-portfolio.test.ts`                            |
| Fresh source disappearance and timeout retire without ghost commitments                    | bot unit test and Phase 3 scenario                                      |
| Exact `{}` initializes; malformed/future/future-tick/over-cap evidence authorizes nothing  | `packages/bot/test/remote-portfolio.test.ts`                            |
| Every ready result immediately reopens under the same bounded owner-local schema           | `packages/bot/test/remote-portfolio.test.ts`                            |
| Warm and reset/reordered 12-tick runs have equal outcomes, owner bytes, and semantic hash  | `packages/scenario-kit/test/phase3-portfolio.test.ts`                   |
| Sole declaration and raw-owner read/write boundaries are source-enforced                   | `scripts/test/architecture-boundaries.test.mjs`                         |

The scenario starts with two equal profitable remotes under one funded slot, activates the canonical
winner, preempts it on threat, activates the alternative, sheds all work under CPU pressure, resumes
after cooldown, reverses profitability, suspends on stale vision, and retires vanished/expired
candidates. Three simulated heap resets and reversed candidate collections preserve every outcome
and final owner byte.

## Research findings

Reviewed 2026-07-27. Exact mechanics and links are recorded in
[ADR 0082](adr/0082-remote-portfolio-authority.md). Material constraints are the 300-tick source
regeneration and observed reserved/unreserved capacities, finite creep life and spawn time, bounded
controller reservation, traffic-sensitive road decay, explicit vision, and CPU limit/bucket
separation.

No predecessor-bot or public-bot implementation was consulted.

## Failure and rollback

- Malformed/future owner or future-tick record: preserve bytes; publish no objective.
- Duplicate, malformed, over-eight, over-horizon, or over-rate input: reject the complete batch.
- Missing/stale/partial intel or non-ready/mismatched route: release funded capacity and remain
  command-free.
- Donor pressure, controller conflict, threat, or negative full cost: suspend or retain a candidate;
  no later executor receives authorization from this result alone.
- Capacity pressure: rank canonically, reserve every dimension or none, and release displaced work
  idempotently.
- Owner pressure: evict lowest-value unfunded candidates, then oldest retired records; committed
  state is never silently evicted, and overflow otherwise fails closed.
- Same-tick replay or heap reset: no duplicate transition or reservation.

Rollback removes `packages/bot/src/remotes`, its tests, ADR, evidence, and documentation references.
The production runtime has not staged a remote objective, so no controller reservation, creep,
contract, command, or Memory migration requires cleanup. Issues #58–#63 remain blocked until an
accepted portfolio authority exists.
