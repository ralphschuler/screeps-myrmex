# ADR 0018: LogisticsPlanner authority and observation boundary

Status: accepted

## Context

Phase 2 introduces competing resource sources, sinks, buffers, deadlines, and reserves. Independent
opportunity selection can reserve the same stock or capacity more than once and starve mandatory
spawn, defense, or controller supply. The model must remain deterministic and bounded without
granting a planner observation, command, contract-ledger, population, or telemetry authority.

## Decision

`LogisticsPlanner` is the sole resource-flow admission authority. PR A is a pure data boundary: its
observation adapter accepts detached current-tick `RoomSnapshot` facts, normalizes stable
resource-specific nodes, and preserves missing, stale, foreign, inactive, empty, full, unknown, and
oversized inputs as bounded stable blockers. It does not read live Screeps objects.

The planner accepts caller-supplied normalized nodes and edges, admits mandatory deadlines first,
and reserves each source amount and sink capacity exactly once. Canonical IDs and ordering make
equivalent graphs byte-equivalent. Node, edge, admitted-flow, room, and blocker caps bound work.
Per-colony `CARRY`/`MOVE` recommendations derive only from admitted amount, round-trip ticks, and
the planning horizon, saturating at useful flow and the 50-part body limit.

Generic later-phase stores may expose observed contents as withdrawable sources. Only acceptance
that the snapshot proves becomes sink capacity: owned active spawn/extensions, survival towers, the
controller supply proxy, and general storage/terminal reserve buffers. Unknown resource-specific
acceptance fails closed. Tombstones and ruins are normalized only inside the fresh owned-room
boundary; PR A does not infer hostile safety.

PR B adds a pure contract projection without adding an authority. Each admitted flow becomes one
stable logical commitment with an acquire (`pickup` or `withdraw`) stage followed by a `transfer`
stage. Version 3 execution terms carry the stable flow identity, resource, reserved amount, stage,
counterpart, and planner-recommended `CARRY`/`MOVE`. Contract identities remain stable through
reset, partial work, lease expiry, and actor replacement; a new bounded cycle is issued only after
cargo is delivered or lost. Fresh endpoint facts suspend vanished, empty, full, stale, or
resource-mismatched work instead of preserving ghost cargo or optimistic capacity.

`ContractLedger.populationView()` remains the sole bridge into population policy. It expands only
the planner-recommended body pairs into bounded stable flow-slot loads. Population policy treats
each logistics slot as one useful copy, suppresses committed duplicates, converges across actor
death and replacement edges, and continues to enforce the existing protected recovery/replacement
reserve. Mandatory planner order receives scarce recommendation slots before optional flows. The
projector does not persist state; a later runtime caller must supply durable commitment state and
reconciled world progress through existing owners.

Runtime activation retains these boundaries: the planner remains the sole admission authority,
contracts remain the executable commitment, and telemetry consumes reconciled cumulative facts
without authorizing work. The composed deterministic gate covers pressure, partial delivery, actor
death, endpoint loss, dropped-resource decay, reset, and reordered observations. Issue #48 remains
the sole link-command authority, and #49 remains the container-repair authority. Terminal sends,
market value, remote hauling, and hostile-safety policy remain outside this decision.

Issue #251 extends the same boundary for lab staging. `IndustryDirector` may publish bounded,
resource-specific fill or drain demands carrying the current derived cluster fingerprint and an
existing `industry` budget binding. A data-only adapter resolves exact owned lab and
storage/terminal facts into ordinary nodes, endpoints, and edges; `LogisticsPlanner` still performs
the only stock and capacity admission. Resource-specific lab energy and mineral capacities use
separate reservation groups, while every mineral drain into one storage or terminal shares that
structure's aggregate free-capacity group. Contamination drains replace incompatible fills until a
later clean observation. The existing contract, workforce, lease, and executor path performs the
haul, and completion is reconciled from later observation rather than an API `OK` result.

## Consequences

- No source amount or sink capacity can be admitted twice within one canonical graph.
- Stale or missing visibility authorizes no optimistic capacity and cannot create ghost cargo.
- Mixed resources remain separate while explicit capacity reservation groups prevent independent
  resource nodes from double-reserving one general store or lab capacity.
- The observation adapter and planner emit projections, reservations, recommendations, and blockers
  only; they do not emit `WorkContract`, population demand, telemetry, or Screeps commands.
- The PR B projector emits typed contract requests and lifecycle retirements only. LeaseAgent can
  consume its existing pickup, withdraw, and transfer fields, but no runtime wiring or command path
  is introduced in this change.

## Mechanics sources consulted

- [Store API](https://docs.screeps.com/api/#Store)
- [StructureStorage](https://docs.screeps.com/api/#StructureStorage)
- [StructureTerminal](https://docs.screeps.com/api/#StructureTerminal)
- [Creep.transfer](https://docs.screeps.com/api/#Creep.transfer)
- [Creep.withdraw](https://docs.screeps.com/api/#Creep.withdraw)
- [Screeps Wiki: Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)

The official Store guidance establishes aggregate and resource-specific capacity semantics. Storage
and terminal are owned general-purpose stores, while terminal sending/cooldown stays outside local
creep hauling. Transfer and withdraw are adjacent creep actions whose partial, empty, full,
out-of-range, and competing-actor outcomes require later reconciliation rather than optimistic
settlement. The Wiki guidance motivates shared opportunity admission and throughput/travel-based
carry sizing while retaining cold-boot and recovery bounds.
