# ADR 0063: Quiescent idle-terminal lab mixed-stock evacuation

## Status

Accepted

## Context

ADR 0053 atomically evacuates one quiescent obsolete lab's energy to a retained committed lab and
its mineral to active storage. ADR 0060 permits a mineral-only obsolete lab to use one exact idle
terminal when no active storage exists. A terminal-only room still cannot converge one role-unused
external lab containing both energy and one mineral kind, even though both resource-specific flows,
the terminal reservation, and every delivery/removal guard already exist.

Layout owns the bounded migration commitment, Industry owns terminal publication and internal-send
suppression, Logistics owns funded resource movement, and the removal arbiter/executor own the
irreversible command. The composition must not add another owner or permit active reaction/boost
mixed-terminal migration.

## Decision

- In one quiescent safe RCL8 room with no active storage, `ConstructionPlanner` may persist a mixed
  evacuation only when Industry publishes one exact active idle terminal with complete aggregate
  capacity and no eligible internal send involves the room. Energy still targets the canonical
  retained lab; mineral targets the terminal.
- The existing layouts-owner V14 `destinationStructureType: "terminal"` discriminator is widened to
  the mixed record. No owner schema version changes. V1-V13 migration invents no terminal evidence;
  older V14 code preserves the owner bytes and fails closed until supporting code returns.
- `LogisticsPlanner` validates the complete record before atomically publishing two funded
  `optional-growth` V3 flows: energy to the retained lab and mineral to the terminal. Any identity,
  budget, capacity, graph, or fixed 64-flow failure publishes neither flow.
- The obsolete source and retained-lab energy endpoints remain suppressed as defined by ADR 0053.
  The terminal sink uses its existing general-purpose Store aggregate-capacity key. The persisted
  terminal commitment continues to suppress every internal send from or to the room.
- Partial delivery is resumable across JSON/global-heap reconstruction and reordered observation.
  Removal requires fresh target emptiness, both baseline-plus-amount destination gains, both flow
  identities and all source/replacement/terminal endpoints retired, unchanged quiescence,
  destination, assignment, cluster, layout, and colony-safety evidence, and no timeout.
- Active reaction and explicit-boost mixed-terminal records remain unavailable. Their established
  storage-backed mixed paths are unchanged. No new command, queue, telemetry cardinality, or
  persistent stock mirror is introduced.

## Consequences

One terminal-only quiescent colony can preserve both resources before obsolete-lab removal. The
runtime reuses one layouts record, two existing budget/flow identities, the sole creep logistics
path, terminal-send suppression, and the existing reset-safe one-command removal receipt.

Work remains bounded by the two-room migration window, one lab evacuation per room, 64 total lab
flows, 128 logistics nodes/endpoints and removal candidates, and one global destroy command. Storage
appearance, send contention, target refill, destination consumption or drift, malformed Store data,
capacity loss, active Industry work, threat, timeout, or incomplete work retirement preserves both
labs and authorizes no destruction.

Earlier V14 code rejects but preserves a widened mixed-terminal owner, so layout planning and
removal fail closed. It cannot derive the terminal reservation from that unavailable owner, however,
so internal sends may resume. An operational rollback must also disable the `phase2.industry` gate
or restore a supporting build before another tick; fresh destination-capacity and delivery evidence
still prevent removal after any stock drift. Redeploying supporting code resumes from the same
bounded record. ADRs 0064 and 0065 subsequently permit this exact record during durable reaction and
explicit-boost handoffs, respectively. General multi-step migration, defensive migration, and creep
dismantling remain issue #99.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [API reference](https://docs.screeps.com/api/).
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): a lab has separate 2,000
  energy and 3,000 mineral capacities and holds one mineral kind.
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
