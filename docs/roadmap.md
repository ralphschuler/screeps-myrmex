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

**Status:** implementation leaves complete; runtime outcome gate not demonstrated. Phase 3 is
continuing under the bounded maintainer override recorded below.

Phase 2 extends the survival kernel into one deterministic RCL2–RCL8 colony authority covering
layouts, mining, logistics, links, maintenance, resources, labs, mature infrastructure, cross-domain
recovery, and bounded observer-only telemetry.

### Authoritative completed implementation leaves

- [#44](https://github.com/ralphschuler/screeps-myrmex/issues/44) — RCL2–RCL8 lifecycle, population,
  and reserves.
- [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) — versioned layouts and
  construction-site arbitration.
- [#46](https://github.com/ralphschuler/screeps-myrmex/issues/46) — static source mining and
  container infrastructure.
- [#47](https://github.com/ralphschuler/screeps-myrmex/issues/47) — storage-centered resource flow
  and specialized hauling.
- [#48](https://github.com/ralphschuler/screeps-myrmex/issues/48) — source, storage, and controller
  link arbitration.
- [#49](https://github.com/ralphschuler/screeps-myrmex/issues/49) — policy-bounded maintenance of
  roads, structures, walls, and ramparts.
- [#50](https://github.com/ralphschuler/screeps-myrmex/issues/50) — mineral extraction and
  storage/terminal stock policy.
- [#51](https://github.com/ralphschuler/screeps-myrmex/issues/51) — bounded reactions and
  deterministic boost workflows.
- [#52](https://github.com/ralphschuler/screeps-myrmex/issues/52) — factories and mature RCL8
  infrastructure.
- [#225](https://github.com/ralphschuler/screeps-myrmex/issues/225) — cross-domain recovery and
  sustained-RCL8 maturity reconciliation.
- [#53](https://github.com/ralphschuler/screeps-myrmex/issues/53) — progression, utilization,
  reserve, attrition, and industry telemetry with fixed gate thresholds.

Nested issues, pull requests, ADRs, and evidence updates remain delivery evidence in their owning
issue and evidence document. They are not additional roadmap leaves, and this section must not be
expanded into a merge-by-merge changelog.

### Completed layout-migration audit

Additional audited leaf [#99](https://github.com/ralphschuler/screeps-myrmex/issues/99) is complete
against its original five acceptance criteria:

1. Replacement-first removal, stock evacuation, cooldown/activity checks, ownership checks,
   protected-capacity checks, and the sole direct-destroy authority are recorded in
   [`phase2-layout-evidence.md`](phase2-layout-evidence.md).
2. Source/controller access and viable spawn-to-source traversal are covered by
   [#367](https://github.com/ralphschuler/screeps-myrmex/issues/367) and
   [#369](https://github.com/ralphschuler/screeps-myrmex/issues/369).
3. Warm, reset, and reordered variants produce equivalent ordered outcomes and semantic state in
   [`phase2-layout-migration-results.json`](phase2-layout-migration-results.json).
4. Bounded retry/reconciliation, threat interruption, and RCL-downgrade recovery are covered by
   [#310](https://github.com/ralphschuler/screeps-myrmex/issues/310),
   [#441](https://github.com/ralphschuler/screeps-myrmex/issues/441), and
   [#451](https://github.com/ralphschuler/screeps-myrmex/issues/451).
5. Nontrivial active extension and tower migrations converge to stable current geometry within
   recorded site, energy, CPU, and persistent-state bounds in
   [#453](https://github.com/ralphschuler/screeps-myrmex/issues/453) and
   [#457](https://github.com/ralphschuler/screeps-myrmex/issues/457).

Further structure variants, alternative migration strategies, or newly imagined completeness work
are enhancements, not unfinished #99 or Phase 2 requirements.

### Outcome gate status and continuation override

The dependency set remained frozen to #44–#53, #225, and #99. Issue #54 evaluated the predeclared
numeric contract without adding another implementation leaf. Its warm/reset/reordered progression
and steady-state collector is an analytical projection: all 58 measurements have zero blockers, but
the collector does not execute production `runTick`. The closure artifact and its then-current
bundle/configuration/policy receipts are immutable.

Current HEAD compatibility separately executes 30 production `runTick` calls across commandful RCL3
construction and RCL8 industry settlement, plus one invocation of the current compiled bundle's
`loop()`. This does not prove a complete healthy RCL8 runtime soak; details and remaining risks are
in [`phase2-gate-evidence.md`](phase2-gate-evidence.md).

**Exit:** not demonstrated by production runtime. The historical analytical thresholds and bounded
current runtime witnesses pass, but they do not satisfy #54's repeated healthy-RCL8 soak criterion.
On 2026-07-27 the maintainer explicitly directed the autonomous agent to continue
[Phase 3 issue #10](https://github.com/ralphschuler/screeps-myrmex/issues/10). That administrative
override is limited to Phase 3 and does not mark #54 passed; no transition beyond Phase 3 is
authorized without an explicit maintainer resolution of this gap.

## Phase 3 — Remote Portfolio

- The sole typed RawMemory-segment substrate is tracked by
  [issue #100](https://github.com/ralphschuler/screeps-myrmex/issues/100) and
  [`phase3-segments-evidence.md`](phase3-segments-evidence.md). It provides bounded asynchronous
  storage and recovery for later intelligence, routes, and accounting without selecting remotes or
  satisfying the phase exit itself.
- Segment-backed room intelligence and freshness-qualified vision demand are tracked by
  [issue #55](https://github.com/ralphschuler/screeps-myrmex/issues/55) and
  [`phase3-intel-evidence.md`](phase3-intel-evidence.md). Current vision, verified history,
  previous-tick events, observer requests, and budget-authorized data-only scout requests share one
  bounded interface; IntelService itself selects no remote.
- Deterministic threat-aware room routes, reconstructible cache invalidation, and body-dependent
  travel/cost estimates are tracked by
  [issue #56](https://github.com/ralphschuler/screeps-myrmex/issues/56) and
  [`phase3-routes-evidence.md`](phase3-routes-evidence.md). The immutable source policy creates no
  gameplay gate. The authority emits data only; cross-room movement execution remains unavailable.
- Positive-only full-cost remote scoring, deterministic admission, portfolio-capacity reservation,
  pressure shedding, bounded hysteresis, and terminal retirement are tracked by
  [issue #57](https://github.com/ralphschuler/screeps-myrmex/issues/57) and
  [`phase3-portfolio-evidence.md`](phase3-portfolio-evidence.md). The command-free authority emits
  funded abstract objectives only; it does not claim delivered energy or satisfy the phase exit.
- Just-in-time remote controller reservation, funded reserver contracts, bounded cross-room route
  consumption, and sole-executor signing/reservation are tracked by
  [issue #58](https://github.com/ralphschuler/screeps-myrmex/issues/58) and
  [`phase3-reservation-evidence.md`](phase3-reservation-evidence.md). Remote source mining, hauling,
  threat evacuation, operational suspension, and cautious resumption remain issues #59–#61.
- Realized per-remote full-cost profitability and outcome telemetry remain issue #62.

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
