# Phase 2 Complete-Colony Gate Evidence

Issue [#54](https://github.com/ralphschuler/screeps-myrmex/issues/54) is **within every frozen
threshold**. The checked source of truth is [`phase2-gate-results.json`](phase2-gate-results.json);
the predeclared contract remains [`phase2-gate-thresholds.json`](phase2-gate-thresholds.json).

## Method

`collectPhase2GateEvidence` streams three deterministic variants (`warm`, `reset`, and `reordered`)
without retaining per-tick transcripts. The progression model executes all 1,820,000 ordinary ticks
per variant, preserves two 3,000-energy/300-tick sources, spends nine energy per tick on the
controller, and leaves the remaining source income for colony operation. The RCL8 model executes
15,000 ticks per variant, includes normal replacement spawn occupancy over ten creep lifetimes, and
records explicit start, recovery, and restored-health receipts for all eleven frozen injections.

The aggregate composes the already-checked production-path evidence for layout, mining, logistics,
maintenance, industry, labs, mature infrastructure, RCL timing, attrition, cooldowns, colony health,
and telemetry. Raw-file SHA-256 receipts prevent those prerequisite artifacts from changing without
the gate changing. Separate tests rebuild the exact deployable bundle and hash the current runtime
configuration and RCL policy. Scenario Kit remains development-only and absent from the bundle.

This is deterministic modeled evidence, not MMO timing evidence. It does not authorize gameplay and
is not a substitute for the controlled Phase 6 live canary.

## Result

- Progression: RCL2→RCL8 in exactly 1,820,000 ticks; 16,380,000 controller energy; zero source
  waste.
- Steady state: 15,000 observed ticks, 14,628 sustaining ticks, final 12,981-tick sustaining tail.
- CPU/bucket: 1,505 bp mean modeled kernel budget, 490 CPU minimum tail headroom, 5,250 minimum
  nominal bucket, 10,000 final bucket.
- State: 324-byte modeled root, zero final-window growth, three cache namespaces, all declared byte
  and cardinality ceilings satisfied.
- Economy: 9,980 bp source uptime, 20 bp waste, 538 bp spawn utilization, 9,940 bp logistics
  fulfillment, zero flow residual and nominal reserve/authority failures.
- Complete-colony paths: exact lab, factory, power, and link effects; all five cooldown kinds across
  15,000 ticks; resource and observer readiness; 17 unlocked structure-policy rows.
- Exclusions: zero duplicate commitments, manual recovery commands, dropped observations, and
  forbidden later-phase actions.

All 58 measurements evaluate with zero blockers. Warm/reset/reordered semantic hashes are identical
for both progression and steady state.

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

Each receipt records sustaining health before injection and after the recovery window. Injection
windows are excluded from nominal-failure counters but remain part of the exact 15,000 observed
ticks.

## Bundle, revisions, and rollback

The checked result pins:

- build label `phase2-gate-evidence` and exact bundle SHA-256;
- canonical runtime-config and `COLONY_RCL_POLICY_TABLE` SHA-256 receipts;
- the immutable threshold-manifest and measurement SHA-256 receipts;
- all frozen prerequisite issues (#44–#53, #225, and #99).

Rollback removes the collector, checked artifact, and documentation. Runtime code, persistent
Memory, commands, energy policy, and deployment state are unchanged. The consequence is loss of the
Phase 2 exit proof and re-blocking Phase 3, not gameplay migration.

## Remaining risks

- Deterministic fixtures cannot reproduce MMO scheduling jitter, shard outages, or hostile strategy.
- CPU is a deterministic scenario budget; live CPU and bucket behavior remain a deployment concern.
- Active MMO promotion, inactive-branch upload, rollback rehearsal, and live hostile-pressure
  evidence remain governed by the Phase 6 deployment/canary gate.

## Foundation receipt

- Official [Control](https://docs.screeps.com/control.html)
- Official [API reference](https://docs.screeps.com/api/)
- Official [CPU limit](https://docs.screeps.com/cpu-limit.html)
- Official [External commit](https://docs.screeps.com/commit.html)
- Screeps Wiki [CPU](https://wiki.screepspl.us/CPU/), [Energy](https://wiki.screepspl.us/Energy/),
  and [Room Control Level](https://wiki.screepspl.us/Room_Control_Level/)
