# Phase 1 Contract Foundation Evidence

Evidence version: `phase1-contracts-v3`

Primary slice: [issue #23](https://github.com/ralphschuler/screeps-myrmex/issues/23)

This document is the evidence contract for persistent capability contracts and bounded workforce
allocation. CI is authoritative for the referenced commit. This slice enables later Phase 1 economy,
spawn, replacement, movement, and creep-action outcomes; it does **not** demonstrate the Phase 1
zero-creep recovery exit condition by itself.

## Outcome matrix

| Outcome                                                    | Evidence                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Exact empty owner initializes owner-local v1               | `contract-ledger.test.ts`, `tick.test.ts`                                   |
| Malformed or future owner content is preserved and faults  | `contract-ledger.test.ts`, `tick.test.ts`                                   |
| Terminal signatures are canonical and identity-bound       | `contract-ledger.test.ts`                                                   |
| Same issuer retry is idempotent; changed terms conflict    | `contract-ledger.test.ts`, `phase1-contracts.test.ts`                       |
| Evicted terminal identities remain retired after reopen    | `contract-ledger.test.ts`                                                   |
| Only declared state transitions are accepted               | `contract-ledger.test.ts`                                                   |
| Live matching BudgetLedger authorization is required       | `contract-ledger.test.ts`, `tick.test.ts`, `phase1-contracts.test.ts`       |
| Grant renewal preserves one contract identity              | `contract-ledger.test.ts`, `phase1-contracts.test.ts`                       |
| One live grant binding authorizes one active contract      | `contract-ledger.test.ts`, owner schema validation                          |
| Revocation suspends work and removes its lease             | `contract-ledger.test.ts`                                                   |
| Unknown funding evidence preserves state without assigning | `contract-ledger.test.ts`, `tick.test.ts`                                   |
| Expiry, cancellation, history, and outcome bounds hold     | `contract-ledger.test.ts`, `phase1-contracts.test.ts`                       |
| Missing or damaged actors release leases before reassign   | `contract-ledger.test.ts`, `phase1-contracts.test.ts`                       |
| Spawning/null-TTL actors and unknown travel fail closed    | `workforce-allocator.test.ts`                                               |
| Exact deadline/TTL equality remains viable through work    | `workforce-allocator.test.ts`, `phase1-contracts.test.ts`                   |
| Equal bids and reordered inputs select deterministically   | `workforce-allocator.test.ts`, `phase1-contracts.test.ts`                   |
| Contract, actor, pair, and safe-idle caps defer safely     | `workforce-allocator.test.ts`                                               |
| `Game.creeps` is the canonical owned-actor inventory       | `world-snapshot.test.ts`                                                    |
| Warm and heap-reset runs preserve contract outcomes        | `phase1-contracts.test.ts`                                                  |
| Only the ledger stages the contracts owner transaction     | `architecture-boundaries.test.mjs`, bundle and dependency checks in `check` |
| Contract reconcile precedes the one mandatory root commit  | `tick.test.ts`, kernel order and mandatory-tail tests                       |
| Skip, stage discard, or root rejection preserves honesty   | `tick.test.ts`                                                              |
| Disabled and prerequisite-blocked gates preserve the owner | `runtime-config.test.ts`, `tick.test.ts`, `phase1-config.test.ts`           |

The named files are assertions, not import smoke tests. Scenario evidence compares outcome hashes
across warm, reset, and reordered-input runs while allowing reset telemetry to differ.

## State and time invariants

- `ContractLedger` is the only contract identity, transition, lease, outcome, and persistence
  authority.
- The root Memory schema remains v3; `contracts.schemaVersion` is independently v1.
- Only exact `{}` initializes the owner-local schema. Malformed v1 or future owner-local content is
  not rebuilt or downgraded.
- A retained terminal signature must decode to the exact canonical request and match the outcome's
  issuer coordinate. Malformed, non-canonical, or mismatched signatures fail owner-open validation
  without rewriting bytes.
- A contract identity is derived from length-prefixed `(issuer, issuerSequence, issuerKey)`
  components. An exact retained retry is a duplicate success; a terms mismatch is an idempotency
  conflict. Each issuer advances a monotonic sequence. The persistent frontier rejects all retired
  coordinates even after their compact outcomes are evicted and the heap resets; unseen late
  coordinates at or below that frontier fail closed.
- The legal transition table is the one recorded in
  [ADR 0004](adr/0004-contract-ledger-and-workforce-authority.md). `assigned` and `active` require a
  lease; terminal outcomes cannot return to the active set.
- A contract stores the stable BudgetLedger key `(owner colony, category, budget issuer)`, not a
  rotating reservation ID. The current tick's exact live reservation is revalidated before funding
  and assignment, so renewal does not change contract identity. That stable key is exclusive among
  active contracts; it cannot authorize a second concurrent contract.
- Missing, pending, consumed, released, or expired authorization rejects funding. Known
  authorization loss suspends funded work and removes a lease. Unknown colony observation authorizes
  no new assignment but preserves the durable commitment.
- `deadline` is inclusive. Contract `expiresAt` and lease `expiresAt` are the first invalid tick.
- A lost or invalid lease records suspension and renewed funding before reassignment only while the
  matching current authorization remains active.
- Terminal overflow removes the oldest outcome by deterministic `(tick, contract ID)` order while
  retaining the issuer retirement frontier. Active work is never silently evicted and retired work
  cannot re-enter.

## Allocation invariants

- `WorkforceAllocator` is pure and receives immutable records plus a travel-estimate interface. It
  cannot read or write Memory and cannot call a Screeps command.
- Actor inventory comes from the immutable world snapshot derived from canonical `Game.creeps`, not
  a duplicate room-local actor list or per-creep task Memory.
- Only body parts with positive hit points contribute capability. Spawning creeps and actors without
  a numeric `ticksToLive` are ineligible.
- Known travel, work, deadline, and remaining life are checked together:

  ```text
  remainingModeledTicks = travelTicks + estimatedWorkTicks
  tick + remainingModeledTicks <= deadline
  ticksToLive - 1 - remainingModeledTicks >= ttlSafetyMargin
  ```

  Reconcile runs after Execute, so the current tick is excluded from a new lease's future lifetime.
  For an incumbent, elapsed modeled travel/work opportunities reduce the remaining estimate. Travel
  evidence is captured by Observe before Execute, so the current modeled opportunity is applied
  before comparing it with the post-Execute schedule; a genuine detected delay raises the estimate.
  Equality passes both checks and remains stable as modeled work progresses. Unknown travel is not
  treated as zero.

- Contract order is priority class, `harvest`, `fill`, remaining work-kind rank, descending numeric
  priority, ascending deadline, then contract ID.
- Actor bids order by switching cost, travel, smallest sufficient capability surplus, smallest
  sufficient remaining-life slack, then actor ID.
- Safe-idle output is a bounded data record. It does not move, park, recycle, or command an actor.
- Pathfinding and travel modeling remain owned by
  [issue #25](https://github.com/ralphschuler/screeps-myrmex/issues/25). Replacement deadlines and
  spawn timing remain owned by
  [issue #27](https://github.com/ralphschuler/screeps-myrmex/issues/27).

## Hard budgets

| Area                               | Limit |
| ---------------------------------- | ----: |
| Active contracts                   |   256 |
| Terminal outcomes                  |   128 |
| Persistent issuer frontiers        |   128 |
| History events per active record   |    16 |
| Issuer requests per tick           |   128 |
| Requested transitions per tick     |   128 |
| Funding entries inspected per tick |   512 |
| Funding owner views per tick       |    64 |
| Active contracts per budget key    |     1 |
| Contracts considered per pass      |    64 |
| Actors considered per pass         |    64 |
| Contract-actor pairs per pass      | 4,096 |
| Safe-idle dispositions per pass    |    64 |

Ledger caps are applied after canonical ordering. Tick-channel capacity is reserved atomically when
each staged producer commits, in deterministic phase/system order: an overflowing producer fails
without publishing a partial batch, while prior safety/lifecycle work and mandatory reconciliation
continue. Ledger overflow is reported as a typed rejection or deferral; neither path authorizes
unbounded work or silent loss of an active commitment. Ledger request/transition counters reset only
when their tick advances, so a warm ledger object and a heap-reopened ledger enforce the same
per-tick bounds.

## Feature activation and ownership

Issue #23 advances the source revision to `runtime-config-source-v3`. Exactly `phase1.colony` and
`phase1.contracts` are source-available; contracts are prerequisite-blocked when colony planning is
disabled. Operational Memory may disable either available gate but cannot activate later work. A
source-v2 receipt is incompatible: a present candidate must revalidate, while a null candidate does
not cause the bot to rewrite stale operator evidence.

Raw `config`, `colonies`, and `contracts` subtrees are absent from the aggregate `StateView`.
`runtime/tick.ts` alone adapts detached authority-owned views, `ContractLedger` alone stages the
contracts transaction, and `state.reconcile` remains the only root commit.

## Mechanics sources

The implementation and boundary tests were constrained by these sources:

- [Screeps API: Game.creeps](https://docs.screeps.com/api/#Game.creeps) defines the name-keyed hash
  of all owned creeps. MYRMEX uses it as the canonical actor inventory before snapshot grouping.
- [Screeps API: Creep.body](https://docs.screeps.com/api/#Creep.body) exposes per-part hit points;
  the same Creep reference defines the spawning and remaining-lifetime fields used by the normalized
  actor record.
- [Screeps API: Creep.getActiveBodyparts](https://docs.screeps.com/api/#Creep.getActiveBodyparts)
  confirms that fully damaged parts do not count as live capability.
- [Screeps Wiki: Pathfinding](https://wiki.screepspl.us/Pathfinding/) records terrain- and
  fatigue-dependent movement, including weight from damaged non-`MOVE` parts. The foundation
  therefore injects a travel estimate and fails closed when none is available instead of inferring
  route time from capability counts.
- [Screeps Wiki: Generic Creeps](https://wiki.screepspl.us/Generic_Creeps/) describes flexible
  creeps assigned from a centrally managed pool. MYRMEX keeps that central assignment principle but
  deliberately stores the durable task in `ContractLedger`, not per-creep Memory.
- [Screeps Wiki: RenewCreep vs SpawnCreep](https://wiki.screepspl.us/RenewCreep_vs_SpawnCreep/)
  describes finite creep lifetime, spawn occupancy, and pre-spawn replacement. This slice checks
  remaining-life feasibility but leaves replacement and spawn policy to issue #27.
- [Screeps Wiki: Combat](https://wiki.screepspl.us/Combat/) likewise documents that a body part only
  contributes while its individual hit points remain above zero.

Official API semantics are authoritative when a community page differs.

## Repository gate

The required command is:

```bash
npm run check
```

It must pass formatting, lint, both TypeScript projects, all deterministic tests, Markdown, the
production bundle graph check, and package staging. GitHub Actions on the issue #23 pull request is
the final merge evidence. Phase 1 remains open until its roadmap exit is demonstrated separately.
