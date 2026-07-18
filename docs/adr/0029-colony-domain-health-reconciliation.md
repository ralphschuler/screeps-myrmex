# ADR 0029: Direct colony domain-health reconciliation

## Status

Accepted

## Context

Controller level 8 proves only engine progression and structure unlocks. It does not prove that a
colony has current mining, logistics, reserves, infrastructure, or industry capability. The Phase 2
domain owners now exist, but reading telemetry or copying their outputs into Memory would create a
second decision source and persistent derived state. Leaving `ColonyDirector` on controller-level
evidence alone would let an inoperable RCL8 room remain `mature`.

## Decision

- `ColonyDirector` remains the sole owned-room lifecycle authority. It accepts one tick-local,
  version-1 domain-health input with the fixed order `layout`, `mining`, `logistics`, `links`,
  `maintenance`, `resources`, `labs`, and `industry`.
- Each direct status names one colony, domain, observation tick, and `healthy` or `failed`. The
  director canonicalizes at most sixteen raw records per colony. Missing, stale, failed, duplicate,
  malformed, and over-cap evidence fails closed with one stable first blocker.
- Runtime composition derives these records directly from current immutable observation and bounded
  owner outputs. It does not read `TelemetryService`.
- RCL8 health requires a current layout commitment and installed spawn/extension/tower target,
  active source commitments, direct logistics health, links classified against reconstructed current
  layout roles by the sole link authority, room-local bounded maintenance, mineral and
  storage/terminal capability, an active lab cluster, and current mature-structure capabilities.
  Source-disabled domains are unhealthy rather than implicitly complete.
- An established mature RCL8 colony enters or remains `recovering` when its survival reserve or
  mandatory domain health is unavailable. A room that has not yet passed maturity remains
  `developing` while it constructs missing infrastructure. Complete current evidence makes the RCL
  policy `sustaining` and permits one normal recovery exit to `mature`.
- Domain health remains tick-local. The existing colony record may persist its lifecycle transition,
  but no health record, world object, telemetry aggregate, or reconstructible index is added to
  Memory. `COLONY_OWNER_SCHEMA_VERSION` remains 1.
- The director emits no domain command or duplicate commitment. While ordinary progression remains
  blocked, current reserve/workforce/safety evidence may authorize only existing owned-site
  `growth/.../build/...` funding. The layout authority rotates its two-room planning window and may
  recreate missing committed sites; controller upgrading and unrelated optional growth stay
  preempted. Existing layout, contract, spawn, logistics, maintenance, and industry owners retain
  command authorization and execution.

## Consequences

A room can no longer claim RCL8 maturity from controller level, one spawn, and one generic worker
alone. Reset and input reordering preserve the same blocker and transition. CPU shedding or missing
source mechanics may temporarily make a mandatory status unavailable; survival remains active while
optional work fails closed and normal evidence can restore maturity.

The runtime evaluates a fixed eight-domain set for at most 64 colonies. Link health uses the sole
link classifier over reconstructed current layout roles, logistics publishes direct cap/error
health, and maintenance publishes room-local health independently of its bounded detail list. Layout
planning remains capped at two rooms per tick and rotates deterministically so every colony is
eligible. The change adds no persistent health bytes and no new Screeps API call. Checked evidence
is in [`phase2-colony-health-results.json`](../phase2-colony-health-results.json), with the proof
matrix in [`phase2-colony-health-evidence.md`](../phase2-colony-health-evidence.md).

## Mechanics sources

- [Official Control guide](https://docs.screeps.com/control.html)
- [Official `StructureController`](https://docs.screeps.com/api/#StructureController)
- [Official `Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable)
- [Screeps Wiki: Room Control Level](https://wiki.screepspl.us/Room_Control_Level/)
- [Screeps Wiki: Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/)
- [Screeps Wiki: Vision](https://wiki.screepspl.us/Vision/)
