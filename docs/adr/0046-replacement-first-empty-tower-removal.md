# ADR 0046: Replacement-first empty-tower removal

## Status

Accepted

## Context

The committed layout may adopt an externally placed tower so the room can use existing capacity. The
existing convergence projection restores committed extension and general-container geometry, but it
leaves compatible external towers permanently adopted. Destroying such a tower before replacement
would reduce active defense, while a full controller allowance prevents building the final committed
tower first.

Towers are defensive structures with RCL-dependent allowances. One attack, heal, or repair consumes
10 energy. Current activation, ownership, Store evidence, colony safety, and construction-site
headroom therefore matter at both planning and command time.

## Decision

- `LayoutPlanner` remains the sole desired-geometry authority. Its pure convergence projection uses
  committed primary tower positions while current adopted towers remain usable world facts.
- The existing site diff, `ConstructionSiteArbiter`, funded build contracts, and executor build the
  first missing committed tower whenever controller allowance is available. No tower-specific site
  command path is added.
- `ConstructionPlanner` remains the sole migration-priority owner. It may propose one obsolete tower
  only when current allowance is at least two and full, exactly allowance minus one active towers
  occupy committed primary positions, and the target is one active owned empty tower on an unshared,
  site-free external tile.
- One deterministic committed replacement must be active and hold at least the official
  `TOWER_ENERGY_COST` of 10. The sole-tower case, stocked or inactive target, underfunded or
  inactive replacement, incomplete committed capacity, threat, controller risk, missing workforce,
  unrestored reserve, layout drift, or site pressure fails closed.
- `StructureRemovalArbiter` retains its 128-input and one-global-command ceilings.
  `StructureDestroyExecutor` remains the sole `Structure.destroy` caller and freshly rechecks the
  target's active empty owned Store plus the replacement's ownership, activation, room, type, exact
  identity, and minimum current energy.
- The layouts owner advances from V5 to V6 only to admit `tower` as the existing fixed removal
  receipt's structure discriminator. V1-V5 migrate without inventing tower evidence. A pre-V6 owner
  containing a tower receipt is rejected; older code sees V6 as future and preserves its bytes.
  There is still at most one fixed-shape receipt per each of 64 room records.
- `OK` remains pending until fresh target disappearance. Existing capped backoff and three-attempt
  exhaustion apply unchanged.

## Consequences

A room can converge tower geometry as allowance grows without ever authorizing removal of its sole
or last immediately operational tower. After observed target disappearance, ordinary site diffing
can create the final committed tower. No tower target policy, energy evacuation, defense command,
new authority, root schema, queue, or unbounded history is introduced.

Rollback to V5 preserves V6 owner bytes and disables layout work as a future owner. Redeploying V6
resumes from the bounded receipt.

## Mechanics sources

- Official [`StructureTower`](https://docs.screeps.com/api/#StructureTower): RCL allowances are
  1/2/3/6 at RCL3/5/7/8, capacity is 1,000 energy, and each attack/heal/repair consumes 10 energy.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate; `OK` means scheduled; documented failures are `ERR_NOT_OWNER` and `ERR_BUSY`.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive): insufficient
  current RCL makes a structure unusable.
- Official [Control guide](https://docs.screeps.com/control.html).
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  supplies tower-geometry and refill-access terminology only. MYRMEX policy remains independently
  source-defined.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/) supplies structure lifecycle
  terminology only.
