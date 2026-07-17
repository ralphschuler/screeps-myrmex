# ADR 0019: LinkArbiter authority and versioned role boundary

Status: accepted

## Context

Links bypass creep hauling but share observed energy, destination capacity, sender cooldown,
transfer loss, controller activation, and layout-dependent roles. Direct calls from mining,
upgrading, or logistics would duplicate reservations and hide transfer loss.

## Decision

`LinkArbiter` is the sole authority that may admit link transfers. PR A observes owned links into
detached immutable data, derives ephemeral source, controller, hub, and reserve roles from one
layout algorithm revision and fingerprint, and performs pure command-free arbitration. No live link
or reconstructible role map enters Memory.

Funded typed proposals carry source, destination, amount, deadline, priority, flow identity, budget
binding, and layout dependency. Arbitration is mandatory-first and canonical. It reserves source
energy and loss-adjusted destination capacity, admits at most one outbound transfer per source, and
uses hard link and proposal caps. Results record predicted sent, delivered, and lost energy; every
non-admission has a stable typed reason.

PR B adds mining, controller, and logistics proposal production, the sole
`StructureLink.transferEnergy` executor, and result reconciliation. No planner may bypass the
arbiter, and telemetry remains observer-only.

## Consequences

- Equivalent observations and proposals produce identical roles and decisions after reset or
  insertion reordering.
- Source energy and destination capacity cannot be allocated twice.
- Layout revision changes invalidate roles instead of retaining stale operational identity.
- Missing observation, cooldown, inactivity, wrong-room targets, and unavailable budgets fail closed
  without aborting logistics.
- Link repair remains #49; remote links and combat tricks remain out of scope.

## Mechanics sources consulted

- [StructureLink](https://docs.screeps.com/api/#StructureLink)
- [StructureLink.transferEnergy](https://docs.screeps.com/api/#StructureLink.transferEnergy)
- [Controller progression](https://docs.screeps.com/control.html)
- [Screeps Wiki: StructureLink](https://wiki.screepspl.us/StructureLink/)

Official mechanics establish 800 energy capacity, 3% transfer loss, sender cooldown of one tick per
linear-distance tile, same-room transfer, and typed return codes for ownership, source energy,
target validity or capacity, range, amount, cooldown, and RCL. Wiki role names are terminology only;
MYRMEX roles derive from versioned layout geometry.
