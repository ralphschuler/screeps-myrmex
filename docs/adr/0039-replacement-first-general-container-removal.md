# ADR 0039: Replacement-first general-container removal

## Status

Accepted

## Context

The committed room layout may adopt a compatible external general container. That preserves current
capacity, but ordinary layout diffing then has no reason to build the corresponding committed
container geometry. Destroying the external container first could reduce available capacity, discard
stock, or invalidate a logistics lease that still names it.

Source-service containers are different: static mining binds its stable execution terms to their
selected positions. Their migration remains outside this decision.

## Decision

- The pure convergence projection restores committed geometry for non-service primary containers
  while preserving exact source-service placements. If any canonical general-container tile is
  source-adjacent, convergence fails closed instead of letting new exact capacity change source-
  service selection. The existing construction-site, funding, contract, and build executors use
  spare controller allowance to build the first safe missing committed general container.
- `ConstructionPlanner` remains the sole migration-priority policy owner. It may stage one external
  compatible general-container target only when current colony, threat, controller, workforce,
  reserve, layout, and site-headroom evidence passes; the room has all five allowed containers;
  exactly four occupy distinct committed source-service/general positions; the target is the sole
  empty structure on its tile, is not source-adjacent, and an exact general-container replacement
  exists on committed geometry.
- The existing `layouts` owner retains at most one compact target ID, replacement ID, start tick,
  and exclusive expiry tick per room. A new commitment never authorizes same-tick removal. Layout
  fingerprint change, target disappearance, stock, replacement drift, malformed evidence, or the
  150-tick timeout clears it safely.
- On following ticks, a pure logistics adapter suppresses the obsolete target's ordinary refill sink
  only while fresh visible owned-room observation proves the target empty and both exact containers
  remain. It emits no flow, budget, contract, or command.
- Layout planning requires ready contract-planning and execution views, then waits while any
  assigned or active V3 logistics contract names the target either as its primary endpoint or
  counterpart. Current same-tick logistics requests are included. Suppressed ordinary edges remain
  available only as reconciliation evidence, so old endpoint work emits one `sink-vanished`
  retirement without admitting new flow. After retirement, the existing `StructureRemovalArbiter`
  may admit the exact container-to-container proposal under its 128-input and one-global-command
  ceilings.
- Only `StructureDestroyExecutor` may call `Structure.destroy`. It revalidates current commitment,
  room control, hostile absence, exact empty target, and exact active same-room replacement.
  Following observation alone proves disappearance; ordinary diffing can then create the final
  missing committed container.

## Consequences

One empty adopted general container can converge to committed geometry without capacity-first loss
or a live logistics endpoint. The compact one-tick handoff survives reset and prevents the planner
and logistics owner from racing. Source-service selection and static-mining work positions do not
change.

Rollback removes the general-container convergence projection, optional compact commitment, and
refill suppression adapter. Existing layout records remain valid because the field is optional and
no destructive migration occurs.

This does not authorize stocked-container evacuation, source-service switching, other structure
classes, defensive/critical migration, arbitrary layout revisions, or `Creep.dismantle`.

## Mechanics sources

- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, have 2,000 capacity, cost 5,000 build energy, and are limited to five per room.
- Official [`Store.getUsedCapacity`](https://docs.screeps.com/api/#Store.getUsedCapacity): omitting
  a resource returns total used capacity for a general-purpose Store.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling; documented results are `OK`, `ERR_NOT_OWNER`, and `ERR_BUSY` when
  hostile creeps are present.
- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) and
  [Control guide](https://docs.screeps.com/control.html): replacement construction uses the existing
  site command under the five-container controller allowance.
- Official [Screeps documentation index](https://docs.screeps.com/) (reviewed 2026-07-18).
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  community layout/access framing only.
- Screeps Wiki [Structure](https://wiki.screepspl.us/Structure/): structures begin as construction
  sites and complete through creep build work.
