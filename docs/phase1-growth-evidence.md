# Phase 1 survival-growth evidence

Source version: `runtime-config-source-v11`.

Issue [#28](https://github.com/ralphschuler/screeps-myrmex/issues/28) adds bounded controller
upgrading and construction of already-observed critical sites without taking layout or construction
site-placement authority.

## Outcome evidence

- `survival-growth.test.ts` proves downgrade-risk controller upgrading outranks optional existing
  construction, funded work alone becomes a contract, hostile rooms emit nothing, and a vanished
  site cancels its contract.
- Optional work requires the protected spawn-energy floor plus the configured growth surplus, uses
  the existing `optional-growth` budget category, and is bounded per room and per tick.
- Controller downgrade work uses `controller-risk`; `BudgetLedger` places it ahead of optional
  growth while recovery, defense, and mandatory work remain authoritative.
- The planner selects only observed owned spawn, extension, container, road, and tower sites. It
  creates no construction sites and retains no layout, topology, or placement state.

## Mechanics sources consulted

- [Screeps documentation: Creep.upgradeController](https://docs.screeps.com/api/#Creep.upgradeController)
- [Screeps documentation: Creep.build](https://docs.screeps.com/api/#Creep.build)
- [Screeps documentation: Room.createConstructionSite](https://docs.screeps.com/api/#Room.createConstructionSite)
- [Screeps Wiki](https://wiki.screepspl.us/)
