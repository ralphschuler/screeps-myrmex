# Private-server lifecycle

Issue [#142](https://github.com/ralphschuler/screeps-myrmex/issues/142) pins the standalone runtime
to `screeps@4.3.0` in `integration/private-server`. The lifecycle script has no production-token,
password, or live-world option. Its state, database, PID, and launcher log are kept under the
ignored `.myrmex-private-server/` directory.

Repository installation and the production bundle build use the repository's Node 24 toolchain. The
pinned standalone server is isolated on Node 22: the workflow selects exactly Node 22.22.1, and the
lifecycle rejects runtime execution outside Node 22.9 or newer on that major line. This keeps the
deployable build contract separate from the older standalone runtime's supported process
environment.

## Commands

```sh
# Node 24: install repository tools and build the exact deployable bundle.
npm ci
npm run build

# Node 22.22.1: install and operate the isolated standalone runtime.
node scripts/private-server.mjs install
node scripts/private-server.mjs init
node scripts/private-server.mjs provision
node scripts/private-server.mjs start
node scripts/private-server.mjs health
node scripts/private-server.mjs stop
```

Each command emits one sanitized JSON lifecycle record. Startup uses loopback-only ports, one
runner, and one processor. A successful `start` exits successfully. Health polling and cleanup are
bounded. Stop retains the launcher PID until the detached process group exits; a five-second timeout
returns the fixed `shutdown-timeout` cleanup reason and prevents a competing restart. A non-success
record fails the command; later scenario work must treat that as infrastructure failure rather than
gameplay evidence.

Health is active rather than a game-port-only check. Each bounded attempt proves, in order, that the
launcher process group is alive, the loopback game port accepts a connection, the loopback CLI port
accepts a connection, and the CLI can sequentially read game time and count users through the pinned
environment and database adapters. No scenario definition write, reset, pause, account creation, or
bundle upload begins before that read-only receipt succeeds. Lifecycle creates the fixed `mods.json`
mapping required to launch the inert fixture module only after a non-mutating path check and after
proving there is no unverified live PID. An existing PID receives one bounded probe so a dead
process-group PID can be discarded, but a live PID is never reused or automatically stopped without
process-identity evidence. It fails closed as `existing-process-unverified` without sending it a
signal. This prevents PID reuse from terminating an unrelated local process and keeps scenario
environment identity immutable. The 32 fresh-start attempts, 500-millisecond interval,
250-millisecond TCP probes, 500-millisecond CLI exchange, and bounded five-second cleanup keep a
conservative existing-PID probe followed by a failed fresh start within the declared 60-second I/O
timeout budget.

When a launcher cannot become healthy, the record may include only one fixed reason code:
`asset-directory-unavailable`, `configuration-file-unavailable`, `required-launch-option-missing`,
`steam-authentication`, `port-unavailable`, `launcher-exited`, `health-timeout`,
`existing-process-unverified`, `game-port-unavailable`, `cli-port-unavailable`,
`cli-connection-failed`, `cli-timeout`, `cli-closed`, `storage-not-ready`,
`storage-readiness-rejected`, `readiness-receipt-invalid`, or `unsupported-node-runtime`. It never
includes launcher text, command arguments, credentials, or state.

If a newly spawned launcher fails active readiness, `start` attempts the bounded process-group stop
before returning. A successful stop preserves the specific readiness failure; a failed stop returns
`cleanup-failed` with the fixed teardown reason instead of masking the live process behind a startup
code. The scenario runner carries that record into incomplete-cleanup evidence and does not signal
an unverified pre-existing PID during its terminal path.

`provision` is the clean-checkout path for a headless local server. It requires
`SCREEPS_STEAM_API_KEY` only in the invoking environment, supplies it to the upstream initializer on
stdin, then removes the generated `steam_api_key` line from the ignored state configuration. Startup
accepts that same runtime-only environment variable when Steam-native authentication is unavailable;
the MYRMEX wrapper removes it from every direct child environment and passes it only through the
upstream launcher's required authentication argument. The pinned launcher then supplies a separate
`STEAM_KEY` variable only to its backend authentication process; storage and engine processes do not
receive it. Issue [#191](https://github.com/ralphschuler/screeps-myrmex/issues/191) owns further
containment of that upstream-required handoff. The GitHub workflow runs the pinned install and its
postinstall scripts in a separate credential-free step. Installation invokes the npm CLI belonging
to the validated Node executable rather than resolving another Node installation through `PATH`. The
value is never included in MYRMEX lifecycle records or evidence artifacts. Without either runtime
provisioning method, `provision` returns `provisioning-required` and the scenario gate must record
`startup-failed` rather than gameplay evidence.

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
