# ADR 0009: Survival-flow planning projection

Status: accepted

## Context

Bootstrap harvesting must alternate one worker between a visible source and an owned spawn or
extension without creating role Memory, spending the emergency spawn reserve, or leaving a suspended
lease permanently stranded after the worker becomes full or empty.

## Decision

`EconomyPlanner` is a pure Plan-time selector. It emits stable harvest and fill demand identities;
`ColonyDirector` remains the only budget authority and `ContractLedger` remains the only persistent
work authority. Economy requests make no energy or spawn claim; their minimum CPU claim is only
valid scheduling metadata, so they never consume the protected recovery energy tranche.

`ContractPlanningView` is a bounded, sanitized projection of active executable contracts. It lets
the planner re-fund suspended survival work and cancel a contract whose visible endpoint
disappeared. A temporary missing workforce suspends rather than retires endpoint demand, so a
replacement worker can reuse its durable contract identity. Survival issuers identify endpoint
demand rather than a particular creep, because `WorkforceAllocator` owns actor selection. The
planner may additionally read `ContractExecutionView` only to retain the actual lease holder's
harvest/transfer phase across partial cargo: harvest continues until full and transfer continues
until empty. The same lease projection classifies upgrade, build, and repair as carried-energy
consumption. A known partial acquire lease remains authoritative until its cargo is full, so a
higher-value consumer cannot create two-energy source/controller trips. Once consumption starts,
survival harvest and pickup are suppressed while the actor still carries energy. An available
survival transfer remains eligible in either phase; the allocator enforces both incumbent guards
against already-funded competing work.

The planning view also exposes bounded detached retirement frontiers. Recurring survival endpoints
retain one active generation or advance exactly to the next frontier coordinate after terminal
evidence; they never reuse sequence 1 or infer a successor from an unrelated contract. Raw
contract-owner bytes, lease history, and mutation access remain private to the ledger. Agents
consume the same execution projection and submit typed dispositions; executors remain the sole
Screeps API callers.

## Consequences

- A full harvest lease suspends and its stable endpoint-scoped fill counterpart is re-funded; an
  empty fill lease mirrors this back to harvest on the following reconciliation.
- Partial cargo does not create one-resource source/sink round trips, and a heap reset reconstructs
  the current batch from ContractLedger rather than actor-local task state.
- A full or inactive endpoint suspends without retiring its reusable issuer coordinate; a confirmed
  visible disappearance retires it deterministically before a replacement binding is used.
- Upgrade, build, and repair cargo drains without source round trips caused by partial capacity.
- Heap resets retain the loop entirely in the colony and contract authorities.
- `phase1.economy` is source-available under `runtime-config-source-v7`.
