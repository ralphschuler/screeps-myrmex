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
the planner re-fund suspended survival work and cancel a contract whose visible endpoint was
replaced. Raw contract-owner bytes, lease history, and mutation access remain private to the ledger.
Agents still consume only `ContractExecutionView` and submit typed dispositions; executors remain
the sole Screeps API callers.

## Consequences

- A full harvest lease suspends and its stable fill counterpart is re-funded; an empty fill lease
  mirrors this back to harvest on the following reconciliation.
- A vanished or full endpoint is retired deterministically before a replacement binding is used.
- Heap resets retain the loop entirely in the colony and contract authorities.
- `phase1.economy` is source-available under `runtime-config-source-v7`.
