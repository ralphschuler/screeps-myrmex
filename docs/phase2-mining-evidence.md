# Phase 2 static mining evidence

Issue [#46](https://github.com/ralphschuler/screeps-myrmex/issues/46) establishes deterministic
static extraction for visible owned sources. The checked result is
[`phase2-mining-results.json`](phase2-mining-results.json).

## Composed deterministic scenario

The scenario composes the production source-service selector, static-mining projection, body
projection, and observer-only mining telemetry reducer with a deterministic funding and replacement
ledger. Warm, serialized-state reset, and reordered source observations produce the same semantic
result.

The fixed room has two sources. One has exactly one legal adjacent tile at `W1N1/9/10`. Each run
keeps one stable primary extraction identity per source and checks a maximum of eight adjacent
candidates per source. The scenario ledger funds two source identities and retains exactly those two
identities after reset.

## Outcome matrix

| Scenario                             | Checked outcome                                                    |
| ------------------------------------ | ------------------------------------------------------------------ |
| Container site and missing container | `site-pending` and `site-needed`; extraction remains active        |
| Full container                       | `container-full`; drop fallback remains available                  |
| Decaying container                   | decay telemetry is exposed without repair authority                |
| Destroyed container                  | `container-destroyed`; drop fallback avoids extraction deadlock    |
| Miner death and expiry               | one stable replacement demand is retained until scheduling         |
| Spawn busy and low energy            | replacement waits; no duplicate identity is introduced             |
| Temporary blocked tile               | the committed work position remains stable for deterministic retry |
| RCL downgrade and recovery           | `rcl-locked` returns to `container-ready` without identity churn   |
| Link candidate                       | `link-candidate` is exposed with zero link commands                |
| Source depletion and regeneration    | the commitment remains stable and energy deltas are observed       |

At 800 room energy capacity the body projection requests five `WORK` and three `MOVE` parts. Five
active `WORK` parts harvest the source regeneration bound of ten energy per tick without requesting
useless throughput. Mining's null energy and spawn requests leave the protected 300-energy recovery
tranche outside mining authority.

The telemetry row checks source uptime, harvested energy, miner idle time, replacement gap,
container fill and decay, and finite CPU per harvested energy. Planning emits one projection per
source, so evaluation is O(owned sources); source-service selection separately checks at most eight
adjacent cells per source.

## Evidence boundaries

- [#47](https://github.com/ralphschuler/screeps-myrmex/issues/47) owns hauling demand, pickup, and
  delivery outcomes. This scenario proves only that extraction does not deadlock when it must drop.
- [#48](https://github.com/ralphschuler/screeps-myrmex/issues/48) owns link transfer commands. This
  scenario proves only the read-only `link-candidate` transition and zero link commands.
- [#49](https://github.com/ralphschuler/screeps-myrmex/issues/49) owns repair policy and commands.
  This scenario observes container decay but does not schedule repair.
- Production runtime integration remains owned by the concurrent runtime worker. Live engine timing,
  real traffic contention, deployed utilization, and executor return codes are not substituted by
  this deterministic local evidence.

## Mechanics sources

ADR 0017 records the consulted official [`Source`](https://docs.screeps.com/api/#Source),
[`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest), and
[`StructureContainer`](https://docs.screeps.com/api/#StructureContainer) contracts. The Screeps Wiki
[`Static Harvesting`](https://wiki.screepspl.us/Static_Harvesting/) page supplies terminology only;
the implementation and scenario remain clean-room.

Run the focused evidence and documentation checks from the repository root:

```bash
npx vitest run packages/scenario-kit/test/phase2-static-mining-gate.test.ts
npx markdownlint-cli2 docs/phase2-mining-evidence.md docs/adr/0017-static-mining-authority.md \
  docs/architecture.md docs/strategy.md docs/roadmap.md
```
