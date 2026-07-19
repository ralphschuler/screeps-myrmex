# ADR 0036: Replacement-first empty-extension removal

## Status

Accepted

## Context

The committed room layout intentionally adopts compatible external structures so a manual extension
remains productive. Permanent adoption, however, prevents the construction diff from using spare
controller allowance to converge that extension onto committed geometry. Removing the external
extension first would unnecessarily reduce spawn capacity and could discard stored energy. General
stock evacuation, defensive migration, persistent multi-step migrations, and creep dismantling
remain unsafe and belong to issue #99.

Unlike a spawn or logistics store, an extension is replaceable under current controller allowance,
has one energy-only Store, and becomes walkable when removed. This permits one bounded
replacement-first outcome without creating another layout owner or migration queue.

## Decision

- `LayoutPlanner` keeps compatible external extension adoption for current usability and commitment
  stability. A separate pure convergence projection restores only committed primary extension
  geometry for the existing construction diff; every other adopted placement remains unchanged.
- While the owned room is below its current extension allowance, the existing site arbiter,
  executor, receipts, funded build contracts, and creep executors build the first canonical missing
  committed extension. No migration-specific construction command path is added.
- `ConstructionPlanner` remains the sole migration-priority policy owner. It may propose one owned
  extension outside committed extension geometry only when:
  - the normal current colony, threat, controller, workforce, reserve, layout, and site-headroom
    authorization passes;
  - current owned extension count equals the unlocked allowance;
  - exactly allowance minus one active owned extensions occupy committed extension positions;
  - the target is active, empty, and the only structure or site on its tile; and
  - one exact committed active owned extension is named as current replacement evidence.
- `StructureRemovalArbiter` keeps the existing 128-candidate fail-closed batch ceiling and one
  global removal per tick. The proposal is a discriminated extension-to-extension migration with an
  exact target and replacement ID; malformed cross-kind terms are rejected.
- Only `StructureDestroyExecutor` may call `Structure.destroy`. Immediately before the command it
  revalidates the current commitment, owned room, hostile absence, exact target identity and
  position, owned empty Store, and exact active owned replacement identity in the same room.
- No new Memory field is added. The next fresh observation alone proves target disappearance. If the
  command fails or any evidence changes, the target remains observed and the complete policy is
  recomputed. The ordinary diff can then fill the final committed extension position.

## Consequences

A room with spare extension allowance now builds desired capacity before removing one empty obsolete
extension. Reordered observation and heap reconstruction yield the same site and removal decisions.
The room never removes a stocked extension, a shared/ramparted tile, or more than one structure per
tick.

The narrow path does not evacuate stock, migrate another structure type, preserve a multi-step
migration record, use `Creep.dismantle`, or complete issue #99. Rollback removes the extension
convergence projection and proposal branch while retaining engine-compatible road/rampart layering.

## Mechanics sources

- Official [`StructureExtension`](https://docs.screeps.com/api/#StructureExtension): extensions hold
  spawn energy; RCL3 permits ten 50-capacity extensions; each costs 3,000 build energy.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling; documented results are `OK`, `ERR_NOT_OWNER`, and `ERR_BUSY` when
  hostile creeps are present.
- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite):
  replacement construction starts through the existing scheduled site command.
- Official [`Store`](https://docs.screeps.com/api/#Store): current used capacity provides the
  executor's fail-closed empty-target proof.
- Official [Screeps documentation index](https://docs.screeps.com/) (last updated May 29, 2026).
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  reachable extension placement and layout terminology informed the scenario only.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/): structures begin as construction
  sites and complete through creep build work.
