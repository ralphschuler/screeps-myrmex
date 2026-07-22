# ADR 0070: Mixed-resource stocked-terminal evacuation

## Status

Accepted

## Context

Issue #361 permits one safe external terminal holding exactly one resource kind and at most 3,000
units to evacuate into active storage before the existing terminal-to-storage removal path. A
terminal holding two small resource rows remains migration-blocking even though the same active
storage, funded V3 Logistics path, aggregate-capacity reservation, suppression, and reset-safe
removal receipt can preserve the stock.

Treating each row as an independent migration would permit partial publication, split terminal send
suppression, and one flow continuing after another loses budget or graph admission. Expanding the
existing scalar record in place would also change durable flow and budget identities across a code
rollback.

## Decision

- Every #359/#361 ownership, RCL, geometry, site-headroom, storage, Industry-quiescence, Logistics,
  workforce, controller, reserve, threat, cooldown, timeout, and removal gate remains mandatory.
- One otherwise eligible terminal containing two through eight positive resource rows totaling at
  most 3,000 units may persist one binary-ordered manifest. Each tuple binds resource type, exact
  committed amount, and that resource's exact storage baseline.
- Layouts owner-local schema V19 adds the manifest alternative. Existing V18 scalar terms remain
  byte-identical and retain their flow and budget identities. V18 input cannot contain manifest
  evidence; V18 migrates without inventing terms, while V18 code preserves future V19 bytes and
  authorizes no layout work.
- The same exact active 1,000,000-unit storage must have complete aggregate capacity for the whole
  manifest. Every row receives one distinct `optional-growth` budget and one resource-specific V3
  flow. All sink nodes share the storage's one aggregate-capacity reservation key.
- Projection rejects malformed, duplicate, non-binary-ordered, over-eight-row, over-3,000-unit, or
  over-64-flow input before publishing a flow prefix. Durable terminal source/refill and internal-
  send suppression remains active when current evidence or bounded projection blocks work.
- Runtime admits all currently projected rows of one manifest or none after Logistics planning and
  again after colony funding. A fully delivered row leaves the current group, allowing asymmetric
  partial delivery to continue without recreating completed work.
- Removal requires fresh terminal emptiness, every storage amount exactly equal to its baseline plus
  committed amount, every exact manifest flow and endpoint retired, zero cooldown, unchanged
  quiescence/storage/geometry/safety evidence, and the existing one-command removal authorization.

## Consequences

Small mixed terminal stock can converge onto committed geometry without a new logistics, terminal,
storage, movement, command, or Memory-root authority. One record contributes at most eight budgets,
flows, and endpoint pairs; the global terminal-evacuation flow cap is 64.

Incoming or refilled stock, destination consumption or overgain, capacity/identity/activity loss,
partial graph or budget admission, unrelated work, timeout, pressure, CPU-skipped evidence, or
observation uncertainty preserves the terminal. Expiry restores ordinary terminal service but keeps
removal blocked. Stock above 3,000 units, more than eight kinds, storage relocation, uninterrupted
terminal service, defensive migration, and creep dismantling remain outside this decision.

Rollback to V18 code preserves the future owner byte-for-byte and disables layout work. Redeploying
V19 resumes the same bounded manifest. No deployment is authorized by this ADR.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal),
  [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage), and
  [`Store`](https://docs.screeps.com/api/#Store) define the 300,000/1,000,000 general-purpose
  capacities, resource rows, and aggregate omitted-resource capacity semantics.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer) define resource-specific
  scheduled movement. Later exact observation, not `OK`, proves delivery.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy) and the current
  engine evidence recorded by ADR 0068/0069 require the existing fresh-empty gate because residual
  stock would enter a ruin outside this Logistics projection.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/), and
  [`Energy`](https://wiki.screepspl.us/Energy/) provide primary-room-inventory and creep-hauling
  terminology only. Official contracts govern behavior.
