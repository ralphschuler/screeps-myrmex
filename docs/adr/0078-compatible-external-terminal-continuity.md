# ADR 0078: Compatible external terminal continuity

## Status

Accepted. Supersedes ADR 0068 only for admission of new terminal relocation; exact persisted
terminal migration evidence retains ADR 0068–0076 continuation and reconciliation.

## Context

The source-defined layout has one canonical RCL6+ terminal position. A compatible owned terminal at
a different position was adopted for ordinary room use, but convergence replaced that adoption with
the canonical position. Screeps permits only one terminal per room. Canonical convergence therefore
required evacuation, destruction, a service outage, and a 100,000-energy rebuild of the room's only
inter-room send and market endpoint.

ADR 0068 accepted that outage for exact bounded relocation, and later decisions made every stock,
command, receipt, and stale-revision continuation safe. Issue #445 chooses uninterrupted terminal
service instead of initiating that cost solely for coordinates.

## Decision

- A complete current layout keeps one compatible external owned terminal as its convergent terminal
  placement at RCL6-RCL8. Layout diffing and `ConstructionPlanner` therefore cannot initiate a new
  terminal site, evacuation, removal, or receipt merely to change its coordinate.
- If no owned terminal exists, the source-defined planned terminal remains the convergent placement
  and the ordinary construction path may rebuild it.
- A current layouts record containing an exact `terminalEvacuation` or terminal removal receipt is a
  grandfathered migration only when every present terminal source/target ID matches the sole current
  owned terminal. Runtime supplies that bounded current-owner fact and current observed identity to
  convergence, which retains the canonical target so ADR 0068–0076 execution and reconciliation can
  finish. Observation cannot create this continuation flag, and no new migration record is admitted.
- Foreign or unowned terminals cannot satisfy exact or compatible-external adoption.
- Storage, spawn, extension, tower, link, lab, container, source-service, stale-layout, and access
  policies remain unchanged.
- No authority, executor, persistent field, owner schema, cache, dependency, telemetry field, or
  command path changes.

## Consequences

A healthy room keeps the same `Room.terminal`, 300,000-unit capacity, endpoint identity, send
cooldown, and market service instead of spending evacuation work and 100,000 build energy for
canonical coordinates. MYRMEX accepts compatible noncanonical terminal geometry as stable. Missing
terminal service still reconstructs at the committed position.

Projection adds one constant owner-term check inside the existing two-room planning window and no
persistent bytes. Reset and fact reordering preserve the same placement. A rollback may again admit
a new relocation; if it persists an evacuation or receipt, redeploying this decision continues that
exact term rather than abandoning irreversible evidence.

## Mechanics sources

Reviewed 2026-07-24:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`Room.terminal`](https://docs.screeps.com/api/#Room.terminal), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) define
  the one-per-room RCL6+ terminal, 300,000-unit capacity, 100,000 build cost, 10-tick send cooldown,
  room property, and separately scheduled reconstruction command.
- Official [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage) defines its
  one-per-room 1,000,000-unit capacity; it remains bounded inventory continuity for an existing
  migration, not terminal-service equivalence for starting a new one.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/) and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide community
  layout terminology only. Official mechanics and MYRMEX's independently designed authority
  boundaries govern.
