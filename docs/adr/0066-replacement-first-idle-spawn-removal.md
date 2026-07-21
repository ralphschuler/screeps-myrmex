# ADR 0066: Replacement-first idle spawn removal

## Status

Accepted

## Context

Parent issue #99 requires explicit safety before any spawn is removed. Existing layout convergence
restores extension, tower, link, and lab geometry, but it leaves compatible external spawns in
place. At RCL7/RCL8, a room can therefore retain full spawn allowance with one empty idle external
spawn and one missing committed position indefinitely.

Removing that spawn from layout evidence alone is unsafe. `SpawnBroker` may have selected the target
or the only idle retained spawn in the same tick, and an assigned/active work lease may still name
the target as its primary or counterpart endpoint. The command is irreversible even though `OK` is
only scheduled evidence.

## Decision

- The convergence projection replaces compatible external spawn placements with source-defined
  committed spawn geometry only when current controller allowance is at least two. Below RCL7,
  current placements remain unchanged.
- `ConstructionPlanner` may propose one external spawn only at full current allowance, with exactly
  allowance minus one active spawns on distinct committed positions. The external target must be the
  sole structure on its site-free tile, active, idle, and have an exact empty 300-energy Store.
- The planner consumes the already-published current-tick `SpawnBroker` result. A selected target is
  ineligible, and at least one active committed spawn with an exact Store must remain idle and
  unselected. `SpawnBroker` remains the sole spawn-slot, body, name, and room-energy authority.
- Every assigned/active contract primary or counterpart endpoint blocks removal, including the V1
  survival-fill path and V3 Logistics path. A newly proposed current-tick refill commitment cannot
  enter same-tick agent execution and does not block; existing target-loss reconciliation handles
  later evidence. Missing contract evidence fails closed.
- `StructureRemovalArbiter` carries explicit target/replacement idle terms and retains the existing
  128-candidate and one-global-command ceilings. `StructureDestroyExecutor` freshly rechecks exact
  room, ownership, layout, target/replacement identity, activity, target Store emptiness, both idle
  states, and hostile absence before the sole `Structure.destroy` call.
- Layouts owner-local schema V15 adds only `spawn` to the existing fixed removal-receipt
  discriminator. V14 migrates without inventing spawn evidence; a spoofed pre-V15 spawn receipt is
  rejected. `OK` waits for observed disappearance, failures use the existing three-attempt backoff,
  and the ordinary site/funding/build chain restores the final committed spawn.
- No owner, queue, spawn reservation, logistics flow, command authority, telemetry cardinality, or
  root Memory schema is added.

## Consequences

One RCL7/RCL8 colony can converge spawn geometry while retaining one immediately executable
committed spawn. At RCL8, one retained spawn may be selected only when another exact retained spawn
remains idle and unselected. A busy, stocked, inactive, selected, endpoint-bound, sole,
replacementless, threatened, reserve-deficient, controller-risk, malformed, or drifted case
preserves the target.

Work remains bounded by the existing two-room layout window, 128 removal candidates, one fixed
receipt per room across 64 records, and one global destroy command. RCL8 domain health may enter
recovery after observed removal and returns only after ordinary construction restores complete
committed geometry.

Rollback to V14 code preserves the future layouts owner byte-for-byte and disables layout work until
supporting code returns. Redeployment resumes from the same receipt. Stocked-spawn evacuation,
sole-spawn relocation, general multi-step migration, defensive migration, autonomous boost-manifest
production, and creep dismantling remain parent issue
[#99](https://github.com/ralphschuler/screeps-myrmex/issues/99).

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn),
  [`StructureSpawn.spawning`](https://docs.screeps.com/api/#StructureSpawn.spawning), and
  [`StructureSpawn.spawnCreep`](https://docs.screeps.com/api/#StructureSpawn.spawnCreep): allowance
  is one through RCL6, two at RCL7, and three at RCL8; spawn capacity is 300; one body part occupies
  the spawn for three ticks.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy),
  [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive),
  [game loop](https://docs.screeps.com/game-loop.html), and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): `OK` schedules the
  command and next-tick observation proves disappearance.
- Official [Control guide](https://docs.screeps.com/control.html) defines RCL spawn allowances.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page),
  [`StructureSpawn`](https://wiki.screepspl.us/StructureSpawn/),
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply spawn-access, committed-layout, and deferred-
  action terminology only. Official API contracts govern behavior.
