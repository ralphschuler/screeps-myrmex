# ADR 0065: Boost-handoff idle-terminal lab mixed-stock evacuation

## Status

Accepted

## Context

ADR 0059 permits one explicit funded boost commitment to move onto a role-identical assignment over
nine retained committed labs before a role-unused external lab is removed. ADR 0062 permits a
mineral-only target under that handoff to evacuate into one exact idle terminal when no active
storage exists. ADR 0063 composes the same terminal destination with mixed stock while Industry is
quiescent, and ADR 0064 reuses that mixed record during a durable reaction handoff.

A terminal-only RCL8 colony still cannot preserve an external lab containing both energy and mineral
while the equivalent explicit boost continues. Industry, Construction, and Logistics reject this
composition even though the existing boost handoff, layouts-V14 record, two funded flows, terminal
reservation, exact boost settlement, and removal guards already define the complete authority
boundary.

## Decision

- Active storage retains precedence. With no active storage, Industry may publish one exact active
  terminal after the boost handoff is durably `ready`, current and retained assignments have byte-
  identical role IDs, the external target remains rebindable, and no eligible internal send involves
  the room. The first rebound remains command-free and publishes no terminal. This availability
  remains published after a persisted mixed record's mineral leg completes so its energy leg cannot
  stall; by itself it authorizes no flow or terminal reservation.
- `ConstructionPlanner` may first persist ADR 0063's existing layouts-V14 mixed terminal record only
  when the exact target has positive energy plus one valid mineral kind. It may then continue that
  record for the same exact boost handoff after either leg completes. It independently verifies
  source layout, target stock, retained-lab energy capacity, terminal identity and aggregate
  capacity, current logistics evidence, and colony safety.
- `LogisticsPlanner` atomically admits the two existing funded V3 flows: energy to the canonical
  retained lab and mineral to the terminal. A graph, identity, budget, capacity, destination, or
  fixed 64-flow failure publishes neither flow.
- The persisted terminal commitment continues to suppress every internally planned send from or to
  the room. Storage appearance, send contention, terminal identity/activity/capacity drift, or lost
  handoff evidence removes same-tick flow authorization and preserves the lab.
- Partial delivery remains resumable across JSON/global-heap reconstruction and reordered
  observation. Mineral-first completion retains the terminal identity and remaining energy flow. A
  current retained-assignment boost intent or matching pending effect retains the evacuation
  projection but blocks removal.
- Any nonquiescent explicit boost handoff remains removal-blocked until exact next-observation body,
  30-mineral-per-part, and 20-energy-per-part evidence settles the boost. This also fails closed if
  a transient invalid input suppresses the current intent while the funded commitment remains
  active.
- A later quiescent observation may remove the lab only after fresh target emptiness, both
  baseline-plus-amount destination gains, retired exact flows and all source/replacement/terminal
  endpoints, unchanged destination/layout/roles/safety, and no timeout. The existing sole removal
  arbiter, destroy executor, and reset-safe receipt remain unchanged.
- No owner, persistent field, schema version, queue, dependency, command authority, autonomous boost
  producer, or telemetry cardinality is added.

## Consequences

One terminal-only colony can preserve a role-unused lab's mixed stock and converge committed RCL8
lab geometry without cancelling or restarting explicit funded boost work. Boost objective,
creep/body identity, compound, target parts, deadline, and settled progress survive rebound, reset,
reorder, partial delivery, and pending exact-effect observation.

Work remains bounded by eight Industry rooms, ten labs per room, the two-room migration window, one
lab evacuation per room, 64 total lab flows, 128 logistics nodes/endpoints and removal candidates,
and one global destroy command. Malformed stock, active storage, internal-send contention,
destination or role drift, incomplete delivery, unresolved boost work, threat, timeout, or capacity
loss fails closed without a partial flow pair or destroy command.

Rolling back only this decision to ADR 0064 code preserves and recognizes the same layouts-V14
record, continues terminal-send suppression, and rejects boost projection and removal until
supporting code returns. A rollback to code older than ADR 0063 still requires disabling
`phase2.industry` first because that code cannot derive the mixed-terminal reservation. Redeploying
supporting code resumes from the same bounded record. Autonomous boost-manifest production, general
multi-step migration, defensive migration, access-proof expansion, and creep dismantling remain
parent issue [#99](https://github.com/ralphschuler/screeps-myrmex/issues/99).

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab),
  [`StructureLab.boostCreep`](https://docs.screeps.com/api/#StructureLab.boostCreep), and
  [creep boosts](https://docs.screeps.com/resources.html#Creep-boosts): labs separate 2,000 energy
  and 3,000 mineral capacity; each boosted part costs 30 compound and 20 energy; `OK` schedules the
  action.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store): a terminal has one shared 300,000-unit Store.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw),
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer), and
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): evacuation and removal use
  scheduled intents with current stock, capacity, ownership, and range preconditions.
- Official [game loop](https://docs.screeps.com/game-loop.html) and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): command acceptance is
  not same-tick proof of boost effect, delivery, or structure disappearance.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page),
  [`StructureLab`](https://wiki.screepspl.us/StructureLab/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply established operational terminology only.
  Official API contracts govern behavior.
