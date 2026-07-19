# ADR 0035: Temporary road-removal authority

## Status

Superseded by issue #308 after current engine verification.

## Context

Issue #284 treated a road on a planned tower tile as an occupancy blocker. MYRMEX therefore added a
bounded `Structure.destroy` path so the ordinary layout diff could propose the tower on a later
observation.

Current Screeps engine 4.3.2 evidence disproves that premise. `checkConstructionSite()` permits a
road or rampart to share a tile with another buildable structure. The build processor likewise
allows the new obstacle structure to complete while a road or rampart is present. Destroying the
road is unnecessary, loses movement efficiency, and creates an irreversible command where the normal
construction-site chain is sufficient. The same blanket occupancy rejection also prevents the
source-defined rampart layer from being built over its spawn, storage, and towers.

## Superseding decision

- `LayoutPlanner` remains the sole desired-position authority. Its source-defined geometry is
  unchanged.
- `diffOwnedRoomLayout()` follows the engine co-location rule. A planned primary structure may share
  its position with an existing road or rampart. A planned road or rampart may share its position
  with another buildable structure.
- A matching existing structure still satisfies the placement. Any current construction site, or a
  different primary structure that is not a road/rampart, remains a fail-closed conflict.
- Existing ownership, visibility, policy, RCL, allowance, deterministic ordering, and site-cap
  checks remain unchanged. `ConstructionSiteArbiter` and `ConstructionSiteExecutor` retain the only
  site-slot and `Room.createConstructionSite` authorities.
- `ConstructionPlanner` no longer classifies a compatible road as a migration candidate.
  `LayoutMigrationProposal` and `DestroyOwnedStructureIntent` no longer contain road-to-tower
  variants, so `StructureRemovalArbiter` cannot authorize this obsolete command path.
- Container and extension migration retain the existing bounded removal arbiter and sole
  `StructureDestroyExecutor` command boundary.
- No persistent state or schema changes.

## Consequences

A tower can be built directly over a road while retaining that road, and canonical ramparts can
converge over their protected structures. Reordered observation and heap reconstruction remain
byte-identical. A current site still serializes same-tile construction, so MYRMEX never submits two
site commands for one tile in the same observed state.

Rollback requires no state migration, but it restores unnecessary road destruction and blocks
canonical rampart layering. General obsolete-road retirement, non-road dismantling, defensive
migration, layout revision replacement, and creep dismantling remain issue #99.

## Mechanics sources

- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) and
  [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) define the existing site
  command and observed build boundary.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) confirms that the
  removed path was an immediate irreversible command.
- Official [Control guide](https://docs.screeps.com/control.html) defines RCL structure allowances;
  this decision does not change them.
- Screeps engine 4.3.2
  [`checkConstructionSite`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/utils.js#L128-L189),
  [`Room.createConstructionSite`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/game/rooms.js#L1029-L1096),
  [`Creep.build` processing](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/creeps/build.js),
  and current common
  [`OBSTACLE_OBJECT_TYPES`](https://github.com/screeps/common/blob/2fb779b26eef9b4b0f412584f6bd47c897949766/lib/constants.js#L85)
  are the authoritative co-location evidence.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) and
  [Structure](https://wiki.screepspl.us/Structure/) provide layout and construction terminology
  only. MYRMEX policy remains independently source-defined.
