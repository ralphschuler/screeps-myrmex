# ADR 0011: Repair execution thresholds and retries

Status: accepted

## Context

Critical maintenance must stop when a policy-defined repair threshold is reached, rather than
silently repairing every target to full hits. It must also retry a rejected `Creep.repair` command
without creating per-creep state or a second durable maintenance queue.

## Decision

`ContractLedger` remains the durable authority for repair contract history and state. Executable
lease terms gain an optional repair-only `completionHits` threshold. Its absence preserves the
existing full-hit completion behavior, so existing owner-local schema-v1 records remain valid and do
not require a migration.

`LeaseAgent` compares the current normalized target hits with that threshold before proposing a
command. Typed action results continue through the existing reconciliation channel. A suspended
repair contract exposes only derived retry evidence: normalized command-failure count and the last
failure tick. The agent reconciliation producer deterministically re-funds it after capped
exponential backoff, or marks it failed at `policy.retries.maximumAttempts`.

## Consequences

- Only `CreepActionExecutor` calls `Creep.repair`; planners and the ledger remain data-only.
- Retry timing and attempts survive heap reset because they are reconstructed from ContractLedger
  history, not stored in a cache or creep Memory.
- Missing targets and non-command dispositions remain normal contract reconciliation concerns; the
  retry path is limited to normalized executor/engine failures.
- Issue #40 can issue recovery-critical repair contracts without inventing a separate retry owner.
