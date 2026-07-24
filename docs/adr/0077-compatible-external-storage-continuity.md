# ADR 0077: Compatible external storage continuity

## Status

Accepted. Supersedes ADR 0071 only for admission of new storage relocation; exact persisted storage
migration evidence retains ADR 0071–0076 continuation and reconciliation.

## Context

The source-defined layout has one canonical RCL4+ storage position. A compatible owned storage at a
different position was adopted for ordinary room use, but RCL6+ convergence replaced that adoption
with the canonical position. Screeps permits only one storage per room. Canonical convergence
therefore required evacuation, destruction, a service outage, and a 30,000-energy rebuild of the
room's primary 1,000,000-unit inventory endpoint.

ADR 0071 accepted that outage for exact bounded relocation and later decisions made every stock,
command, receipt, and stale-revision continuation safe. The remaining Phase 2 question is whether
coordinate convergence is worth initiating that outage. Issue #443 chooses uninterrupted inventory
service instead.

## Decision

- A complete current layout keeps one compatible external owned storage as its convergent storage
  placement at RCL4-RCL8. Layout diffing and `ConstructionPlanner` therefore cannot initiate a new
  storage site, evacuation, removal, or receipt merely to change its coordinate.
- If no storage exists, the source-defined planned storage remains the convergent placement and the
  ordinary construction path may rebuild it.
- A current layouts record containing an exact `storageEvacuation` or storage removal receipt is a
  grandfathered migration. Runtime supplies only that bounded current-owner fact to convergence,
  which retains the canonical target so ADR 0071–0076 execution and reconciliation can finish.
  Observation cannot create this continuation flag, and no new migration record is admitted.
- Terminal, spawn, extension, tower, link, lab, container, source-service, stale-layout, and access
  policies remain unchanged.
- No authority, executor, persistent field, owner schema, cache, dependency, telemetry field, or
  command path changes.

## Consequences

A healthy room keeps the same `Room.storage`, full 1,000,000-unit capacity, endpoint identity, and
local Logistics/Industry service instead of spending evacuation work and 30,000 build energy for
canonical coordinates. MYRMEX accepts compatible noncanonical storage geometry as stable. Missing
storage still reconstructs at the committed position.

Projection adds one constant owner-term check inside the existing two-room planning window and no
persistent bytes. Reset and fact reordering preserve the same placement. A rollback may again admit
a new relocation; if it persists an evacuation or receipt, redeploying this decision continues that
exact term rather than abandoning irreversible evidence.

## Mechanics sources

Reviewed 2026-07-24:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`Room.storage`](https://docs.screeps.com/api/#Room.storage), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) define
  the one-per-room RCL4+ storage, 1,000,000-unit capacity, 30,000 build cost, absent-room property,
  and separately scheduled reconstruction command.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) defines its
  one-per-room RCL6+ 300,000-unit capacity; it is bounded continuity for an existing migration, not
  service equivalence for starting a new one.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/), and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide primary
  room-store and layout terminology only. Official mechanics and MYRMEX's independently designed
  authority boundaries govern.
