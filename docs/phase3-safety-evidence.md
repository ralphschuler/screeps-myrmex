# Phase 3 Remote Safety Evidence

Issue: [#61](https://github.com/ralphschuler/screeps-myrmex/issues/61)

Status: implemented. This leaf proves threat-qualified suspension, leased-actor evacuation, cargo
preservation, and cautious resumption through existing authorities. It does not claim realized
rolling profit or the Phase 3 exit.

## Outcome contract

For one active profitable remote:

1. current unexcluded offensive NPC/player evidence, recent attacks, imminent Invader Core
   deployment, unsafe route evidence, excessive detached loss, or insufficient confidence makes the
   candidate unsafe;
2. configured self/ally/NAP actors and move-only scouts do not become threats;
3. `RemotePortfolio` releases every commitment dimension and publishes no active objective;
4. reservation, mining, replacement, hauling acquisition, and remote capital demand stop through
   their existing objective and contract boundaries;
5. current exposed leases suppress their primary action and follow one independently safe return
   route through the existing lease-agent/local-path/movement chain;
6. exact routed V6 delivery already returning to the donor preserves loaded cargo under
   `LogisticsPlanner` ownership;
7. arrival, actor loss, or unavailable safe return emits one bounded `ContractLedger` suspension,
   with a tick-local hold suppressing same-tick ordinary work for arrival/route failure; and
8. fresh complete, zero-risk, sufficient-confidence, bounded-loss evidence must survive the existing
   cooldown and consecutive resumption probes before work becomes active again.

## Deterministic evidence

Scenario `phase3/safety/threat-evacuation-resumption` runs eleven consecutive ticks across warm and
reset/reordered variants. Both variants produce equal outcomes, final owner bytes, and semantic
hash; reset metadata changes only the complete transcript hash.

| Tick outcome      | Required result                                                    |
| ----------------- | ------------------------------------------------------------------ |
| Initial safe pair | `probing → active`                                                 |
| NPC Invader       | `credible-hostile`; commitment released; miner return override     |
| Hostile player    | remains threatened; incomplete retreat continues                   |
| Harmless scout    | `harmless-presence`; suspended retreat continues                   |
| Configured ally   | `excluded-presence`; cooldown retreat continues                    |
| Stale sighting    | `intel-stale`; no active objective; retreat continues              |
| Route-only threat | `route-threat`; threat state and return override                   |
| Threat clears     | donor arrival emits one ordinary evacuated suspension              |
| Fresh safe probes | `suspended → cooldown → active`; no early replacement/capital work |
| Actor loss        | one `remote-safety-actor-lost` suspension; no retry storm          |

Focused tests additionally prove:

- active `ATTACK`, `RANGED_ATTACK`, `WORK`, and `CLAIM` capability is operational threat evidence;
- move-only scouts are harmless and configured allies are fail-closed exclusions;
- unattributed previous-tick attack, imminent/deployed core, route risk, stale/partial evidence, low
  confidence, and excessive detached loss remain distinct bounded reasons;
- an underfunded CPU batch publishes no prefix;
- a threat releases the exact portfolio commitment and feeds no reservation, mining, hauling, spawn
  replacement, or capital proposal;
- a V4/V5/acquire-V6 lease receives at most one reverse-route override;
- a loaded V6 deliver lease already following the safe return route remains Logistics-owned;
- donor arrival, missing actor, and unavailable route settle through ordinary transition reasons,
  while arrival/route-failure holds suppress same-tick ordinary work;
- lease-agent override suppresses the harvest action, uses the existing local path, and performs the
  exact cardinal room crossing at safety priority; and
- malformed, duplicate, over-cap, reset, and reordered inputs fail closed or remain deterministic.

## Budgets and bounds

| Resource                     | Bound/default                                     |
| ---------------------------- | ------------------------------------------------- |
| Safety evidence/assessments  | 8 remotes per call                                |
| Portfolio dispositions       | 32 existing owner records                         |
| Assessment CPU               | 25 milli-CPU per remote; whole-batch admission    |
| Existing lease/actor view    | 64 leases / 64 actors                             |
| Safe return route            | 16 rooms                                          |
| Threat risk                  | source value 1; portfolio source ceiling 10,000   |
| Current intel age            | at most 5 ticks                                   |
| Confidence                   | at least 8,000 basis points                       |
| Detached recent loss         | at most 2,500 basis points for resumption         |
| Invader Core lead            | 100 ticks                                         |
| Evacuation movement priority | 10,000 through the existing arbiter               |
| Energy / spawn               | no new spend; released portfolio dimensions are 0 |
| Persistent Memory            | none; existing remotes/contracts owners unchanged |
| Telemetry                    | fixed counters and bounded reason-coded rows      |

Owned-colony survival, defense, and scheduler admission precede the candidate capacity supplied to
this request-driven projection. CPU denial, over-cap input, missing vision, or missing safe return
cannot publish optimistic work.

## Authority and failure behavior

- `classifyPlayerRelation`: sole configured relation decision and exclusion boundary.
- `IntelService`: current/fresh hostile, event, structure, and completeness evidence.
- `RoutePlanner`: outbound risk and independently safe return-room sequence.
- `assessRemoteSafety`: command-free operational exposure projection only.
- `RemotePortfolio`: sole lifecycle, hysteresis, and abstract capacity owner.
- Reservation/mining/`LogisticsPlanner`: stop or preserve their own work from the active objective.
- `ContractLedger`: sole lease and suspension state authority.
- Lease agent/local path/`MovementArbiter`/executor: sole executable retreat movement chain.

No player identity enters metrics or durable state. Missing or partial evidence suspends rather than
claiming safety. A missing route emits no movement. A missing actor produces one suspension and no
replacement while the portfolio remains inactive. Expected movement/action command failures retain
the existing typed reconciliation and bounded contract retry behavior.

## Mechanics grounding

Exact official contracts and Wiki context are recorded in
[ADR 0087](adr/0087-threat-qualified-remote-evacuation.md). Official documentation governs.

## Validation

```text
npx vitest run packages/bot/test/remote-safety.test.ts \
  packages/bot/test/remote-mining-agent.test.ts \
  packages/scenario-kit/test/phase3-safety.test.ts
npm run typecheck
npm run check
```

Final repository-wide counts and CI results are recorded in the pull request and issue completion
receipt.

## Rollback and residual risk

Rollback removes the request-driven assessment, evacuation planner, and tick-local lease travel
override; no persistent schema migration is required. Allow or cancel active retreats before older
code resumes their underlying contracts. A missing safe return route can strand an actor by design;
combat escort and active remote defense remain later Phase 5 work. Realized loss/profit attribution
remains issue #62.
