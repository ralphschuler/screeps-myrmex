# ADR 0020: Construction maintenance policy authority

Status: accepted

## Context

Phase 1 critical maintenance protects only immediate recoverability. Mature rooms also need bounded
road, container, ordinary-structure, wall, and rampart targets. Raw hit points or `hitsMax` cannot
be used directly because fortifications have enormous ceilings, decaying structures have different
consequences, and tower energy must remain available for defense.

## Decision

`ConstructionPlanner` is the sole mature-colony maintenance-demand policy owner. It consumes current
detached structure facts, versioned layout placements, bounded traffic scores, reserve posture, RCL,
and current threat presence. It emits canonical data-only proposals with explicit target hits,
energy cost, consequence priority, and tower eligibility.

Structure scans, accepted proposals, energy per room and retained deferral detail are hard capped.
Roads, containers, and ordinary structures use ratio bands. Walls and ramparts use absolute RCL
bands and are ineligible while the recovery reserve is protected. Threat can raise an explicit
fortification target but disables routine tower eligibility. Rampart public posture and decay remain
inputs; diplomacy and threat escalation retain their existing owners.

PR A establishes observation and pure policy only. BudgetLedger and ContractLedger remain the sole
funding and creep-work authorities. Defense arbitration remains the sole tower-action authority and
must preserve attack/heal precedence plus emergency tower energy before PR B may compose proposals.

## Consequences

- Reordering, target loss, target satisfaction, and heap reset recompute identical demand from
  current evidence without a persistent maintenance queue.
- Fortification depth cannot silently grow toward `hitsMax`.
- Backlog overload retains highest-consequence work and exposes bounded deferral counts.
- Runtime funding, command reconciliation, and the `phase2.maintenance` gate remain deferred until
  composed outcome evidence exists.
