# Phase 1 survival-growth evidence

Source version: `runtime-config-source-v11`.

Issue [#28](https://github.com/ralphschuler/screeps-myrmex/issues/28) adds bounded controller
upgrading and construction of already-observed critical sites without taking layout or construction
site-placement authority.

## Outcome evidence

- `survival-growth.test.ts` proves downgrade-risk controller upgrading outranks optional existing
  construction, funded work alone becomes a contract, hostile rooms emit nothing, and a vanished
  site cancels its contract.
- The bootstrap acceptance scaffold is covered by targeted command:
  `npm exec vitest -- run packages/bot/test/survival-growth.test.ts`
- Optional work requires the protected spawn-energy floor plus the configured growth surplus, uses
  the existing `optional-growth` budget category, and is bounded per room and per tick.
- `survival-growth.test.ts` also proves the RCL1 bootstrap path: when `energyAvailable` and
  `energyCapacityAvailable` are both at the configured protected floor, growth can emit
  `bootstrap-controller` upgrade work with stable reason `rcl1-bootstrap-controller`, and bootstrap
  demand remains reusable while temporary conditions fluctuate.
- Issue #479 gives that work a 1,500-tick budget/contract horizon, matching its existing bounded
  assignment-cost ceiling instead of inheriting the generic 50-tick lease horizon. The regression
  test rejects the prior 49-tick initial and roughly 40-tick post-renewal windows. A due active
  generation now enters the existing atomic ContractLedger replacement channel with only its exact
  next sequence and a freshly funded horizon; no parallel contract, budget, or queue is added.
- `workforce-allocator.test.ts` distinguishes `no-actor`, `travel-unknown`, and
  `deadline-infeasible` from remaining actor infeasibility. It also requires current positive actor
  energy for controller work, so an empty worker cannot issue a doomed upgrade.
  `telemetry-service.test.ts` proves those reasons plus funding/issuer-renewal rejection remain
  bounded and expose only opaque contract fingerprints.
- Controller downgrade work uses `controller-risk`; `BudgetLedger` places it ahead of optional
  growth while recovery, defense, and mandatory work remain authoritative. Issue #481 makes every
  RCL1 risk form a null room-energy claim, so the live `protected-energy-floor` blocker cannot
  deadlock carried controller work. A pre-fix pending positive claim receives one fresh revision;
  cargo loss then leaves the corrected request byte-stable and allocation deferred until refill.
- That RCL1 risk form suppresses the duplicate ordinary candidate. A due risk generation renews
  atomically before any later category transition. As an upgrade raises the downgrade timer out of
  the risk window—or later decay re-enters it—the same ContractLedger replacement advances the
  issuer's exact next generation between `controller-risk` and `bootstrap-controller` funding. The
  ledger accepts only that typed category-handoff proof with unchanged owner, budget issuer, work,
  and target terms; integrated tests reject an unproved category change.
- Bootstrap growth uses a `bootstrap-controller` budget category with a null room-energy claim so
  controller progress spends carried creep energy first and leaves the protected reserve intact
  until RCL2.
- Issue #473 adds the bounded next transition: an owned RCL2 room below the configured normal-growth
  floor may emit only observed owned extension-site work when one active spawn, the protected room
  reserve, and one viable worker with carried energy are current. The distinct
  `rcl2-infrastructure-bootstrap` candidate keeps the existing `optional-growth` posture gates but
  claims no room energy and uses the extended 1,500 assignment-cost ceiling.
- `survival-growth.test.ts` proves the low-capacity selection, null energy claim, stable distinct
  issuer, normal-floor handoff without duplicate contract submission, hostile/reserve denial,
  temporary worker-loss retention, and stale target retirement. `colony-budget-ledger.test.ts`
  proves that the active request reserves one CPU unit and zero of the protected 300 room energy.
  `workforce-allocator.test.ts` proves that a nearer empty worker cannot displace a loaded worker,
  including a bounded 111-tick travel estimate.
- `phase1-gate-runtime.test.ts` reconstructs Memory and the module heap, then executes the exact
  production contract/action path against a first-extension site. Five carried energy completes the
  bounded fixture while spawn energy remains 300 and capacity rises from 300 to 350. Issue #474 adds
  a production row in which a funded but unleased V2 static contract cannot suppress the only mobile
  worker: that worker harvests and progresses the first extension while all 300 spawn energy remains
  protected. A second row reaches an exact static takeover, removes that miner, enters constrained
  CPU, and restores one mobile harvest without duplicate source commands. Issue #476 closes the
  remaining production chain in `spawn-only-rcl2-progression-runtime.test.ts`: a zero-site,
  zero-extension 300-capacity room uses the production layout executor, exact PathFinder adapter,
  deferred next-tick movement, ordinary contracts/leases/actions, and full 3,000-energy extension
  costs to exceed 400 capacity and resume controller progress. The same bounded row injects surplus
  and constrained CPU, unavailable/recovered paths, module/Memory reset, reordered observations,
  complete workforce loss, and replacement useful work without duplicate site commands or kernel
  faults. A newly considered full carry-bearing actor consumes its cargo before V2/V5 drop-mining;
  an incumbent drop miner retains continuity.
- `survival-flow-runtime.test.ts` composes the recovery and bootstrap paths from an empty Memory
  RCL1 world with one 300-capacity spawn: it accounts controller spend separately from room and
  creep energy, reaches RCL2 by tick 1,599 (a 1,500-tick replay deadline), and asserts the spawn
  reserve is restored to 300 while `upgradeController` work executes. The same replay preserves
  heap-reset, reordered-source, movement, replacement, and single-authority assertions.
- Its #479 production-`runTick` row starts with a full 300/300 spawn, one full legal worker, and a
  mechanically valid 196/200 RCL1 controller facing a synthetic legal route whose fatigue-safe
  estimate is at least 40 ticks. Constrained CPU and an unavailable path defer safely; after both
  recover, one lease moves and upgrades across fatigue, JSON/module-heap reconstruction, and
  reordered observations, reaches RCL2 within 250 ticks, emits no deadline-infeasible outcome or
  duplicate command, and leaves spawn energy at 300.
- The #481 production-`runTick` row starts that same 196/200 outcome at the exact controller-risk
  boundary with four carried energy and a full 300/300 spawn. It obtains a zero-room-energy
  controller-risk grant, defers across constrained CPU, an unavailable/recovered path, and temporary
  cargo removal/refill, then moves and upgrades four times. It crosses atomically into ordinary
  bootstrap funding when the official 100-tick timer effect clears risk, survives JSON/module-heap
  reconstruction and input reorder, and reaches RCL2 with one contract, one lease, no spawn command,
  and all 300 spawn energy intact. Focused ContractLedger evidence retains exact first-tick lease
  expiry/reassignment, while the complete recovery row retains actor death/replacement.
- The planner selects only observed owned spawn, extension, container, road, and tower sites. It
  creates no construction sites and retains no layout, topology, or placement state.

## Mechanics sources consulted

- [Screeps documentation: Creep.upgradeController](https://docs.screeps.com/api/#Creep.upgradeController)
- [Screeps documentation: Creep.move](https://docs.screeps.com/api/#Creep.move)
- [Screeps documentation: Creep.ticksToLive](https://docs.screeps.com/api/#Creep.ticksToLive)
- [Screeps documentation: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps documentation: Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [Screeps documentation: Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps documentation: Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable)
- [Screeps documentation: Control](https://docs.screeps.com/control.html)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)
- [Screeps Wiki: Pathfinding and fatigue](https://wiki.screepspl.us/Pathfinding/)
- [Screeps Wiki: Room Control Level](https://wiki.screepspl.us/Room_Control_Level/)
- [Screeps Wiki: Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)

Reviewed 2026-07-28. Official mechanics establish range-three carried-energy upgrading, one-square
movement, fatigue return behavior, and finite creep lifetime. Wiki pages supplied operational
fatigue/path and RCL terminology only; MYRMEX's horizon and renewal policy are independently
derived.
