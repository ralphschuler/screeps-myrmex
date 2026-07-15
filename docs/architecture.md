# Architecture

MYRMEX is one deployable TypeScript application. Internal module boundaries exist to assign
authority, not to create independently versioned frameworks.

## Product Boundary

- `@myrmex/bot` is bundled into `dist/main.js` and is the only runtime artifact.
- `@myrmex/scenario-kit` is a development dependency in spirit and may never enter the bundle.
- New workspace packages require an architecture decision record.

## Tick Lifecycle

Every tick passes through seven deterministic phases:

1. **Boot** validates persistent state and migrations.
2. **Observe** creates one immutable snapshot of visible game state.
3. **Safety** handles towers, safe mode, evacuation, and survival overrides.
4. **Plan** converts objectives and deficits into typed intents.
5. **Execute** arbitrates conflicting intents and issues Screeps commands.
6. **Reconcile** records results, failures, and invalidated assumptions.
7. **Telemetry** emits bounded outcome metrics.

Only safety and execution code may issue irreversible actions. Planners operate on snapshots and
emit data.

## Authorities

| Concern                          | Sole authority                  |
| -------------------------------- | ------------------------------- |
| Persistent state and migrations  | `state/`                        |
| Tick deadlines and CPU admission | `runtime/`                      |
| Visible-world normalization      | `world/`                        |
| Spawn demand                     | future `spawn/` planner         |
| Movement reservations            | future `movement/` arbiter      |
| Diplomacy and reputation         | future `diplomacy/` ledger      |
| Military authorization           | future `operations/` controller |
| Metrics                          | `telemetry/`                    |

Duplicate caches, event buses, command registries, or memory managers are architecture defects.

## Persistent State

`Memory.myrmex` is small, versioned, and authoritative. It stores facts that must survive a global
reset and committed strategic decisions. Derived indexes, game objects, paths, and per-tick task
state stay in heap memory or reconstruct from observation.

RawMemory segments will eventually hold bounded room intelligence, path matrices, and telemetry
rings behind one segment scheduler. InterShardMemory will contain only heartbeats and idempotent
handoff records.

## Capability Contracts

Creeps are bodies that satisfy work contracts. The planner asks for capabilities such as mining,
hauling, building, healing, or dismantling with a deadline, location, priority, budget, and exit
condition. Names such as miner or defender may be useful body archetypes, but they do not become
parallel planning systems.

## CPU Model

Every optional planner declares a cadence, deadline, estimated cost, and minimum bucket mode. The
scheduler always admits survival, defense, spawning, and essential logistics first. Expensive work
must be incremental and safely skippable.
