# ADR 0074: Two-batch single-resource stocked-storage evacuation

## Status

Accepted

## Context

ADR 0072 permits one obsolete external storage containing one resource kind and at most 3,000 units
to evacuate into the room's exact active terminal. ADR 0073 composes several resource kinds without
raising that total. A safe RCL6–RCL8 room therefore cannot converge when the sole external storage
contains 3,001–6,000 units of one resource, even when the terminal has complete aggregate capacity.

A second flow cannot reuse the first flow or budget identity after settlement: `ContractLedger`
retains monotonic terminal evidence and must not resurrect retired work. An unbounded rolling
migration queue would also violate the existing layouts-owner and Logistics bounds.

## Decision

- Every ADR 0071/0072 geometry, colony, Logistics-health, endpoint, terminal-quiescence, capacity,
  send-suppression, removal, receipt, and executor gate remains mandatory.
- `ConstructionPlanner` may persist the new form only for exactly one positive resource kind
  totaling 3,001–6,000 units. The exact active terminal must have free aggregate capacity for the
  complete total. Existing scalar and two-to-eight-row manifest forms remain capped at 3,000 units.
- Layouts owner-local schema V23 adds one `settledAmount` cursor to that scalar form. It is exactly
  zero while batch one is current and exactly 3,000 after batch-one settlement. The owner retains
  the original total, terminal baseline, endpoint identities, start, and one fixed 300-tick
  exclusive expiry. Cursor advancement never renews the deadline.
- V22 migration invents no cursor. Pre-V23 owners carrying one are rejected. V22 code treats V23 as
  future, preserves its bytes, and authorizes no layout work.
- Batch one is exactly 3,000 units; batch two is the exact 1–3,000-unit remainder. Batch-qualified
  flow and budget identities prevent ContractLedger retirement evidence or a stale lease from
  crossing the boundary. Legacy V21/V22 identity bytes remain unchanged.
- The Logistics projection exposes only the current batch amount. It subtracts deferred stock from
  the observed source node while validating conservation against the complete original source and
  terminal amounts. The terminal keeps capacity for all undelivered committed stock. Endpoint and
  internal-send suppression remains continuous across the cursor change.
- `ConstructionPlanner` advances the cursor only after fresh exact 3,000-unit terminal gain, exact
  remaining source stock, current-flow retirement, and complete contract/lease/endpoint retirement.
  Persistence occurs after the tick's Logistics projection, so batch two cannot publish until the
  following tick.
- Removal requires the advanced cursor, fresh empty source, terminal stock exactly at the original
  baseline plus the complete total, final-flow and endpoint retirement, and every unchanged safety
  gate. Full delivery without the durable cursor cannot bypass the sequence.
- Missing funding, stale vision, threat, Industry activity, refill, destination consumption or
  overgain, capacity/identity drift, malformed state, expiry, CPU skip, or bounded graph pressure
  suppresses execution and removal while preserving the storage.

## Consequences

One safe room can move at most 6,000 units of one resource through exactly two existing-size funded
V3 Logistics batches before accepting ADR 0071's temporary storage-service outage and capacity
contraction. No planner, queue, contract authority, executor, command path, package, dependency, or
root Memory owner is added.

Persistent cost is one bounded integer in at most one storage evacuation per room across 64 layout
records. Runtime still projects at most one current storage flow per such room and remains within
the existing 64-flow/128-node ceilings. The fixed 300-tick total deadline scales ADR 0072's 150-tick
single-batch window without allowing renewal.

Mixed stock above 3,000 units, totals above 6,000, arbitrary batching, continuous evacuation,
uninterrupted storage/terminal service, defensive migration, autonomous boost-manifest production,
and creep dismantling remain outside this decision. Rollback to V22 preserves V23 bytes and pauses
layout work; redeploying V23 resumes exact terms.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal), and
  [`Store`](https://docs.screeps.com/api/#Store) define the 1,000,000/300,000-unit general-purpose
  Stores and aggregate capacity evidence.
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
