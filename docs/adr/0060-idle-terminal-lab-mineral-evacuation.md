# ADR 0060: Idle-terminal lab mineral evacuation

## Status

Accepted

## Context

ADR 0052 permits one obsolete quiescent lab containing a single mineral kind to evacuate only to the
exact active owned storage published by Industry. This preserves stock before `Structure.destroy`,
but a safe RCL8 room with no active storage and one usable terminal cannot converge its lab layout.

A terminal is not interchangeable with storage. Its general-purpose Store holds 300,000 total units,
and Industry may issue an internal `StructureTerminal.send` that changes the terminal's resource
amount or capacity. Layout cannot select a terminal independently or bypass the existing terminal,
logistics, contract, and command authorities.

## Decision

- Industry retains storage precedence. When no active storage exists, it may publish one exact
  active owned terminal to the lab-migration view only while the room is quiescent and no current
  eligible internal send uses that room as source or destination. Missing send evidence publishes no
  terminal.
- Layouts owner-local schema V14 adds only an optional `destinationStructureType: "terminal"`
  discriminator to the existing mineral-only lab evacuation. Its absence preserves V12/V13 storage
  semantics. V1-V13 migration invents no terminal evidence; V13 code rejects and preserves V14 owner
  bytes.
- Terminal destinations remain unavailable to boost handoffs and mixed energy/mineral evacuations.
  ADR 0061 subsequently permits only the mineral-only active-reaction handoff to reuse this exact
  V14 destination under storage-absence and current no-send evidence.
- A persisted terminal-bound evacuation reserves its room against every internally planned send,
  whether the room would be the source or destination. `IndustryDirector` remains the sole send
  policy owner and reports `terminal-reserved`; no terminal command authority is added.
- `ConstructionPlanner` and the lab-evacuation projection independently require one exact active
  terminal with a valid 300,000-unit aggregate Store, complete free capacity, unchanged identity,
  and the persisted mineral baseline. The existing 150-tick commitment and 64-flow ceiling remain.
- `LogisticsPlanner` alone admits one funded `optional-growth` mineral flow. Existing V3 contracts,
  leases, creep agents, and executors perform `withdraw` then `transfer`; the terminal sink shares
  the canonical aggregate Store-capacity reservation key.
- Removal requires fresh empty-lab observation, terminal stock at least baseline plus committed
  amount, retired exact flow/endpoints, unchanged quiescent assignment/cluster/destination evidence,
  current colony safety, and no timeout. `StructureRemovalArbiter` and `StructureDestroyExecutor`
  retain the sole one-command removal path and reset-safe receipt.

## Consequences

One safe terminal-only colony can preserve a mineral-only obsolete lab's stock and resume canonical
layout convergence without a second logistics or terminal path. Partial delivery, JSON/global-heap
reset, and structure reordering retain the same bounded commitment.

Internal sends cannot race the reserved terminal. External incoming transfers, other Store activity,
capacity loss, stock consumption, terminal inactivity, unauthorized active lab work, threat,
malformed evidence, or timeout reduce progress and authorize no destruction. ADR 0061's exact ready
reaction handoff is the only active-work exception. Fresh Store evidence, not an `OK` command,
proves preservation.

The persistent cost is one optional fixed discriminator in the existing single lab evacuation per
room. Rollback requires reverting code and documentation; V13 fails closed on V14 owner bytes until
V14 code returns.

## Mechanics sources

Reviewed 2026-07-21:

- Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store): one RCL6+ terminal exposes a shared 300,000-unit
  Store; cooldown governs terminal sends, not creep transfers.
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): a lab holds 3,000 units of
  one mineral kind and 2,000 energy.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): adjacent scheduled intents move
  resources subject to current source and destination capacity.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy),
  [game loop](https://docs.screeps.com/game-loop.html), and
  [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html): command acceptance is
  not same-tick world-state proof.
- Current Screeps engine 4.3.2 terminal-send and creep transfer/withdraw processors confirm deferred
  effects and capacity clipping; public API contracts remain authoritative.
- Screeps Wiki [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/),
  [`StructureLab`](https://wiki.screepspl.us/StructureLab/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply operational terminology only.
