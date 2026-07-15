# ADR 0008: Lease-agent result correlation and reconciliation

Status: accepted

## Context

Issue #38 needs a generic creep agent to turn a lease into bounded proposals while preserving the
`ContractLedger` as the only owner of lease state and durable progress. A scheduled Screeps command
is not completion evidence: it only proves the executor accepted a current-tick request. Without
typed correlation, a result could be attributed to the wrong contract after reassignment or reset.

## Decision

`LeasedWorkExecution` carries the strategy-owned priority and active contract revision. Lease agents
are pure per-tick translators: they read immutable snapshot and execution-view data, emit at most
one correlated action and movement intent per actor, and retain no per-creep Memory or durable
owner. Observe data is the next-tick completion authority; it detects full, depleted, missing, or
finished targets.

Movement and primary-action intents carry nullable `(contractId, contractRevision)` correlation.
Only lease agents set both values. `agents.reconcile` uses same-tick executor evidence to request
`assigned -> active` after a scheduled primary action, or suspension after a stale actor/target
result. It stages requests through the existing `ContractRequestChannel` before
`contracts.reconcile`; the ledger remains the only component that validates transitions and writes
the contracts owner.

## Consequences

- A heap reset cannot lose role/task progress because none exists outside contract state.
- Agents cannot create contracts, choose objectives, issue Screeps commands, or stage persistent
  state directly.
- `phase1.agents` is source-available under `runtime-config-source-v6`; economy and recovery stay
  unavailable until their separate outcome slices prove them.
- The snapshot includes detached dropped-resource, ruin, and tombstone facts needed to validate
  pickup and withdraw leases without live reads.
