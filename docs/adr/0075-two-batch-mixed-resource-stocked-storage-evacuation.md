# ADR 0075: Two-batch mixed-resource stocked-storage evacuation

## Status

Accepted

## Context

ADR 0073 permits one obsolete external storage containing two through eight resource kinds only when
the complete canonical manifest totals at most 3,000 units. ADR 0074 raises that total to 6,000 only
for one resource kind. A safe RCL6–RCL8 room therefore cannot converge when its sole external
storage contains 3,001–6,000 units spread across two through eight kinds, even when the terminal can
hold the complete stock.

Persisting materialized batch arrays would duplicate a deterministic projection. Reusing a resource
flow after its first-batch contract retires would also conflict with `ContractLedger`'s monotonic
retirement evidence.

## Decision

- Every ADR 0071–0074 geometry, colony, Logistics-health, endpoint, terminal-quiescence, capacity,
  send-suppression, removal, receipt, and executor gate remains mandatory.
- `ConstructionPlanner` may persist the new form only for one canonical binary-ordered manifest of
  two through eight positive resource rows totaling 3,001–6,000 units. The exact active terminal
  must have free aggregate capacity for the complete total.
- Layouts owner-local schema V24 adds the existing bounded `settledAmount` cursor to that manifest.
  It is zero while batch one is current and exactly 3,000 after batch-one settlement. The original
  manifest, source and terminal identities, per-resource terminal baselines, start, and one fixed
  300-tick exclusive expiry remain unchanged; no batch array is stored.
- V23 migration invents no manifest cursor. A pre-V24 manifest carrying one is rejected. V23 code
  treats V24 as future, preserves its bytes, and authorizes no layout work.
- Canonical manifest order defines one aggregate resource interval. Batch one is the first 3,000
  units; batch two is the exact remainder. A row crossing that boundary appears partially in both
  projections. Every current row receives the existing resource-qualified identity plus the batch
  suffix, so no retired first-batch flow or budget identity can reopen.
- The Logistics projection exposes only current-batch stock. Rows wholly before or after the current
  interval publish no work. It still validates per-resource source/terminal conservation and
  aggregate terminal capacity against the complete original manifest. Every currently incomplete row
  in one batch admits atomically. Every acquire lease is capped tick-locally by the fresh admitted
  virtual-source amount without mutating its persistent contract; absent or zero current admission
  suppresses acquire execution while delivery remains available. Deferred batch-two stock cannot
  satisfy a stale batch-one quantity after actor loss or partial withdrawal.
- `ConstructionPlanner` advances the cursor only after fresh exact per-resource first-batch delivery
  and complete prior flow, contract, lease, and endpoint retirement. Persistence follows the tick's
  Logistics projection, so batch two cannot publish until a later tick.
- Endpoint and internal-send suppression remains continuous across the cursor change. Removal
  requires the advanced cursor, fresh empty storage, every terminal row exactly at its original
  baseline plus original amount, final work retirement, and unchanged safety evidence.
- Missing funding, stale vision, threat, Industry activity, refill, destination consumption or
  overgain, capacity/identity drift, malformed state, expiry, CPU skip, or bounded graph pressure
  suppresses execution and removal while preserving the storage.

## Consequences

One safe room can move at most 6,000 units across at most eight resources through exactly two
existing-size funded V3 Logistics batches before accepting ADR 0071's temporary storage-service
outage and capacity contraction. No planner, queue, contract authority, executor, command path,
package, dependency, root Memory owner, or per-batch persisted array is added.

Persistent cost remains one bounded integer in at most one storage evacuation per room across 64
layout records. Runtime projects at most eight current storage flows per room and retains the
existing 64-flow/128-node ceilings. The fixed 300-tick deadline does not renew.

Totals above 6,000, more than eight resource kinds, arbitrary batching, continuous evacuation,
uninterrupted storage/terminal service, defensive migration, autonomous boost-manifest production,
and creep dismantling remain outside this decision. Rollback to V23 preserves V24 bytes and pauses
layout work; redeploying V24 resumes exact terms.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal), and
  [`Store`](https://docs.screeps.com/api/#Store) define the 1,000,000/300,000-unit general-purpose
  Stores, resource-specific amounts, and aggregate capacity evidence.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer) define resource-specific
  scheduled movement. Later observation, not `OK`, proves each delivery.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) defines scheduled
  owned destruction and hostile-room rejection; fresh exact emptiness remains mandatory.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/),
  [`StructureTerminal`](https://wiki.screepspl.us/StructureTerminal/), and
  [`Energy`](https://wiki.screepspl.us/Energy/) provide inventory and hauling terminology only;
  official API contracts govern.
