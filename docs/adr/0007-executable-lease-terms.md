# ADR 0007: Executable lease terms and the leased-work projection

Status: accepted

## Context

The contract ledger originally established durable capability contracts and assignments, but a
generic creep agent could not safely translate a lease into a primary action. A coarse contract
kind, one target, and a quantity do not authorize resource-sensitive actions such as transfer or
withdraw, and exposing the raw `contracts` owner would bypass the ledger's persistence boundary.

## Decision

`WorkContractRequest` may carry versioned `ContractExecutionTerms`: one scoped action, completion
disposition, optional source/sink counterpart ID, and resource type where the Screeps action
requires one. Validation rejects action-kind mismatches, target-less terms, missing transfer or
withdraw resources, and resources attached to actions that do not take one. Terms are part of the
canonical request signature, so a retry with changed execution authorization is an idempotency
conflict.

`ContractLedger.executionView()` is the only projection for agent planning. It contains only leased
records with explicit valid terms, ordered by actor and contract ID, and includes the lease
identity, revision, target/range/amount/deadlines, and execution terms. It contains no raw owner
bytes, live objects, budget authority, command functions, occupancy, reservations, or role state.
Legacy contracts without terms remain valid durable records but are absent from the projection and
therefore produce no command.

Runtime composition opens the ledger through its existing owner adapter and publishes this immutable
view in `TickContext` before planning. The ledger remains the only authority that creates contracts,
assigns/releases leases, transitions state, and stages the contracts owner.

## Consequences

- Issue #38 can consume an explicit lease authorization without selecting targets or inventing
  per-creep task memory.
- New contract producers must supply terms whenever a contract is intended for generic agent
  execution; incomplete terms fail closed.
- Existing schema-1 contract-owner data remains readable because the optional field is absent from
  its original canonical signature. A later producer can replace a legacy contract only under normal
  issuer/idempotency rules.
- Local pathfinding remains a separate movement authority tracked by #115; this decision does not
  authorize routing, movement commands, or role loops.
