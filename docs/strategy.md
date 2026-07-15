# Strategy

MYRMEX is a hard target with disciplined expansion. It does not attack everyone; it makes hostile
behavior predictably unprofitable and uses force when the strategic return exceeds the complete
cost.

## Strategic Objective

Maximize durable control and productive capacity under CPU, GCL, spawn, energy, mineral, and
diplomatic constraints.

The bot should compound this loop:

1. stabilize each colony;
2. maximize source utilization and logistics efficiency;
3. operate only profitable remotes;
4. build defense depth and regional intelligence;
5. claim defensible rooms that improve the empire graph;
6. deny adversaries profitable pressure points;
7. project force with budgeted operations and explicit exit conditions.

## Diplomacy

Players occupy one of seven states: self, ally, non-aggression pact, neutral, trespasser, hostile,
or war. Reputation is based on observed events with decay and confidence.

Escalation is predictable: observe, warn, block, evict, deny remotes, retaliate, then wage war.
Configured allies are excluded from targeting by a fail-closed safety invariant.

## Economy

Remote and claim decisions use full-cost accounting. Energy delivered is reduced by spawn
amortization, road upkeep, reservation cost, expected hostile loss, replacement latency, and a CPU
shadow price. Losing remotes are suspended automatically.

Claims are scarce portfolio slots. A room must improve energy potential, graph connectivity,
defensibility, mineral coverage, or strategic reach enough to repay bootstrap and defense cost.

## Defense

Defense is layered: vision, threat scoring, evacuation, ramparts, tower focus, local defenders,
regional reinforcement, boosts, and safe mode. MYRMEX preserves terminal and spawn energy reserves
before optional industry or upgrading.

## Military Operations

Every operation declares an objective, owner, target, intelligence freshness requirement, body and
boost manifest, staging room, maximum energy/spawn/CPU budget, success criteria, retreat condition,
timeout, and diplomatic authorization.

Owned-room defense, remote evacuation, hostile-remote denial, and combat intelligence precede
sieges, boosted formations, nukes, strongholds, power operations, or cross-shard campaigns.
