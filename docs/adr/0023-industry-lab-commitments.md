# ADR 0023: Industry owner V2 and data-only lab commitments

- Status: Accepted
- Date: 2026-07-17
- Issues: #51, #253

## Context

Lab observation, reconstructible cluster roles, and bounded logistics staging exist, but reaction
objectives and boost manifests need one durable identity across heap reset and partial staging.
Persisting lab assignments, stock reservations, or expanded dependency chains would duplicate the
layout, observation, reaction-catalog, and logistics authorities. Splitting reaction and boost
policy would also let two planners compete for the same cluster.

The existing opaque `industry` owner already stores terminal-send retry state under schema V1. The
root Memory envelope does not interpret that payload, so adding lab commitments does not require a
root schema migration or another owner.

## Decision

`IndustryDirector` owns one pure bounded lab policy. It arbitrates explicit funded boost manifests
before discretionary forward reactions, selects at most one canonical reaction chain per room, and
emits independently funded resource demands through the existing LogisticsPlanner boundary. Lab
hauls remain normal priority so survival and mandatory logistics preempt them. Exact observed
contamination becomes a drain demand before production can become ready.

The policy persists only stable reaction or boost commitment terms and settlement counters. It does
not persist lab IDs or roles, expanded chains, current stock, logistics graph state, reservations,
derived readiness, or future command retries. Current assignment and reaction-catalog fingerprints
bind a commitment to the facts under which it was admitted. Changed fingerprints, deadlines, missing
actors, invalid facts, duplicates, and caps fail closed.

`IndustryOwnerV2` adds a capped canonical `labCommitments` array while retaining V1 terminal command
state. The owner-local V1-to-V2 migration increments the owner revision, advances to
`industry-policy-v2`, preserves canonical terminal retries, and initializes no invented lab work.
Unknown future and malformed non-empty owners remain unchanged and authorize nothing. The existing
industry/root transaction stages the migration atomically.

`ready` is a data disposition only. It does not authorize `runReaction`, `reverseReaction`, or
`boostCreep`, submit an intent, publish a contract, or infer command success. Reaction settlement
cannot be inferred from aggregate stock changes; the later lab executor and next observation own
that evidence. Exact observed creep boost groups may settle only their matching manifest tuple.

## Consequences

- Reordered inputs and heap reset reproduce canonical commitment, demand, budget, and blocker
  identities.
- Boost and reaction policy cannot race for one cluster.
- Logistics remains the sole stock and capacity reservation authority; there is no second mineral
  ledger.
- Existing terminal retry/backoff state survives the owner migration.
- Lab intent arbitration, API execution, result settlement, telemetry, and gate activation remain
  separate later work under #51.

## Mechanics sources consulted

- [StructureLab](https://docs.screeps.com/api/#StructureLab)
- [StructureLab.runReaction](https://docs.screeps.com/api/#StructureLab.runReaction)
- [StructureLab.boostCreep](https://docs.screeps.com/api/#StructureLab.boostCreep)
- [Constants and resources](https://docs.screeps.com/api/#Constants)
- [Store API](https://docs.screeps.com/api/#Store)
- [Screeps Wiki: StructureLab](https://wiki.screepspl.us/StructureLab/)
- [Screeps Wiki: Boosts](https://wiki.screepspl.us/Boosts/)
