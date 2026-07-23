# Phase 2 static mining evidence

Issue [#46](https://github.com/ralphschuler/screeps-myrmex/issues/46) establishes deterministic
static extraction for visible owned sources. Issue
[#302](https://github.com/ralphschuler/screeps-myrmex/issues/302) preserves those executable terms
when alternate source containers appear. Issue
[#304](https://github.com/ralphschuler/screeps-myrmex/issues/304) adds one explicit lost-service
handoff. Issue [#306](https://github.com/ralphschuler/screeps-myrmex/issues/306) safely reuses that
handoff for one strictly better existing exact service. Issue
[#411](https://github.com/ralphschuler/screeps-myrmex/issues/411) preserves an already-settled
explicit source-service contract and lease across one command-free stale layout revision. The
checked gate result remains [`phase2-mining-results.json`](phase2-mining-results.json).

## Composed deterministic scenario

The scenario composes the production source-service selector, static-mining projection, body
projection, and observer-only mining telemetry reducer with a deterministic funding and replacement
ledger. Warm, serialized-state reset, and reordered source observations produce the same semantic
result. Focused runtime evidence retains the persisted work position and byte-stable contract while
only worse exact candidates exist. A different existing exact container that strictly precedes the
selected service under the canonical ordering persists sequence 2 once and cannot oscillate back
while both containers remain. Persisted services stay source-scoped when adjacent candidate sets
overlap. When the selected container disappears, a different exact reachable replacement follows the
same path. Both require fresh safety evidence and leave sequence 1 executable; on the following
tick, each path atomically reconciles to exactly one successor contract after reset and reordered
observation. An older-algorithm record already carrying a settled explicit sequence takes a separate
path: once any coordinate is explicit, every stale service must match one exact current
ContractLedger planning record, including its canonical full request signature. The bounded current-
revision layout plan must then preserve the complete source/position/effective-sequence set in the
existing two-room window before colony budgeting under normal progression or the existing bounded
developing-RCL8 infrastructure-recovery policy. Only that accepted exact stale set may renew
already-matching mining work. Persistence and mining-contract staging wait for the final spawn-
settled view and require one active reservation per service with matching colony, harvesting/filling
category, issuer, and effective sequence. Blocked or unattempted handoffs receive no continuity
budget, and no stale-layout suspension or new contract is produced for an accepted handoff. The
handoff therefore retains the same contract and lease and cannot also move mining.

The fixed room has two sources. One has exactly one legal adjacent tile at `W1N1/9/10`. Each run
keeps one stable primary extraction identity per source and checks a maximum of eight adjacent
candidates per source. The scenario ledger funds two source identities and retains exactly those two
identities after reset. Continuity inspects no additional source candidates and trusts a prior
position only when exactly one matching persisted service remains among the same legal reachable
eight tiles.

## Outcome matrix

| Scenario                             | Checked outcome                                                      |
| ------------------------------------ | -------------------------------------------------------------------- |
| Container site and missing container | `site-pending` and `site-needed`; extraction remains active          |
| Full container                       | `container-full`; drop fallback remains available                    |
| Decaying container                   | decay telemetry is exposed without repair authority                  |
| Destroyed container                  | `container-destroyed`; drop fallback avoids extraction deadlock      |
| Miner death and expiry               | one stable replacement demand is retained until scheduling           |
| Spawn busy and low energy            | replacement waits; no duplicate identity is introduced               |
| Temporary blocked tile               | the committed work position remains stable for deterministic retry   |
| Worse exact alternate appears        | selected exact service and contract remain byte-stable               |
| Better exact alternate appears       | one safe atomic next-sequence handoff; no selection oscillation      |
| Source candidate sets overlap        | each persisted exact service remains scoped to its source            |
| Selected container disappears        | prior tile remains until a safe exact successor exists               |
| Safe exact replacement exists        | sequence 1 atomically advances to one funded sequence 2              |
| Unsafe/unfunded replacement          | predecessor remains unchanged; no executable switch occurs           |
| Settled stale explicit issuance      | revision handoff preserves exact contract, lease, position, sequence |
| Mismatched/terminal stale issuance   | stale record remains inert; no continuity budget, contract, command  |
| Invalid/ambiguous prior evidence     | continuity is ignored; bounded normal selection remains fail-closed  |
| RCL downgrade and recovery           | `rcl-locked` returns to `container-ready` without identity churn     |
| Link candidate                       | `link-candidate` is exposed with zero link commands                  |
| Source depletion and regeneration    | the commitment remains stable and energy deltas are observed         |

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
- `ContractLedger` remains the sole contract state owner. One replacement consumes one bounded
  request and transition; validation failure restores the predecessor byte-for-byte.
- The focused multi-tick runtime outcome proves the persisted layout/contract transition. The #411
  row additionally proves warm, JSON/module-reset, and reordered structure and creep exact sequence-
  2 handoffs; zero site/destroy commands; no replacement or terminal outcome; one retained contract;
  one active continuity reservation; and a following `duplicate-active` submission. Pure two-source
  reconciliation proves detached source/contract-order independence and rejects missing, duplicate,
  unavailable, ID, sequence, source, owner, binding, action, resource, version, work-position, and
  full-signature mismatch. A runtime unsafe-policy control receives no continuity budget or command;
  a later-revision active reservation persists no layout, stages no duplicate submission, and leaves
  the stale contract suspended; and a mature RCL8 row proves the same exact active-reservation
  handoff through bounded infrastructure recovery. Terminal-only and changed-plan evidence remains
  covered by the existing handoff blockers.
- Live engine timing, real traffic contention, and deployed utilization are not substituted by this
  deterministic local evidence.

## Mechanics sources

ADRs 0017, [0044](adr/0044-selected-source-service-handoff.md), and
[0076](adr/0076-command-free-stale-layout-revision-handoff.md) record the consulted official
[`Source`](https://docs.screeps.com/api/#Source),
[`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest), and
[`StructureContainer`](https://docs.screeps.com/api/#StructureContainer) contracts. The Screeps Wiki
[`Static Harvesting`](https://wiki.screepspl.us/Static_Harvesting/) page supplies terminology only;
the implementation and scenario remain clean-room.

Run the focused evidence and documentation checks from the repository root:

```bash
npx vitest run packages/bot/test/source-services.test.ts \
  packages/bot/test/static-mining.test.ts \
  packages/bot/test/static-mining-runtime.test.ts \
  packages/bot/test/layout-revision-handoff-runtime.test.ts \
  packages/scenario-kit/test/phase2-static-mining-gate.test.ts
npx markdownlint-cli2 docs/phase2-mining-evidence.md docs/phase2-layout-evidence.md \
  docs/adr/0017-static-mining-authority.md \
  docs/adr/0044-selected-source-service-handoff.md docs/architecture.md docs/strategy.md \
  docs/roadmap.md
```
