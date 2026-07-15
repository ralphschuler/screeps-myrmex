# Roadmap

Phases are outcome gates, not feature checklists. Later work starts only when the previous gate is
demonstrably stable.

## Phase 0 — Executable Specification

**Status:** implemented; release evidence is tracked in
[issue #22](https://github.com/ralphschuler/screeps-myrmex/issues/22) and
[`phase0-evidence.md`](phase0-evidence.md).

- Repository, CI, bundle, documentation, and Wiki.
- Versioned memory and deterministic tick phases.
- Scenario DSL and the first cold-boot/recovery outcomes.
- CPU and outcome telemetry contracts.

**Exit:** deterministic replay, recovery, CPU accounting, mandatory-tail reservation, and ownership
enforcement pass the repository gate. Phase 1 may begin after the Phase 0 evidence PR is green and
merged.

## Phase 1 — Survival Kernel

- Validated survival policy, immutable planner configuration, source-controlled feature gates, and
  fail-closed self/ally/NAP exclusions form the Phase 1 foundation. The contract and deterministic
  proof matrix are tracked by [issue #36](https://github.com/ralphschuler/screeps-myrmex/issues/36)
  and [`phase1-config-evidence.md`](phase1-config-evidence.md).
- The authoritative owned-room survival lifecycle and local energy/spawn-time/CPU reservation ledger
  are tracked by [issue #37](https://github.com/ralphschuler/screeps-myrmex/issues/37) and
  [`phase1-colony-evidence.md`](phase1-colony-evidence.md). They derive one deterministic recovery
  objective and explicitly fund or block it without taking over spawn selection or command
  execution.
- Persistent capability contracts and bounded deterministic workforce allocation. Foundation
  evidence is tracked in [issue #23](https://github.com/ralphschuler/screeps-myrmex/issues/23) and
  [`phase1-contracts-evidence.md`](phase1-contracts-evidence.md); this slice alone does not satisfy
  the phase exit.
- Deterministic body construction, exclusive spawn-slot arbitration, narrow command execution, and
  atomic budget settlement are tracked by
  [issue #24](https://github.com/ralphschuler/screeps-myrmex/issues/24) and
  [`phase1-spawn-evidence.md`](phase1-spawn-evidence.md). This schedules the zero-worker recovery
  body without adding a second ledger or persistent spawn queue.
- Bootstrap harvesting, filling, upgrading, and construction demand.
- Proactive replacement deadlines plus worker execution for end-to-end zero-creep recovery.
- Minimal movement arbitration.

The config foundation initially left every Phase 1 gameplay gate source-unavailable. Issue #37 made
`phase1.colony` available under `runtime-config-source-v2`; issue #23 makes `phase1.contracts`
available under `runtime-config-source-v3`; issue #24 makes `phase1.spawn` available under
`runtime-config-source-v4`. Every later gate remains source-unavailable. Each subsequent outcome
change may mark only its own gate available after its prerequisites and outcome test exist.
Operational Memory may disable available work but can never activate an unfinished gate.

**Exit:** recover from empty Memory and zero creeps without console intervention.

## Phase 2 — Complete Colony

- Extend the existing colony authority from the survival lifecycle to complete RCL policy; do not
  create a second per-room kernel or state machine.
- Static mining, logistics contracts, links, storage, terminal, and layouts.
- Repair/rampart policy, labs, reactions, factory, and stock reserves.
- RCL progression and spawn/energy utilization telemetry.

**Exit:** repeatedly reach and sustain RCL8 within CPU and energy budgets.

## Phase 3 — Remote Portfolio

- Remote discovery, reservation, mining, hauling, suspension, evacuation, and resumption.
- Full-cost profitability and threat-adjusted routing.

**Exit:** only profitable remotes remain active during long private-server runs.

## Phase 4 — Expansion

- Claim scoring, bootstrap operations, donor budgets, and abandonment.

**Exit:** autonomously found and stabilize a second colony.

## Phase 5 — Hard-Target Defense

- Player reputation, threat modeling, towers, ramparts, safe mode, reinforcement, and boosts.

**Exit:** survive defined unboosted and boosted attacks without ally-safety violations.

## Phase 6 — MMO Canary

- Market policy, terminal balancing, deployment branches, canary gates, and rollback.

**Exit:** sustained MMO operation with bounded CPU/memory and no manual recovery.

## Phases 7–8 — Power Projection

- Combat model, remote denial, breach, siege, formations, nukes, power, highway resources,
  strongholds, portals, and cross-shard strategy.

**Exit:** operations meet objective, budget, loss-rate, and retaliation-risk targets.
