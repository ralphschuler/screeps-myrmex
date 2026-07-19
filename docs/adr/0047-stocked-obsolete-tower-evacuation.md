# ADR 0047: Stocked obsolete-tower evacuation

## Status

Accepted

## Context

ADR 0046 permits replacement-first removal of one active empty obsolete tower only while an exact
active committed replacement retains at least one 10-energy defense action. A stocked obsolete tower
still cannot converge: destroying it wastes defensive energy, while silently treating command or
aggregate stock changes as delivery would weaken the replacement-first guarantee.

The existing LogisticsPlanner, V3 contracts, lease agents, removal arbiter/executor, and bounded
destroy receipt already own resource flow and irreversible removal. Tower migration must extend
those authorities rather than add a tower-specific hauler, queue, or command path.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. It may persist one tower
  evacuation only after ADR 0046's full-allowance, committed-replacement, workforce, reserve,
  controller, site-headroom, and no-threat evidence passes.
- The target Store must contain one exact positive energy amount. The active committed replacement
  must begin with at least `TOWER_ENERGY_COST` 10 and have exact free capacity for the complete
  amount. Malformed, mixed, refilled above terms, or over-capacity evidence fails closed.
- The commitment contains only source and replacement IDs, amount, replacement baseline, start, and
  exclusive 150-tick expiry. Layouts owner-local schema V7 adds at most one such fixed-shape field
  per each of 64 records. V1-V6 migrate without invented terms; V6 tower-removal receipts remain
  valid.
- On following ticks, runtime composition projects one externally bound `optional-growth` budget,
  one energy edge, two nodes, and two endpoints into the sole LogisticsPlanner. The obsolete
  target's ordinary refill is suppressed, and the replacement's physical capacity is reserved once
  while target stock remains. Existing V3 contracts and lease executors perform the only withdraw
  and transfer commands.
- Removal requires fresh target emptiness, replacement energy of at least baseline plus amount,
  retirement of the exact flow and both endpoint contracts, and the unchanged active operational
  replacement and colony-safety evidence. `StructureRemovalArbiter` and `StructureDestroyExecutor`
  retain their one-global-command and live-revalidation authority.
- `OK` remains pending until fresh target disappearance. Existing identity-bound three-attempt
  backoff applies unchanged. Timeout, threat, capacity or activity drift, unavailable logistics
  evidence, CPU pressure, or command failure preserves the tower and authorizes no unsafe destroy.

## Consequences

One stocked obsolete tower can converge without discarding energy or creating a second logistics or
destruction authority. Planning remains bounded by two rooms and 128 migration candidates; each
active tower evacuation adds at most one flow, two nodes, two endpoints, one budget, and one fixed
persistent record.

Replacement defense actions may delay or prevent the exact observed gain. That is intentionally
fail-closed: no aggregate stock inference substitutes for delivery evidence. A 1,000-energy target
cannot fit a replacement that must already retain 10 energy and therefore remains untouched.

Rolling back to V6 preserves the V7 owner as future data and disables layout work. Redeploying V7
resumes the bounded commitment.

## Mechanics sources

- Official [`StructureTower`](https://docs.screeps.com/api/#StructureTower): 1,000 energy capacity
  and 10 energy per attack, heal, or repair.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw): an adjacent creep may
  withdraw a resource from a structure; `OK` schedules the action.
- Official [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): an adjacent creep may
  transfer a resource to a structure; excess capacity returns `ERR_FULL`.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive) and
  [Control guide](https://docs.screeps.com/control.html): current RCL controls tower activation and
  allowance.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [StructureTower](https://wiki.screepspl.us/StructureTower/) supplies tower placement,
  refill-access, and action-cost terminology only.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) supplies creep energy-hauling terminology
  only. MYRMEX policy remains independently source-defined.
