# ADR 0053: Quiescent obsolete-lab mixed-stock evacuation

## Status

Accepted

## Context

ADR 0051 evacuates energy-only obsolete labs to the canonical committed replacement lab, while ADR
0052 evacuates mineral-only obsolete labs to the active storage published by Industry. A legal lab
may hold both energy and one mineral kind. Destroying that lab would discard both resources, but
retaining it prevents committed RCL8 lab geometry from converging.

The layouts owner and `ConstructionPlanner` already own the migration commitment. `LogisticsPlanner`
already owns both resource-specific flow forms, and the existing V3 leases, agents, removal
arbiter/executor, and bounded receipt own every command and reconciliation boundary.

## Decision

- `ConstructionPlanner` extends only the quiescent path from ADRs 0050–0052. The target must remain
  active and zero-cooldown, contain exact positive energy of at most 2,000 plus one exact positive
  non-energy resource of at most 3,000, and retain every RCL8, assignment, cluster, endpoint, and
  colony-safety proof.
- The canonical committed replacement lab must have complete independent energy capacity. The exact
  active owned storage published by Industry must have complete aggregate capacity for the mineral.
  Layout policy selects neither destination independently.
- Layouts owner-local schema V13 adds one mixed variant to the existing optional lab evacuation:
  source, replacement lab, storage destination, resource type, both amounts and destination
  baselines, start tick, and exclusive 150-tick expiry. V1–V12 migrate without inventing mixed
  evidence; V11 energy and V12 mineral records retain their representations.
- Following ticks validate the complete mixed record before atomically publishing two distinct
  `optional-growth` budget bindings and flows through the sole `LogisticsPlanner`: energy to the
  replacement lab and mineral to storage. An identity or fixed 64-flow/128-node projection overflow
  publishes neither flow.
- Independent partial progress is resumable. Loss of either destination, baseline, capacity,
  quiescence, cluster, or safety proof removes the complete mixed projection from same-tick agent
  execution. Completed resource flow does not authorize removal while the other remains.
- Removal requires fresh target emptiness, replacement energy at least its baseline plus committed
  energy, storage mineral at least its baseline plus committed mineral, both exact flow identities
  and all three endpoint identities retired, unchanged destination/assignment/cluster evidence, and
  current colony safety.
- The sole removal arbiter, `StructureDestroyExecutor`, and three-attempt reset-safe receipt remain
  unchanged. No layout-owned creep command, second logistics authority, or stock mirror is added.

## Consequences

One mixed-stock obsolete lab can converge without discarding energy or mineral and without
interrupting active lab work. Each room still persists at most one fixed lab evacuation. Projection
work remains bounded by 64 layout records, 64 total lab evacuation flows, 128 nodes/endpoints, the
existing two-room migration window, 128 removal candidates, and one global destroy command.

ADR 0063 subsequently permits this quiescent mixed form to use one exact idle terminal for mineral
when no active storage exists; energy still moves to the retained lab and both flows remain atomic.
ADR 0064 extends that destination to one exact durable reaction handoff, and ADR 0065 extends it to
the equivalent explicit-boost handoff. Multiple labs, general layout-revision migration, and creep
dismantling remain separate. Rolling back to V12 preserves V13/V14 bytes and fails closed;
redeploying current code resumes bounded evidence.

## Mechanics sources

Reviewed 2026-07-19:

- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): RCL8 allows ten labs; each
  lab has independent 2,000 energy and 3,000 mineral capacities, holds one mineral type, and applies
  cooldown to reaction/unboost work.
- Official [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage): one RCL4+ owned
  storage provides 1,000,000 units of general-purpose capacity.
- Official [`Store`](https://docs.screeps.com/api/#Store): resource-specific stock and aggregate
  general-store free capacity constrain both admissions.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled resource
  movement supplies the existing logistics command boundary.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate and returns explicit ownership and hostile-room failures.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies cluster, cooldown,
  emptying, refill, and storage-drain terminology only. MYRMEX policy remains independently
  source-defined.
