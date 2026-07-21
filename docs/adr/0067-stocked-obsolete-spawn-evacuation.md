# ADR 0067: Stocked obsolete-spawn evacuation

## Status

Accepted

## Context

ADR 0066 permits replacement-first removal of one idle empty external spawn at RCL7/RCL8. An
otherwise eligible target holding 1–300 energy remains off-layout indefinitely. Destroying it would
lose room spawn energy, while ordinary refill and spawn selection can race an unpersisted haul.
Spawn energy is room-wide for spawning, so target emptiness alone does not prove that the committed
replacement retained the evacuated amount.

## Decision

- Layouts owner-local schema V16 adds one optional fixed-shape `spawnEvacuation` per room: exact
  target/replacement IDs, positive amount at most 300, replacement baseline, start tick, and an
  exclusive expiry exactly 150 ticks later. V15 migration invents no terms and rejects spoofed V15
  evacuation data.
- `ConstructionPlanner` reuses ADR 0066's full-allowance, committed-geometry, controller, reserve,
  workforce, site-headroom, threat, idle, and current `SpawnBroker` gates. It stages terms only when
  the different active committed replacement has an exact 300-capacity energy-only Store with free
  capacity for the complete target amount.
- On following ticks a pure projection emits one externally funded `optional-growth` edge, two
  nodes, and two V3 endpoints into the sole `LogisticsPlanner`. It reserves replacement capacity
  once, suppresses ordinary target refill throughout, and suppresses replacement refill while the
  target still holds energy. Once acquisition empties the target, ordinary replacement refill may
  restore a gain consumed from the room-wide spawn-energy pool.
- Current assigned/active endpoint evidence is flow-qualified. The exact evacuation endpoint may
  continue without self-blocking progress; any unrelated primary or counterpart endpoint naming
  either spawn fails closed. The exact flow and endpoints must retire before removal.
- Current `SpawnBroker` selection is revalidated before both planning and lease execution. The
  ordinary operational `agents.plan` view excludes every lease whose primary/counterpart names a
  currently suppressed migration spawn, plus every spawn-evacuation V3 identity. After current
  migration revalidation, the economic `migration.layout` system re-admits, submits, funds, and
  plans only the exact authorized V3 terms through the existing contract channel and lease-agent
  policy. Selecting either migration spawn, busy/inactive identity drift, malformed Store evidence,
  safety drift, or planner CPU loss suppresses the flow and removal. No second spawn, logistics,
  contract, workforce, lease, or creep-action authority is introduced.
- When layout change or owner reconciliation removes the persistent terms, generic Logistics cannot
  fund or execute the prefixed flow. It cancels an orphaned proposal, suspends orphaned funded work,
  and fails orphaned suspended/assigned/active work through legal `ContractLedger` transitions.
- Removal requires fresh exact target emptiness, replacement energy at least baseline plus amount,
  unexpired terms, unchanged ADR 0066 evidence, and retired exact work. The typed removal intent
  carries the minimum replacement energy; `StructureDestroyExecutor` revalidates it immediately
  before the sole `Structure.destroy` call. Existing one-global-command and reset-safe three-attempt
  receipts remain unchanged, and `OK` waits for observed disappearance.

## Consequences

At most one fixed evacuation exists in each of 64 layout records. Each active room adds at most one
flow, two nodes, and two endpoints within existing graph caps. Partial transfer, heap reset,
observation reordering, or post-acquire room-energy consumption preserves the target until complete
fresh evidence returns. While valid terms remain in a freshly owned room, target-refill suppression
survives activity, threat, and Store drift even when no optional flow is emitted. Survival-flow and
ordinary V3 leases cannot bypass that suppression; if the layout changes, the old evacuation remains
non-executable while its contract retires. Timeout, refill, selection, activity, capacity, layout,
safety, endpoint, or command drift authorizes no unsafe destroy.

Rollback to V15 code preserves the future layouts owner byte-for-byte and disables layout work.
Redeploying V16 resumes from persisted terms or the existing removal receipt. Sole-spawn relocation,
non-energy movement, defensive migration, broad multi-step migration, and creep dismantling remain
out of scope.

## Mechanics sources

Reviewed 2026-07-21:

- Official [Screeps documentation index](https://docs.screeps.com/),
  [API reference](https://docs.screeps.com/api/),
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn),
  [`Store`](https://docs.screeps.com/api/#Store),
  [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw),
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [game loop](https://docs.screeps.com/game-loop.html) define the 300-energy Store and deferred
  resource/destruction intents.
- Screeps Wiki [`StructureSpawn`](https://wiki.screepspl.us/StructureSpawn/),
  [Logistics](https://wiki.screepspl.us/Logistics/), and
  [`Intent`](https://wiki.screepspl.us/Intent/) supply terminology only; official contracts govern.
