# ADR 0064: Active-reaction idle-terminal lab mixed-stock evacuation

## Status

Accepted

## Context

ADR 0057 lets one mixed-stock role-unused external lab evacuate energy to a retained committed lab
and mineral to active storage while a durable role-identical reaction continues. ADR 0061 permits a
mineral-only target under that same handoff to use one exact idle terminal when no active storage
exists. ADR 0063 composes the terminal destination with mixed stock only while Industry is
quiescent.

A terminal-only RCL8 colony still cannot preserve both resources and converge committed lab geometry
while its retained nine labs continue an otherwise unchanged reaction. Industry, Construction, and
Logistics reject this composition even though the existing handoff, layouts-V14 record, two funded
flows, terminal reservation, and removal guards already define the complete authority boundary.

## Decision

- Active storage retains precedence. With no active storage, Industry may publish one exact active
  terminal for mixed stock only after the reaction handoff is durably `ready`, current and retained
  assignments have byte-identical role IDs, the external target has exact positive energy plus one
  valid mineral kind, and no eligible internal send involves the room. The first rebound remains
  command-free and publishes no terminal.
- `ConstructionPlanner` may persist or continue ADR 0063's existing layouts-V14 mixed terminal
  record only for that exact reaction handoff. It independently verifies source layout, target
  stock, retained-lab energy capacity, terminal identity and aggregate capacity, current logistics
  evidence, and colony safety.
- `LogisticsPlanner` atomically admits the two existing funded V3 flows during the exact reaction
  handoff: energy to the canonical retained lab and mineral to the terminal. A graph, identity,
  budget, capacity, destination, or fixed 64-flow failure publishes neither flow.
- A persisted terminal commitment continues to suppress every internally planned send from or to the
  room. Storage appearance, send contention, terminal identity/activity/capacity drift, or lost
  handoff evidence removes same-tick flow authorization and preserves the lab.
- Partial delivery remains resumable across JSON/global-heap reconstruction and reordered
  observation. A matching pending retained-assignment reaction effect may retain evacuation flows
  and endpoint suppression but blocks removal.
- Removal requires fresh target emptiness, baseline-plus-amount replacement-lab energy and terminal
  mineral, retired exact flows and all source/replacement/terminal endpoints, no pending reaction
  attempt, unchanged destination/layout/roles/safety, and no timeout. The existing sole removal
  arbiter, destroy executor, and reset-safe receipt remain unchanged.
- Mixed-terminal explicit-boost work remains unavailable. No owner, persistent field, schema
  version, queue, dependency, command authority, or telemetry cardinality is added.

## Consequences

One terminal-only colony can preserve a role-unused lab's mixed stock and converge committed RCL8
lab geometry without cancelling or restarting productive reaction work. Objective identity, batch
amount, and settled progress survive rebound, reset, reorder, partial delivery, and pending exact-
effect observation.

Work remains bounded by eight Industry rooms, ten labs per room, the two-room migration window, one
lab evacuation per room, 64 total lab flows, 128 logistics nodes/endpoints and removal candidates,
and one global destroy command. Malformed stock, active storage, internal-send contention,
destination or role drift, incomplete delivery, unrelated or boost work, threat, timeout, or
capacity loss fails closed without a partial flow pair or destroy command.

Rolling back only this decision to the ADR 0063 implementation preserves and recognizes the same
layouts-V14 record, continues terminal-send suppression, and rejects active projection and removal
until supporting code returns. A rollback to code older than ADR 0063 still requires disabling
`phase2.industry` first because that code cannot derive the mixed-terminal reservation. Redeploying
supporting code resumes from the same bounded record. Mixed-terminal boost handoff, autonomous
boost-manifest production, general multi-step migration, defensive migration, and creep dismantling
remain parent issue [#99](https://github.com/ralphschuler/screeps-myrmex/issues/99).

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): a lab has separate 2,000
  energy and 3,000 mineral capacities; reaction roles use two range-two reagent labs and output
  labs.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store): a terminal has one shared 300,000-unit Store.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): each scheduled action names one
  exact resource and is constrained by current stock, capacity, and range.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy),
  [game loop](https://docs.screeps.com/game-loop.html), and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): command acceptance is
  not same-tick proof of delivery or structure disappearance.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply cluster, terminal, and deferred-intent
  terminology only. Official API contracts govern behavior.
