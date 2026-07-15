# MYRMEX Agent Rules

## Mission

Build one autonomous Screeps bot that survives, compounds economic advantage, maintains credible
deterrence, and expands profitably. Optimize gameplay outcomes, not repository activity.

## Clean-Room Boundary

- Do not copy source, tests, schemas, workflows, or generated files from `ralphschuler/screeps`.
- Legacy behavior may be rewritten only from game mechanics, observed outcomes, or a new acceptance
  scenario.
- Do not add compatibility layers for the legacy architecture.

## Architecture

- `packages/bot` is the only deployable package.
- `packages/scenario-kit` is development-only and must never be imported by runtime code.
- Prefer internal modules over new packages. A new workspace requires an ADR.
- There is exactly one owner for persistent memory, scheduling, room observation, movement requests,
  spawn demand, diplomacy, and operation authorization.
- Runtime systems emit typed intents; only executors issue Screeps API commands.
- Optional planners must degrade safely when their CPU budget is exhausted.

## Quality Gate

Before committing, run:

```bash
npm run check
```

New gameplay behavior requires a test that asserts an outcome. Placeholder assertions, skipped tests
without a linked issue, and tests that only prove imports are forbidden.

## Documentation

- Update `docs/` in the same change as architecture or strategy behavior.
- Update `wiki/` only when reader-facing guidance changes; CI mirrors it to the GitHub Wiki.
- Record decisions that introduce a new authority, dependency, package, or persistent schema in
  `docs/adr/`.
