# ADR 0012: Recovery-critical maintenance policy

Status: accepted

## Context

Phase 1 needs to repair only assets whose loss can prevent local recovery, without becoming the
later layout, fortification, or general maintenance authority.

## Decision

`CriticalMaintenancePlanner` is a pure snapshot selector. It can request creep repair only for a
critically damaged owned spawn, the sole owned container, or a directly adjacent visible access road
with critical hits or near decay. It never selects walls, ramparts, extensions, general roads,
construction, dismantling, or remote targets.

The planner emits stable budget requests to `ColonyDirector` and repair contracts only after an
active `critical-maintenance` reservation. `BudgetLedger` keeps emergency spawn, defense,
replacement, harvesting/filling, and controller survival ahead of maintenance and preserves the
protected recovery-energy floor. A present offensive hostile suppresses creep maintenance; the
existing DefenseDirector remains the sole tower repair selector and executor.

## Consequences

- Critical repair work is deterministic, bounded by per-room contract and per-tick energy policy,
  and uses the existing lease/movement/action pipeline.
- Completion, destruction, disappearance, and threat suppression omit the demand; the two durable
  ledgers release the reservation and cancel the contract without a planner-owned queue.
- Repair command failures use the bounded retry semantics from ADR 0011.
- `phase1.critical-maintenance` is source-available under `runtime-config-source-v10`.
