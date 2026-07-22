# ADR 0068: Empty obsolete-terminal relocation

## Status

Accepted

## Context

The source-defined RCL6+ layout commits exactly one terminal. When the room's sole terminal is
active but external to committed geometry, the controller allowance prevents construction of its
canonical replacement. Parent issue #99 requires explicit safety for sole critical logistics
structures, and the existing removal authority has no terminal path.

A terminal is the room's only inter-room send and market endpoint. Current or retrying Industry
work, a terminal-bound layout evacuation, or Logistics endpoint work can still depend on an
otherwise empty terminal. Removing it from layout evidence alone would interrupt owned work and
could strand new stock in a ruin outside the current logistics graph.

## Decision

- The pure convergence projection restores the one committed terminal position when current policy
  unlocks exactly one terminal. Ordinary layout diffing remains allowance-bound, so the site becomes
  executable only after observed removal.
- Industry publishes one bounded tick-local terminal-work projection after current send planning.
  Every current send marks its source and destination rooms active. An unmatched persisted active or
  backoff command makes the complete projection unavailable. Skipped or failed Industry publication
  therefore fails terminal migration closed.
- `ConstructionPlanner` may propose one RCL6-RCL8 external terminal only when it is the sole
  observed owned terminal, active, zero-cooldown, and has an exact empty 300,000-unit
  general-purpose Store. Exactly one different active owned storage with an exact 1,000,000-unit
  Store provides local inventory continuity. Existing ownership, lifecycle, controller, workforce,
  reserve, threat, layout, site-headroom, and progression gates remain mandatory.
- Current Industry terminal work, the target's current or proposed Logistics endpoints, and any
  layouts-owned lab evacuation naming the terminal block removal. Storage endpoint work alone does
  not self-block because storage remains operational.
- `StructureRemovalArbiter` permits one narrow cross-type `terminal → storage` continuity intent
  only with the exact one-million-capacity term. Every prior structure path retains same-type
  replacement validation and the existing 128-candidate/one-global-command limits.
- `StructureDestroyExecutor` freshly rechecks target identity, ownership, room, position, activity,
  exact empty terminal Store, zero cooldown, hostile absence, and the exact active same-room storage
  with its full capacity before the sole `Structure.destroy` call.
- Layouts owner-local schema V17 adds only `terminal` to the fixed removal-receipt discriminator.
  V16 migrates without inventing terminal evidence and rejects spoofed V16 terminal receipts. The
  original storage ID remains pinned across capped retries. `OK` waits for fresh disappearance;
  ordinary site, funding, contract, and build authorities reconstruct committed geometry.

## Consequences

One safe mature room can trade a bounded terminal-service outage for deterministic geometry
convergence while retaining local inventory service. No stock evacuation, new persistent commitment,
terminal command authority, storage authority, logistics flow, queue, or root Memory schema is
added.

Work remains bounded by the two-room layout window, fixed Industry/send and Logistics views, one
receipt per room across 64 records, and one destroy command globally. Stock, cooldown, activity,
Store, work, storage, safety, CPU, or layout uncertainty preserves the terminal. RCL8 domain health
may enter recovery after disappearance and returns only when ordinary construction restores the
active committed terminal.

Rollback to V16 code preserves the future layouts owner byte-for-byte and disables layout work.
Redeploying V17 resumes from the same receipt. Stocked-terminal evacuation, storage relocation,
uninterrupted terminal service, broad access proof, defensive migration, and creep dismantling
remain outside this slice.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/),
  [API reference](https://docs.screeps.com/api/),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) define
  the RCL allowances, 300,000/1,000,000 capacities, terminal cooldown, scheduled destroy/site
  commands, and global site limit.
- Official engine 4.3.2
  [`structures/_destroy.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/structures/_destroy.js)
  and
  [`room/destroy-structure.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/room/destroy-structure.js)
  create a ruin carrying prior Store contents and reject owned destruction while a foreign creep is
  present. MYRMEX still requires emptiness because its current logistics graph does not publish ruin
  stock.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/) and
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/) describe storage as the primary
  RCL4 local inventory structure with one-million capacity. Community terminology informed
  continuity framing only; official contracts and engine evidence govern.
