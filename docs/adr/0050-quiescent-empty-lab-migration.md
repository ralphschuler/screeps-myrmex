# ADR 0050: Quiescent empty-lab migration

## Status

Accepted

## Context

The committed RCL8 layout can adopt an externally placed lab. Existing convergence restores
committed extension, tower, link, and general-container geometry, but an adopted lab permanently
suppresses its canonical site. Removing a lab during reaction, reverse-reaction, boost, staging, or
pending settlement would change the current lab-layout and assignment fingerprints and interrupt
IndustryDirector-owned work.

The current layout diff/site chain, deterministic lab-cluster assignment, logistics contracts,
structure-removal arbiter/executor, and reset-safe destroy receipt already own the required build,
work, and irreversible-command boundaries.

## Decision

- `IndustryDirector` publishes one bounded current-tick `LabMigrationRoomView` per observed owned
  room. It contains only the current assignment, cluster limits, observation tick, room identity,
  bounded activity reason codes, and a quiescent bit derived from current commitments, pending
  attempts, intents, staging demands, and demand endpoints. It exposes no policy mutation or command
  capability.
- The convergence projection restores committed primary lab geometry through the ordinary
  construction-site, funding, build-contract, and executor path while adopted external labs remain
  usable current observation.
- `ConstructionPlanner` remains the sole migration-priority owner. RCL8 removal requires all ten
  observed owned labs, exactly nine active labs on distinct committed primary positions, and one
  external active target on an unshared site-free tile.
- The target must have exact empty Store evidence, 2,000 energy capacity, 3,000 mineral capacity,
  null mineral type, and zero cooldown. Current industry evidence must match the same observation,
  be quiescent, and reproduce the current assignment fingerprint. No assigned/active logistics
  endpoint may name any lab in the room.
- The existing deterministic cluster authority is rerun over the nine post-removal exact labs. A
  valid assignment is mandatory; its canonical first member supplies the existing exact replacement
  identity carried by the proposal, receipt, and executor.
- The sole removal arbiter keeps its 128-input and one-global-command limits. Only
  `StructureDestroyExecutor` may call `Structure.destroy`; it freshly rechecks the target's exact
  owned active empty Store, capacities, null mineral type, zero cooldown, position, room, and the
  exact active owned replacement.
- Layouts owner-local schema V10 adds only `lab` to the fixed removal-receipt discriminator. V1-V9
  migrate without inventing lab evidence. `OK` remains pending until fresh disappearance; failures
  retain the existing three-attempt reset-safe backoff.
- Any current commitment, pending attempt, intent, staging demand, logistics endpoint, stock,
  contamination, cooldown, inactive lab, cluster drift, stale observation, threat, controller risk,
  reserve/workforce loss, RCL/layout drift, or site pressure preserves the target and authorizes no
  command.

## Consequences

One quiescent empty external lab can converge without losing stock or interrupting reaction/boost
work and without a second lab, layout, logistics, removal, or persistence authority. Planning stays
inside the existing two-room window, ten-lab cluster cap, 128-candidate removal cap, and one global
destroy slot. Each room retains at most one fixed removal receipt; no migration queue or lab-role
map is persisted.

Active-work-preserving lab migration remains out of scope because current assignment fingerprints
include every observed lab identity and position. It requires a separate explicit handoff design.
Rolling back to V9 preserves the V10 owner as future data and disables layout work; redeploying V10
resumes bounded receipt evidence.

## Mechanics sources

Reviewed 2026-07-19:

- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): labs unlock 3/6/10 at
  RCL6/7/8, cost 50,000 energy, store 3,000 mineral plus 2,000 energy, use two range-two input labs,
  and expose reaction/unboost cooldown.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate; `OK` reports scheduling; ownership and hostile-room failures are explicit.
- Official [`Structure.isActive`](https://docs.screeps.com/api/#Structure.isActive): insufficient
  current RCL makes a structure unusable.
- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite): site
  creation is scheduled and constrained by ownership, target compatibility, player cap, arguments,
  and RCL.
- Official [Screeps documentation index](https://docs.screeps.com/).
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies common two-input,
  range-two, cooldown, emptying, and refill terminology only. MYRMEX policy remains independently
  source-defined.
