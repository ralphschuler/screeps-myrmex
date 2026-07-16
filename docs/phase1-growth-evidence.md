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
- The planner selects only observed owned spawn, extension, container, road, and tower sites. It
  creates no construction sites and retains no layout, topology, or placement state.

## Mechanics sources consulted

- [Screeps documentation: Creep.upgradeController](https://docs.screeps.com/api/#Creep.upgradeController)
- [Screeps documentation: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps documentation: Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [Screeps Wiki](https://wiki.screepspl.us/)
