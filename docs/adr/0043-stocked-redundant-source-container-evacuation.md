# ADR 0043: Stocked redundant source-container evacuation

## Status

Accepted

## Context

ADR 0038 allows one empty, unselected container beside exactly one source to be removed only while a
different exact container remains that source's selected reachable service. ADRs 0040–0042 route
stock from one obsolete non-service container through `LogisticsPlanner`, but `ConstructionPlanner`
still blocks a stocked redundant source-adjacent container. Destroying it would lose resources,
while a source-local hauling path would duplicate budget, logistics, contract, lease, action, and
executor authorities.

The existing `LayoutContainerMigration` shape can represent the exact transfer, but its persisted
meaning previously covered only a general non-service target. Old layouts-owner V2 code would not
recognize a source-specific continuation safely enough to provide a rollback boundary.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. It may persist one evacuation for
  a stocked, unselected container adjacent to exactly one visible source only while a different
  current `exact` source-service placement and exact active replacement container serve that same
  source.
- The target and replacement Stores must be canonical current 2,000-unit container Stores. The
  complete target stock must contain at most eight positive, unique, binary-ordered resource kinds
  and fit the replacement's aggregate free capacity.
- `LayoutContainerMigration` gains one optional `sourceId`. Its presence distinguishes this narrow
  source-specific continuation; absence preserves every general-container commitment and identity.
  The layouts owner advances from V2 to V3. V1 and V2 records without `sourceId` migrate unchanged;
  a legacy owner containing the new field is rejected. Older code sees V3 as future and fails
  closed.
- On following ticks, runtime composition verifies the exact source, target adjacency, persisted
  selected service, and replacement position before projecting the existing migration. One legacy
  energy flow or one resource-specific flow per manifest row enters the sole `LogisticsPlanner`.
  Ordinary target source/refill projections and replacement refill are suppressed through the
  existing shared aggregate-capacity boundary.
- Static mining keeps the same `mining/{room}/{source}` identity and selected work position. The
  redundant target never becomes a mining service or a second extraction commitment.
- Removal requires fresh target-empty evidence, every persisted replacement baseline plus amount, no
  active exact migration flow, and no assigned/active logistics endpoint naming either container.
  One compact result receipt records at most three destroy attempts with capped exponential backoff;
  `OK` or exhausted attempts wait fail-closed for observation and never issue an every-tick command
  loop. Selection drift, malformed Stores, capacity loss, refill, timeout, threat, unavailable
  contract evidence, or missing source/service evidence authorizes no destroy command.
- Existing ceilings remain: one container migration per room, 64 layout records, eight resource
  rows, 64 migration flows, 128 nodes, 128 removal candidates, and one accepted removal globally per
  tick. Invalid or over-cap input publishes no partial graph or command.

## Consequences

A redundant source-adjacent container can preserve energy, minerals, commodities, or mixed stock
before removal without changing extraction or adding another hauling authority. Empty redundant
containers retain ADR 0038's direct no-persistence path.

The root schema does not change. Layouts-owner V3 adds only the optional bounded source identity and
migrates prior valid commitments without changing their terms. Rolling back to V2 disables layout
work while preserving owner bytes and structures; redeploying V3 resumes operation. No manual or
opportunistic Memory rewrite is allowed.

Selected source-service switching, sole-container replacement, other structure classes,
defensive/critical migration, arbitrary layout revision replacement, and `Creep.dismantle` remain
issue #99.

## Mechanics sources

- Official [`Store`](https://docs.screeps.com/api/#Store): exact resource amounts share aggregate
  container capacity.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, hold 2,000 total units, and collect dropped resources on their tile.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): each adjacent scheduled action
  names one resource type, so each manifest row remains one executable flow.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): irreversible
  removal remains isolated behind the existing narrow executor and current safety checks.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide mining,
  hauling, and layout terminology only. MYRMEX policy remains independently source-defined.
