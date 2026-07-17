# ADR 0024: Lab execution and exact observation settlement

## Status

Accepted

## Context

ADR 0023 deliberately stopped `ready` lab commitments before command authority. Reactions and boosts
now need a bounded path through shared arbitration and a way to distinguish a scheduled API call
from an effect observed in the world.

## Decision

- The lab runtime projects typed `lab.run-reaction` and `lab.boost-creep` intents only from current
  `ready` commitments.
- Every intent claims one assignment-fingerprinted lab-cluster exclusive key. Boosts use defense
  priority and therefore precede discretionary reaction work; the shared `IntentChannel` remains
  final admission authority.
- `LabExecutor` is the sole adapter allowed to call `runReaction` or `boostCreep`. It revalidates
  ownership, activation, range, resources, fingerprints, body eligibility, and observed amounts
  immediately before one API call.
- Only normalized `OK` creates a bounded pending attempt. `IndustryOwnerV3` stores those attempts
  with the exact pre-command observation and preserves V1 terminal and V2 commitment state through
  owner-local migration.
- The next exact observation settles a reaction only for `-5/-5/+5` reagent/product deltas. A boost
  settles only when body, mineral, and energy deltas agree at 30 mineral and 20 energy per part.
  Missing, changed, late, conflicting, or retry-capped observations fail closed.

## Consequences

Command success is not confused with gameplay success, heap reset cannot duplicate an observed
attempt, and unrelated lab actors cannot bypass shared arbitration. This decision does not activate
the industry gate, add telemetry acceptance, authorize reverse reactions, move creeps, or introduce
power effects.

## References

- [StructureLab.runReaction](https://docs.screeps.com/api/#StructureLab.runReaction)
- [StructureLab.boostCreep](https://docs.screeps.com/api/#StructureLab.boostCreep)
