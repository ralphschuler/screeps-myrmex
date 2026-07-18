# Phase 2 Colony Domain-Health Evidence

Issue [#225](https://github.com/ralphschuler/screeps-myrmex/issues/225) closes the dependency cycle
left by the initial Phase 2 colony policy. `ColonyDirector` now consumes current direct domain
status without becoming a layout, mining, logistics, link, maintenance, resource, lab, or industry
owner.

## Outcome contract

The input is fixed at eight canonical domains:

1. layout;
2. mining;
3. logistics;
4. links;
5. maintenance;
6. resources;
7. labs;
8. industry.

Each record is tick-local and contains only colony, domain, observation tick, and healthy/failed
status. Missing, stale, failed, duplicate, malformed, and over-cap evidence is blocked. The first
canonical blocker is stable across input order and heap reconstruction. No status is persisted, and
telemetry is not a decision input.

At RCL8, complete direct evidence changes the existing RCL policy from
`rcl8-health-evidence-unavailable` to `sustaining`. Workforce loss, protected-reserve collapse,
required-structure loss, unavailable logistics, and any mandatory domain failure move an established
mature colony into the existing single `recovering` lifecycle. A room that has not passed maturity
remains `developing` while it constructs missing infrastructure. Restored evidence exits once
without creating domain commitments; the existing workforce recovery objective remains the only
exception when the legal worker itself is lost. Infrastructure recovery keeps ordinary progression
blocked but allows the layout authority's deterministic rotating two-room window and only owned-site
build funding after workforce, safety, controller, and protected-reserve checks pass. Controller
upgrading and unrelated optional growth remain preempted.

## Runtime evidence

`deriveRuntimeColonyDomainHealth` uses current immutable observation and bounded direct outputs:

| Domain      | Required current evidence                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| layout      | current algorithm commitment; no layout/service blocker; active RCL8 spawn, extension, and tower target |
| mining      | one unblocked projection and one active harvest lease for every visible source                          |
| logistics   | direct planner health; no unavailable view, malformed, stale, wrong-colony, duplicate, or cap blocker   |
| links       | six current active links classified against reconstructed layout roles by the sole link authority       |
| maintenance | direct room-local status, independent of the capped deferral-detail list                                |
| resources   | mineral, active extractor, storage, and terminal                                                        |
| labs        | ten active labs and one derived cluster assignment                                                      |
| industry    | current mechanics plus active factory, power spawn, observer, and nuker capabilities                    |

Operational feature disablement is unhealthy; Memory cannot activate missing behavior. The adapter
reads no console output, metric, reporter state, or telemetry history.

## Deterministic matrix

[`phase2-colony-health-results.json`](phase2-colony-health-results.json) records:

- nominal RCL8 `mature` and `sustaining` output;
- JSON round-trip, heap reconstruction, world reordering, and domain-status reordering equivalence;
- independent failure of all eight domains;
- current reserve and workforce loss;
- stale logistics evidence;
- deterministic joint-failure precedence;
- one restored recovery exit with no domain objective, reservation, or persistent health copy;
- repair-path authorization limited to owned construction-site work and deterministic colony
  rotation; and
- fixed cardinality, zero persistent-health bytes, and zero telemetry decision inputs.

The executable check is `packages/scenario-kit/test/phase2-colony-health-gate.test.ts`. Focused
owner/runtime tests are `packages/bot/test/colony-domain-health.test.ts`,
`packages/bot/test/colony-domain-health-runtime.test.ts`,
`packages/bot/test/colony-director.test.ts`, and `packages/bot/test/colony-rcl-policy.test.ts`.

## Research receipt

- Official [Control](https://docs.screeps.com/control.html), updated May 29, 2026, defines RCL8
  unlocks and finite controller downgrade behavior. It does not define an operational maturity flag.
- Official [`StructureController`](https://docs.screeps.com/api/#StructureController) defines
  current ownership, level, and `ticksToDowngrade` evidence.
- Official [`Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable) and
  `energyCapacityAvailable` distinguish current reserve from installed spawn-pool capacity.
- Screeps Wiki [Room Control Level](https://wiki.screepspl.us/Room_Control_Level/) and
  [Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/) supply community terminology and
  operational framing only.
- Screeps Wiki [Vision](https://wiki.screepspl.us/Vision/) confirms that unavailable room objects
  are unknown to code; stale evidence therefore cannot prove health.

Official mechanics constrain current facts. The health policy, canonical order, limits, and recovery
decision are independent MYRMEX strategy.
