# ADR 0037: Stocked obsolete-extension evacuation

## Status

Accepted

## Context

ADR 0036 permits one empty obsolete extension to be removed only after exact committed replacement
capacity exists. A stocked target remained blocked because destroying it would discard spawn energy.
Naively exposing that extension as a logistics source is also unsafe: the ordinary logistics graph
would project every newly available extension capacity as a mandatory refill sink and could return
the withdrawn energy to the migration target.

Layout planning follows current colony publication, while colony budget arbitration precedes later
Plan systems. A heap-only evacuation request would therefore either miss same-tick funding or vanish
on global reset. Reconstructing desired placements inside the colony authority would duplicate the
sole layout-planning decision.

## Decision

- `ConstructionPlanner` remains the sole migration-priority policy. After all existing colony,
  threat, controller, workforce, reserve, layout, allowance, site-headroom, target, and replacement
  checks pass, a stocked obsolete extension creates one compact extension-evacuation commitment in
  the existing layout record instead of a removal proposal.
- The layout owner retains at most one commitment per room. It stores only source and replacement
  IDs, exact initial amount, replacement baseline, start tick, and exclusive expiry tick. It stores
  no creep, route, contract state, placement array, or game object. A changed layout, vanished
  target, or invalid replacement clears it. Expiry with stock still present and no active flow
  clears for one newly observed retry; an empty but unproved target remains blocked and cannot
  become removable by forgetting evidence.
- On the following tick, runtime composition validates the persisted terms against fresh visible
  owned active extensions. It derives one collision-free length-prefixed, bounded `optional-growth`
  budget issuer and one graph-only demand. `ColonyDirector` and `BudgetLedger` remain the sole
  funding authorities.
- `LogisticsPlanner` remains the sole resource-flow authority. Its specialized flow reserves the
  obsolete extension's observed energy and the exact replacement's energy capacity once. Ordinary
  sink projections for both exact targets are suppressed during acquisition, preventing refill
  competition. After the source becomes empty, its refill remains suppressed while ordinary
  replacement refill may restore completion evidence if spawn use consumed delivered energy. At most
  64 records create 64 edges and 128 nodes inside the existing 128-node, 256-edge, and 128-flow
  limits.
- Existing V3 haul contracts, `WorkforceAllocator`, lease agents, `CreepActionArbiter`, and
  `CreepActionExecutor` perform the `withdraw` and `transfer`; no command path or per-creep state is
  added. The external binding is preserved across acquire/deliver transition and does not create a
  second budget.
- Removal remains blocked until fresh observation proves the source Store empty, the replacement has
  gained at least the committed amount, the evacuation has not expired, and no active V3 flow still
  names the commitment. `StructureRemovalArbiter` and `StructureDestroyExecutor` retain the sole
  one-command removal path. The next observation clears the commitment when the target disappears.
- The commitment timeout is 150 ticks, matching the declared Phase 2 command-error recovery window.
  Threat, reserve loss, controller risk, RCL/layout drift, malformed Store evidence, insufficient
  replacement capacity, missing contract prerequisites, and CPU admission loss preserve or reduce
  work without authorizing destruction.

## Consequences

A newly built replacement can receive one obsolete extension's energy before the existing removal
path runs. The one-tick persistent handoff keeps layout and budget authority ordered and reset-safe.
Equivalent reordered observations and JSON Memory reconstruction yield the same commitment and flow.
Rollback removes the optional record and projector while restoring ADR 0036's stocked-target block.

This remains an extension-only slice. Stock evacuation for storage, containers, links, towers, labs,
terminals, spawns, or defensive structures; general migration state; and `Creep.dismantle` remain in
issue #99.

## Mechanics sources

- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw): a creep may withdraw a
  specified resource and amount from an adjacent structure; successful return means scheduled.
- Official [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): a creep may transfer a
  specified carried resource and amount to an adjacent structure with available capacity.
- Official [`StructureExtension`](https://docs.screeps.com/api/#StructureExtension): extensions hold
  room-wide spawn energy and have finite RCL-dependent capacity.
- Official [`Store`](https://docs.screeps.com/api/#Store): extensions use a limited Store; current
  used and free energy capacity are the exact source/sink evidence.
- Official [Screeps documentation index](https://docs.screeps.com/) (last updated May 29, 2026).
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/): creep hauling and extension filling
  informed community terminology only.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  reachable extension placement and refill-layout guidance informed the scenario only.
