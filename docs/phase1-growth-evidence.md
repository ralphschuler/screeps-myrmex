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
- `survival-growth.test.ts` also proves the new RCL1 bootstrap path: when `energyAvailable` and
  `energyCapacityAvailable` are both at the configured protected floor, growth can emit
  `bootstrap-controller` upgrade work with stable reason `rcl1-bootstrap-controller`, and bootstrap
  demand remains reusable while temporary conditions fluctuate.
- Controller downgrade work uses `controller-risk`; `BudgetLedger` places it ahead of optional
  growth while recovery, defense, and mandatory work remain authoritative.
- Bootstrap growth uses a new `bootstrap-controller` budget category with a null room-energy claim
  so controller progress spends carried creep energy first and leaves the protected reserve intact
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
  bounded fixture while spawn energy remains 300 and capacity rises from 300 to 350. Layout-to-site,
  static-mining handoff, and full movement/progression evidence remain issues #474 and #476.
- `survival-flow-runtime.test.ts` composes the recovery and bootstrap paths from an empty Memory
  RCL1 world with one 300-capacity spawn: it accounts controller spend separately from room and
  creep energy, reaches RCL2 by tick 1,599 (a 1,500-tick replay deadline), and asserts the spawn
  reserve is restored to 300 while `upgradeController` work executes. The same replay preserves
  heap-reset, reordered-source, movement, replacement, and single-authority assertions.
- The planner selects only observed owned spawn, extension, container, road, and tower sites. It
  creates no construction sites and retains no layout, topology, or placement state.

## Mechanics sources consulted

- [Screeps documentation: Creep.upgradeController](https://docs.screeps.com/api/#Creep.upgradeController)
- [Screeps documentation: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps documentation: Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [Screeps documentation: Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps documentation: Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable)
- [Screeps documentation: Control](https://docs.screeps.com/control.html)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)
- [Screeps Wiki: Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
