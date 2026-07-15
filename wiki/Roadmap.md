# Roadmap

1. Executable specification and telemetry
2. Cold-boot survival kernel
3. Complete RCL8 colony
4. Profitable remote portfolio
5. Autonomous expansion
6. Hard-target defense and diplomacy
7. MMO canary and market policy
8. Military power projection
9. Endgame and cross-shard operations

Every phase ends in a private-server or MMO outcome gate. Feature count is not progress.

Phase 1 begins with one validated survival-policy authority, immutable planner config, a
source-controlled feature-gate DAG, and fail-closed self/ally/NAP exclusions. Its first gameplay
outcome adds one authoritative owned-room survival lifecycle and one local energy, spawn-time, and
CPU reservation ledger. A bootstrapping or recovering colony with a spawn but no legal worker
derives exactly one recovery objective and explicitly funds or blocks it; threat and recovery
preempt optional growth.

The next foundation outcome adds persistent capability contracts and bounded deterministic workforce
allocation. Contract funding and assignment consume the current colony BudgetLedger authorization;
they do not create another reserve authority or per-creep role registry.

`phase1.colony` and its dependent `phase1.contracts` gate are source-available under runtime-config
source v3. Every later Phase 1 gate remains unavailable. Each later change enables only the gate for
an outcome it proves, after all prerequisite outcomes exist. Operational Memory may disable
available work but can never activate an unfinished gate.
