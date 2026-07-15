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
Configured self, allies, and non-aggression-pact players are authoritative exclusions and are never
targetable. This check occurs before optional reputation, so empty, stale, malformed,
future-assessed, or contradictory reputation cannot weaken it. Invalid observed identities also fail
closed to exclusion.

During Phase 1, a valid unconfigured identity has at most a `local-defense` targeting ceiling.
`local-defense` is not permission to attack: a defense authority must additionally prove a fresh
threat in an owned room. Irreversible offense remains forbidden until a later authorized operation.
Optional reputation may reduce a ceiling but cannot raise it. The engine's hostile collections mean
“not owned,” not “diplomatically authorized,” and area-effect actions must preserve configured
exclusions.

## Economy

Every owned room has one survival lifecycle and one local ledger. A bootstrapping or recovering
colony with a spawn but no legal `WORK`/`CARRY`/`MOVE` worker derives exactly one recovery
objective, which the ledger explicitly funds or blocks. Threat and recovery preempt optional growth;
losing vision preserves state but authorizes no new work, while current visible ownership loss ends
the colony and releases its local commitments.

Local spending follows a fixed survival order: emergency spawning, defense, replacement,
harvesting/filling, controller survival, critical maintenance, then optional growth. Current energy,
spawn time, and kernel-admitted CPU are conserved before priority is considered. Only emergency
spawning, defense, and replacement may consume protected spawn energy; every later category must
leave the remaining tranche intact.

Remote and claim decisions use full-cost accounting. Energy delivered is reduced by spawn
amortization, road upkeep, reservation cost, expected hostile loss, replacement latency, and a CPU
shadow price. Losing remotes are suspended automatically.

Claims are scarce portfolio slots. A room must improve energy potential, graph connectivity,
defensibility, mineral coverage, or strategic reach enough to repay bootstrap and defense cost.

## Defense

Defense is layered: vision, threat scoring, evacuation, ramparts, tower focus, local defenders,
regional reinforcement, boosts, and safe mode. MYRMEX preserves terminal and spawn energy reserves
before optional industry or upgrading.

Current unowned creeps are not automatically threats. Configured exclusions are applied first, then
fresh local offensive capability may move a colony into threatened posture. Clearing that evidence
enters recovery before optional growth resumes.

## Military Operations

Every operation declares an objective, owner, target, intelligence freshness requirement, body and
boost manifest, staging room, maximum energy/spawn/CPU budget, success criteria, retreat condition,
timeout, and diplomatic authorization.

Owned-room defense, remote evacuation, hostile-remote denial, and combat intelligence precede
sieges, boosted formations, nukes, strongholds, power operations, or cross-shard campaigns.
