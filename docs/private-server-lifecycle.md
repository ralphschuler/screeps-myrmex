# Private-server lifecycle

Issue [#142](https://github.com/ralphschuler/screeps-myrmex/issues/142) pins the standalone runtime
to `screeps@4.3.0` in `integration/private-server`. The lifecycle script has no production-token,
password, or live-world option. Its state, database, PID, and launcher log are kept under the
ignored `.myrmex-private-server/` directory.

## Commands

```sh
npm run private-server -- install
npm run private-server -- init
npm run private-server -- provision
npm run private-server -- start
npm run private-server -- health
npm run private-server -- stop
```

Each command emits one sanitized JSON lifecycle record. Startup uses loopback-only ports, one
runner, and one processor. Health polling and cleanup are bounded. Stop retains the launcher PID
until the detached process group exits; a five-second timeout returns the fixed `shutdown-timeout`
cleanup reason and prevents a competing restart. A non-success record fails the command; later
scenario work must treat that as infrastructure failure rather than gameplay evidence.

When a launcher cannot become healthy, the record may include only one fixed reason code:
`asset-directory-unavailable`, `configuration-file-unavailable`, `required-launch-option-missing`,
`steam-authentication`, `port-unavailable`, `launcher-exited`, or `health-timeout`. It never
includes launcher text, command arguments, credentials, or state.

`provision` is the clean-checkout path for a headless local server. It requires
`SCREEPS_STEAM_API_KEY` only in the invoking environment, supplies it to the upstream initializer on
stdin, then removes the generated `steam_api_key` line from the ignored state configuration. Startup
accepts that same runtime-only environment variable when Steam-native authentication is unavailable;
the value is never included in MYRMEX lifecycle records or evidence artifacts. Without either
runtime provisioning method, `provision` returns `provisioning-required` and the scenario gate must
record `startup-failed` rather than gameplay evidence.

The scenario runner may add `--fixture-scenario <safe-scenario-id>` to `start`. The lifecycle
derives the only permitted definition path, `<state-directory>/fixtures/definition.json`, instead of
accepting a caller-supplied path. The safe scenario id is also passed separately to the engine
processes so a definition with another identity is rejected. A generated `mods.json` names only the
committed `myrmex-fixture.cjs` module, and both files remain under the selected ignored state
directory. Immediately before launcher spawn, lifecycle start validates that `mods.json` has exactly
that one canonical module entry. Before preparation, validation, publication, or recursive removal,
every existing component from the real checkout through those fixed generated paths is inspected
without following it. Any symbolic link component or altered module mapping fails with the fixed
`fixture-module-state-invalid` startup reason, so direct lifecycle invocation cannot traverse or
load code outside the selected checkout.

The module configuration exists before the first server start, but the definition does not. The
processor and runner therefore start inert, wait on that one derived path, and can acknowledge a
later post-bootstrap definition while simulation remains paused. The runner publishes the complete
bounded JSON with an atomic rename and does not restart the server between controlled-bot bootstrap
and scenario execution. This avoids treating the pinned storage engine's persistence timing as a
bootstrap guarantee.

`system.pauseSimulation()` changes the simulation flag but is not itself a quiescence barrier: work
from an already-started main-loop pass may still be in flight. For every reset, fixture publication,
and fixture cleanup transition, the runner serially removes and verifies the previous pause keys,
invokes the fixed pause command, and verifies the paused flag while publishing the next bounded,
sequenced request. Each step is acknowledged separately and same-store mutations do not overlap. The
runner then waits for the fixed fixture mod in the main process to acknowledge a paused, idle
`mainLoopStage` boundary. The acknowledgement is valid only when the pinned paused flag is set and
the observed main-loop pass went directly from start to finish without work. `system.resetAllData()`
restores `mainLoopPaused=0`, so the runner establishes a fresh acknowledged pause boundary
immediately after reset and before controlled-bot bootstrap or deployment.

The official standalone server documents the console launcher, its separate CLI port, and the
multiple-process runtime. It requires a supported Node release and may require local authentication
setup; MYRMEX does not store that setup, credentials, or server state in the repository. See the
[official standalone server repository](https://github.com/screeps/screeps), the
[Screeps documentation overview](https://docs.screeps.com/), and the
[Screeps Wiki](https://wiki.screepspl.us/).

## Boundaries

This lifecycle establishes only install/start/health/stop controls. The sanitized evidence manifest
and artifact contract is documented in [private-server-evidence.md](private-server-evidence.md).
`npm run private-server:bundle` builds and emits the byte size plus SHA-256 identity for the exact
deployable `dist/main.js`, without emitting its source. The bounded loopback CLI adapter is owned by
issue #148: it maps a fixed operation vocabulary to the pinned server's administrator CLI and
returns only opaque response metadata. It never accepts a caller-supplied expression, remote host,
credential, or raw CLI transcript. Its only upload path serializes the locally built bundle as data
into the pre-defined `myrmex-integration` test account, invalidates the pinned backend's script
cache, and publishes its source hash. Account creation and deterministic world setup are fixture
work, not upload behavior. Controlled-bot bootstrap selects an unowned controller from the pinned
world instead of assuming a particular room is available. `npm run private-server:deploy` builds
before attempting that upload and fails closed until a provisioned local server has created the
controlled fixture account. Controlled-bot sampling retries only the bounded not-ready receipt until
its scenario deadline. Fixture publication is a separate paused handshake: both engine processes
must acknowledge the expected definition before resume, and a rejection or bounded readiness timeout
is reported through a fixed failure code.

Terminal cleanup uses the same bounded main-loop barrier. Once the idle paused boundary is
acknowledged, it first removes the generated fixture publication (`definition.json`, its pending
file, and `mods.json`), then deletes and verifies exactly seven namespaced request, acknowledgement,
readiness, and action receipts. The process-group stop is still attempted when either cleanup phase
fails.

World seeding, deterministic hostile/reset fixtures, and scenario assertions remain ordered under
issues #149 and #150 (parent [#144](https://github.com/ralphschuler/screeps-myrmex/issues/144)).
Runtime production code does not import these scripts.
