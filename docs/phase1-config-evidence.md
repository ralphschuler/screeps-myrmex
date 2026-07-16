# Phase 1 Runtime Configuration Evidence

Evidence version: `phase1-config-v4`

Roadmap foundation: [issue #36](https://github.com/ralphschuler/screeps-myrmex/issues/36), with the
first outcome activation in [issue #37](https://github.com/ralphschuler/screeps-myrmex/issues/37),
contract activation in [issue #23](https://github.com/ralphschuler/screeps-myrmex/issues/23), and
spawn activation in [issue #24](https://github.com/ralphschuler/screeps-myrmex/issues/24)

This document is the versioned evidence contract for survival policy, roadmap feature gates, and
fail-closed player exclusions. CI is authoritative for the referenced commit. No gameplay gate can
be made available by operational Memory; source v4 makes only the proved `phase1.colony`,
`phase1.contracts`, and `phase1.spawn` outcomes available.

## Authority and revision contract

`RuntimeConfigAuthority` is the sole interpreter of `Memory.myrmex.config`. Source defaults use
`runtime-config-source-v4`; the owner-local schema is version 1. The owner contains an
operator-owned `candidate` and a bot-owned `lastValid` acceptance receipt. Exact `{}` is the only
initialization shorthand.

```ts
interface RuntimeConfigOwnerV1 {
  schemaVersion: 1;
  candidate: null | { revision: number; overrides: unknown };
  lastValid: null | {
    sourceRevision: string;
    candidateRevision: number;
    overrides: CanonicalRuntimeOverrides;
    resolvedRevision: string;
  };
}
```

A candidate revision is a nonnegative safe integer other than negative zero. Changed canonical
content requires a revision greater than the accepted candidate revision. An equal revision is valid
only for a canonically equivalent override; a lower revision is stale. `lastValid` is compatible
only when its source revision matches, its canonical override revalidates, and its recomputed
resolved revision matches. Canonical override data—not a compact hash—is the equality evidence.

`candidate: null` means no new proposal. If `lastValid` is compatible, its resolved config and
candidate-revision high-water remain active and the owner is not rewritten. An initial null or a
null with incompatible evidence uses source defaults without opportunistically rewriting the
receipt. Null is not rollback; rollback requires a newer candidate containing the complete prior
override or `overrides: {}` for source defaults.

The source-v4 gate manifest intentionally invalidates source-v3 `lastValid` receipts. A present
candidate is revalidated and receives a v4 receipt when valid. If `candidate` is null and only an
incompatible v3 receipt exists, source defaults apply and the owner is not opportunistically
rewritten.

The full config `revision` and survival `policyRevision` are stable compact identities over their
respective canonical values. Equivalent key order and identity input therefore resolve to the same
frozen values and revisions across JSON serialization and global heap reset. Resolution statuses are
`source-defaults`, `candidate-accepted`, `last-valid-retained`, and `owner-unavailable`. Bounded
reason codes are:

- `owner-unavailable`, `owner-initialized`, `owner-malformed`, and `owner-future-schema`;
- `no-candidate`, `candidate-valid`, `candidate-invalid`, `candidate-stale`, and
  `candidate-revision-reused`.

A malformed or future owner in otherwise ready schema-v3 state resolves to `source-defaults` with
`owner-malformed` or `owner-future-schema`. `owner-unavailable` status and reason are reserved for
recovery or unsupported root state, where an owned config transaction cannot be opened.

Telemetry may expose status, reason, candidate/accepted revision numbers, source revision, config
revision, and policy revision. It must not expose identities, override values, or candidate content.

## Validation budgets

Candidate validation is all-or-nothing and runs after a global reset or candidate-revision change.
The whole override is rejected when any structural, identity, numeric, or cross-field rule fails.

| Area               | Hard limit or rule                                                        |
| ------------------ | ------------------------------------------------------------------------- |
| Nesting            | depth 5, with the override root at depth 0                                |
| Object fields      | 64 cumulative keys; 64 UTF-16 code units per key                          |
| Values             | 256 cumulative nodes                                                      |
| Canonical payload  | 8,192 UTF-8 bytes                                                         |
| Arrays             | 32 items per array                                                        |
| Identity length    | 1–64 UTF-16 code units                                                    |
| Identity count     | 32 per self/allies/NAP class; 64 across all three classes                 |
| Numeric values     | finite integers inside inclusive bounds; negative zero is rejected        |
| Objects and arrays | own enumerable data only; unknown keys and sparse arrays are rejected     |
| Identities         | exact-case NFC strings; no edge whitespace, controls, or lone surrogates  |
| Identity sets      | binary-sorted; duplicates and overlap among self/allies/NAPs are rejected |

The override top level accepts only `policy`, `relations`, and `features`. Every nested object also
uses exact allowlisted keys. The resolved view is detached and recursively frozen.

## Survival policy

All numeric bounds are inclusive. “Basis points” are ten-thousandths of maximum hits, so 2,500 basis
points means 25%. These source defaults are tunable only within the documented bounds; game
invariants and the bounds themselves are not operational overrides.

| Path                                    | Unit                 | Default | Bounds          |
| --------------------------------------- | -------------------- | ------: | --------------- |
| `recovery.protectedSpawnEnergy`         | energy               |     300 | 200–12,900      |
| `recovery.emergencyWorkerEnergyBudget`  | energy               |     300 | 200–800         |
| `recovery.controllerRiskWindowTicks`    | ticks                |   3,000 | 500–20,000      |
| `leases.durationTicks`                  | ticks                |      50 | 1–1,500         |
| `leases.renewalWindowTicks`             | ticks                |      10 | 0–duration − 1  |
| `retries.maximumAttempts`               | attempts             |       5 | 0–16            |
| `retries.initialDelayTicks`             | ticks                |       2 | 1–100           |
| `retries.maximumDelayTicks`             | ticks                |      64 | initial–1,500   |
| `movement.maximumSearchOperations`      | search operations    |   2,000 | 100–10,000      |
| `movement.maximumPathCost`              | path-cost units      |     200 | 10–1,000        |
| `movement.stuckReplanTicks`             | ticks                |       3 | 1–20            |
| `movement.blockedReleaseTicks`          | ticks                |      10 | stuck–100       |
| `spawn.maximumBodyParts`                | body parts           |      50 | 3–50            |
| `spawn.maximumBodyEnergy`               | energy               |   3,000 | 200–12,900      |
| `spawn.maximumNonMovePartsPerMovePart`  | body-part ratio      |       2 | 1–5             |
| `spawn.replacementSafetyMarginTicks`    | ticks                |      50 | 0–300           |
| `spawn.nameCollisionRetryLimit`         | attempts             |       3 | 1–10            |
| `repair.criticalHitsBasisPoints`        | basis points         |   2,500 | 1–5,000         |
| `repair.completionHitsBasisPoints`      | basis points         |   8,000 | critical–10,000 |
| `repair.maximumActiveContractsPerRoom`  | contracts per room   |       2 | 1–16            |
| `repair.maximumEnergyPerTick`           | energy per tick      |     200 | 1–1,000         |
| `tower.emergencyReserveEnergy`          | energy               |     400 | 0–1,000         |
| `tower.repairMinimumEnergy`             | energy               |     800 | reserve–1,000   |
| `safeMode.enabled`                      | boolean              |    true | `false`/`true`  |
| `safeMode.criticalAssetHitsBasisPoints` | basis points         |   2,000 | 1–5,000         |
| `safeMode.lossPredictionHorizonTicks`   | ticks                |      20 | 1–100           |
| `safeMode.minimumHostileOffenseParts`   | offensive body parts |       1 | 1–50            |
| `safeMode.retryDelayTicks`              | ticks                |      10 | 1–100           |

Cross-field validation additionally requires emergency-worker energy not to exceed protected spawn
energy or maximum body energy, lease renewal to precede expiry, maximum retry delay not to precede
initial delay, blocked release not to precede stuck replanning, repair completion not to precede its
critical threshold, and tower repair energy not to consume the emergency reserve.

## Feature-gate DAG

Only `features.disabled` is operationally configurable. Source availability and prerequisites are
not. The list accepts each known gate ID at most once and is binary-sorted canonically; an unknown,
duplicate, or activation field rejects the entire candidate. For every gate `g`:

`effective(g) = available(g) && !disabled(g) && every prerequisite is effective`

Issue #37 made `phase1.colony` available under source v2. Issue #23 added `phase1.contracts` under
source v3. Issue #24 adds only `phase1.spawn` under source v4. Every later gate remains
source-unavailable.

| Gate                          | Availability | Prerequisites                                          |
| ----------------------------- | ------------ | ------------------------------------------------------ |
| `phase1.colony`               | available    | none                                                   |
| `phase1.contracts`            | available    | `phase1.colony`                                        |
| `phase1.spawn`                | available    | `phase1.colony`                                        |
| `phase1.movement`             | unavailable  | none                                                   |
| `phase1.agents`               | unavailable  | `phase1.colony`, `phase1.contracts`, `phase1.movement` |
| `phase1.economy`              | unavailable  | `phase1.agents`, `phase1.spawn`                        |
| `phase1.recovery`             | available    | `phase1.economy`                                       |
| `phase1.growth`               | unavailable  | `phase1.recovery`                                      |
| `phase1.safety`               | unavailable  | `phase1.colony`, `phase1.movement`                     |
| `phase1.telemetry`            | unavailable  | `phase1.agents`, `phase1.spawn`                        |
| `phase1.critical-maintenance` | available    | `phase1.economy`, `phase1.recovery`                    |

Each decision is `enabled`, `source-unavailable`, `operator-disabled`, or `prerequisite-blocked`; a
prerequisite-blocked decision names one deterministic blocker. An operational override can never
activate unavailable work or bypass the DAG.

## Relation ceiling

The observed identity key is the exact `owner.username` string. Configured `self`, `allies`, and
`naps` are checked first and always resolve to `excluded`. A malformed observed identity also
resolves to `excluded`. Configured relation checks do not consult optional reputation.

Optional reputation v1 has the exact shape `{ schemaVersion: 1, relation, assessedAt, expiresAt }`.
Ticks are nonnegative safe integers, `assessedAt <= current tick <= expiresAt`, and the validity
span is at most 1,500 ticks. Missing, malformed, future-version, future-assessed, or expired data is
absent/invalid/stale and resolves a valid unconfigured identity to neutral with the `local-defense`
ceiling. Fresh advisory reputation may reduce that ceiling to `excluded`; Phase 1 never returns
`authorized-operation`.

A targeting ceiling is not action authorization. Later action policy must still prove fresh local
threat evidence and area-effect safety.

## Deterministic proof matrix

| Variant                                       | Required outcome                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Source defaults                               | canonical immutable config and stable source/config/policy revisions             |
| Valid and key-reordered override              | identical canonical policy, gates, relation view, and revisions                  |
| Unknown key or mixed valid/invalid field      | whole candidate rejected; no partially applied value                             |
| Unsafe range or cross-field constraint        | whole candidate rejected                                                         |
| Malformed, duplicate, or overlapping identity | whole candidate rejected; configured exclusions preserved                        |
| Same revision with changed canonical content  | revision reuse rejected; compatible last-valid retained                          |
| Lower candidate revision                      | stale candidate rejected; compatible last-valid retained                         |
| Invalid candidate plus compatible receipt     | receipt revalidated and retained                                                 |
| Source-revision mismatch or bad receipt       | receipt rejected; source defaults used                                           |
| Null candidate plus compatible receipt        | last-valid config/receipt retained byte-equivalently across heap reset           |
| Initial or incompatible null candidate        | source defaults; owner bytes remain unchanged                                    |
| Exact empty owner                             | owner schema initialized without inventing an override                           |
| Malformed or future ready-state owner         | owner preserved; source defaults; malformed/future reason                        |
| Recovery or unsupported root state            | source defaults; `owner-unavailable` status and reason                           |
| Heap/JSON reset                               | byte-equivalent resolved values, decisions, and revisions                        |
| Available colony, contracts, and spawn gates  | enabled by default; each may be disabled; dependents may be prerequisite-blocked |
| Unavailable, disabled, or blocked gate        | cannot bypass source/prerequisites; deterministic reason and blocker             |
| Source-v3 receipt under source v4             | revalidate present candidate or use defaults without opportunistic rewrite       |
| Configured self/ally/NAP                      | `excluded` with absent, stale, malformed, future, or conflicting reputation      |
| Malformed observed username                   | `excluded`; optional reputation not consulted                                    |
| Valid unconfigured username                   | at most `local-defense`; never `authorized-operation`                            |
| Valid v2 root                                 | one bounded v2-to-v3 step adds exact empty config owner                          |
| Interrupted historical v1-to-v2 cursor        | resume, transition to v2-to-v3, finish v3 across resets                          |
| Future root schema                            | no downgrade and no mutation                                                     |

Evidence is provided by focused config, relation, persistent-state migration, runtime context,
telemetry, architecture-boundary, and scenario tests. Colony-gate outcome evidence is maintained in
[`phase1-colony-evidence.md`](phase1-colony-evidence.md), with spawn activation evidence in
[`phase1-spawn-evidence.md`](phase1-spawn-evidence.md). The repository gate remains `npm run check`.

## Screeps mechanics foundation

The design and bounds were constrained by these official or maintained community references:

- [Global Objects](https://docs.screeps.com/global-objects.html) and
  [Screeps Wiki: Global reset](https://wiki.screepspl.us/Global_reset/) for the recreated `Game`
  object and disposable global heap;
- [Memory API](https://docs.screeps.com/api/#Memory) and
  [Screeps Wiki: Memory](https://wiki.screepspl.us/Memory/) for JSON-persisted runtime state;
- [Creep.owner](https://docs.screeps.com/api/#Creep.owner) and
  [OwnedStructure.owner](https://docs.screeps.com/api/#OwnedStructure.owner) for observed
  `owner.username` identity;
- [Room.find](https://docs.screeps.com/api/#Room.find) for the fact that hostile find constants mean
  not owned rather than diplomatically targetable;
- [Creep bodies and spawning](https://docs.screeps.com/creeps.html) and
  [StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep) for initial
  energy and 50-part body constraints;
- [StructureTower](https://docs.screeps.com/api/#StructureTower),
  [StructureController.activateSafeMode](https://docs.screeps.com/api/#StructureController.activateSafeMode),
  and [Defense](https://docs.screeps.com/defense.html) for tower energy and safe-mode mechanics; and
- [Screeps Wiki: Alliances](https://wiki.screepspl.us/Alliances/) for the distinction between
  community alliance data and authoritative in-bot configured exclusions.
