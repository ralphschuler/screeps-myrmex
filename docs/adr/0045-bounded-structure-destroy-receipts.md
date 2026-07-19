# ADR 0045: Bounded structure-destroy receipts

## Status

Accepted

## Context

`StructureRemovalArbiter` and `StructureDestroyExecutor` already form the sole irreversible owned-
structure removal path. ADR 0043 added a compact retry receipt only inside a stocked redundant
source-container handoff. Empty redundant source containers, general containers, and extensions had
no durable command-result evidence. If `Structure.destroy` failed while the target remained visible,
a heap reset could therefore regenerate the same proposal every tick and repeatedly consume the one
global removal slot.

The official API describes destruction as immediate while `OK` reports that the operation was
scheduled successfully. Current observation—not the return code—must therefore prove disappearance.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner, `StructureRemovalArbiter` remains
  the sole removal authorization owner, and `StructureDestroyExecutor` remains the sole
  `Structure.destroy` caller.
- Every accepted extension or container removal result reconciles into at most one compact receipt
  on its existing room layout record. The receipt binds the target ID, replacement ID, target type,
  attempt, normalized result code, observation tick, and next eligible tick. Its containing record
  binds the layout fingerprint.
- `OK` and `TARGET_ABSENT` wait without retry until a fresh observation no longer contains the exact
  target. Other results use deterministic two-, four-, then terminal-attempt backoff. Attempt three
  remains failed closed until fresh target disappearance or exact migration/layout drift.
- A matching live receipt suppresses only its exact removal. A fresh exact proposal with different
  target, replacement, or type clears obsolete receipt evidence rather than inheriting its history.
  A missing observed target clears the receipt and is the only success evidence.
- A blocked room emits no removal proposal, so another eligible room may use the unchanged
  one-command global slot. Existing 128-candidate and two-room planning bounds remain unchanged.
- The layouts owner advances to schema V5. V1-V4 records migrate deterministically. A valid V3/V4
  source-specific nested receipt moves to the generic room field without changing attempt evidence.
  Legacy owners containing a future generic field, and V5 owners retaining the old nested field,
  fail closed.
- The root schema does not change. At most one fixed-shape receipt exists per each of 64 layout
  records; no history array, live-API scan, or unbounded traversal is introduced.

## Consequences

Every current irreversible layout-removal path survives heap reset without an every-tick command
loop. `OK` cannot claim disappearance, retry exhaustion cannot monopolize the global slot, and old
source-container evidence retains its meaning. Runtime layout telemetry counts persisted destroy
receipts alongside site receipts without exposing room or structure identities.

Rolling back to V4 preserves V5 owner bytes and disables layout work as a future owner. Redeploying
V5 resumes from the bounded receipt. New structure classes, defensive migration, arbitrary layout
revision replacement, and `Creep.dismantle` remain issue #99.

## Mechanics sources

- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate; `OK` means scheduled; documented failures are `ERR_NOT_OWNER` and `ERR_BUSY`.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/) supplies the construction-site and
  structure lifecycle terminology.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  supplies layout-convergence terminology only. MYRMEX policy remains independently source-defined.
