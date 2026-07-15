# Phase 0 Evidence

Evidence version: `phase0-v1`

Roadmap gate: [issue #22](https://github.com/ralphschuler/screeps-myrmex/issues/22)

This document is the versioned evidence contract for the executable foundation. CI is authoritative
for the referenced commit; counts below are refreshed before the gate PR is merged.

## Outcome matrix

| Outcome                                   | Evidence                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Empty Memory and normal tick              | `memory.test.ts`, `tick.test.ts`                                        |
| Warm boot and heap-reset equivalence      | `phase0-runtime.test.ts`, cache reset-equivalence test                  |
| Supported v1/v2 and interrupted migration | chained migration tests in `state-migrations` and `phase0-runtime`      |
| Malformed optional state                  | valid authority salvage and optional-subtree rebuild migration test     |
| Optional planner and staged commit fault  | tick/kernel fault-isolation tests and deterministic replay              |
| Normal/emergency/recovery CPU pressure    | kernel boundary tests and mandatory-tail CPU replay                     |
| Deterministic observation                 | reordered room/source, partial-vision, immutability, and reset tests    |
| Intent conflict and legal command failure | arbitration/executor tests, including accepted-only command enforcement |
| Architecture and bundle boundaries        | AST violation fixtures and esbuild metafile assertion                   |
| Deployable/package output                 | `dist/main.js` build and GitHub Packages staging check                  |

## Hard budgets

| Area                  | Limit                                                           |
| --------------------- | --------------------------------------------------------------- |
| Migration             | 1 step by default; hard maximum 4 constant-size steps per tick  |
| Persistent JSON       | depth 64; 50,000 nodes; 1,500,000 string/key code units         |
| Persistent containers | 10,000 array items; 10,000 object keys; key length 1,024        |
| Recovery diagnostics  | 16 entries; detail length 128                                   |
| Kernel fault state    | 128 restored system records; failure count capped at 16         |
| Mandatory CPU tail    | 5 CPU reserved; registered Phase 0 tail estimates total 2 CPU   |
| Intent channel        | 512 submissions; 128 accepted; 1,000,000 abstract budget units  |
| Cache registry        | 128 namespaces; 10,000 entries per namespace                    |
| Cache values          | key 16,384; encoded value 1,000,000 JavaScript code units       |
| Cache maintenance     | 32 expiry inspections per admitted runtime sweep                |
| World creep body      | 50 parts summarized into fixed-width capability counters        |
| Scenario runner       | 10,000 ticks; value 1,000,000; transcript 10,000,000 code units |

Migration cursors may use only their fixed transient overhead of 11 nodes and 248 code units above
the persistent JSON row. The projected final root must still pass the published cap, and a
completion diagnostic is best-effort when recording it would otherwise evict valid owner state.

Snapshot bytes, cache entries/namespaces, system/phase CPU, kernel overhead, estimate error,
overrun, skip reason, fault count, and CPU mode are bounded fields in the Phase 0 tick result. The
full-tick CPU total is the sum of system CPU and overhead; overhead includes bounded Memory
preflight and orchestration. Cache metrics and the minimal telemetry summary execute inside the
reserved `telemetry.minimum` system boundary.

## Failure invariants

- Future schemas are never downgraded or mutated.
- Recovery migrations are restartable and persist one cursor step at a time; a historical v1-to-v2
  cursor completes before the v2-to-v3 config-owner migration.
- During root recovery, invalid optional owner state is rebuilt without erasing valid
  authority-owned commitments.
- Tick systems receive detached state and immutable snapshots, never mutable Memory.
- A failed optional system cannot suppress accepted-safe Execute, Reconcile, or Telemetry tail work.
- Rejected or deferred intents cannot reach a command adapter.
- Cache and module-heap reset may add computation but cannot change outcomes.
- World facts absent from vision are unknown, not confirmed absent.
- Scenario-kit code is rejected from both deployable source and the final bundle graph.

## Foundation sources

Implementation and tests were constrained by these sources:

- [Screeps CPU limit](https://docs.screeps.com/cpu-limit.html)
- [Screeps Game loop](https://docs.screeps.com/game-loop.html)
- [Screeps Global Objects](https://docs.screeps.com/global-objects.html)
- [Screeps Scripting Basics](https://docs.screeps.com/scripting-basics.html)
- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.rooms](https://docs.screeps.com/api/#Game.rooms)
- [Screeps API: Room.find](https://docs.screeps.com/api/#Room.find)
- [Screeps API: StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep)
- [Screeps API: Constants](https://docs.screeps.com/api/#Constants)
- [Screeps caching overview](https://docs.screeps.com/contributed/caching-overview.html)
- [Screeps Wiki: Memory](https://wiki.screepspl.us/Memory/)
- [Screeps Wiki: Global reset](https://wiki.screepspl.us/Global_reset/)
- [Screeps Wiki: CPU](https://wiki.screepspl.us/CPU/)
- [Screeps Wiki: Caching](https://wiki.screepspl.us/Caching/)
- [Screeps Wiki: Undocumented behavior](https://wiki.screepspl.us/Undocumented_Behavior/)

## Repository gate

Local verification on 2026-07-15 completed with:

- 18 passing test files and 147 passing tests;
- a 107.1 kB `dist/main.js` production bundle with scenario-kit excluded; and
- successful package staging for `@ralphschuler/screeps-myrmex@0.0.0-development`.

The required command is:

```bash
npm run check
```

It must pass formatting, lint, both TypeScript projects, all deterministic tests, Markdown, the
production bundle graph check, and package staging from a clean checkout. GitHub Actions results on
the gate PR are the final merge evidence.
