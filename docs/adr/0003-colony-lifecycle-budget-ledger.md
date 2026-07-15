# ADR 0003: Colony Lifecycle and Budget Ledger

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Phase 1 needs a durable answer to three related questions before contracts, spawning, or economy can
be enabled: which owned rooms are viable colonies, which survival objective is active in each
colony, and which requests may consume energy, spawn time, or admitted CPU. Leaving these decisions
to later domain planners would create overlapping lifecycle and reserve authorities. Keeping them
only on the JavaScript heap would also duplicate objectives and reservations after a global reset.

The existing schema-v3 root already reserves the `colonies` owner, but that owner has no local
schema. The runtime also has one `CpuScheduler`; a gameplay budget must partition admitted work
without becoming another CPU-admission system.

## Decision

MYRMEX has one `ColonyDirector` under `packages/bot/src/colony/`. It is the sole authority for
owned-room lifecycle, local survival objectives, and colony posture. It reads the current immutable
`WorldSnapshot`, the detached `colonies` owner, resolved `RuntimeConfig`, and the kernel-provided
`CpuMode` and `CpuBudget`. It maintains no world cache, reads no live game objects, and issues no
Screeps commands.

Each colony uses the Phase 1 lifecycle:

`discovering -> bootstrapping -> developing -> mature -> threatened -> recovering`

`lost` is explicit and terminal. A visible room whose controller is absent or no longer owned is
lost. A room absent from `Game.rooms` is observation-unknown and does not prove loss. Threat and
recovery preempt optional growth. A newly observed room may record discovery and resolve to
bootstrapping in the same evaluation, so a bootstrapping or recovering colony with an owned spawn
and no legal worker produces exactly one recovery objective. The ledger funds it when its atomic
minimum claims fit current capacity.

Evidence is defined as follows:

- a legal local worker is non-spawning and has at least one active `WORK`, `CARRY`, and `MOVE` part;
- controller risk is a missing downgrade timer or a timer at or below the configured risk window;
- mature evidence is an owned RCL8 controller, an owned spawn, a legal worker, no controller risk,
  and no active threat; and
- a local threat exists when current unowned creeps whose identities are not excluded by configured
  self/ally/NAP policy have enough total active `ATTACK`, `RANGED_ATTACK`, `WORK`, and `CLAIM` parts
  to meet the configured offense threshold. Healing alone does not authorize a threat transition.

`BudgetLedger` is the sole local reservation authority and is part of the colony boundary. It
arbitrates atomic request bundles in this order:

1. emergency spawn;
2. defense;
3. replacement;
4. harvesting and filling;
5. controller survival;
6. critical maintenance; and
7. optional growth.

Requests and durable commitments are compared together by category, deadline or expiry, colony ID,
issuer, and revision. Stable request identity and canonical request fields make re-arbitration
independent of insertion order. A request may claim integer energy, an exact half-open spawn-time
interval, and integer abstract CPU units. Energy grants never exceed current room spawn/extension
energy. Only emergency, defense, and replacement work may consume the protected spawn-energy
tranche; every other category must leave its remaining balance intact. Spawn intervals on one spawn
never overlap. CPU capacity is derived from the system's kernel-admitted budget and never overrides
kernel admission.

Consumption is cumulative and idempotent. Repeated consume, release, expire, and reconcile
operations return stable outcomes; actual cost cannot exceed the grant. Visible colony loss releases
active local reservations. Unknown visibility preserves durable entry bytes unchanged but exposes no
live authorization; expiry is reconciled when current ownership becomes known again.

The `colonies` owner-local schema is version 1:

```ts
interface ColoniesOwnerV1 {
  schemaVersion: 1;
  revision: number;
  colonies: readonly ColonyRecordV1[];
  ledger: readonly LedgerEntryV1[];
}
```

Exact `{}` is the only initialization shorthand. Non-empty malformed or future owners are preserved
unchanged and fail closed with no objectives or grants. Arrays are canonical, bounded, and unique;
numeric values are nonnegative safe integers; references and accounting invariants validate as one
owner transaction. The generic root schema remains version 3 because it already contains the
`colonies` owner.

The director is registered once in the runtime composition root as mandatory Plan work with cadence
one. Its staged result may stage only the `colonies` transaction and publish its immutable
tick-local view. Kernel discard removes both. `state.reconcile` remains the sole normal root commit.
The system still runs fail-closed when the root owner is unavailable so emergency CPU mode cannot
strand its state machine.

Issue #37 makes only `phase1.colony` source-available and advances the runtime-config source
revision to `runtime-config-source-v2`. Every downstream gameplay gate remains source-unavailable.

## Consequences

- A heap reset or reordered request/entity collection reproduces the same lifecycle, grants,
  denials, canonical output, owner bytes, and reason codes.
- Later contract and spawn systems consume explicit funded objectives and reservations; they do not
  invent another reserve or lifecycle policy.
- `BudgetLedger` priority never becomes permission to overspend, and its CPU values never become a
  second scheduler.
- Owner parsing and arbitration have explicit structural caps. Valid excess requests within the raw
  input boundary receive deterministic denial rather than silent truncation; input beyond that
  boundary fails before an unbounded scan and stages nothing.
- Lifecycle state, fixed-cardinality reservation totals, and bounded decision reasons can be
  reported without persisting a second telemetry history.
- Changes to lifecycle evidence, resource units, owner schema, or authority boundaries require a new
  ADR or owner-local migration.

## Mechanics Basis

The decision follows the official [Game.rooms](https://docs.screeps.com/api/#Game.rooms),
[StructureController](https://docs.screeps.com/api/#StructureController),
[Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable),
[StructureSpawn](https://docs.screeps.com/api/#StructureSpawn),
[Creep](https://docs.screeps.com/api/#Creep), and
[CPU limit](https://docs.screeps.com/cpu-limit.html) contracts. The maintained Screeps Wiki pages on
[Vision](https://wiki.screepspl.us/Vision/),
[StructureController](https://wiki.screepspl.us/StructureController/),
[StructureSpawn](https://wiki.screepspl.us/StructureSpawn/), and
[CPU](https://wiki.screepspl.us/CPU/) provide operational context but do not override observed API
facts or configured diplomacy.
