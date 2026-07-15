# ADR 0004: Contract Ledger and Workforce Authority

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Phase 1 needs durable, idempotent work commitments before economy planners, spawn policy, movement,
and creep execution can coordinate safely. A contract may outlive a creep or the JavaScript heap,
and issuer retries must not create duplicate work. Assignment also needs deterministic behavior when
multiple contracts and creeps compete under a bounded CPU budget.

Storing a task in each creep's Memory would split authority between actors, issuers, and recovery
logic. Letting an allocator write persistence would mix a pure matching decision with state-machine
ownership. Both designs would make lease recovery, global reset equivalence, and conflict handling
ambiguous.

This change activates a new persistent authority and an owner-local schema, so it requires an ADR.

## Decision

### Contract authority

`ContractLedger` is the sole authority for contract identity, state transitions, leases, terminal
outcomes, validation, and persistence in the `contracts` owner subtree. Issuers submit desired work
with a stable `(issuer, issuerSequence, issuerKey)` identity. The sequence is monotonic within each
bounded issuer authority. The ledger derives a collision-free length-prefixed ID. An identical retry
is idempotent; different terms under an existing identity are rejected as an idempotency conflict. A
persistent per-issuer retirement frontier records the highest terminal sequence. Once compact
outcome history evicts a record, any request at or below that frontier still fails closed rather
than recreating work; new logical work advances the sequence.

The legal transitions are:

| From        | Allowed next states                                        |
| ----------- | ---------------------------------------------------------- |
| `proposed`  | `funded`, `cancelled`, `expired`                           |
| `funded`    | `assigned`, `suspended`, `cancelled`, `expired`            |
| `assigned`  | `active`, `suspended`, `cancelled`, `expired`, `failed`    |
| `active`    | `completed`, `suspended`, `cancelled`, `expired`, `failed` |
| `suspended` | `funded`, `cancelled`, `expired`, `failed`                 |

`completed`, `cancelled`, `expired`, and `failed` are terminal. An assigned or active contract must
have one lease. Losing that lease records `suspended` and then `funded` before the work may be
reassigned, but only while the current BudgetLedger authorization remains valid.

### Budget authorization

Budget funding is not a producer assertion. Each contract persists a stable BudgetLedger binding
consisting of its owning colony, category, and budget issuer. `contracts.reconcile` adapts the
current tick's immutable `ColonyDirector` reservations into a consumer-owned funding view. A
requested `proposed|suspended -> funded` transition is accepted only when that view contains the
exact matching entry, the owner is a currently visible colony, the entry is `active`, and its expiry
has not passed. Direct ledger calls without the funding view are rejected.

The stable binding is exclusive among active contracts: one live BudgetLedger issuer grant may
authorize one active contract. A second identity using the same owner/category/issuer tuple is
rejected until the first becomes terminal. Reservation revision renewal continues to authorize that
same contract.

The live reservation ID and revision are deliberately not part of the contract request signature.
BudgetLedger may renew or supersede a reservation under the same stable issuer key without creating
a second contract or an idempotency conflict. Missing, pending, consumed, released, or expired
entries deny funding. Loss of known authorization suspends funded work and removes an assigned or
active lease without automatically returning it to `funded`. Unknown colony observation or an
unavailable colony result authorizes no new funding or assignment, but does not invent revocation
evidence or rewrite the preserved commitment.

Deadlines are inclusive. `expiresAt` is the first invalid tick for both contracts and leases. A
modeled completion exactly on the deadline and available future life exactly equal to the configured
safety margin are viable. Because assignment occurs after Execute, feasibility excludes the current
tick from a newly assigned actor's available life. An incumbent lease deducts elapsed modeled
travel/work opportunities instead of charging the original work estimate again every tick. Its
current travel evidence is captured before Execute, so reconciliation applies the modeled current
opportunity before comparing it with the lease's post-Execute schedule.

### Persistence and failure behavior

The `Memory.myrmex` root remains schema v3. `ContractLedger` owns an independent schema v1 inside
the existing `contracts` owner:

```ts
interface ContractLedgerStateV1 {
  readonly schemaVersion: 1;
  readonly active: readonly WorkContractRecord[];
  readonly issuerFrontiers: readonly ContractIssuerFrontier[];
  readonly outcomes: readonly ContractOutcome[];
}
```

Only exact `{}` initializes the owner-local schema. A valid v1 subtree is retained. Malformed v1
content and versions newer than v1 fail closed: the system emits a bounded fault and preserves the
subtree rather than rebuilding or downgrading it.

Every retained terminal request signature must decode to the exact canonical request and carry the
same issuer, issuer sequence, and issuer key as its outcome. Malformed, non-canonical, or
identity-mismatched signatures invalidate the owner rather than becoming idempotency evidence.

General `StateView` consumers cannot inspect raw `config`, `colonies`, or `contracts` persistence.
The runtime adapter obtains a frozen detached contracts-owner view from `MemoryManager`, and only
`ContractLedger` may stage the contracts transaction.

The ledger stages a validated owner transaction through `MemoryManager`. Operational
`contracts.reconcile` runs before mandatory-tail `state.reconcile`, which remains the only system
that commits the root. A discarded contract stage or rejected atomic root commit clears its
tick-local publication. The active set is capped at 256, terminal outcomes at 128, persistent issuer
frontiers at 128, history at 16 events per active contract, and issuer requests and requested
transitions at 128 each per tick. One stable budget binding may back one active contract. Each
producer reserves the shared tick-channel capacity atomically when its staged result commits, so an
overflowing producer fails without suppressing prior batches or mandatory lifecycle work. Terminal
overflow evicts the oldest outcomes deterministically but retains the issuer frontier; it never
evicts active work or permits a retired identity to reopen. Quota counters advance with the tick,
independent of whether the same ledger object survives on the heap.

Issue #23 makes `phase1.contracts` source-available with `phase1.colony` as its prerequisite and
advances runtime configuration to `runtime-config-source-v3`. When that effective gate is disabled,
the runtime does not parse, initialize, fund, assign, or stage the contracts owner.

### Allocation policy

`WorkforceAllocator` is a pure, read-only policy. It receives immutable contract records,
snapshot-derived actor records, and an injected travel-estimate view. It returns assignment,
deferral, preservation, and safe-idle proposals. It cannot access `MemoryManager`, live Screeps
objects, or creep Memory, and it cannot issue commands. `ContractLedger` validates and persists any
lease that results.

The allocator evaluates no more than 64 contracts, 64 actors, and 4,096 pairs per pass. Safe-idle
output is capped at 64 actors and remains data only. Contract order is priority class, survival work
kind (`harvest`, then `fill`, then the remaining kind rank), descending numeric priority, ascending
deadline, and contract ID. Actor bids sort by switching cost, known travel, smallest sufficient
capability surplus, smallest sufficient remaining-life slack, and actor ID.

`Game.creeps` is the canonical owned-actor inventory and `WorldObserver` projects it into immutable
room snapshots. Capability uses only active body parts. Spawning creeps and actors with null
`ticksToLive` are ineligible. Unknown travel fails closed. No contract, lease, or task is duplicated
in per-creep Memory.

### Deferred authorities

This decision does not add movement, spawn, or replacement policy. Issue
[#25](https://github.com/ralphschuler/screeps-myrmex/issues/25) owns pathfinding and travel
estimates. Issue [#27](https://github.com/ralphschuler/screeps-myrmex/issues/27) owns replacement
deadlines and spawn timing. Until those slices land, allocation accepts only injected known travel
and does not invent route or lifetime estimates.

## Consequences

- Issuer retries, heap resets, creep loss, and reordered input produce one deterministic contract
  history instead of duplicate work.
- Contract recovery has one fail-closed state owner, while matching remains cheap to replay and unit
  test.
- A rotating BudgetLedger reservation revision preserves one logical contract, while missing or
  revoked current authorization cannot fund or retain a lease.
- CPU and Memory growth are bounded explicitly, at the cost of deterministic deferrals when caps are
  reached.
- A bad owner-local schema cannot be silently erased, so the contract system may stop while the
  mandatory state commit and telemetry tail continue.
- Economy, spawn, movement, and creep-action systems must use the contract channel and ledger views;
  they cannot introduce another task registry or per-creep role state.
- This foundation alone does not satisfy the Phase 1 zero-creep recovery exit condition.
