# Phase 2 Colony Policy Evidence

Issue [#44](https://github.com/ralphschuler/screeps-myrmex/issues/44) begins Phase 2 with a bounded,
read-only projection owned by `ColonyDirector`.

| RCL | Spawn pool target | Spawns | Extensions | Towers | Links | Storage | Terminal | Labs | Extractor | Factory | Observer | Power spawn | Nuker |
| --: | ----------------: | -----: | ---------: | -----: | ----: | ------: | -------: | ---: | --------: | ------: | -------: | ----------: | ----: |
|   2 |               550 |      1 |          5 |      0 |     0 |       0 |        0 |    0 |         0 |       0 |        0 |           0 |     0 |
|   3 |               800 |      1 |         10 |      1 |     0 |       0 |        0 |    0 |         0 |       0 |        0 |           0 |     0 |
|   4 |             1,300 |      1 |         20 |      1 |     0 |       1 |        0 |    0 |         0 |       0 |        0 |           0 |     0 |
|   5 |             1,800 |      1 |         30 |      2 |     2 |       1 |        0 |    0 |         0 |       0 |        0 |           0 |     0 |
|   6 |             2,300 |      1 |         40 |      2 |     3 |       1 |        1 |    3 |         1 |       0 |        0 |           0 |     0 |
|   7 |             5,600 |      2 |         50 |      3 |     4 |       1 |        1 |    6 |         1 |       1 |        0 |           0 |     0 |
|   8 |            12,900 |      3 |         60 |      6 |     6 |       1 |        1 |   10 |         1 |       1 |        1 |           1 |     1 |

Containers, walls, and ramparts are also in the typed unlock projection. Domains are bounded and
ordered: mining, logistics, construction, maintenance, defense, storage, terminal, industry.

Reason precedence is observation unknown, colony lost, outside RCL2-RCL8, threat, recovery,
bootstrap, constrained CPU, downgrade risk, reserve unrestored, capacity below target, RCL8 health
unavailable, active, then sustaining only with direct health evidence. This slice has no such
producer; [#225](https://github.com/ralphschuler/screeps-myrmex/issues/225) owns it. The frozen
projection is tick-local, reset/reordering deterministic, attached to `ColonyView`, and does not
change `COLONY_OWNER_SCHEMA_VERSION`.

Sources consulted: [control guide](https://docs.screeps.com/control.html) (last updated May 29,
2026), [StructureController](https://docs.screeps.com/api/#StructureController),
[StructureSpawn](https://docs.screeps.com/api/#StructureSpawn), and
[Room Control Level](https://wiki.screepspl.us/Room_Control_Level/).

Checks: focused
`npm test -- --run packages/bot/test/colony-rcl-policy.test.ts packages/bot/test/colony-director.test.ts packages/bot/test/runtime-config.test.ts`;
repository `npm run check`.

## Population policy

Normalized funded objectives use a fixed 50-tick horizon. Productive ticks are
`min(source capacity, measured + min(backlog, 50))`; round-trip travel contributes
`ceil(productive * min(2 * travel, 50) / 50)` actor ticks; copies are the ceiling of total actor
ticks over 50, capped at eight. Evaluation is canonical and bounded to 64 objectives, 8 demands, 256
target parts, 150 travel ticks, and 9,000 basis-point spawn saturation. Visible non-spawning actors
count only when TTL is known and strictly greater than replacement lead. Unknown ownership, lost
colonies, unavailable funding, unaffordable bodies, protected-reserve violations, and existing
commitment IDs authorize no demand. Domain behavior remains in #45-#52; #225 owns cross-domain
recovery and RCL8 maturity.
