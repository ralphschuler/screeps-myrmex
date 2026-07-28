# Phase 3 Remote Profitability Evidence

Issue: [#62](https://github.com/ralphschuler/screeps-myrmex/issues/62)

Status: implemented. This leaf proves bounded realized full-cost accounting and portfolio feedback.
It does not claim the complete Phase 3 portfolio soak or schedule autonomous candidate composition.

## Outcome contract

For settled per-remote receipts, the sole `RemotePortfolio` authority:

1. retains a bounded rolling window of harvested/delivered energy, spawn energy/time, travel,
   reservation, construction, repair, CPU, creep loss, and downtime;
2. counts exact owned-sink delivery as revenue and keeps harvested energy as utilization evidence;
3. applies explicit source-controlled shadow prices to time and CPU;
4. exposes profitable, marginal, loss-making, stale, incomplete, and warming-up summaries with
   forecast variance and confidence;
5. feeds qualified loss/staleness/incompleteness into existing portfolio suspension and atomic
   energy/spawn/CPU/Memory release;
6. preserves threat and other safety precedence;
7. rejects malformed, duplicate, conflicting, or over-cap accounting as one atomic batch; and
8. preserves semantic outcomes across collection reorder and heap reset.

## Deterministic evidence

Scenario `phase3/profitability/realized-full-cost-window` runs nine consecutive ticks over three
forecast-positive remotes in warm and reset/reordered variants. Both variants produce equal
outcomes, final V2 owner bytes, and semantic hash; reset metadata changes only the complete
transcript hash.

| Outcome               | Required result                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Rolling qualification | Three complete ticks classify one profitable, one marginal, and one loss-making remote                                               |
| Full attribution      | Spawn energy/time, travel, reservation, construction, repair, CPU, creep loss, downtime, harvest, and delivery enter distinct fields |
| Portfolio feedback    | The loss-making active remote releases its complete commitment with `realized-negative`                                              |
| Threat precedence     | A threatened profitable remote reports `threat-risk`, not an accounting override                                                     |
| Resumption            | Fresh positive windows pass the existing suspension/cooldown probes before active work returns                                       |
| Stale evidence        | Three ticks without a receipt suspend tracked work with `accounting-stale`                                                           |
| Partial evidence      | A current partial receipt suspends tracked work with `accounting-incomplete`                                                         |
| Cap                   | Nine observations reject the entire eight-observation batch with `limit-exceeded` and unchanged owner                                |
| Persistence           | Compact V2 state stays below 32,768 code units and is equal after reset/reorder                                                      |

Focused numeric evidence uses a three-tick window with 60 delivered energy and all cost categories.
It attributes 40,350 milli-energy cost, 60,000 milli-energy revenue, 19,650 milli-energy profit,
6,550 milli-energy/tick realized return, and +2,550 milli-energy/tick forecast variance. Separate
windows prove exact `profitable`, `marginal`, and `loss-making` reason boundaries.

## Budgets and bounds

| Resource                             |              Bound/default |
| ------------------------------------ | -------------------------: |
| Accounting observations per tick     |                          8 |
| Retained accounting remotes          |                          8 |
| Window / samples per remote          | 50 ticks / 50 compact rows |
| Minimum complete evidence            |                   10 ticks |
| Minimum confidence                   |         8,000 basis points |
| Maximum current evidence age         |                    2 ticks |
| Complete remotes owner               |     32,768 JSON code units |
| Portfolio lifecycle records          |                existing 32 |
| Portfolio candidates/transitions     |   existing 8 / 32 per tick |
| Spawn-time shadow price              |      100 milli-energy/tick |
| Travel shadow price                  |       50 milli-energy/tick |
| CPU shadow price                     |   2 milli-energy/milli-CPU |
| New energy, spawn, or command budget |                       none |

The existing candidate commitment retains energy, spawn-time, CPU, and Memory admission. Accounting
creates no grant. Once qualified evidence blocks a remote, `RemotePortfolio` releases every existing
commitment dimension atomically.

## Authority and failure behavior

- Upstream domain owners provide settled, disjoint detached receipts.
- `reduceRemoteAccounting` is a pure reducer owned by `RemotePortfolio`.
- `RemotePortfolio` remains the sole lifecycle, policy-feedback, and `remotes` persistence
  authority.
- Telemetry may observe returned fixed counters and bounded summaries; it does not authorize work.
- Existing budget, contract, logistics, movement, spawn, site, repair, diplomacy, safety, and
  command authorities do not change.

Exact same-tick replay is idempotent. A conflicting replay, duplicate room, invalid number,
malformed owner, future owner or sample, unsafe arithmetic, or cap breach changes no owner and
authorizes no new work. Rings belonging to active, threatened, suspended, or cooling lifecycle
records cannot be evicted to admit a ninth tracked remote; only candidate or retired evidence may be
replaced. Missing evidence becomes stale; partial evidence remains explicit and cannot claim profit.
Expected command failure contributes only when an upstream settled receipt attributes a cost or
loss, so no return code creates phantom delivery or a retry loop here.

Owner-local V1 migrates to V2 with unchanged lifecycle records and empty accounting. Exact `{}`
initializes V2. Rollback to V1 code fails closed on future-owner bytes and starts no new remote
work.

## Mechanics grounding

Exact official contracts, strategic assumptions, Wiki context, and clean-room boundaries are
recorded in [ADR 0088](adr/0088-realized-remote-profitability-accounting.md). Official documentation
governs.

## Validation

```text
npx vitest run packages/bot/test/remote-profitability.test.ts \
  packages/bot/test/remote-portfolio.test.ts \
  packages/scenario-kit/test/phase3-profitability.test.ts
npm run typecheck
npm run check
```

Final repository-wide counts and CI results are recorded in the pull request and issue completion
receipt.

## Residual risk and next gate

The accounting contract is request-driven like the preceding Phase 3 leaves. Issue #63 must compose
current production receipts and run the frozen multi-remote portfolio soak before Phase 3 can pass.
This leaf does not infer market value, expansion ROI, combat value, or hostile causality, and
retains no unbounded history.
