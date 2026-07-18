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
  the phase exit. Executable leased-work terms and the immutable agent projection are tracked by
  [issue #114](https://github.com/ralphschuler/screeps-myrmex/issues/114).
- Deterministic body construction, exclusive spawn-slot arbitration, narrow command execution, and
  atomic budget settlement are tracked by
  [issue #24](https://github.com/ralphschuler/screeps-myrmex/issues/24) and
  [`phase1-spawn-evidence.md`](phase1-spawn-evidence.md). This schedules the zero-worker recovery
  body without adding a second ledger or persistent spawn queue.
- Bootstrap harvesting, filling, upgrading, and construction demand.
- Proactive replacement deadlines plus worker execution for end-to-end zero-creep recovery.
- Deterministic movement/primary-action authority is tracked by
  [issue #25](https://github.com/ralphschuler/screeps-myrmex/issues/25); bounded runtime channels,
  cache-backed local path admission, and executor composition are tracked by
  [issue #112](https://github.com/ralphschuler/screeps-myrmex/issues/112). Runtime-owned local path
  service composition is tracked by
  [issue #115](https://github.com/ralphschuler/screeps-myrmex/issues/115).
- Generic lease-to-intent translation and typed action-result reconciliation are tracked by
  [issue #38](https://github.com/ralphschuler/screeps-myrmex/issues/38).
- Repair completion thresholds and bounded command-failure retry are tracked by
  [issue #122](https://github.com/ralphschuler/screeps-myrmex/issues/122) and
  [`phase1-repair-foundation-evidence.md`](phase1-repair-foundation-evidence.md); this is the
  execution foundation for the recovery-critical maintenance policy in issue #40.
- Workforce-loss recovery and its source-gate evidence are tracked by
  [issue #124](https://github.com/ralphschuler/screeps-myrmex/issues/124) and
  [`phase1-recovery-evidence.md`](phase1-recovery-evidence.md).
- Recovery-critical maintenance is tracked by
  [issue #40](https://github.com/ralphschuler/screeps-myrmex/issues/40) and
  [`phase1-maintenance-evidence.md`](phase1-maintenance-evidence.md).
- Survival-budgeted controller progress and existing critical construction are tracked by
  [issue #28](https://github.com/ralphschuler/screeps-myrmex/issues/28) and
  [`phase1-growth-evidence.md`](phase1-growth-evidence.md).
- Bounded survival accounting and explainable structured status are tracked by
  [issue #39](https://github.com/ralphschuler/screeps-myrmex/issues/39) and
  [`phase1-telemetry-evidence.md`](phase1-telemetry-evidence.md).
- Security redaction of player-controlled and fault data before it reaches observability is tracked
  by [issue #98](https://github.com/ralphschuler/screeps-myrmex/issues/98) and
  [`phase1-security-evidence.md`](phase1-security-evidence.md).

The config foundation initially left every Phase 1 gameplay gate source-unavailable. Issue #37 made
`phase1.colony` available under `runtime-config-source-v2`; issue #23 makes `phase1.contracts`
available under `runtime-config-source-v3`; issue #24 makes `phase1.spawn` available under
`runtime-config-source-v4`; issue #25 makes `phase1.movement` available under
`runtime-config-source-v5`; issue #38 makes `phase1.agents` available under
`runtime-config-source-v6`; issue #26 makes `phase1.economy` available under
`runtime-config-source-v7`; issue #29 makes `phase1.safety` available under
`runtime-config-source-v8`; issue #124 makes `phase1.recovery` available under
`runtime-config-source-v9`; issue #40 makes `phase1.critical-maintenance` available under
`runtime-config-source-v10`; issue #28 makes `phase1.growth` available under
`runtime-config-source-v11`; issue #39 makes `phase1.telemetry` available under
`runtime-config-source-v12`; issue #130 advances observer-only console policy to
`runtime-config-source-v15`; issue #188 adds the reporter input work ceiling under
`runtime-config-source-v16`. Every later gate remains source-unavailable. Each subsequent outcome
change may mark only its own gate available after its prerequisites and outcome test exist.
Operational Memory may disable available work but can never activate an unfinished gate.

**Exit:** recover from empty Memory and zero creeps without console intervention.

## Phase 2 — Complete Colony

The first bounded Phase 2 slice is tracked by
[issue #44](https://github.com/ralphschuler/screeps-myrmex/issues/44) and
[`phase2-colony-policy-evidence.md`](phase2-colony-policy-evidence.md). It adds the tick-local
RCL2-RCL8 projection and `runtime-config-source-v17`; final domain-health reconciliation and
sustained-RCL8 maturity belong to [#225](https://github.com/ralphschuler/screeps-myrmex/issues/225).

- Extend the existing colony authority from the survival lifecycle to complete RCL policy; do not
  create a second per-room kernel or state machine.
- Static mining, logistics contracts, links, storage, terminal, and layouts.
- Issue #284 adds one deterministic, road-only layout convergence step: under fresh safe colony,
  layout, RCL, allowance, and site-headroom evidence, the sole removal arbiter/executor may destroy
  one road that solely blocks a planned tower. Issue #286 adds one extension-only replacement-first
  step: spare allowance builds canonical committed capacity before the same authority may remove one
  empty, unshared, obsolete extension under exact current replacement evidence. Issue #288 persists
  at most one compact extension evacuation per room, routes its exact energy to that replacement
  through funded logistics, suppresses target refill, and keeps removal blocked until fresh
  delivered/empty evidence. Issue #290 removes at most one empty, unshared source-adjacent container
  only while a different exact committed container remains the selected reachable service for that
  same source; mining identity and work position stay unchanged. Other structure types,
  selected/stocked containers, general multi-step migration, and creep dismantling remain issue #99.
- Issue #46 defines static extraction contracts, stationary workforce projection, and composed
  reset/reorder recovery evidence in [`phase2-mining-evidence.md`](phase2-mining-evidence.md).
  `phase2.mining` activates only behind layout and telemetry prerequisites. Hauling remains #47,
  link commands remain #48, and container repair remains #49.
- Issue #47 establishes the sole bounded LogisticsPlanner authority, fresh owned-room normalization,
  exact resource reservations, deterministic admission, funded V3 acquire/deliver contracts,
  convergent dedicated-hauler demand, runtime reconciliation, and observer-only telemetry. Its
  reset/reorder/failure evidence is recorded in
  [`phase2-logistics-evidence.md`](phase2-logistics-evidence.md). Terminal sends, link commands
  (#48), and container repair (#49) remain separate authorities.
- Issue #48 establishes the sole bounded LinkArbiter authority. Its pure foundation observes owned
  links, derives ephemeral roles from versioned layout geometry, and admits funded proposals with
  deterministic source, capacity, and loss reservations. Runtime proposal production, command
  execution, settlement, and composed recovery evidence remain the next #48 slice.
- Issue #266 establishes the sole bounded ObserverArbiter and ObserverExecutor. Versioned authorized
  requests deterministically claim at most one slot per observer, and `OK` settles only from exact
  next-tick visibility with bounded no-effect retry.
- Issue #267 composes mature factory, power-spawn, capped nuker-stock, and observer authorities into
  the static tick graph behind `phase2.mature` and `runtime-config-source-v27`. Exact next-tick
  effects and observer receipts persist atomically in `IndustryOwnerV5`; checked evidence is in
  [`phase2-mature-evidence.md`](phase2-mature-evidence.md). Observer target strategy and nuke launch
  remain unavailable.
- Issue #225 reconciles the fixed direct layout, mining, logistics, links, maintenance, resources,
  labs, and industry status into the sole colony lifecycle. RCL8 becomes `sustaining` only with
  complete current evidence; loss enters one bounded recovery without persisting health or reading
  telemetry. Checked evidence is in
  [`phase2-colony-health-evidence.md`](phase2-colony-health-evidence.md).
- Issue #275 adds fixed progression, reserve, utilization, authority-outcome, and modeled-flow gate
  inputs plus a bounded rolling observer window in the sole telemetry owner. Telemetry remains
  unavailable to gameplay decisions; checked evidence is in
  [`phase2-telemetry-evidence.md`](phase2-telemetry-evidence.md). Issue #277 adds reset-safe
  adjacent RCL transition durations with bounded opaque baselines and fixed RCL2–RCL8 aggregates;
  checked evidence is in [`phase2-rcl-transition-evidence.md`](phase2-rcl-transition-evidence.md).
  Issue #279 adds bounded adjacent-snapshot road/container net attrition with opaque baselines,
  fixed rows, and fail-closed gap/cardinality/byte behavior; checked evidence is in
  [`phase2-attrition-evidence.md`](phase2-attrition-evidence.md). Exact next-observation lab,
  factory, and power input/output accounting is fixed and label-free. Nested telemetry schema V5
  adds fixed extractor, link, terminal, lab, and factory current/rolling cooldown-utilization rows
  with explicit continuity and bounded cap behavior; checked evidence is in
  [`phase2-telemetry-evidence.md`](phase2-telemetry-evidence.md). Issue #53 predeclares the numeric
  progression, steady-state, bounded-state, economy, and recovery thresholds in
  [`phase2-gate-thresholds.md`](phase2-gate-thresholds.md); issue #54 owns their measured soaks and
  final Phase 2 pass/fail evidence.
- Repair/rampart policy, labs, reactions, factory, and stock reserves.
- RCL progression and spawn/energy utilization telemetry.

**Exit:** repeatedly reach and sustain RCL8 within CPU and energy budgets.

## Phase 3 — Remote Portfolio

- Remote discovery, reservation, mining, hauling, suspension, evacuation, and resumption.
- Full-cost profitability and threat-adjusted routing.

**Exit:** only profitable remotes remain active during bounded deterministic portfolio soaks.

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

The final #44-owned slice adds bounded funded-objective population scaling under
`runtime-config-source-v18`. Domain behavior remains in #45-#52 and cross-domain recovery and
maturity remain in #225.
