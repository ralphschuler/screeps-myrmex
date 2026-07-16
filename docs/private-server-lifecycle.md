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
runner, and one processor. Health polling and cleanup are bounded. A non-success record fails the
command; later scenario work must treat that as infrastructure failure rather than gameplay
evidence.

`provision` is the clean-checkout path for a headless local server. It requires
`SCREEPS_STEAM_API_KEY` only in the invoking environment, supplies it to the upstream initializer on
stdin, then removes the generated `steam_api_key` line from the ignored state configuration. Startup
accepts that same runtime-only environment variable when Steam-native authentication is unavailable;
the value is never included in MYRMEX lifecycle records or evidence artifacts. Without either
runtime provisioning method, `provision` returns `provisioning-required` and the scenario gate must
record `startup-failed` rather than gameplay evidence.

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
work, not upload behavior. `npm run private-server:deploy` builds before attempting that upload and
fails closed until a provisioned local server has created the controlled fixture account.

World seeding, deterministic hostile/reset fixtures, and scenario assertions remain ordered under
issues #149 and #150 (parent [#144](https://github.com/ralphschuler/screeps-myrmex/issues/144)).
Runtime production code does not import these scripts.
