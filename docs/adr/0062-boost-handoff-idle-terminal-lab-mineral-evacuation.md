# ADR 0062: Boost-handoff idle-terminal lab mineral evacuation

## Status

Accepted

## Context

ADR 0059 permits one explicit funded boost commitment to move onto a role-identical assignment over
nine retained committed labs before a role-unused external lab is removed. ADR 0060 permits a
mineral-only obsolete lab to evacuate into an idle terminal when Industry is quiescent, and ADR 0061
reuses that exact layouts-V14 destination during a durable reaction handoff.

A terminal-only colony still cannot preserve the same lab stock during the equivalent boost handoff.
Industry, Construction, and Logistics reject the terminal only because the handoff kind is `boost`,
even though the existing handoff already preserves all boost objective and assignment terms. Stock
must not be destroyed, and a current boost command or unresolved effect must not race removal.

## Decision

- Industry keeps active-storage precedence. With no active storage, it may publish one exact active
  terminal during an explicit boost handoff only when the handoff is durably `ready`, current and
  retained assignments have byte-identical role IDs, the external target has zero energy and at most
  one valid mineral kind, and no eligible internal send involves the room.
- The first rebound remains non-executable and publishes no terminal. Pending or blocked rebound,
  nonzero target energy, mixed or malformed stock, missing send evidence, duplicate terminals, and
  destination drift remain excluded.
- `ConstructionPlanner` may persist or continue ADR 0060's existing mineral-only V14 record while a
  current boost intent or matching pending attempt exists. Those activity states block only removal;
  they do not discard safe evacuation progress.
- `LogisticsPlanner` admits the existing funded V3 mineral flow during the exact ready boost
  handoff. The terminal uses its shared aggregate Store-capacity key, and the persisted commitment
  continues to suppress every internal send from or to the room.
- Removal requires fresh target emptiness, baseline-plus-amount terminal stock, retired exact flow
  and endpoints, no current boost intent or pending attempt, unchanged destination/layout/roles and
  colony safety, and no timeout. After boost settlement, the quiescent path may consume the same
  persisted record without weakening those gates.
- `StructureRemovalArbiter` and `StructureDestroyExecutor` remain the sole irreversible path. The
  existing `remove-active-reaction-lab-v1` identity remains the kind-neutral active-commitment
  compatibility identity established by ADR 0059.
- No owner, persistent field, schema version, queue, dependency, command authority, autonomous boost
  producer, or telemetry cardinality is added.

## Consequences

One terminal-only RCL8 colony can preserve a mineral-only role-unused lab while an explicit boost
continues on retained labs. JSON/global reset, reordered observation, partial delivery, current
boost execution, and pending exact-effect observation retain the same bounded V14 terms. Delivery
and structure disappearance still require fresh observation.

Storage appearance, internal-send contention, terminal identity/activity/capacity drift, nonzero lab
energy, mixed stock, assignment or layout drift, threat, timeout, or missing work-retirement
evidence fails closed. Rollback requires only reverting code and documentation because layouts V14
and Industry owner V5 are unchanged. Mixed terminal stock, autonomous boost-manifest production,
general multi-step migration, defensive migration, and creep dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab) and
  [`StructureLab.boostCreep`](https://docs.screeps.com/api/#StructureLab.boostCreep): labs separate
  2,000 energy and 3,000 mineral capacity; each boosted part costs 30 compound and 20 energy; `OK`
  schedules the action.
- Official [creep boosts](https://docs.screeps.com/resources.html#Creep-boosts): compound and body
  part determine the effect, and one part accepts one boost.
- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store): a terminal has one shared 300,000-unit Store;
  terminal-send cooldown does not block creep transfers into the Store.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw),
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer), and
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): evacuation and removal use
  scheduled intents with current stock, capacity, ownership, and range preconditions.
- Official [game loop](https://docs.screeps.com/game-loop.html) and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): command acceptance is
  not same-tick world-state proof.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply established operational terminology only.
  Official API contracts govern behavior.
