# Phase 1 aggregate gate matrix (#30)

Status: `blocked` (aggregate evidence is not complete)

This is the checked-in evidence boundary for issue
[#30](https://github.com/ralphschuler/screeps-myrmex/issues/30). Thresholds are declared here before
any aggregate run is treated as evidence. The numbers are integer budgets, not measurements or
claims that an unevidenced row passes. `partial` means that a linked slice proves some outcomes but
not this complete budget row; `evidenced` means the linked slice is the current evidence for the
row's stated boundary. No row is marked `complete` until the aggregate run records measurements and
hashes for every column.

## Declared budget table

`persistent-growth` is the maximum per-row increase in durable bytes. `energy-flow` is the maximum
absolute modeled energy-unit delta that the row may reconcile per tick. `spawn-utilization` is a
percentage of the row's owned spawn ticks. `controller-margin` is the minimum permitted integer
margin in ticks before the configured controller-risk boundary; `controller-risk` is encoded as `0`
(not asserted) or `1` (risk allowed and must be handled). These definitions make the table
machine-checkable without pretending that a missing measurement is zero.

| row-id                    | status      | evidence                                                                                               | max-ticks | max-modeled-cpu | max-persistent-bytes | max-persistent-growth | max-telemetry-bytes | max-telemetry-cardinality | max-spawn-utilization-pct | max-energy-flow | max-replacement-lateness | min-controller-margin | controller-risk | max-recovery-time |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ | --------: | --------------: | -------------------: | --------------------: | ------------------: | ------------------------: | ------------------------: | --------------: | -----------------------: | --------------------: | --------------: | ----------------: |
| rcl2-established          | evidenced   | [gate evidence](phase1-gate-evidence.md)                                                               |       150 |             500 |                32768 |                  4096 |                8192 |                        64 |                       100 |             400 |                       50 |                     1 |               1 |               150 |
| rcl1-cold-boot-growth     | partial     | [growth evidence](phase1-growth-evidence.md), [economy evidence](phase1-economy-evidence.md)           |      1500 |           12000 |                32768 |                  8192 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |              1500 |
| spawn-blocker-recovery    | partial     | [spawn-blocker evidence](phase1-spawn-blocker-evidence.md), [spawn evidence](phase1-spawn-evidence.md) |       200 |            1000 |                32768 |                  4096 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |               200 |
| path-target-recovery      | partial     | [path/target evidence](phase1-path-target-evidence.md)                                                 |         3 |               3 |                32768 |                  1024 |                8192 |                        64 |                       100 |              50 |                       50 |                     1 |               1 |                 3 |
| hostile-pressure-recovery | partial     | [hostile-pressure evidence](phase1-hostile-pressure-evidence.md)                                       |       100 |            1000 |                32768 |                  4096 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |               100 |
| constrained-cpu           | partial     | [constrained CPU evidence](phase1-constrained-cpu-evidence.md)                                         |         8 |               8 |                32768 |                  1024 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |                 8 |
| reset-reorder-equivalence | partial     | [contracts evidence](phase1-contracts-evidence.md), [spawn evidence](phase1-spawn-evidence.md)         |      1500 |           12000 |                32768 |                  8192 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |              1500 |
| aggregate-phase1-matrix   | unevidenced | [gate evidence](phase1-gate-evidence.md)                                                               |      1500 |           12000 |                32768 |                  8192 |                8192 |                        64 |                       100 |             300 |                       50 |                     1 |               1 |              1500 |

The machine-readable local result is checked in as
[`phase1-gate-results.json`](phase1-gate-results.json). It records actual warm, reset, and reordered
outputs for the four exported deterministic component rows. A `null` measurement is paired with its
field name in `unevidenced`; missing measurements are never represented as zero. The aggregate row
remains `unevidenced` because the runtime RCL1/RCL2 fixtures do not yet export independent variants,
several component seams do not own Memory or telemetry, and external live evidence remains open.

## Evidence policy

- Thresholds are reviewed and checked in before evidence collection; observed values must be
  integer, non-negative, and within the row's declared ceiling. Missing observations are not
  represented as zero.
- Warm, JSON/global-heap-reset, and input-reordered runs must have equal outcome bytes, final world,
  and outcome hash. Reset metadata may change the transcript hash; reorder must not change the
  outcome hash. A future aggregate may use a different execution order only if this equivalence is
  preserved.
- The production artifact must contain no `packages/scenario-kit` input. The bundle-boundary check
  is composed by the focused test below; this document does not claim a built artifact was produced.
- Persistent bytes, telemetry bytes/cardinality, spawn utilization, energy reconciliation,
  replacement lateness, controller margin/risk, recovery time, and row hashes must be recorded by a
  future aggregate run before this status can change.

## Reproduction

Run the aggregate and matrix contract tests from the repository root:

```bash
npm exec vitest -- run packages/scenario-kit/test/phase1-gate-aggregate.test.ts scripts/test/phase1-gate-matrix.test.mjs
```

This command compares exported deterministic row outputs with the checked-in JSON, checks the
manifest, and composes the production bundle boundary. It does not substitute for unavailable
runtime measurements or live Screeps evidence.

## Explicit remaining risks

- The local aggregate covers only the four currently exported scenario-kit component rows.
- Replacement lateness and controller margin/risk remain acceptance dimensions, not proven values.
- Persistent-memory growth and telemetry byte/cardinality measurements are not yet joined to row
  hashes.
- RCL1 and RCL2 runtime fixtures still need independently exported warm/reset/reordered results.
- Live Screeps timing, engine inflows, hostile pressure, and deployment behavior remain outside this
  deterministic metadata contract.
