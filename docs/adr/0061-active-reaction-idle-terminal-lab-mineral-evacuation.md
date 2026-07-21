# ADR 0061: Active-reaction idle-terminal lab mineral evacuation

## Status

Accepted

## Context

ADR 0056 permits one mineral-only obsolete lab to evacuate to active storage during a durable,
role-identical reaction-assignment handoff. ADR 0060 permits the same mineral-only V14 record to use
an idle terminal when Industry is quiescent and no active storage exists. A terminal-only colony
still cannot converge committed lab geometry while the retained nine labs continue an otherwise
unchanged reaction.

The two existing paths already define the complete safety boundary: Industry owns destination and
send eligibility, Layout owns the bounded V14 commitment, Logistics owns funded resource movement,
and the removal arbiter/executor own the irreversible command. The active continuation needs no new
state or authority.

## Decision

- Industry keeps active-storage precedence. With no active storage, it may publish one exact active
  terminal during a reaction handoff only when the handoff is durably `ready`, current and retained
  assignments have byte-identical role IDs, the external target has zero energy and at most one
  valid mineral kind, and no eligible internal send involves the room. Pending rebound, boost,
  mixed-stock, unknown send, duplicate terminal, and malformed target evidence remain excluded.
- The first rebound remains non-executable and publishes no terminal. Once the rebound is durable,
  `ConstructionPlanner` may persist ADR 0060's existing V14 mineral-only terminal record. It
  independently verifies no active storage, exact terminal identity and 300,000-unit aggregate
  capacity, target stock, source layout, retained roles, current logistics evidence, and colony
  safety.
- `LogisticsPlanner` admits the existing funded V3 mineral flow during active reaction work only for
  that exact reaction handoff and terminal-bound V14 record. The terminal shares its aggregate Store
  capacity key. A post-handoff pending reaction effect may retain the flow and endpoint suppression
  but still blocks removal.
- A persisted terminal commitment continues to suppress every internally planned send from or to the
  room. Storage appearance, terminal identity/activity/capacity drift, send contention, or lost
  handoff evidence removes flow authorization and preserves the lab.
- Removal requires fresh target emptiness, baseline-plus-amount terminal mineral, retired exact flow
  and endpoints, no pending lab attempt, unchanged destination/layout/roles/safety, and no timeout.
  The existing one-command `StructureRemovalArbiter` and `StructureDestroyExecutor` remain the sole
  irreversible path.
- No owner, persistent field, schema version, queue, dependency, command authority, or telemetry
  cardinality is added.

## Consequences

One terminal-only RCL8 colony can preserve a role-unused lab's mineral and converge committed lab
geometry without cancelling or restarting productive reaction work. JSON/global reset, reordered
observation, and partial delivery preserve the same V14 terms. Current fresh evidence must reprove
every destination and handoff condition; command acceptance never proves delivery or removal.

The path remains bounded by eight Industry rooms, ten labs per room, 64 layout records and total lab
evacuation flows, 128 logistics nodes/endpoints and removal candidates, the existing two-room
migration window, and one global destroy command. Rollback requires only reverting code and
documentation because layouts V14 and Industry owner V5 are unchanged. ADR 0062 subsequently permits
the equivalent mineral-only explicit-boost handoff. Mixed terminal stock, autonomous boost-manifest
production, general multi-step migration, defensive migration, and creep dismantling remain in
parent issue [#99](https://github.com/ralphschuler/screeps-myrmex/issues/99).

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): labs have separate
  2,000-energy and 3,000-mineral capacities, and reactions use two range-two input labs plus one
  output lab.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store): a terminal has one shared 300,000-unit Store;
  terminal-send cooldown does not block creep transfer into the Store.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled actions move
  one exact resource subject to current source stock and destination capacity.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy),
  [game loop](https://docs.screeps.com/game-loop.html), and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): accepted intents do
  not prove same-tick delivery or structure disappearance.
- Screeps Wiki [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/),
  [`StructureLab`](https://wiki.screepspl.us/StructureLab/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply operational terminology only. MYRMEX policy
  and authority boundaries remain independently source-defined.
