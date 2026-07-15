# Strategy

MYRMEX is a hard target, not a random bully.

It stabilizes colonies, compounds energy, operates profitable remotes, builds defense depth, expands
into defensible strategic rooms, and retaliates predictably against aggression.

Each owned room has one survival lifecycle and one local budget ledger. Emergency spawning, defense,
replacement, harvesting/filling, controller survival, and critical maintenance precede optional
growth. Current energy, spawn time, and kernel-admitted CPU are conserved before priority. Only
emergency spawning, defense, and replacement may consume protected spawn energy; every later
category must leave the remaining tranche intact.

One spawn broker orders emergency recovery before replacement, upgrading, and construction, then
uses stable deadline, body-cost, and identity tie-breakers. All local spawns share one current room
energy balance. With the default 300-energy grant, the canonical `WORK,CARRY,MOVE` recovery body
costs 200 and the unused 100 is released after the command schedules. Durable bounded expectations
rederive the exact stable recovery name and prevent a heap reset from immediately ordering it again
while its spawn result is not yet visible. A matching live creep must retain the required active
capabilities; a damaged same-name creep remains a bounded collision. Generated recovery names are
never suffixed; bounded suffix attempts apply only to explicit caller-selected bases.

A bootstrapping or recovering colony with a spawn but no legal `WORK`/`CARRY`/`MOVE` worker derives
exactly one recovery objective, which the ledger explicitly funds or blocks. Threat and recovery
preempt growth. Unknown vision preserves durable state without authorizing new work, while current
visible ownership loss releases local commitments.

Capability contracts bind to a stable BudgetLedger issuer key and must see the matching current
active reservation before funding or assignment. One grant binding backs at most one active
contract. Grant renewal preserves contract identity; released, consumed, expired, or missing
authorization suspends known work and removes its lease. Unknown vision authorizes no new assignment
without inventing revocation evidence.

Diplomacy follows observable states and an escalation ladder. Offensive operations require fresh
intelligence, a positive strategic margin, a complete resource budget, retreat conditions, and
diplomatic authorization.

Configured self, ally, and non-aggression-pact identities are authoritative exclusions. MYRMEX
checks them before optional reputation, so empty, stale, malformed, future-assessed, or
contradictory data cannot make them targetable. Invalid observed identities also fail closed to
exclusion.

In Phase 1, every valid unconfigured identity has at most a `local-defense` ceiling. This is not
permission to attack: fresh owned-room threat evidence and the defense authority are still required.
Optional reputation may lower a ceiling but cannot raise it, and irreversible offense remains
forbidden until an operation is explicitly authorized. Screeps “hostile” collections mean not owned,
not diplomatically approved.

Unowned presence alone also does not move a colony into threatened posture. Configured exclusions
are applied first; only fresh local offensive capability meeting policy is threat evidence. Clearing
that evidence enters recovery before optional growth resumes.
