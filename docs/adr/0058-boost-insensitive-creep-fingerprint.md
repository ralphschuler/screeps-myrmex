# ADR 0058: Boost-insensitive creep identity fingerprint

## Status

Accepted

## Context

ADR 0024 requires a scheduled boost to settle only when the next exact observation corroborates the
body-part, mineral, and energy deltas. The composed lab runtime also binds an explicit boost
manifest, its command intent, and its pending attempt to one creep fingerprint.

That fingerprint included current boost groups. A successful `StructureLab.boostCreep` necessarily
changes those body annotations, so the next observation was rejected as `fingerprint-changed` before
the exact 30-mineral, 20-energy, and target-part deltas could settle. Isolated settlement tests used
a synthetic unchanged fingerprint and did not reproduce the composed failure.

## Decision

- The lab creep fingerprint identifies immutable actor shape only: creep ID, creep name, and the
  total count of each canonical body-part type. Current boost annotations are effect evidence and
  are excluded. Position, lifetime, hits, active-part state, fatigue, and store state remain
  excluded as before.
- Snapshot composition and the live executor adapter use the same canonical type order and hash.
  Existing unboosted fingerprints remain byte-identical because they previously had no boost rows.
- Before `boostCreep`, the sole `LabExecutor` still revalidates that fingerprint, exact lab stock,
  range, requested unboosted target parts, and the pre-command count of parts carrying the requested
  compound.
- On the next exact observation, settlement still requires a positive bounded increase in that
  target boost group plus exactly 30 mineral and 20 energy consumed per settled part. A stable
  identity fingerprint alone never proves success.
- Missing creeps, changed ID/name/body shape, missing or inactive labs, no effect, conflicting
  deltas, late observation, and retry exhaustion keep their existing bounded fail-closed outcomes.
- The checked Phase 2 lab evidence advances to schema 2 and includes one composed boost intent,
  exact settlement/accounting, and reset/reordered equivalence.
- No persistent field, owner schema, authority, manifest producer, queue, dependency, or telemetry
  cardinality is added.

## Consequences

An expected body annotation no longer masquerades as actor replacement, so composed boosts can
produce exact next-observation receipts and accounting. Immutable actor/body drift still prevents a
command or settlement, while the resource and target-part deltas remain the stronger effect proof.

An in-flight attempt created from an unboosted creep remains compatible because its fingerprint
bytes do not change. An older attempt or manifest that included pre-existing boost rows fails closed
after upgrade; rollback similarly may cancel a new boost-insensitive manifest for a creep that
already has boosts. Neither direction can claim an unobserved effect. Rollback requires only
reverting code and the checked evidence; `IndustryOwnerV5` remains valid.

This fixes issue #339 only. Autonomous boost-manifest production and issue #99's obsolete-lab boost
handoff remain separate work.

## Mechanics sources

Reviewed 2026-07-21:

- Official [`StructureLab.boostCreep`](https://docs.screeps.com/api/#StructureLab.boostCreep): the
  creep must be adjacent; each boosted part costs 30 mineral and 20 energy; the optional count fixes
  how many eligible parts are targeted; `OK` schedules the action.
- Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab): labs have separate 3,000
  mineral and 2,000 energy capacities.
- Official [creep boosts](https://docs.screeps.com/resources.html#Creep-boosts): applied compounds
  are represented on individual body parts, and one part accepts only one boost.
- Screeps Wiki [`StructureLab`](https://wiki.screepspl.us/StructureLab/) supplies established boost,
  refill, and cooldown terminology. Official API contracts govern command and settlement behavior.
