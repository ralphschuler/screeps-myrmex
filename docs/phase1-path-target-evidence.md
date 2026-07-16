# Phase 1 path and target recovery evidence

Issue [#30](https://github.com/ralphschuler/screeps-myrmex/issues/30) now has one bounded,
deterministic replay in `packages/scenario-kit/test/phase1-path-target-recovery.test.ts`.

The replay covers three fixed ticks at a CPU budget of 3: a stale lease target suspends with
`target-missing` and no command; a valid target with an unavailable local route suspends with
`path-unavailable` and records one replan; after a heap reset, the same target and valid local route
are recovered, the arbiter admits one move, and the executor issues exactly one `Creep.move(3)`
command.

The scenario runs warm, with heap reconstruction, and with reordered lease input. Outcome hashes,
world transitions, no-command outcomes, suspension reasons, and the single recovery command are
equivalent across all runs. CPU use is fixed at 2 of 3 modeled units per tick. The path service is
data-only and deterministic; dynamic contention remains with `MovementArbiter`, and command
authority remains with `MovementExecutor`. This slice does not claim a separate dynamic contention
row.

Mechanics references: [Creep.move](https://docs.screeps.com/api/#Creep.move),
[PathFinder](https://docs.screeps.com/api/#PathFinder), [Creep API](https://docs.screeps.com/api/),
and [simultaneous actions](https://docs.screeps.com/simultaneous-actions.html).

## Production runtime composition

The aggregate gate composes the stale resolver and incomplete local-path adapter through production
`runTick` while measuring the same persistent Memory, telemetry, controller, and replacement
lifecycle used by the other recovery faults. Its warm, heap-reset, and source-reordered outcomes are
equivalent.
