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
- An explicitly funded reverse objective uses the same commitment, cluster key, shared arbiter, and
  executor boundary. It settles only for exact `-5/+5/+5` compound/reagent deltas. A no-effect
  observation becomes a durable retry-ready marker rather than a permanently blocking attempt.
- One pure composition seam derives cluster/catalog facts, runs policy staging around the existing
  logistics demand projection, and publishes typed intents. The tick graph supplies its budgets to
  `ColonyDirector` and atomically persists reconciliation in `IndustryOwnerV3`.

## Consequences

Command success is not confused with gameplay success, heap reset cannot duplicate an observed
attempt, and unrelated lab actors cannot bypass shared arbitration. Issue `#257` adds checked
composed evidence in `phase2-labs-results.json` and makes the separate `phase2.labs` source gate
available under `runtime-config-source-v26`. It does not authorize factory, power-spawn, nuker,
market, movement, or power-effect behavior.

## References

- [StructureLab.runReaction](https://docs.screeps.com/api/#StructureLab.runReaction)
- [StructureLab.reverseReaction](https://docs.screeps.com/api/#StructureLab.reverseReaction)
- [StructureLab.boostCreep](https://docs.screeps.com/api/#StructureLab.boostCreep)
