# ADR 0042: Single non-energy general-container evacuation

## Status

Accepted

## Context

ADR 0040 preserves one energy-only obsolete general container through paired legacy fields. ADR 0041
adds a resource-specific manifest for two through eight resource kinds. A safe non-service target
holding exactly one non-energy resource still cannot converge even though the same manifest,
`LogisticsPlanner`, V3 contract, lease, action, and executor path can represent its transfer.
Destroying the target would lose stock, while another hauling path would duplicate existing
authorities.

A one-row energy manifest must not become valid. It would give the same logical transfer both the
legacy unsuffixed identity and the resource-specific identity, weakening reset-safe deduplication
and rollback expectations.

## Decision

- `ConstructionPlanner` remains the sole migration-priority owner. After the existing geometry,
  replacement, source-service, colony-safety, reserve, site-headroom, and contract-view checks pass,
  a target holding exactly one positive non-energy resource may persist one canonical one-row
  layouts owner V2 manifest with resource type, amount, and replacement baseline.
- One-row manifests are valid only when the resource type is not `energy`. Energy-only migration
  continues to use ADR 0040's paired `energyAmount` and `replacementInitialEnergy` fields and
  byte-stable legacy flow/budget identities. Two-through-eight-row manifests retain ADR 0041's
  resource-specific identities and semantics.
- The persistence parser, planner continuation, and logistics projector enforce the same
  one-to-eight bound, canonical binary order, unique trimmed resource identities, positive target
  amounts, nonnegative baselines, and aggregate 2,000-unit Store limit. A singleton energy manifest
  fails closed.
- On following ticks, runtime composition projects exactly one resource-specific source, replacement
  sink, edge, and externally funded `optional-growth` budget binding. The specialized source
  replaces the ordinary target source; both endpoint refill sinks remain suppressed; the replacement
  uses the shared aggregate-capacity key.
- Existing V3 logistics contracts, leases, creep agents, action arbitration, and executors perform
  the withdraw/transfer. Removal still requires fresh target-empty, baseline-plus-amount replacement
  gain, retired exact flow, and retired endpoint evidence.
- Existing caps remain unchanged: one handoff per room, 64 records, eight manifest rows, 64
  migration flows, 128 nodes, 128 removal candidates, and one accepted removal command globally per
  tick. Invalid or over-cap input publishes no partial migration graph or destroy command.

## Consequences

One obsolete non-service container holding a mineral, commodity, deposit resource, or other exact
non-energy resource can converge without stock loss or another authority. Existing empty,
energy-only, and multi-resource commitments remain byte-compatible.

The root and layouts owner schema versions do not change. This release widens layouts owner V2
validation only for a canonical singleton non-energy manifest. Prior V2 code rejects that record and
fails closed while preserving owner bytes and every structure, so code rollback is safe. Restoring
operation requires redeploying supporting code; opportunistic Memory rewriting remains forbidden.

Selected or stocked source-service migration, other structure classes, defensive or critical
migration, arbitrary layout revision replacement, and `Creep.dismantle` remain issue #99.

## Mechanics sources

- Official [`Store`](https://docs.screeps.com/api/#Store): containers expose exact per-resource
  amounts under one aggregate-capacity Store.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers use
  the general-purpose Store constrained by this policy.
- Official [`Creep.withdraw`](https://docs.screeps.com/api/#Creep.withdraw) and
  [`Creep.transfer`](https://docs.screeps.com/api/#Creep.transfer): each adjacent scheduled action
  names one resource type, so one manifest row maps to one executable flow.
- Official [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy): destruction
  remains isolated behind the existing narrow executor and current safety checks.
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [Energy](https://wiki.screepspl.us/Energy/) and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide hauling and
  layout terminology only. MYRMEX policy and authority boundaries remain independently
  source-defined.
