# Roadmap

Phases are outcome gates, not feature checklists. Later work starts only when the previous gate is
demonstrably stable.

## Phase 0 — Executable Specification

- Repository, CI, bundle, documentation, and Wiki.
- Versioned memory and deterministic tick phases.
- Scenario DSL and the first cold-boot/recovery outcomes.
- CPU and outcome telemetry contracts.

**Exit:** deterministic replay and CPU accounting work before gameplay code.

## Phase 1 — Survival Kernel

- Bootstrap harvesting, spawn demand, filling, upgrading, and construction.
- Replacement deadlines and recovery from zero creeps.
- Minimal movement arbitration and deterministic body construction.

**Exit:** recover from empty Memory and zero creeps without console intervention.

## Phase 2 — Complete Colony

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
