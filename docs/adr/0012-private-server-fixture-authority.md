# ADR 0012: Private-server fixture authority

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

The private-server integration gate needs a real hostile in the controlled MYRMEX room and a bounded
heap-loss event. The stock standalone server's authenticated hostile endpoint requires a player
token, while its administrator CLI evaluates arbitrary JavaScript. Neither is an acceptable fixture
authority.

## Decision

The test harness loads one committed fixture module through the standalone server's documented
`mods.json` mechanism. It is loaded only from ignored server state and is not imported by the bot.
The lifecycle accepts a safe scenario id rather than a fixture path and derives the only definition
location under the selected state root. The expected id reaches processor and runner independently
of the file, so a definition cannot select another scenario identity. The module accepts one strict,
4 KiB JSON definition with a fixed room, controlled user, coordinates, ticks, and the canonical
`smallMelee` invader body. It exposes no CLI command, HTTP route, credential, arbitrary path,
arbitrary JavaScript, or database query. Fixture state operations resolve the real checkout and
reject every existing symbolic-link component between it and the fixed generated targets before
recursive preparation, publication, or cleanup. Lifecycle start repeats that path check and accepts
only an exact single-entry `mods.json` mapping to the canonical committed module immediately before
spawn; direct lifecycle invocation cannot substitute another module.

The same strict definition can name one bounded runner tick for a fixture-side bot exception. The
fixture writes a fixed `injected` receipt before throwing; the scenario runner samples only that
receipt and classifies the terminal result. It does not read exception text, console output, Memory,
or raw runner state, and it does not alter the deployed bot bundle.

The generated `mods.json` exists before the first server start, while the derived definition path is
deliberately absent. Processor and runner register a non-persistent watch on that fixed path after
their storage connection initializes, but remain inert during bootstrap. Once the controlled actor
is available, the scenario runner establishes an acknowledged idle pause boundary, clears and
verifies all fixed receipts for the expected safe scenario id, and atomically renames the complete
definition into place. There is no post-bootstrap server restart and therefore no dependency on the
pinned Loki store persisting recent bootstrap writes before the scenario can continue.

`system.pauseSimulation()` alone is not the barrier because a main-loop pass that already started
may still have processor or runner work in flight. The runner writes a bounded sequenced pause
request, and the fixed mod in the main process acknowledges it only after observing the pinned
paused flag and an idle `mainLoopStage` pass from start directly to finish. The runner waits at most
30 seconds for that acknowledgement before each reset, fixture publication, and fixture cleanup
transition. Since `system.resetAllData()` restores `mainLoopPaused=0`, the runner immediately
requests and verifies a new pause boundary after reset and before controlled-bot bootstrap or bundle
deployment.

Each processor and runner independently validates the first complete file it observes. A missing
file remains pending. A valid, identity-matching definition is latched for that process run; any
malformed, oversized, mismatched, or unsupported definition is permanently rejected and a later
replacement cannot revive it. Each process writes one separate fixed readiness receipt. The runner
samples only aggregate `ready`, `rejected`, or `absent` states and resumes simulation only after
both processes report `ready` within the 30-second bound.

At the pinned `screeps@4.3.0` / `@screeps/driver@5.3.0` boundary, the module uses `processRoom` and
the engine bulk writer to schedule a user `"2"` invader. The normal engine invader processor
supplies its movement and attacks on the following tick. A bounded heap reset publishes the pinned
`RUNTIME_RESTART` key once; the runner's existing driver subscriber clears user VMs. Processor
scheduling and runner observation communicate only through separate fixed namespaced server-env
receipts, never module-local state. Receipt bodies and transient definition identities are not
admitted to evidence.

Cleanup first waits for a fresh idle paused main-loop acknowledgement. It then removes the generated
fixture publication (`definition.json`, its pending file, and `mods.json`) before deleting and
verifying exactly seven namespaced keys: `pause-request`, `quiescent-main`, `ready-processor`,
`ready-runner`, `hostile`, `reset`, and `bot-exception`. The scenario runner attempts the bounded
process-group stop even if publication or receipt cleanup fails. A subsequent scenario recreates the
module mapping without a definition and uses a new server run; incomplete acknowledgement,
symlink-safe file cleanup, receipt cleanup, or process cleanup is terminal evidence failure.

## Consequences

- Hostile pressure is real game capability in the controlled room, not an unrelated bot.
- Reset proof is bounded restoration (`T+2`), not a claim of same-tick or byte-identical engine
  timing.
- Bot-exception proof establishes the evidence plumbing and runner fault boundary; it is not a claim
  that MYRMEX production behavior itself throws.
- Controlled-bot bootstrap and fixture publication share one server run; storage autosave timing is
  not part of the fixture contract.
- Paused state is not quiescence; each destructive or publication transition requires a fresh,
  bounded acknowledgement from the idle main-loop boundary.
- Generated publication is removed before receipt clearance, and symbolic-link components fail
  closed rather than being traversed.
- Rejected definitions require a new process run. In-place correction is deliberately unsupported.
- This is an intentionally version-pinned extension contract. Any runtime dependency update must
  rerun the private-server hostile and heap-reset smoke tests before the integration gate can pass.
- A future official public fixture API replaces this module. Raw CLI database writes and forged
  player authentication remain prohibited.
