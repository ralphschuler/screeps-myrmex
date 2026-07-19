# ADR 0041: Mixed general-container stock evacuation

## Status

Accepted

## Context

ADR 0040 evacuates one obsolete non-service general container only when its entire Store contains
energy. A target holding energy plus a mineral or commodity therefore cannot converge even after the
existing replacement-first path has built exact committed capacity. Destroying it would lose stock.
A layout-local hauling implementation would duplicate `LogisticsPlanner`, BudgetLedger,
ContractLedger, workforce, lease, action-arbitration, and executor authorities.

Containers are general-purpose Stores and may contain multiple resource kinds under one aggregate
2,000-unit capacity. Each `Creep.withdraw` or `Creep.transfer` action names exactly one resource, so
the existing energy flow cannot represent mixed stock as one executable commitment.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. After ADR 0039's geometry,
  replacement, source-service, colony-safety, reserve, site-headroom, and contract-view checks pass,
  a target containing two through eight exact positive resource kinds may persist one compact
  binary-ordered manifest. Each tuple stores resource type, source amount, and the replacement's
  current amount for that resource.
- Manifest resource identities are unique, trimmed, and at most 64 characters. Target amount is at
  most the official 2,000-unit capacity. Aggregate persisted baselines plus target stock must also
  fit 2,000. Duplicate, malformed, noncanonical, over-eight-kind, and mixed legacy/manifest records
  invalidate the layouts owner. Owner-local schema V2 adds the manifest; opening V1 validates and
  advances its empty/energy records without changing commitments. Empty records and ADR 0040's
  paired energy fields remain valid. Fresh policy/projection validation inspects at most 64 current
  replacement Store rows before failing closed.
- One non-energy kind remains fail-closed. This slice is specifically the smallest mixed-stock
  continuation; it does not reinterpret ADR 0040's stable energy identity.
- On following ticks, runtime composition validates the record against fresh visible owned-room
  observation. `LogisticsPlanner` receives one specialized source, replacement sink, edge, and
  distinct externally funded `optional-growth` budget binding per manifest row. Every sink uses the
  same aggregate replacement-capacity key. The target's ordinary sources and both endpoint refill
  sinks are suppressed, so stock and capacity are reserved once.
- Existing V3 logistics contracts, leases, creep agents, action arbitration, and executors perform
  each resource-specific withdraw/transfer. Legacy energy flow and budget identities remain
  byte-for-byte unchanged; mixed identities append one length-prefixed resource component.
- At most 64 resource flows and 128 nodes may be projected across the 64 layout records. Overflow or
  one invalid resource identity returns the complete empty migration projection rather than a
  prefix, preventing suppression without all stock flows.
- Removal remains blocked until fresh observation proves the target Store empty, every replacement
  resource is at least its persisted baseline plus committed amount, no exact resource flow remains
  active, and no assigned/active logistics endpoint names either structure. Refill, replacement
  drift, capacity loss, missing contract evidence, threat, timeout, or command failure preserves the
  target and authorizes no destruction.
- `StructureRemovalArbiter` retains its 128-input and one-global-command ceilings. Only
  `StructureDestroyExecutor` calls `Structure.destroy`; following observation remains the sole
  removal-completion evidence.

## Consequences

One mixed-stock obsolete general container can converge without stock loss or a second logistics
owner. Canonical Store, structure, and JSON/global-heap reordering yields identical terms and
outcomes. Distinct budget bindings preserve ContractLedger's one-active-contract-per-binding rule,
while one shared capacity key prevents aggregate replacement overcommit.

The optional manifest does not change the root schema. It advances the layouts owner from V1 to V2
so prior code treats the owner as future and fails closed instead of misreading a manifest as an
empty handoff. A code rollback therefore disables layout work while preserving owner bytes and every
structure. Restoring V1 operation requires a separate explicit downgrade release after all mixed
commitments are absent; opportunistic or manual Memory rewriting is forbidden.

Selected source-service migration, one non-energy resource, other structure classes, defensive or
critical migration, arbitrary layout revision replacement, and `Creep.dismantle` remain issue #99.

## Mechanics sources

- Official [`Store`](https://docs.screeps.com/api/#Store): containers use general-purpose Stores;
  omitted-resource capacity methods expose aggregate capacity while resource properties expose exact
  per-resource amounts.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, limited to five per room, and hold 2,000 total resource units.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): each adjacent scheduled action
  names one `RESOURCE_*` type and optional exact amount; `OK` is scheduling evidence only.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction is
  immediate after scheduling and returns `ERR_BUSY` while hostile creeps are present.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-18.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide hauling and
  layout terminology only. MYRMEX policy and authority boundaries remain independently
  source-defined.
