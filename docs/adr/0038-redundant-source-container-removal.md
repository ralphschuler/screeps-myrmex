# ADR 0038: Redundant source-container removal

## Status

Accepted

## Context

The source-service layout commits one deterministic reachable container position per visible owned
source and prefers an exact existing container. A second empty container adjacent to the same source
can remain outside that semantic commitment. It adds maintenance exposure and prevents bounded
layout convergence even though removing a container leaves a walkable tile.

Changing the selected service to a newly preferred position would also change the static miner's
execution terms under its stable contract identity. That broader migration needs explicit contract
revision and handoff policy. This slice instead removes only an unselected redundant container while
the already selected exact service remains unchanged.

## Decision

- `ConstructionPlanner` remains the sole migration-priority policy owner. Within its existing
  128-candidate bound, it may classify an unselected container only when that container is adjacent
  to exactly one visible source.
- The current complete layout must contain exactly one different `exact` semantic `source-container`
  placement for that source, and fresh stored-structure observation must resolve exactly one
  non-foreign container at that selected position.
- The target tile must contain only the exact target and no construction site. The target Store must
  be exactly empty. A selected, sole, stocked, shared, site-conflicted, ambiguous-source, missing-
  replacement, foreign, malformed, or stale target authorizes no removal.
- Existing colony safety, threat, controller-risk, workforce, reserve, progression, layout, and
  construction-site-headroom checks remain mandatory. The selected service was already admitted by
  the bounded source-service reachability policy; removal does not recalculate or persist a path.
- `StructureRemovalArbiter` accepts the discriminated container-to-container terms through its
  existing fail-closed batch and one-global-command ceilings.
- Only `StructureDestroyExecutor` may call `Structure.destroy`. It revalidates current room control,
  hostile absence, commitment fingerprint, target identity/type/position, empty current Store, and
  exact active same-room replacement. Containers need not expose `my`; official destruction policy
  permits structures in the caller's controlled room.
- No persistent state, layout revision, mining-contract revision, evacuation flow, or receipt is
  added. The next fresh observation proves disappearance. Static mining continues with the same
  issuer, source, and work position.

## Consequences

One empty redundant source container can be removed without interrupting extraction or changing the
committed source service. Reordered observations and JSON/global-heap reconstruction yield the same
proposal. Command failure simply leaves the target visible for complete fresh reevaluation.

The slice intentionally does not build or switch source services, evacuate stocked containers,
remove controller/logistics containers, migrate another structure class, issue `Creep.dismantle`, or
close parent issue #99.

## Mechanics sources

- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, hold 2,000 resources, and receive dropped resources on their tile.
- Official [`Store.getUsedCapacity`](https://docs.screeps.com/api/#Store.getUsedCapacity): total
  used capacity without a resource argument is exact empty-store evidence for a general-purpose
  Store.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest): a source must be
  adjacent; harvested resources drop when no carry capacity is available.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling; documented results are `OK`, `ERR_NOT_OWNER`, and `ERR_BUSY` when
  hostile creeps are present.
- Official [Screeps documentation index](https://docs.screeps.com/) (reviewed 2026-07-18).
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/): community
  stationary-harvester and courier terminology only.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  community access and convergence framing only; MYRMEX policy remains clean-room and
  source-defined.
