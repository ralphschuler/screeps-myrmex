# Development

## Requirements

- Node.js 24
- npm 11
- a Screeps account only when deploying a built bundle

## Commands

| Command                        | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `npm ci`                       | install the locked dependency graph               |
| `npm run check`                | run every required repository gate                |
| `npm run test:watch`           | run focused tests during development              |
| `npm run format`               | apply repository formatting                       |
| `npm run build`                | create `dist/main.js`                             |
| `npm run package:bot -- 0.1.0` | stage a GitHub Packages payload in `dist/package` |
| `npm run clean`                | remove generated output                           |

## Automation

| Workflow                 | Trigger                              | Authority                                            |
| ------------------------ | ------------------------------------ | ---------------------------------------------------- |
| `CI`                     | push, pull request, manual           | validates and uploads the bundle artifact            |
| `CodeQL`                 | push, pull request, schedule, manual | security analysis                                    |
| `Publish GitHub Package` | published release or manual          | publishes the bot bundle to GitHub Packages          |
| `Deploy to Screeps`      | manual on `main`                     | uploads and verifies one Screeps code branch         |
| `Auto Respawn`           | every 15 minutes or manual           | detects terminal account loss and places a new spawn |
| `Sync Wiki`              | changes under `wiki/` or manual      | mirrors versioned Wiki pages                         |

Publishing uses the workflow repository's `GITHUB_TOKEN` with `packages: write`. No long-lived
GitHub package credential is required. A published release tag such as `v0.1.0` becomes package
version `0.1.0`; a manual run requires an explicit SemVer. The generated distribution package is
`@ralphschuler/screeps-myrmex`. It contains the single CommonJS `main.js` bundle and is separate
from the private internal workspace name `@myrmex/bot`.

## Screeps production environment

Create a GitHub environment named `screeps-production`. Deployment is manual, while scheduled
respawn must remain unattended if enabled. Configure environment protections accordingly; a required
reviewer will pause scheduled respawn runs.

Add these environment secrets:

| Secret                    | Required | Meaning                                                     |
| ------------------------- | -------- | ----------------------------------------------------------- |
| `SCREEPS_TOKEN`           | yes      | dedicated Screeps auth token; never use an account password |
| `SCREEPS_RESPAWN_TARGETS` | no       | private JSON fallback spawn targets                         |

The fallback target format is:

```json
[{ "room": "ROOM_NAME", "x": 20, "y": 20, "shard": "SHARD_NAME" }]
```

Room names and coordinates are operational intelligence, so keep this value in a secret rather than
a repository variable. Every configured target must name its shard. The respawner discovers the
currently available shards itself, counts owned rooms across all of them, and requests a start room
on every shard. It ranks valid rooms by spawn-site quality and uses shard name and room name as
stable tie-breakers. No target coordinate is printed to the public workflow log.

Add these environment variables:

| Variable                        | Required         | Default                   | Meaning                                                                  |
| ------------------------------- | ---------------- | ------------------------- | ------------------------------------------------------------------------ |
| `SCREEPS_AUTO_RESPAWN_ENABLED`  | yes for mutation | `false`                   | must equal `true` before scheduled recovery can mutate the account       |
| `SCREEPS_RESPAWN_ON_ZERO_ROOMS` | no               | `false`                   | also recover when status is `normal` but the rooms endpoint reports zero |
| `SCREEPS_RESPAWN_NAME`          | no               | `Myrmex`                  | non-secret prefix for the generated spawn name                           |
| `SCREEPS_API_BASE_URL`          | no               | `https://screeps.com/api` | API base for MMO or an explicitly supported server                       |

Use a dedicated Screeps token scoped, where supported, to only the endpoints required by the two
workflows:

- deployment: `GET` and `POST /api/user/code`;
- shard discovery: `GET /api/game/shards/info`;
- health: `GET /api/user/world-status` and `GET /api/user/rooms` on every discovered shard;
- respawn transition: `POST /api/user/respawn`;
- target selection: `GET /api/user/respawn-prohibited-rooms`, `GET /api/user/world-start-room`,
  `GET /api/game/room-terrain`, and `GET /api/game/room-objects`;
- placement: `POST /api/game/place-spawn`.

Screeps officially documents auth tokens and code upload, but describes the wider Web API as
undocumented. The recovery script therefore validates every response, recognizes only known world
states, verifies successful spawn placement, and fails closed on malformed or changed responses.

Foundation references:

- [Screeps authentication tokens](https://docs.screeps.com/auth-tokens.html);
- [committing scripts through the Screeps API](https://docs.screeps.com/commit.html);
- [Screeps respawning behavior](https://docs.screeps.com/respawn.html);
- [Screeps Wiki code-pushing guidance](https://wiki.screepspl.us/Pushing_code_to_Screeps/);
- [GitHub Packages npm registry](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

### Deployment procedure

1. Create the target code branch in Screeps; the upload API does not guarantee branch creation.
2. Add `SCREEPS_TOKEN` to `screeps-production`.
3. Run `Deploy to Screeps` from `main` and enter the target Screeps branch, normally `default` only
   after canary approval.
4. The workflow performs a locked install and full repository gate.
5. It rebuilds with `MYRMEX_BUILD_SHA` embedded in the bundle banner.
6. It uploads `dist/main.js`, downloads the same branch, and requires an exact content match.

The workflow never changes the active Screeps branch. Rollback is a deployment of a previously
validated commit to the same branch or activation of a separately maintained last-known-good branch.

### Auto-respawn procedure

1. Configure `SCREEPS_TOKEN`; shard discovery is automatic.
2. Keep `SCREEPS_AUTO_RESPAWN_ENABLED=false` and run `Auto Respawn` manually with dry-run enabled.
3. Optionally configure private fallback targets.
4. Set `SCREEPS_RESPAWN_ON_ZERO_ROOMS=true` only when a normal account state with zero reported
   rooms should be treated as terminal loss.
5. Set `SCREEPS_AUTO_RESPAWN_ENABLED=true` to authorize scheduled mutation.

Healthy accounts are read-only. A `lost` account, or an explicitly authorized zero-room account, is
moved through respawn and polled until it becomes `empty`. An `empty` account skips the destructive
respawn call and proceeds directly to placement. After `place-spawn`, the action requires
`world-status=normal`. Unknown states, malformed shard or room data, exhausted targets, or changed
API responses fail without additional account mutation.

Auto-respawn is disaster recovery, not expansion strategy. Once the initial spawn exists, the
runtime's cold-boot and colony systems own all further decisions.

## Scenario Rules

A scenario has a stable id, deterministic initial world, bounded tick count, and outcome assertions.
Good scenarios include cold boot, zero-creep recovery, miner death, route blockage, hostile arrival,
nuke impact, lost spawn, failed claim, and portal arrival.

Do not assert implementation trivia such as a class name or event emission when the real requirement
is delivered energy, survival, replacement, or retreat.

## Wiki

Edit Markdown in `wiki/`. The Wiki workflow mirrors those files to the repository Wiki after a
successful `main` update. `_Sidebar.md` controls Wiki navigation.
