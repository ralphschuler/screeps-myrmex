# ADR 0040: Stocked general-container energy evacuation

## Status

Accepted

## Context

ADR 0039 permits replacement-first removal of one empty compatible-external general container. An
energy-bearing target remains indefinitely even when exact committed replacement capacity exists.
Destroying it would lose stock, while adding a layout-local hauling path would duplicate the sole
`LogisticsPlanner`, budget, contract, lease, and executor authorities.

Containers can hold arbitrary resources. This slice handles only the common energy-only case so one
fixed amount and replacement baseline can prove preservation without adding an unbounded resource
manifest.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. After ADR 0039's current safety,
  allowance, committed-capacity, source-service, and contract-view checks pass, it may persist the
  target's exact positive energy and replacement's current energy in the existing compact
  general-container migration record. Mixed, malformed, foreign, over-2,000, or insufficient-
  capacity Store evidence fails closed.
- Existing records without energy fields retain ADR 0039's empty-target semantics. The paired
  optional fields are valid only together, with positive energy and a baseline-plus-amount no
  greater than the official 2,000 container capacity. No root or owner-local schema version changes.
- On following ticks, one pure adapter requests an externally funded `optional-growth` reservation
  and projects the exact target/replacement nodes and one energy edge into `LogisticsPlanner`. The
  specialized source replaces the target's ordinary source projection so stock is reserved once;
  ordinary refill sinks for both containers are also suppressed. Existing V3 contracts, leases,
  creep agents, action arbitration, and executors perform every withdraw and transfer.
- Removal remains blocked while target energy remains, the exact flow or either endpoint has active
  work, replacement energy is below its persisted baseline plus the amount, contract evidence is
  unavailable, or the 150-tick commitment expires. Threat, layout/replacement drift, reserve/site
  pressure, target refill, and malformed observation also authorize no command.
- `StructureRemovalArbiter` retains the 128-input and one-global-command ceilings. Only
  `StructureDestroyExecutor` calls `Structure.destroy` and rechecks the now-empty target and exact
  replacement. Following observation remains the only removal-completion evidence.

## Consequences

One energy-only obsolete general container can converge without stock loss or another logistics
owner. Terms and outcomes remain deterministic across input reordering and heap reconstruction.
Survival work can defer the optional budget, and failed commands simply leave the target for fresh
reevaluation.

Rollback removes the specialized projection and paired optional fields. Existing empty-container
records remain valid; stocked targets remain in place. Mixed resources, source-service switching,
other structure classes, defensive migration, and `Creep.dismantle` remain issue #99.

## Mechanics sources

- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, have 2,000 capacity, cost 5,000 build energy, and are limited to five per room.
- Official [`Store.getUsedCapacity`](https://docs.screeps.com/api/#Store.getUsedCapacity): omitting
  the resource returns total used capacity for a general-purpose Store.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled resource
  movement and exact amount/error contracts.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling; documented results are `OK`, `ERR_NOT_OWNER`, and `ERR_BUSY` while
  hostile creeps are present.
- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) and
  [Control guide](https://docs.screeps.com/control.html): replacement construction remains on the
  existing site and controller-allowance path.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-18.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/),
  [Structure](https://wiki.screepspl.us/Structure/), and [Energy](https://wiki.screepspl.us/Energy/)
  supply community layout, construction, and hauling terminology only; MYRMEX's policy and authority
  boundaries remain source-defined and clean-room.
