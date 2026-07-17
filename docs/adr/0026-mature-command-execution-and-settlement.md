# ADR 0026: Mature command execution and exact observation settlement

## Status

Accepted

## Context

Funded factory and power-processing objectives can become logistics-ready, but `ready` is not
command authority. Calling `StructureFactory.produce` or `StructurePowerSpawn.processPower` from
policy would bypass exclusive-resource arbitration, live precondition checks, normalized command
results, and reset-safe next-observation settlement.

Factory effects, recipes, store capacity, and cooldown timing can change independently. Operated
power processing also consumes more than the base one power per call. Treating `OK` as completed
work would overstate production and could duplicate a command after a heap reset.

## Decision

- `MatureStructureArbiter` is the bounded domain authority for current funded `ready` factory and
  power-processing commitments. It emits typed intents only. Both kinds claim the canonical
  `mature-structure/{structureId}` exclusive key; the shared intent channel remains final admission
  authority.
- Source mechanics normalize all five `PWR_OPERATE_POWER` effects. A power-processing intent
  requests exactly the complete amount the API will process; a smaller remaining objective cannot
  authorize a partial call.
- `MatureStructureExecutor` is the sole boundary allowed to call `StructureFactory.produce` and
  `StructurePowerSpawn.processPower`. It revalidates the current mechanics fingerprint, ownership,
  activation, controller level, cooldown, factory level/effect, exact affected store amounts, total
  factory capacity, operated power effect, and exact power/energy stock before one call.
- Every documented return code is normalized through the shared command-result boundary. Only `OK`
  creates a pending attempt.
- `IndustryOwnerV4` adds at most 64 canonical mature attempts. A factory receipt retains at most 64
  complete pre-command store-resource entries; a larger store fails closed before an intent. The
  owner-local V3-to-V4 migration preserves terminal and lab state and initializes no mature effect.
- The next exact observation settles a factory attempt only for recipe component/product deltas and
  remaining cooldown `recipe.cooldown - 1`. Power processing settles only for the exact operated
  power delta and 50 energy per processed power. Exact factory settlement also requires the expected
  total store use and unchanged capacity, so unrelated stock movement cannot masquerade as a batch.
  An issued attempt may still record its exact irreversible effect after the objective is fulfilled
  or withdrawn; that receipt authorizes no retry. No effect retries within a cap; conflicting,
  missing, inactive, stale, unfunded, expired, or late retry evidence fails closed.
- A fixed-cardinality observer projection reports intent, command, retry, cancellation, truncation,
  and settled factory/power totals. It owns no history and authorizes no work.

## Consequences

Heap reset and reordered bounded inputs reproduce intent and settlement identities. Policy remains
data-only, command success is not confused with gameplay success, and persistent Memory stores no
live object or reconstructible world snapshot. This slice does not compose mature commands into the
tick graph or activate a feature gate; issue #267 owns that work. Observer commands, nuke launch,
market sourcing, and power-creep policy remain absent.

## Mechanics sources

- [Official `StructureFactory.produce`](https://docs.screeps.com/api/#StructureFactory.produce)
- [Official `StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower)
- [Official engine factory processor](https://github.com/screeps/engine/blob/master/src/processor/intents/factories/produce.js)
- [Official engine power-spawn processor](https://github.com/screeps/engine/blob/master/src/processor/intents/power-spawns/process-power.js)
- [Official engine structure API](https://github.com/screeps/engine/blob/master/src/game/structures.js)
- [Screeps Wiki: StructureFactory](https://wiki.screepspl.us/StructureFactory/)
- [Screeps Wiki: Power](https://wiki.screepspl.us/Power/)
