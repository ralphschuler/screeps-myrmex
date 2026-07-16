# Private-server lifecycle

Issue [#142](https://github.com/ralphschuler/screeps-myrmex/issues/142) pins the standalone runtime
to `screeps@4.3.0` in `integration/private-server`. The lifecycle script has no production-token,
password, or live-world option. Its state, database, PID, and launcher log are kept under the
ignored `.myrmex-private-server/` directory.

## Commands

```sh
npm run private-server -- install
npm run private-server -- init
npm run private-server -- start
npm run private-server -- health
npm run private-server -- stop
```

Each command emits one sanitized JSON lifecycle record. Startup uses loopback-only ports, one
runner, and one processor. Health polling and cleanup are bounded. A non-success record fails the
command; later scenario work must treat that as infrastructure failure rather than gameplay
evidence.

The official standalone server documents the console launcher, its separate CLI port, and the
multiple-process runtime. It requires a supported Node release and may require local authentication
setup; MYRMEX does not store that setup, credentials, or server state in the repository. See the
[official standalone server repository](https://github.com/screeps/screeps), the
[Screeps documentation overview](https://docs.screeps.com/), and the
[Screeps Wiki](https://wiki.screepspl.us/).

## Boundaries

This lifecycle establishes only install/start/health/stop controls. World seeding, fault injection,
evidence manifests, bundle deployment, and scenario assertions are deliberately owned by issues
[#143](https://github.com/ralphschuler/screeps-myrmex/issues/143) and
[#144](https://github.com/ralphschuler/screeps-myrmex/issues/144). Runtime production code does not
import these scripts.
