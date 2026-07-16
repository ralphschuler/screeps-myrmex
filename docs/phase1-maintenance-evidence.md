# Phase 1 critical-maintenance evidence

Source version: `runtime-config-source-v10`.

Issue [#40](https://github.com/ralphschuler/screeps-myrmex/issues/40) implements bounded local
repair policy without enabling Phase 2 layout or fortification maintenance.

## Outcome evidence

- `critical-maintenance.test.ts` covers deterministic selection of a damaged spawn, sole container,
  and direct access road; it excludes walls, ramparts, and a non-critical road.
- The same test verifies hostile-threat suppression, funded contract emission only after an active
  maintenance reservation, repair completion thresholds, and clean cancellation after resolution.
- `BudgetLedger` enforces protected recovery energy and higher-priority emergency, defense, and
  replacement categories before `critical-maintenance`; tower repair remains under DefenseDirector
  and its emergency reserve.
- `lease-agent.test.ts` and ADR 0011 cover repair threshold completion and bounded command-failure
  retry across durable contract history.

## Mechanics sources consulted

- [Screeps documentation: Creep.repair](https://docs.screeps.com/api/#Creep.repair)
- [Screeps documentation: Structure.hits](https://docs.screeps.com/api/#Structure-hits)
- [Screeps documentation: StructureTower.repair](https://docs.screeps.com/api/#StructureTower-repair)
- [Screeps documentation: StructureRoad](https://docs.screeps.com/api/#StructureRoad)
- [Screeps Wiki](https://wiki.screepspl.us/)

The visible-road observation is used only for the explicitly local access predicate; it is not a
layout or route-maintenance cache.
