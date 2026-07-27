# ADR 0086: Carried-energy RCL2 infrastructure bootstrap

## Status

Accepted

## Context

A newly upgraded RCL2 room can have one 300-capacity spawn, no extensions, and the full protected
300-energy reserve. Normal growth requires that reserve plus the configured 100-energy surplus, so
the room cannot fund the extension work needed to reach the 400-energy threshold. The existing
budget request also claims room energy even though `Creep.build` spends energy already carried by
the assigned creep.

The repair must not weaken the spawn reserve, add placement or creep-task authority, or let optional
growth bypass threat, replacement, recovery, CPU, contract, movement, or action arbitration.

## Decision

- `SurvivalGrowthPlanner` recognizes one bounded RCL2 infrastructure-bootstrap state only while the
  controller is owned at RCL2, exactly one spawn is active, room energy still covers the protected
  spawn floor, room capacity remains below the configured normal-growth floor, and one viable
  `WORK`/`CARRY`/`MOVE` worker carries energy.
- That state emits only currently observed owned extension-site build candidates. It does not place
  sites, upgrade the controller, or admit another structure kind.
- Each candidate keeps the existing `optional-growth` budget category but uses stable reason
  `rcl2-infrastructure-bootstrap`, a distinct issuer namespace, a null room-energy claim, one
  milli-CPU claim, and the existing extended bootstrap assignment ceiling. The creep's carried
  energy is therefore the build input; the complete room/spawn reserve remains unallocated.
- `ColonyDirector`, `BudgetLedger`, `ContractLedger`, `WorkforceAllocator`, movement/action
  arbiters, and `CreepActionExecutor` retain their existing authorities. The distinct bootstrap
  issuer lets workforce allocation use current actor energy to reject an empty actor for this build;
  an unknown legacy fixture field remains non-authoritative. Existing threat, posture, replacement,
  and constrained-CPU rules continue to preempt the optional category.
- A valid bootstrap contract survives temporary worker/cargo or authorization loss without
  resurrecting a retired issuer coordinate. It retires when the exact site disappears, ownership or
  RCL2 status is lost, active-spawn evidence changes, or capacity reaches the configured normal
  growth floor. Normal growth then uses its existing distinct issuer and surplus policy.
- The projection remains bounded by the existing 64 global candidates and configured per-room
  active-contract limit. No persistent owner, schema, feature gate, cache, or command path changes.

## Consequences

A spawn-only RCL2 room can progress an observed first-extension site through production contracts
and executors while the spawn remains at 300 energy. Heap reconstruction preserves the contract and
normal growth resumes without duplicate bootstrap work once sufficient capacity exists.

This repair does not prove layout placement, static-mining handoff, or a complete spawn-only RCL2 to
RCL3 movement soak. Issues #474 and #476 retain those separate outcomes.

Rollback needs no Memory migration. Cancel or allow the distinct bootstrap contracts to retire
before deploying older code; older planning otherwise cancels their ordinary `growth/` issuers
fail-closed.

## Mechanics sources

Reviewed 2026-07-27:

- Official [`Creep.build`](https://docs.screeps.com/api/#Creep.build): build uses carried energy,
  requires `WORK` and `CARRY`, has range three, and reports typed resource/range/target errors.
- Official [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite): progress and
  `progressTotal` are current construction evidence.
- Official [`Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable) and
  [`Room.energyCapacityAvailable`](https://docs.screeps.com/api/#Room.energyCapacityAvailable):
  these values cover spawn/extension energy and capacity, not creep cargo.
- Official [Control guide](https://docs.screeps.com/control.html): RCL2 unlocks five 50-capacity
  extensions.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/): community guidance distinguishes
  harvested/carried worker energy from spawn/extension energy and describes generic early-RCL
  workers.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/):
  community terminology for unattended extension placement and construction.

Official mechanics govern. Wiki material supplied terminology and operational context only.
