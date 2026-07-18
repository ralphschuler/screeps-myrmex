# Phase 2 Gate Thresholds

Status: **declared, not measured**

Issue [#53](https://github.com/ralphschuler/screeps-myrmex/issues/53) fixes the numeric pass/fail
boundary that issue [#54](https://github.com/ralphschuler/screeps-myrmex/issues/54) must use for the
Phase 2 progression and steady-state soaks. The machine-readable source of truth is
[`phase2-gate-thresholds.json`](phase2-gate-thresholds.json). No value in that file is a measured
result or evidence that Phase 2 passes.

## Pinned progression fixture

The progression fixture is one owned colony with two ordinary owned-room sources, no controller
boost, and no `PWR_OPERATE_CONTROLLER` effect. Each source supplies 3,000 energy every 300 ticks, so
the modeled gross supply is 20 energy per tick. MYRMEX must average at least nine controller energy
per tick, leaving 55% of gross source income for spawning, construction, hauling, maintenance, and
reserve restoration.

| Destination RCL | Official progress | Maximum ticks |
| --------------: | ----------------: | ------------: |
|               3 |            45,000 |         5,000 |
|               4 |           135,000 |        15,000 |
|               5 |           405,000 |        45,000 |
|               6 |         1,215,000 |       135,000 |
|               7 |         3,645,000 |       405,000 |
|               8 |        10,935,000 |     1,215,000 |
|       **Total** |    **16,380,000** | **1,820,000** |

Every ceiling is `ceil(progress / 9)`. These are MYRMEX policy deadlines, not engine deadlines. The
existing scenario runner's 10,000-tick bound cannot represent the complete 1,820,000-tick timeline.
Issue #54 must add a bounded streaming or segmented collector that preserves ordinary source,
controller, spawn, and deferred-command mechanics. Accelerating controller progress does not prove
this gate.

## Pinned steady state

The RCL8 soak lasts 15,000 consecutive observed ticks: 50 ordinary source regeneration cycles and
ten normal creep lifetimes. At least 13,500 ticks must report the colony's direct domain-health
state as `sustaining`, including one final uninterrupted 1,500-tick interval. Recovery-injection
ticks may consume the 1,500-tick allowance, but every injection also has its own deadline.

The steady-state fixture may preload finite lab, factory, and power inputs. That exercises the
already-authorized Phase 2 structure paths without requiring market, remote, or expansion systems.
Observer readiness is required, but Phase 3 observer target production remains forbidden.

## Numeric boundaries

### CPU and bounded state

| Metric                                                | Boundary                            |
| ----------------------------------------------------- | ----------------------------------- |
| Mean total kernel CPU / `Game.cpu.limit`              | at most 6,500 bp                    |
| Per-tick `tickLimit - cpuUsed` tail headroom          | at least 5 CPU                      |
| Nominal bucket / final bucket                         | at least 5,000 / 9,500              |
| Bucket during low-bucket injection                    | never below 1,000                   |
| Complete persistent root                              | at most 65,536 UTF-8 bytes          |
| Positive net persistent growth over final 1,024 ticks | exactly 0 bytes                     |
| Telemetry owner / tick telemetry                      | at most 8,192 bytes each            |
| Registered heap cache                                 | at most 384 entries in 3 namespaces |

Total kernel CPU comes from `KernelTickReport`, not Phase 2's lower-bound domain CPU tuple. Memory
is measured from canonical serialized persistent state. The growth metric is
`max(0, finalBytes - initialBytes)` over the pinned final window; compaction may make it zero but a
negative delta is not required. Cache limits come from the three currently registered source-owned
namespaces. Any legitimate contract change must revise this declaration before, not after, a soak.

### Economy and safety

| Metric                                                  | Boundary                           |
| ------------------------------------------------------- | ---------------------------------- |
| Minimum controller downgrade margin                     | 3,001 ticks                        |
| Minimum nominal spawn-pool energy                       | 300 energy                         |
| Minimum nominal terminal energy                         | 10,000 energy                      |
| Source uptime / inferred waste                          | at least 9,500 bp / at most 500 bp |
| Spawn utilization                                       | at most 9,000 bp                   |
| Logistics scheduled/requested fulfillment               | at least 9,000 bp                  |
| Maximum absolute modeled flow residual                  | exactly 0                          |
| Nominal reserve violations / authority failures         | exactly 0                          |
| Dropped observer inputs / RCL evidence interruptions    | exactly 0                          |
| Unrestored net attrition hits / nominal structures lost | exactly 0                          |
| Final owned construction backlog                        | exactly 0                          |

Ratios use integer basis points. Measurements retain their raw finite values until evaluation:
upper-bound values are rounded up, lower-bound values are rounded down, and exact values must
already be safe integers. This conservative quantization prevents a fractional CPU or ratio overrun
from rounding into a pass. A zero denominator is missing evidence, not an automatic pass. Injected
recovery windows do not become nominal failures; their start, end, and recovered state must be
explicit. Expected ring rotation is not a dropped observer input. Attrition remains a net
adjacent-snapshot observation and is not labeled decay, combat damage, repair, or replacement.

### Complete-colony exercise and exclusions

The steady-state collector must observe at least one exact settled lab, factory, and power effect,
one successful link transfer, one resource-policy observation, and one observer-ready observation.
All five cooldown kinds—extractor, link, terminal, lab, and factory—must have active-slot evidence
for the complete 15,000-tick interval. This proves exercised or ready authority paths; cooldown does
not prove useful output.

Duplicate commitments, manual recovery commands, and later-phase actions must remain exactly zero.
Later-phase actions include remote, expansion, autonomous market, observer-target strategy, and
offensive command paths unavailable in Phase 2.

## Recovery deadlines

| Injection                     | Maximum recovery ticks |
| ----------------------------- | ---------------------: |
| Heap reset                    |                      1 |
| Bounded Memory recovery       |                     16 |
| Worker loss                   |                    122 |
| Spawn loss                    |                  1,500 |
| Other required structure loss |                  1,500 |
| Blocked logistics             |                    150 |
| Controller risk               |                     50 |
| Low bucket                    |                     50 |
| Resource shortage             |                    300 |
| Expected command error        |                    150 |
| Temporary hostile pressure    |                    100 |

Recovery ends only when the pre-injection direct health obligation is restored; expiration of the
fault itself is insufficient. One tick preserves the global-reset correctness contract; 16 ticks
bounds owner-by-owner Memory recovery; 122 preserves the Phase 1 workforce deadline; and 1,500 ticks
is one normal creep lifetime for rebuilding a lost required structure. The shorter deadlines cover
at most three 50-tick lease/planning horizons, one 300-tick source cycle, or the bounded command
retry interval. The low-bucket deadline means return to normal admission above the configured
hysteresis, not immediate refill to 9,500. The final bucket threshold applies at the end of the
complete soak.

## Executable contract

`@myrmex/scenario-kit` exports `validatePhase2GateThresholds` and `evaluatePhase2Gate`. Validation
rejects post-hoc status changes, unknown fields, missing or reordered required limits, invalid basis
points, inconsistent source throughput, progression ceilings that do not equal the pinned
nine-energy rate, and any changed or reused recovery mapping. Schema V1's complete canonical UTF-8
declaration receipt is `sha256:ecc728959ca26151df59f005fffee04dd7692502aedf71d008ccabe498912380`;
changing any limit tuple or fixture term requires a schema revision before a soak. The declaration
pins separate `phase2-progression-v1` and `phase2-steady-state-v1` seeds, warm/reset/reordered
variants, and exact production-bundle evidence.

Evaluation accepts issue #54 measurements only. Their structural receipt must match the canonical
manifest and measurement SHA-256 values and pinned seeds, carry an exact production-bundle SHA-256,
and show equal warm, reset, and reordered outcome hashes for both runs. Missing measurements block;
they never default to zero. Transition durations must be positive and sum to total progression.
Sustaining ticks cannot exceed the exact 15,000 observed ticks, the final sustaining tail cannot
exceed total sustaining ticks, and cooldown continuity cannot exceed the observed window. Limit and
blocker order remains fixed.

A zero-blocker evaluation returns `within-thresholds`, never `pass`. Structural hashes are not an
independent proof that a run occurred. Issue #54 owns the collector that derives measurements and
hashes from canonical per-variant artifacts, compares them with checked results, verifies the exact
bundle/config/policy revisions, and emits the final pass/fail artifact. Telemetry remains
observer-only; neither this manifest nor its evaluator is available to runtime gameplay code.

## Foundation receipt

- Official [CPU limit](https://docs.screeps.com/cpu-limit.html) and
  [`Game.cpu`](https://docs.screeps.com/api/#Game.cpu): CPU is measured execution time, unused
  baseline accumulates in a 10,000-cap bucket, and `limit`, `tickLimit`, `bucket`, and `getUsed()`
  are separate observations.
- Official [Control](https://docs.screeps.com/control.html): the RCL2-RCL8 progress requirements are
  45,000, 135,000, 405,000, 1,215,000, 3,645,000, and 10,935,000 energy. Controller downgrade is a
  separate finite obligation.
- Official [`Room.energyAvailable`](https://docs.screeps.com/api/#Room.energyAvailable) and
  `energyCapacityAvailable`: current spawn-pool stock and installed capacity are distinct.
- Screeps Wiki [CPU](https://wiki.screepspl.us/CPU/), [Energy](https://wiki.screepspl.us/Energy/),
  and [Room Control Level](https://wiki.screepspl.us/Room_Control_Level/): community guidance
  supplies operational terminology for profiling, source regeneration, and controller maintenance.
- Screeps Wiki [Maturity Matrix](https://wiki.screepspl.us/Maturity_Matrix/): maturity is a
  community capability model, not an engine flag. MYRMEX's direct eight-domain colony health remains
  the sole gameplay authority.
