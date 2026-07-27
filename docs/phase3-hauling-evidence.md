# Phase 3 Remote Hauling Evidence

Issue: [#60](https://github.com/ralphschuler/screeps-myrmex/issues/60)

Status: implemented. This leaf proves loss-aware remote delivery through existing authorities. It
does not claim strict threat evacuation/resumption, realized rolling profit, or the Phase 3 exit.

## Outcome contract

One active profitable remote with current source stock, an owned sink, safe directional routes, and
an exact donor grant:

1. derives required `CARRY`/`MOVE` from production, round trip, and predicted loss;
2. reduces dropped pickup stock by official decay during approach;
3. admits source stock and aggregate owned Store capacity once through `LogisticsPlanner`;
4. emits one routed V6 acquire stage and one independent routed delivery stage;
5. requires the exact body through ContractLedger population and ordinary spawn demand;
6. settles delivery only from exact owned-sink gain corroborated by the live actor's cargo
   reduction, never cargo disappearance or unrelated sink gain alone;
7. advances a monotonic successor cycle after delivery, retains loaded work under sink pressure, and
   fails or replaces bounded work after death, route/endpoint change, command rejection, threat,
   stale evidence, timeout, or budget loss; and
8. preserves outcome bytes across collection reorder and heap reset.

## Deterministic evidence

Scenario `phase3/hauling/loss-aware-routed-delivery` runs eleven bounded ticks across warm and
reset/reordered variants. Its adapter composes production hauling projection, LogisticsPlanner,
contract stages, and `planLogisticsRuntime`; modeled actor cargo and owned-sink observations, rather
than manually assigned delivery/loss counters, drive settlement. Both variants produce equal
outcomes, final world, and semantic hash while reset metadata changes the complete transcript hash.

| Outcome        | Required result                                                        |
| -------------- | ---------------------------------------------------------------------- |
| Budget         | 16 `CARRY` + 16 `MOVE`; 1,600 energy; 96 spawn ticks; 50 milli-CPU     |
| Exact capacity | exact actor is leaseable and a V6 route-backed contract exists         |
| Under/over     | 15/15 is insufficient; 17/17 remains eligible for the 16/16 contract   |
| Drop decay     | 800-unit pile after 40 approach ticks exposes 760 units                |
| Full sinks     | full storage falls back to terminal; no available sink emits no flow   |
| Death/loss     | vanished 800 cargo records zero delivered and one bounded failed stage |
| Route change   | old flow retires and a revision-qualified successor differs            |
| Hostile        | threat risk publishes no budget, edge, contract, or action             |
| Blocked route  | directionally invalid return evidence publishes no work                |
| Delivery       | one routed contract delivers 800 observed units into the owned sink    |

Focused tests additionally prove:

- source and sink reservation through existing LogisticsPlanner limits;
- predicted transit loss increases required capacity before body budget request;
- storage-before-terminal sink policy and aggregate Store capacity identity;
- strict V6 normalization, JSON reset round-trip, exact ContractLedger allocation, and population
  capability projection;
- independent acquire/return cardinal-border movement and bounded withdraw/transfer amounts;
- typed command rejection and route/full-sink suspension;
- delivery continuation with missing remote vision after acquisition;
- sink-baseline partial delivery requires both exact owned-sink gain and live cargo reduction;
- unrelated sink gain, owner loss, and actor death cannot create ghost delivery;
- full-sink pressure retains loaded delivery work under its existing timeout;
- successful and failed cycles advance monotonic issuer coordinates;
- route, production, travel, endpoint, or loss revision retires the old flow before a successor;
- fixed tick-local blocked/idle-source and planned empty/loaded travel counters; and
- unchanged local V3 logistics runtime behavior.

## Budgets and bounds

| Resource                  | Bound/default                                            |
| ------------------------- | -------------------------------------------------------- |
| Objectives / sources      | 8 objectives × 8 sources                                 |
| Budget receipts           | 512                                                      |
| Route evidence            | 16 rooms per direction                                   |
| Body                      | at most 25 `CARRY` + 25 `MOVE`                           |
| Reserved source example   | 10 energy/tick × 80 round-trip = 800 / 50 = 16 pairs     |
| Body energy / spawn       | 1,600 energy / 96 ticks for the example                  |
| Planner CPU reservation   | 50 milli-CPU per source                                  |
| Portfolio Memory forecast | 1,024 code units per source; no new persistent owner     |
| Logistics graph           | existing 128 nodes / 256 edges / 128 admitted flows      |
| Contract owner            | existing 256 active contracts and bounded history        |
| Dropped decay             | `ceil(amount / 1000)` per approach tick                  |
| Persistent telemetry      | none; fixed tick-local metrics and reason dispositions   |
| Travel / idle telemetry   | planned empty/loaded ticks and blocked idle-source count |

Every source decrements the active portfolio energy, spawn, CPU, and Memory envelope before donor
funding. It then needs an exact current colony grant. Owned survival and defense can therefore deny
remote hauling before portfolio admission, donor admission, population demand, or spawn selection.

## Authority and failure behavior

- `RemotePortfolio`: lifecycle, forecast, risk, and abstract capacity.
- `RoutePlanner`: each directional room sequence and travel estimate.
- `LogisticsPlanner`: production/loss body sizing and sole stock/capacity admission.
- `ContractLedger`: V6 persistence, leases, population, stage retirement, and replacement.
- Colony population / `SpawnBroker`: exact body demand and live spawn-slot arbitration.
- Local path / `MovementArbiter`: current-room path and cardinal border movement.
- `CreepActionExecutor`: sole pickup, withdraw, and transfer API calls.

Missing/stale/partial vision, unsafe evidence, no stock, full sinks, unaffordable body, excessive
loss, route drift, timeout, and over-cap input authorize no new pickup. A loaded actor retains its
bounded delivery contract under sink pressure and may finish at the exact current owned sink after
remote vision disappears. Exact sink ownership is revalidated. A dead actor's cargo is loss, not
delivery; unrelated sink gain is not credited. No room name or player identity enters
fixed-cardinality metrics.

## Mechanics grounding

Exact official contracts, formulas, Wiki context, and clean-room boundaries are recorded in
[ADR 0085](adr/0085-loss-aware-remote-hauling.md). Official documentation governs.

## Validation

```text
npx vitest run packages/bot/test/remote-hauling.test.ts \
  packages/bot/test/remote-hauling-agent.test.ts \
  packages/bot/test/logistics-runtime-e2e.test.ts \
  packages/scenario-kit/test/phase3-hauling.test.ts
npm run typecheck
npm run check
```

Final repository-wide counts and CI results are recorded in the pull request and issue completion
receipt.

## Rollback and residual risk

Before rollback, cancel or expire every V6 contract; older code rejects that execution shape and
fails the contracts owner closed. No root or owner-local schema migration is required. Remote
portfolio/mining/hauling remain request-driven until an authorized later runtime composition
supplies candidates and grants. Strict retreat/resumption remains #61. Realized full-cost rolling
profit, idle travel, downtime, and attributed hostile loss remain #62 rather than becoming a second
persistent telemetry owner here.
