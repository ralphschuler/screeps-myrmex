# Phase 1 respawn recovery regression evidence

Issue [#499](https://github.com/ralphschuler/screeps-myrmex/issues/499) protects the existing Phase
1 zero-creep outcome after terminal account loss and fresh respawn. This is post-gate regression
protection, not a new Phase 1 closure criterion or authority.

## Observed failure

On 2026-08-01, bounded authorized read-only sampling found current telemetry advancing with no
kernel fault while one freshly controlled room had an operational idle spawn, enough regenerated
energy for the minimum recovery body, and zero creeps. The current-schema colony record remained
`lost` with `visible-ownership-lost`; no emergency reservation or spawn command was produced. Room,
shard, player, stockpile, defense, credential, raw Memory, and tactical timing details were omitted.

The current-default-branch reproduction persisted a valid owner-local colony V1 `lost` record and
then supplied fresh owned-controller, active idle-spawn, 300-energy, zero-creep observation to
production `runTick`. Before the repair, the resulting visible colony stayed `lost` and the expected
recovery spawn was absent.

## Root cause and outcome

`ColonyDirector` treated `lost` as terminal before checking fresh ownership. A successful account
respawn can retain the bounded room record, so that ordering let stale lifecycle disposition outrank
current world truth.

Fresh unowned evidence still enters or retains terminal loss, and unknown or stale vision still
preserves the record without authorization. Owned-controller evidence starts a new lifecycle only
when the room observation tick equals the executing tick. An operational spawn with no legal worker
re-enters `bootstrapping`; the existing `BudgetLedger`, `SpawnBroker`, `SpawnExecutor`, and exact
spawn expectation schedule and deduplicate the ordinary `WORK,CARRY,MOVE` recovery worker.

The current state's `stateSince` tick is the recovery-expectation boundary; the executing tick is
used before the first restarted state persists. A consumed recovery-spawn expectation scheduled
before that boundary no longer satisfies or defers the new objective when none of its bounded
candidate names is observed in a room current to that tick. This remains true when the replacement
spawn is absent on the restart tick and appears later. A matching current creep or active spawn
keeps that expectation and remains duplicate-suppression evidence. Existing ledger and suspended
contract records remain under their current owners and reconcile from the new lifecycle's exact
funding; the lifecycle transition does not clear either owner.

No owner field, schema version, authority, cache, queue, or command path changes. The existing room
record advances one bounded revision. Rollback requires no migration, but restores the deadlock for
retained terminal-loss Memory.

## Executable evidence

- `packages/bot/test/tick.test.ts` seeds a valid current Memory root with one terminal `lost`
  colony, one consumed/released prior-lifecycle emergency spawn entry, and one suspended stale work
  contract. Production `runTick` first receives a fresh owned controller without a spawn and
  persists `discovering` without spending while retaining the stale entry. When an active idle spawn
  and 300 energy appear on the next tick, the test asserts `bootstrapping`, exact emergency
  energy/CPU/spawn settlement, no stale-contract assignment or kernel fault, and one scheduled
  200-energy, nine-spawn-tick `WORK,CARRY,MOVE` command through the sole executor.
- The same test serializes Memory, resets loaded modules, observes the selected name still spawning
  on the next tick, and proves the current-lifecycle expectation suppresses a duplicate after global
  heap reconstruction.
- `packages/bot/test/colony-director.test.ts` proves unknown vision, stale owned-room evidence, and
  fresh unowned evidence leave the terminal record inert with zero objective and zero active
  reservation.

## Budgets and safety

- CPU: one constant-time lifecycle normalization plus linear passes over the existing bounded
  64-colony and 512-ledger projections; no new scan or scheduler admission.
- Persistent Memory: no new bytes by schema; one existing record revision changes when ownership
  restarts the lifecycle.
- Energy and spawn: existing emergency recovery policy only—minimum 200 energy and nine spawn ticks
  for `WORK,CARRY,MOVE`, within the existing 300-energy grant.
- Diplomacy and defense: unchanged. Current owned-controller evidence is mandatory; no target or
  threat classification changes.
- Deployment: repository validation proves the repair. Live outcome requires the normal validated
  merged-commit deployment gate and is not claimed by this document.

## Mechanics grounding

Reviewed 2026-08-01:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [Control guide](https://docs.screeps.com/control.html): room control begins from a claimed
  controller and the first owned spawn is the colony bootstrap boundary.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController): current
  ownership is explicit through the owned-structure contract.
- Official [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn): a spawn
  auto-regenerates room energy toward 300 so an account can recover after every creep dies; nullable
  `spawning` distinguishes idle from active spawning; `spawnCreep` schedules a legal body from room
  spawn/extension energy.
- Screeps Wiki [index](https://wiki.screepspl.us/),
  [Getting Started](https://wiki.screepspl.us/Getting_Started/),
  [`StructureController`](https://wiki.screepspl.us/StructureController/), and
  [`StructureSpawn`](https://wiki.screepspl.us/StructureSpawn/) supplied respawn, first-spawn, and
  RCL1 bootstrap terminology only. Official mechanics and observed MYRMEX outcomes govern.
