# ADR 0017: Static mining authority foundation

Status: accepted (partial foundation)

## Context

Issue #46 introduces source-adjacent container identity before any mining contract, population,
spawn, creep execution, hauling, repair, link, telemetry, or feature-gate behavior. The foundation
must be deterministic across observation order and heap reset while preserving the existing layout,
construction-site, contract, workforce, spawn, movement, and action authorities.

## Decision

- `WorldObserver` remains the sole Source and container fact reader. Source snapshots retain the
  Source ID on their detached position; stored container facts include hits, store, and nullable
  decay timing. Loss is represented by absence from a fresh visible snapshot.
- `LayoutPlanner` remains the sole desired-position authority. Its pure source-service selector
  commits one semantic `{ kind: "source-container", sourceId }` placement per source when a legal
  reachable adjacent tile exists.
- Sources sort by binary ID and inspect exactly eight y/x-ordered adjacent candidates. Exact
  containers precede matching sites, then bounded static route distance from committed storage or
  primary spawn, plain before swamp, y, and x. Borders, walls, incompatible occupancy, and duplicate
  source assignment are rejected; road and rampart overlap is legal.
- Dynamic creeps, congestion, reservations, contracts, roles, and commands cannot affect the
  commitment, fingerprint, or compiled-layout cache. Missing legal service positions become bounded
  source-specific blockers; no unsafe partial layout is published.
- The algorithm revision is `owned-room-layout-v2-source-services`. Old layout commitments are stale
  and rebuildable, not malformed. Persistent memory retains only commitment identity and bounded
  blocker metadata, never placement arrays.
- Future PR B will add `StaticMiningPlanner` as the sole source-mining demand authority. It will
  read committed semantic services and current observations, then publish typed mining
  demand/contracts through existing budget, contract, population, spawn, lease, movement, and action
  boundaries. This PR neither creates that planner nor activates `phase2.mining`.

## Consequences

- Existing containers and sites are adopted without duplicate construction-site proposals.
- Single-access sources remain supportable, and two source assignments cannot share one tile.
- Heap resets and fact reordering reconstruct identical source-service placements and fingerprints.
- Container decay, damage, store, and visible loss facts are available for later repair and hauling
  decisions without granting layout code command authority.

## Sources consulted

- [Source](https://docs.screeps.com/api/#Source)
- [Creep.harvest](https://docs.screeps.com/api/#Creep.harvest)
- [StructureContainer](https://docs.screeps.com/api/#StructureContainer)
- [Room.Terrain](https://docs.screeps.com/api/#Room.Terrain)
- [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) (terminology only)
