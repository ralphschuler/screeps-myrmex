# Phase 3 Profitable Remote Portfolio Gate Evidence

Issue: [#63](https://github.com/ralphschuler/screeps-myrmex/issues/63)

Status: implemented under the bounded historical Phase 3 continuation exception. The production tick
composes adjacent-room discovery, portfolio selection, donor budgets, contracts, spawn demand,
hauling, safety, evacuation, and accounting feedback through the existing authorities. Phase 3 is
complete. Reactivated #54 remains the sole current autonomous slice and blocks Phase 4 until its
frozen production-runtime outcome is demonstrated.

## Outcome contract

For bounded adjacent neutral remotes, production `runTick` now:

1. queries current/fresh complete intel and creates ready threat-qualified room routes;
2. gives the sole `RemotePortfolio` owner positive-only candidates and an energy, spawn-time, CPU,
   Memory, and count envelope derived after donor survival evidence;
3. submits active objectives through the existing reservation, mining, Logistics, BudgetLedger,
   ContractLedger, population, SpawnBroker, site, lease-agent, movement, action, and executor paths;
4. releases every portfolio dimension before new work under threat, donor workforce loss, CPU
   pressure, route loss, missing vision, negative value, or source disappearance;
5. renews a continuously selected and eligible 1,500-tick objective inside its final 250 ticks,
   while denied, expired, or source-vanished objectives cannot extend their deadlines;
6. opens realized accounting only on exact delivery/loss settlements, attributes full modeled cycle
   travel, CPU, and lifetime-amortized V4/V5/V6 replacement energy/spawn time, and waits five cycles
   before profitability can preempt work;
7. preserves one exact actor per remote-reservation contract and filters same-tick population demand
   when its current budget request disappears; and
8. stages only the portfolio-owned `remotes` transaction before the sole root commit.

Configured self, ally, and NAP exclusions still precede operational threat evidence. The integration
adds no command API, role/task state, route cache, budget ledger, diplomacy owner, or telemetry
strategy reader.

## Deterministic production soak

Scenario `phase3/portfolio/production-threat-profit-soak-v2` executes production
`packages/bot/src/runtime/tick.runTick` for 30 consecutive ticks in each of warm, heap-reset, and
reordered variants: 90 production ticks total. The reset variant reconstructs Memory and modules
twice. Every variant has semantic hash `fnv1a64-utf16:6455a107910840ac` under
`runtime-config-source-v28` and policy revision `fnv1a64-utf16:60656ee428f2f356`.

The matrix begins with two competing adjacent remotes and one available portfolio slot. The
higher-value two-source remote becomes active while the one-source remote remains capacity-blocked.
The sequence then injects:

| Injection                          | Required production result                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Expected spawn energy error        | One typed `ERR_NOT_ENOUGH_ENERGY`; no kernel fault; later remote spawns remain scheduled |
| Credible hostile                   | Primary becomes `threatened`; secondary begins bounded takeover                          |
| CPU pressure                       | Both release capacity with `capacity-cpu`                                                |
| Route closure                      | Primary suspends with `route-unavailable`; secondary resumes after policy probes         |
| Missing current vision             | Primary suspends with `intel-unavailable`; no optimistic operation                       |
| Source-capacity profit reversal    | Primary suspends with `negative-value`; only the profitable secondary remains active     |
| Total owned donor workforce loss   | Both suspend with `donor-pressure`; remote budget publication stops                      |
| Complete primary source loss       | Primary becomes terminal `retired` with `source-vanished`                                |
| Recovery                           | Secondary passes cooldown probes and is the sole final active remote                     |
| Heap reset / collection reordering | Equal decisions, owner bytes, final gameplay state, and semantic hash                    |

The focused production runtime test also executes three consecutive expected remote spawn failures
at the policy boundary, then threat preemption. Planning remains available, the threat releases the
portfolio, and no stale population selection reaches SpawnBroker. Separate composition tests prove
that threat-blocked objectives do not renew, active retained identities and exact donors win the
four-candidate bound, constrained cold boots authorize no route-search CPU, and unstaffed/in-flight
work opens no zero-revenue accounting. Exact settlement attribution records 50 owned-sink energy, 37
amortized body energy, 3 amortized spawn ticks, 104 routed/replacement travel ticks, and 10,000
milli-CPU while excluding lookalike-room and wrong-donor contracts; a missing 100-energy hauler body
is loss without ghost delivery. A five-cycle payback matrix stays warming through the first four
full-cost settlements and becomes profitable only on the fifth.

## Numeric budgets and thresholds

| Measurement                             | Observed maximum/result | Gate bound or outcome                         |
| --------------------------------------- | ----------------------: | --------------------------------------------- |
| Portfolio energy commitment             |            6,800 energy | Must fit donor post-reserve capacity          |
| Portfolio spawn-time commitment         |               312 ticks | Must fit one active donor-spawn envelope      |
| Portfolio CPU commitment                |        300 milli-CPU/tk | Must fit scheduler-derived post-colony budget |
| Portfolio persistent commitment         |        4,352 code units | Must fit source per-candidate bound           |
| Objective lifetime / renewal window     |       1,500 / 250 ticks | Finite timeout with qualified renewal         |
| Accounting window / stale interval      |       1,000 / 250 ticks | At most 50 settlement samples                 |
| Profitability qualification             |        5 settled cycles | No in-flight zero-revenue samples             |
| Active donor budget reservations        |                       5 | Existing BudgetLedger only                    |
| Active V4/V5/V6 remote contracts        |                       6 | Existing ContractLedger only                  |
| Scheduled remote spawn commands         |                       2 | Existing SpawnBroker/SpawnExecutor only       |
| Expected command errors                 |                       1 | Typed; zero kernel faults                     |
| Protected spawn reserve                 |              300 energy | Never reduced by remote work                  |
| `remotes` owner JSON                    |          851 code units | At most 32,768                                |
| Complete persistent root                |            58,076 bytes | Bounded and reset/reorder equivalent          |
| Kernel faults across all three variants |                       0 | Exactly zero                                  |

The realized-accounting dependency remains the full attribution receipt. Its checked scenario
records 60 delivered energy and distinct spawn energy/time, travel, reservation, construction,
repair, CPU, creep loss, and downtime costs; the three-tick example yields 60,000 milli-energy
revenue, 40,350 milli-energy cost, and 19,650 milli-energy profit. See
[`phase3-profitability-evidence.md`](phase3-profitability-evidence.md). The production gate composes
that owner input boundary without treating harvested energy as delivery or telemetry as strategy.

## Authority and failure behavior

- `IntelService` remains the sole historical room-intelligence and freshness projection.
- `RoutePlanner` remains the sole room-route and travel/cost authority.
- `RemotePortfolio` remains the sole lifecycle, forecast, realized-accounting, and `remotes` owner.
- Remote reservation/mining/safety projections and `LogisticsPlanner` emit ordinary budget,
  contract, site, and retreat data only.
- `ColonyDirector`/`BudgetLedger` preempt remote requests when legal donor workforce, reserve, or
  CPU evidence is lost.
- `ContractLedger` classifies V4 reservation population as one exclusive actor. V2/V5 stationary and
  V3/V6 logistics semantics remain unchanged.
- Current budget-request filtering prevents an opening contract view from spawning preempted remote
  work before reconciliation suspends it.
- Existing arbiters and executors remain the only Screeps command callers.

Missing map access, intel, routes, healthy donor workforce, active spawn, post-reserve stored
energy, CPU headroom, controller availability, objective time, or exact grant evidence authorizes no
new remote work. Zero constrained CPU cannot authorize a cold route search. Current expected command
errors settle through existing typed receipts and bounded retry. Heap loss changes route computation
cost only.

## Configuration, rollback, and residual risk

`phase3.portfolio` is source-available under `runtime-config-source-v28` with `phase2.mature` as its
prerequisite. Operational Memory may disable it but cannot enable another gate. Rollback disables
that gate, stops new remote requests, and allows existing V4/V5/V6 work to suspend or expire before
older code is deployed. `RemotePortfolio` V2 bytes remain fail-closed under older V1 code.

Deterministic fixtures do not model MMO scheduling jitter, shard outages, novel hostile strategy, or
a complete healthy RCL8 colony. The Phase 2 production RCL8 soak remains unproved. The maintainer's
bounded 2026-07-27 exception ended at the Phase 3 exit; reactivated #54 now blocks Phase 4,
deployment, and MMO promotion.

## Foundation receipt

Reviewed 2026-07-28:

- Official [Screeps documentation index](https://docs.screeps.com/),
  [`Game.time`](https://docs.screeps.com/api/#Game.time),
  [`Game.cpu`](https://docs.screeps.com/api/#Game.cpu), and
  [CPU limits](https://docs.screeps.com/cpu-limit.html): deterministic tick coordinates and CPU
  limit, tick-limit, and bucket separation.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest),
  [`Creep.pickup`](https://docs.screeps.com/api/#Creep.pickup),
  [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw),
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer), and
  [`Creep.reserveController`](https://docs.screeps.com/api/#Creep.reserveController): distinct
  scheduled work and settlement boundaries; harvest is not owned-sink delivery.
- Official [`StructureSpawn.spawnCreep`](https://docs.screeps.com/api/#StructureSpawn.spawnCreep):
  body energy, spawn-time, expected result, and next-observation behavior remain explicit costs.
- Screeps Wiki [index](https://wiki.screepspl.us/),
  [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [CPU](https://wiki.screepspl.us/CPU/), and [Vision](https://wiki.screepspl.us/Vision/): community
  terminology and operational edge cases for miners, haulers, reservation, replacement, loss,
  vision, and CPU. Official mechanics and MYRMEX settled evidence govern.

No predecessor-bot or public-bot source was consulted.

## Validation

```text
npm exec vitest -- run packages/bot/test/remote-runtime.test.ts \
  packages/scenario-kit/test/phase3-gate.test.ts
npm run check
```

Final repository-wide and CI results are recorded in the pull request and issue completion receipt.
