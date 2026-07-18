# ADR 0033: Exact settled industry input accounting

## Status

Accepted. ADR 0034 later advances the nested Phase 2 observer state to V5 while preserving this
settled-accounting contract.

## Context

Phase 2 telemetry reported settled lab, factory, and power output but discarded the exact inputs
that existing next-observation reconciliation had already proved. Lab `settledAmount` also
represented objective progress: forward and reverse reactions used different input/output ratios,
while boosts counted body parts rather than produced resources. Treating that value as lab output
fabricated industry accounting and left the final RCL8 soak unable to compare recipe cost with
settled effects.

Inferring inputs later from aggregate room stock would duplicate observation logic and misattribute
unrelated hauling or production. Dynamic resource labels would also violate telemetry cardinality
and operational-security constraints.

## Decision

- Exact lab and mature-structure settlement receipts carry one fixed accounting row: `energyInput`,
  `resourceInput`, and `resourceOutput`.
- Only an exact next-observation settlement may publish nonzero accounting. Pending, retry,
  cancelled, failed, conflicting, or timed-out effects publish a zero row.
- Forward reactions account two reagent amounts into one product amount. Reverse reactions account
  one compound amount into two reagent amounts. Exact boosts account mineral and energy consumed per
  corroborated body part and publish no resource output.
- Factory settlements split the source-controlled recipe components into energy and non-energy input
  units and publish the exact batch output. Power processing accounts power input, effect-adjusted
  energy input, and registered-power output.
- Lab and mature telemetry project only bounded settled receipts as compact tuples aligned with the
  exported `(energy input, resource input, resource output)` field order and omit an empty aggregate
  row. Phase 2 combines those rows without resource-type labels, corrects lab output to exclude
  boost progress, and retains separate energy-input, resource-input, and aggregate output values in
  the rolling sample/window.
- The root telemetry owner remains V5. Its nested Phase 2 state advances from V3 to V4. V4 preserves
  RCL timing and attrition state but drops V1–V3 sample rows because they contain no recipe inputs;
  each dropped row advances the existing saturating sample-loss counter. Missing inputs are never
  migrated as zero.
- V4 persists samples as compact tuples aligned with one exported fixed field order. The existing
  64-sample, configured history, and 8,192-byte whole-owner ceilings remain authoritative. Existing
  deterministic byte fitting evicts complete V4 samples before RCL, attrition, and reporter
  evidence.
- No planner, director, arbiter, executor, or domain-health adapter may consume the accounting or
  telemetry history.

## Consequences

The Phase 2 gate can now compare exact settled industry inputs with outputs without deriving stock
movement, mislabeling boosts, or adding dynamic resource cardinality. A deployment upgrade loses
only legacy aggregate samples; current gameplay commitments, pending industry attempts, RCL timing,
and attrition evidence remain unchanged. Rollback to V3 loses input history only.

Checked evidence is in
[`phase2-industry-accounting-results.json`](../phase2-industry-accounting-results.json), with the
contract and migration matrix in [`phase2-telemetry-evidence.md`](../phase2-telemetry-evidence.md).

## Mechanics sources

- [Official `StructureLab.runReaction`](https://docs.screeps.com/api/#StructureLab.runReaction)
- [Official `StructureLab.reverseReaction`](https://docs.screeps.com/api/#StructureLab.reverseReaction)
- [Official `StructureFactory.produce`](https://docs.screeps.com/api/#StructureFactory.produce)
- [Official `StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower)
- [Screeps Wiki: StructureLab](https://wiki.screepspl.us/StructureLab)
- [Screeps Wiki: StructureFactory](https://wiki.screepspl.us/StructureFactory)
- [Screeps Wiki: Power](https://wiki.screepspl.us/Power)
