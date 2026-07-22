# ADR 0071: Empty obsolete-storage relocation

## Status

Accepted

## Context

The source-defined layout commits exactly one RCL4+ storage. When the room's sole active storage is
compatible but external to committed geometry, controller allowance prevents construction of its
canonical replacement. Issue #359 established the inverse `terminal → storage` continuity path, but
storage remained deliberately irreplaceable under parent issue #99.

Storage is the primary local inventory endpoint and has a 1,000,000-unit Store. Removing it is safe
only when it is empty, later RCL capability provides another exact local inventory endpoint, and no
current work still names it. A retained terminal provides only 300,000 units and therefore
represents an explicit temporary capacity contraction rather than equivalent service.

## Decision

- The pure convergence projection restores committed storage geometry only when policy unlocks
  exactly one storage and one terminal. RCL4-RCL5 external storage remains adopted current geometry.
- `ConstructionPlanner` may propose one RCL6-RCL8 external storage only when it is the sole observed
  owned storage, active, and has an exact empty 1,000,000-unit general-purpose Store. Exactly one
  different active owned terminal with an exact 300,000-unit Store provides bounded local inventory
  continuity.
- Existing ownership, lifecycle, controller, workforce, reserve, threat, layout, site-headroom, and
  progression gates remain mandatory. The committed storage tile must be clear except for compatible
  roads or ramparts.
- The `phase2.logistics` gate must be effective, contract execution/planning evidence must be ready,
  and exactly one current healthy Logistics row must match the room observation. Assigned or active
  primary/counterpart work and every current projected V3 Logistics request naming the storage block
  removal. A durable lab evacuation using it as storage destination or terminal evacuation using it
  as replacement also blocks removal. Terminal work does not self-block because the terminal remains
  operational.
- `StructureRemovalArbiter` permits one narrow `storage → terminal` continuity intent only with the
  exact 300,000-unit replacement-capacity term. The inverse `terminal → storage` form remains exact;
  same-type checks for every other structure remain unchanged.
- `StructureDestroyExecutor` freshly rechecks target identity, ownership, room, position, activity,
  exact empty Store, hostile absence, and the exact active same-room terminal Store before the sole
  `Structure.destroy` call.
- Layouts owner-local schema V20 adds only `storage` to the existing bounded removal-receipt
  discriminator. V1-V19 migration invents no storage receipt. The original terminal ID remains
  pinned through capped retry; `OK` waits for fresh disappearance before ordinary construction
  exposes the committed storage site.

## Consequences

One safe RCL6-RCL8 room can trade a bounded storage-service outage and a temporary capacity
reduction from 1,000,000 to 300,000 units for deterministic geometry convergence. The target must be
empty, so no evacuation flow or energy is introduced; rebuilding uses the existing 30,000-energy
construction path. No new planner, Logistics/Industry/storage authority, persistent record, cache,
dependency, or root Memory schema is added.

Work remains bounded by the two-room layout window, current Logistics projection, 128 removal
candidates, one receipt per room across 64 records, three attempts, and one destroy command
globally. Stock, pre-RCL6 policy, endpoint work, durable destination claims,
capacity/identity/activity loss, safety pressure, CPU skip, or observation uncertainty preserves the
storage.

Rollback to V19 code preserves the future layouts owner byte-for-byte and disables layout work.
Redeploying V20 resumes receipt reconciliation. After successful destruction, rollback can delay
canonical reconstruction but leaves the active terminal and ordinary construction authority
available. Stocked-storage evacuation, capacity parity, uninterrupted `Room.storage`, dynamic
access, defensive migration, and creep dismantling remain outside this decision.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`Store`](https://docs.screeps.com/api/#Store),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) define
  allowances, 1,000,000/300,000 capacities, exact Store evidence, destroy/site commands, and storage
  rebuild cost.
- Official engine 4.3.2
  [`structures/_destroy.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/structures/_destroy.js)
  and
  [`room/destroy-structure.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/room/destroy-structure.js)
  create a ruin carrying prior Store contents and reject owned destruction while a foreign creep is
  present. MYRMEX still requires exact emptiness and current hostile absence.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/), and
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/) provide local-inventory and
  inter-room endpoint terminology only; official contracts and engine evidence govern.
