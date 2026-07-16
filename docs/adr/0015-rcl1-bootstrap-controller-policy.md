# ADR 0015: RCL1 bootstrap controller growth without protected reserve spend

Status: accepted

## Context

RCL1 rooms can run with exactly one 300-energy spawn and no extensions. The normal growth policy
guards controller upgrades until the room has protected floor plus growth surplus, which prevents an
owned RCL1 room from bridging to RCL2 if it has no extensions and no extra room energy.

## Decision

- Add a dedicated `bootstrap-controller` budget category in `BUDGET_CATEGORIES`, ordered after
  `controller-risk` and before `critical-maintenance`/`optional-growth`.
- `planSurvivalGrowth` emits a `bootstrap-controller` upgrade-controller candidate only when all of
  the following hold:
  - owned RCL1 controller;
  - full spawn-energy floor (`energyAvailable === energyCapacityAvailable`) and at least the
    configured protected floor;
  - exactly one active spawn and zero owned extensions;
  - at least one legal worker with `WORK`, `CARRY`, and `MOVE` plus positive carried energy.
- `GrowthCandidate` for `bootstrap-controller` uses stable reason code `rcl1-bootstrap-controller`
  and a `null` energy claim, so it spends carried creep cargo while preserving the room’s protected
  reserve.
- `authorizedSurvivalGrowth` keeps bootstrap contracts alive while temporary conditions fluctuate
  (for example temporary loss of carried energy or workforce), but transitions them to `cancelled`
  only when the room can no longer represent the bootstrap phase (lost ownership, not RCL1,
  extensions present, or non-1 active spawn).
- Requests for `bootstrap-controller` are denied outside developing/mature and in
  recovery/emergency/ constrained CPU, matching the existing optional-growth posture rule.

## Consequences

- This enables the room to fund legal 200-energy replacement workers and then progress the
  controller using post-harvest/transfer cargo without spending protected spawn energy.
- Bootstrap growth avoids duplicate bootstrap contracts while the target phase is viable; the
  contract is only retired when phase constraints no longer hold.
- Existing movement, contract, allocator, and execution authorities remain unchanged.

## Mechanics sources consulted

- [Screeps documentation: Creep.upgradeController](https://docs.screeps.com/api/#Creep.upgradeController)
- [Screeps documentation: StructureController](https://docs.screeps.com/api/#StructureController)
- [Screeps documentation: Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable)
- [Screeps control levels and room progression](https://docs.screeps.com/control.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
