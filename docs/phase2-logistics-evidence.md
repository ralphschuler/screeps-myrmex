# Phase 2 logistics evidence

Issue [#47](https://github.com/ralphschuler/screeps-myrmex/issues/47) establishes one bounded,
deterministic logistics authority for owned-room resource flow. The checked result is
[`phase2-logistics-results.json`](phase2-logistics-results.json).

## Composed deterministic scenario

The scenario composes the production logistics planner, V3 contract projector, and observer-only
logistics telemetry reducer. It admits seven stable flows spanning container, storage, dropped,
tombstone, and ruin sources and spawn, extension, storage, terminal, lab, and factory sinks. Warm,
serialized-state reset, and reversed node/edge insertion order produce the same semantic result.

The normal graph has ten nodes and seven edges. Source and sink reservations are checked against
every fresh observed amount and capacity. Mandatory spawn and extension flows receive all 250 energy
requested when optional storage and terminal work is removed under pressure, while the 300-energy
recovery tranche remains outside logistics authority. Three identical projections keep the
dedicated-hauler recommendation at four `CARRY` and four `MOVE` parts rather than growing or
oscillating.

## Recovery matrix

| Scenario                  | Checked outcome                                                        |
| ------------------------- | ---------------------------------------------------------------------- |
| Partial load and delivery | 50 picked up, 30 delivered, 20 retained for the delivery stage         |
| Hauler death              | Actor-dead deferral advances one cycle, then reacquires remaining 170  |
| Heap/persistent reset     | Flow id, 200 reservation, cycle, and delivered 30 survive round-trip   |
| Full or empty store       | Flow blocks deterministically and creates no source/sink reservation   |
| Vanished spawn            | Flow is not admitted, request retires, and no sink reservation remains |
| Dropped-resource decay    | A fresh fall from 50 to 20 caps the next reservation at 20             |
| Reordered observations    | Contract identity, target order, reservations, and body demand match   |

Telemetry reports tick-local pickup, delivery, loss, shortfall, latency, active contract, and CPU
facts from cumulative observations. A serialized reset emits no duplicate deltas. The scenario
exceeds and caps observer state at eight flows, checks it remains below 4 KiB, and proves reducing
telemetry does not alter the logistics plan. The fixture issues zero Screeps commands.

## Evidence boundaries

- This deterministic gate proves pure authority composition and reconciliation. The production
  runtime test owns live snapshot adaptation, funding, allocation, lease execution, and Screeps
  return-code behavior.
- [#48](https://github.com/ralphschuler/screeps-myrmex/issues/48) remains the sole link-command
  authority.
- [#49](https://github.com/ralphschuler/screeps-myrmex/issues/49) remains the sole container-repair
  authority.
- Terminal sends, market valuation, remote hauling, hostile-safety policy, and inter-room flow are
  outside this gate.

## Mechanics sources

ADR 0018 records the official [`Store`](https://docs.screeps.com/api/#Store),
[`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
[`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
[`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer), and
[`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) contracts. The Screeps Wiki
[`Maturity Matrix`](https://wiki.screepspl.us/Maturity_Matrix/) and
[`Energy`](https://wiki.screepspl.us/Energy/) pages supply terminology and strategy context only;
the implementation and scenario remain clean-room.

Run the focused gate from the repository root:

```bash
npx vitest run packages/scenario-kit/test/phase2-logistics-gate.test.ts
```
