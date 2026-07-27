# Phase 3 Remote Mining Evidence

Issue: [#59](https://github.com/ralphschuler/screeps-myrmex/issues/59)

Status: implemented. This leaf proves budgeted remote extraction and positive-value capital; it does
not claim delivered energy, threat evacuation, realized profit, or the Phase 3 exit.

## Outcome contract

One active profitable remote with current/fresh complete source evidence and a ready safe route:

1. requests exact post-survival donor energy/CPU for each source;
2. emits no harvest contract before that grant is active;
3. emits one routed V5 static-harvest contract per funded source;
4. requests a successor before route plus spawn plus safety lead expires;
5. keeps extraction active through container fullness by falling back to dropped energy;
6. submits container/road capital only with current vision, positive remaining value, remaining
   portfolio capacity, and an exact separate donor grant;
7. passes capital through the sole global site arbiter and executor; and
8. suspends or replaces work when source, route, threat, controller, objective, or budget evidence
   fails.

## Deterministic evidence

Scenario `phase3/mining/funded-lifecycle` runs nine bounded ticks across warm and reset/reordered
variants. Both variants produce equal outcome bytes and final world state while complete transcript
hashes differ at reset ticks.

| Tick outcome    | Required result                                                            |
| --------------- | -------------------------------------------------------------------------- |
| budget          | 450-energy unreserved and 750-energy reserved bodies; no unfunded contract |
| authorize       | funded source contracts; capital waits behind extraction funding           |
| capital         | one separately funded, site-authorized container proposal                  |
| full container  | `container-full-drop`; harvest remains continuous                          |
| miner death     | same funded contract re-enters allocation; replacement terms remain stable |
| global site cap | no create-site intent above the 95-site usable ceiling                     |
| route change    | predecessor cancels and exact next contract sequence carries the new route |
| threat          | no new primary work/capital; existing work suspends                        |
| source loss     | no ghost extraction; existing source contract suspends                     |

Focused unit evidence additionally proves:

- canonical adjacent work-position selection and V5 persistence across JSON/global-heap reset;
- production travel estimation plus ledger/allocation of a zero-`CARRY` V5 miner, route approach,
  exact cardinal border crossing, local static positioning, and sole harvest intent;
- zero-`CARRY`, full-Store drop fallback and source-regeneration idle behavior;
- route/source failure plus typed command rejection reconciliation;
- three-attempt command retry exhaustion from bounded ContractLedger history and deterministic
  32-transition progress when larger unsafe sets suspend over multiple ticks;
- stationary population projection and the exact 105-tick five-WORK/five-MOVE replacement edge for a
  50-tick route (50 route + 30 spawn + 25 safety);
- profitable container/road grant requirements, aggregate room-profit conservation, mining-before-
  capital ordering, current route binding, global site headroom, and deterministic input reordering;
- exact neutral/self-reserved controller revalidation at the sole construction-site executor.

## Budgets and bounds

| Resource                       | Bound/default                                                       |
| ------------------------------ | ------------------------------------------------------------------- |
| Objectives per tick            | 8                                                                   |
| Sources per objective          | 8                                                                   |
| Route rooms                    | 16                                                                  |
| Road candidates/capital output | 16 candidates / 8 proposals per objective                           |
| Contract/budget inputs         | 256 / 512                                                           |
| Contract bytes                 | 4,096 code units                                                    |
| Transitions                    | 32 per tick                                                         |
| Reserved source miner          | 5 WORK + 5 MOVE, 750 energy, 30 spawn ticks, 50 milli-CPU           |
| Unreserved source miner        | 3 WORK + 3 MOVE, 450 energy, 18 spawn ticks, 50 milli-CPU           |
| Portfolio Memory commitment    | 1,024 code units per source; no new persistent owner                |
| Container                      | 5,000 build energy plus modeled 0.5 energy/tick unowned-room upkeep |
| Construction sites             | existing 95 usable global, 2/tick global, 1/tick/room, 10/room      |
| Command retry                  | 3 attempts, capped exponential delay                                |

Energy, spawn, CPU, Memory, and source count fit atomically in the active portfolio commitment.
Mining and each capital item then need exact donor grants. No capital authorization exists until its
source extraction grant is active. Owned-room survival and defense therefore preempt every remote
expense twice: before portfolio admission and again at the donor ledger.

## Authority and failure behavior

- `RemotePortfolio`: remote lifecycle, forecast, and abstract capacity.
- `RemoteMiningPlanner`: active objective to extraction/capital data only.
- `ContractLedger`: contract persistence, lease, retry, and outcome authority.
- Colony population / `SpawnBroker`: replacement and exact body/slot selection.
- `RoutePlanner`, local path service, `MovementArbiter`: route and movement authority.
- `ConstructionSiteArbiter` / `ConstructionSiteExecutor`: site limits and sole API call.
- `CreepActionExecutor`: sole harvest command.

The planner owns no root Memory, queue, actor role, route cache, layout, command, or realized-profit
history. Current visible source/container/site facts outrank historical intel. Missing or stale
vision can preserve a valid funded mining contract but cannot authorize capital. Controller or route
drift fails before a site or harvest command. Source depletion waits; source disappearance suspends.

## Mechanics grounding

The exact official and community pages, material formulas, and clean-room boundary are recorded in
[ADR 0084](adr/0084-budgeted-remote-source-mining.md). Official API contracts govern; Wiki pages
supply terminology and operational context only.

## Validation

```text
npx vitest run packages/bot/test/remote-mining.test.ts \
  packages/bot/test/remote-mining-agent.test.ts \
  packages/bot/test/contract-v2-schema.test.ts \
  packages/bot/test/construction-site-executor.test.ts \
  packages/scenario-kit/test/phase3-mining.test.ts
npm run typecheck
npm run check
```

The final commands and repository-wide counts are recorded in PR validation and the issue closure
receipt.

## Rollback and residual risk

Rollback requires cancelling/expiring V5 contracts before older code is deployed; there is no Memory
schema migration. The planner remains request-driven pending autonomous candidate/grant composition.
Remote energy delivery and capital-site build completion are intentionally unproved until #60 and
the Phase 3 gate compose remote logistics. Strict evacuation/resumption is #61, and realized
profitability is #62. Road proposals require explicit bounded current-route usage evidence; absent
evidence creates no road. Existing remote sites are engine state; this request-driven leaf stops new
capital when authorization disappears but does not add a second persistent site or cancellation
owner.
