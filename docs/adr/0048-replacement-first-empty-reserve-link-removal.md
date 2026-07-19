# ADR 0048: Replacement-first empty reserve-link removal

## Status

Accepted

## Context

The committed layout may adopt an externally placed link. Existing convergence restores committed
extension, container, and tower geometry, but adopted links remain permanently external. Removing a
source, hub, or controller link could interrupt funded energy flow. At RCL8, the existing pure link
role boundary can instead prove one external link is unused reserve capacity after committed spare
capacity has been built.

Links hold 800 energy, and an outbound transfer gives the sender a distance-based cooldown. An empty
Store alone is therefore insufficient evidence: current role, activation, cooldown, logistics
leases, exact replacement geometry, and every productive role must also remain valid.

## Decision

- `LayoutPlanner` remains the sole desired-geometry authority. Its convergence projection restores
  committed primary link positions through the existing site, funding, contract, and build chain.
- `ConstructionPlanner` remains the sole migration-priority owner. Optional `migration.layout` runs
  after `layout.plan` and `links.plan` in the kernel's stable system-ID order and requires the link
  planner's public current-tick classification and accepted-transfer evidence. The planner reuses
  `deriveLinkRoleAnchors` and `classifyLinks`, the canonical pure `LinkArbiter` role boundary,
  rather than deriving a second link-role policy.
- Removal is RCL8-only. All six owned links must be current and active, exactly five must occupy
  committed primary positions, and the one missing ideal anchor must be `reserve`. Every source,
  hub, and controller anchor must retain an exact active link.
- The external target and one exact committed replacement must both classify as `reserve`, have an
  exact empty 800-capacity energy Store, have zero cooldown, and be absent from assigned or active
  V3 logistics endpoints. Current public link-runtime arbitration does not emit transfers from or to
  reserve roles.
- Shared tiles, sites, stock, cooldown, incomplete/stale/duplicate role evidence, target or
  replacement activity loss, threat, controller risk, workforce/reserve loss, site pressure, and
  layout or progression drift fail closed.
- `StructureRemovalArbiter` retains its 128-input and one-global-command ceilings.
  `StructureDestroyExecutor` remains the sole `Structure.destroy` caller and freshly rechecks the
  target and replacement identity, type, room, ownership, activation, exact Store, and cooldown.
- The layouts owner advances from V7 to V8 only to admit `link` as the existing fixed removal
  receipt's structure discriminator. V1-V7 migrate without inventing link evidence. A pre-V8 owner
  containing a link receipt is rejected, and older code preserves V8 as future owner bytes.
- `OK` remains pending until fresh target disappearance. Existing identity-bound three-attempt
  backoff and reset-safe reconciliation apply unchanged.

## Consequences

One empty idle reserve link can converge to committed geometry without interrupting current
source-to-hub/controller or hub-to-controller capability and without adding a link-transfer,
construction, removal, or persistent-state authority. After observed disappearance, ordinary site
diffing exposes the final committed reserve-link position.

The policy intentionally excludes stocked or recently active links and productive roles. Those need
separate evacuation or handoff evidence. Rolling back to V7 preserves V8 owner bytes and disables
layout work; redeploying V8 resumes the bounded receipt.

## Mechanics sources

- Official [`StructureLink`](https://docs.screeps.com/api/#StructureLink): RCL allowances are
  2/3/4/6 at RCL5-RCL8, capacity is 800 energy, build cost is 5,000, transfer loss is 3%, and sender
  cooldown is distance-based.
- Official
  [`StructureLink.transferEnergy`](https://docs.screeps.com/api/#StructureLink.transferEnergy):
  transfers are same-room, `OK` schedules the action, and ownership, stock, target, capacity, range,
  argument, cooldown, and RCL failures are explicit.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate; `OK` means scheduled; documented failures are `ERR_NOT_OWNER` and `ERR_BUSY`.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive) and
  [Control guide](https://docs.screeps.com/control.html): current RCL governs activation and gives
  RCL8 six links.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [`StructureLink`](https://wiki.screepspl.us/StructureLink/) supplies common link-role
  and flow terminology only.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  supplies layout-convergence terminology only. MYRMEX policy remains independently source-defined.
