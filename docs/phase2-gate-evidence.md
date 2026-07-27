# Phase 2 Complete-Colony Gate Evidence

Issue [#54](https://github.com/ralphschuler/screeps-myrmex/issues/54) is **within every frozen
analytical threshold**. The historical closure attestation is
[`phase2-gate-results.json`](phase2-gate-results.json); the predeclared contract remains
[`phase2-gate-thresholds.json`](phase2-gate-thresholds.json). The attestation is not a rolling cache
for the current branch.

## Method

`collectPhase2GateEvidence` streams three deterministic analytical variants (`warm`, `reset`, and
`reordered`) without retaining per-tick transcripts. It does not import or execute production
`runTick`. The progression projection iterates all 1,820,000 model steps per variant, assumes two
3,000-energy/300-tick sources, assigns nine controller energy per step, and assigns the remainder to
colony operation. The RCL8 projection iterates 15,000 model steps per variant, applies fixed
replacement occupancy, and records modeled start, recovery, and restored-health receipts for the
eleven frozen injections.

The historical aggregate composes the then-checked evidence for layout, mining, logistics,
maintenance, industry, labs, mature infrastructure, RCL timing, attrition, cooldowns, colony health,
and telemetry. Its prerequisite, configuration, policy, and bundle receipts describe closure commit
`c27af80c1af59519f0d7723d553402b792e35edf`. The complete JSON is immutable under
`sha256:8222dd56b25220bf4e4e4c0940e76d743293c423066bb2421235abb71e78a0f1`. Later-phase changes must
not refresh those historical hashes.

Current-HEAD compatibility is separate and executable:

- `phase2-runtime-compatibility-gate.test.ts` streams 21 production `runTick` calls through the RCL3
  construction path. Each warm/reset/reordered variant issues four real `Creep.build` calls, commits
  100 progress, and observes the completed site disappear.
- The same test streams nine production `runTick` calls through the RCL8 mature-command path. Each
  variant issues one `StructureFactory.produce` and one `StructurePowerSpawn.processPower`,
  reconstructs Memory in the reset variant, and observes exact `[40, 100, 20]` and `[50, 1, 1]`
  settlement.
- `phase2-gate-evidence.test.mjs` rebuilds the current deployable CJS bundle, rejects Scenario Kit
  inputs, evaluates it in a clean VM, invokes its exported `loop()`, and observes tick-100
  telemetry.

That is 30 production `runTick` calls across commandful paths plus one exact-bundle entrypoint call.
It is bounded runtime-path evidence, not a complete healthy RCL8 soak or MMO timing evidence.
Scenario Kit remains development-only and absent from the bundle.

## Acceptance status and continuation override

The frozen #54 acceptance criterion requires the configured colony to repeatedly reach RCL8 and
sustain CPU, energy, and recovery behavior for the agreed soak window. The repository does not
currently demonstrate that criterion through production `runTick`; the historical analytical pass
artifact is therefore invalid as proof of the Phase 2 runtime exit, although it remains preserved as
an audit record.

On 2026-07-27 the maintainer explicitly directed the autonomous agent to continue Phase 3 while this
evidence repair landed. That is an administrative continuation override limited to Phase 3 work, not
a #54 pass. Advancing beyond Phase 3 requires another explicit maintainer decision after the
unproved RCL8 soak is resolved or the roadmap contract is intentionally revised.

## Result

- Progression model: RCL2→RCL8 in exactly 1,820,000 steps; 16,380,000 controller energy; zero
  modeled source waste.
- Steady-state model: 15,000 projected steps, 14,628 sustaining steps, final 12,981-step sustaining
  tail.
- CPU/bucket model: 1,505 bp mean assigned kernel budget, 490 assigned CPU minimum tail headroom,
  5,250 minimum nominal bucket, 10,000 final bucket.
- State: 324-byte modeled root, zero final-window growth, three cache namespaces, all declared byte
  and cardinality ceilings satisfied.
- Economy declaration rows: assigned 9,980 bp source uptime, 20 bp waste, 538 bp spawn utilization,
  9,940 bp logistics fulfillment, zero flow residual, and zero nominal reserve/authority failures.
- Complete-colony declaration rows: assigned one lab, factory, power, and link effect; five cooldown
  kinds for the 15,000-step model; resource and observer readiness; and 17 ready structure-policy
  rows.
- Exclusion declaration rows: assigned zero duplicate commitments, manual recovery commands, dropped
  observations, and forbidden later-phase actions.

All 58 analytical measurements evaluate with zero blockers. Warm/reset/reordered semantic hashes are
identical for both projections. The current runtime witness separately passes exact command,
settlement, reset, reorder, kernel-fault, and bundle-entrypoint assertions.

## Recovery matrix

| Injection                  | Recovery ticks | Limit |
| -------------------------- | -------------: | ----: |
| Heap reset                 |              1 |     1 |
| Bounded Memory recovery    |             16 |    16 |
| Worker loss                |              9 |   122 |
| Spawn loss                 |            150 | 1,500 |
| Required structure loss    |             50 | 1,500 |
| Blocked logistics          |             20 |   150 |
| Controller risk            |             25 |    50 |
| Low bucket                 |             25 |    50 |
| Resource shortage          |             50 |   300 |
| Expected command error     |              6 |   150 |
| Temporary hostile pressure |             20 |   100 |

Each analytical receipt assigns sustaining health before injection and after a fixed projected
recovery window. The collector does not execute the fault or recovery behavior. Injection windows
are excluded from nominal-failure counters but remain part of the 15,000 modeled steps.

## Bundle, revisions, and rollback

The immutable closure result pins:

- build label `phase2-gate-evidence` and the closure bundle SHA-256;
- canonical runtime-config and `COLONY_RCL_POLICY_TABLE` SHA-256 receipts;
- the immutable threshold-manifest and measurement SHA-256 receipts;
- all frozen prerequisite issues (#44–#53, #225, and #99).

Current compatibility builds use an ephemeral `phase2-head-compatibility` label. They never rewrite
the closure result. Rollback removes the analytical collector, immutable artifact, current runtime
witness, and documentation. Runtime code, persistent Memory, commands, energy policy, and deployment
state are unchanged.

## Remaining risks

- No fixture currently executes a complete healthy RCL8 colony through a production `runTick` soak.
  The RCL8 command witness explicitly remains `developing` with a layout-domain blocker.
- Deterministic fixtures cannot reproduce MMO scheduling jitter, shard outages, or hostile strategy.
- CPU and bucket values in the long-horizon result are analytical assignments, not measured
  production or MMO CPU.
- Active MMO promotion, inactive-branch upload, rollback rehearsal, and live hostile-pressure
  evidence remain governed by the Phase 6 deployment/canary gate.

## Foundation receipt

- Official [Control](https://docs.screeps.com/control.html)
- Official [API reference](https://docs.screeps.com/api/)
- Official [CPU limit](https://docs.screeps.com/cpu-limit.html)
- Official [External commit](https://docs.screeps.com/commit.html)
- Screeps Wiki [CPU](https://wiki.screepspl.us/CPU/), [Energy](https://wiki.screepspl.us/Energy/),
  and [Room Control Level](https://wiki.screepspl.us/Room_Control_Level/)
