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

## Runtime configuration overrides

`Memory.myrmex.config` is a versioned operational control surface, not a planner-owned settings bag.
The runtime owns schema interpretation and `lastValid`; operators own only `candidate`. Planners
never read this Memory subtree directly.

After a new schema-v3 root or migration, allow one tick for exact `{}` to become the owner-local
schema. Then set only `Memory.myrmex.config.candidate`. A copy-accurate example is:

```js
Memory.myrmex.config.candidate = {
  revision: 12,
  overrides: {
    policy: {
      recovery: { protectedSpawnEnergy: 400 },
      safeMode: { enabled: true },
    },
    relations: {
      self: ["MyUser"],
      allies: ["AllyA"],
      naps: ["NapA"],
    },
    features: { disabled: ["phase1.growth"] },
  },
};
```

Follow this procedure:

1. Inspect the current candidate and bot-owned `lastValid`; keep a private copy outside repository
   logs.
2. Build one complete desired override. Omitted fields return to source defaults; a candidate does
   not merge with the previously accepted override.
3. Use a nonnegative safe-integer revision. Increase it whenever the canonical override changes.
   Reusing an accepted revision with different content is rejected, and lower revisions are stale.
4. Assign `candidate` once. Do not edit `schemaVersion` or `lastValid`, and do not expose
   operational identities or values in logs, issues, telemetry, or committed files.
5. Confirm the bounded config status/reason and the new config/policy revisions before depending on
   the policy. Unknown keys, invalid values, and malformed or overlapping identities reject the
   whole candidate; no field applies partially.
6. Roll back by publishing the previous override—or `overrides: {}` for source defaults—under a
   newer revision. Do not restore an old revision number.

Setting `candidate: null` is not rollback. It means no new proposal and keeps a compatible
`lastValid` policy plus its revision high-water active. Only a null candidate without compatible
evidence uses source defaults.

Operational feature overrides can only disable known source-available gates. They cannot enable a
gate, change prerequisites, or bypass an incomplete roadmap outcome. Exact identity matching is
case-sensitive; self, ally, and NAP arrays must contain distinct canonical names with no overlap.

If the owner itself is malformed or from a future owner schema, the runtime preserves it and uses
source defaults. Diagnose and save the value privately before an explicit operator reset to exact
`{}`; the bot will not silently downgrade or repair non-empty owner data.

The complete defaults, bounds, validation budgets, gate DAG, failure matrix, and mechanics sources
are in [`phase1-config-evidence.md`](phase1-config-evidence.md).

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
currently available shards itself, validates account-wide ownership, and requests start-area anchors
on every shard. It inspects each anchor plus a bounded three-room radius, validates neutral
two-source rooms, and ranks safe spawn tiles deterministically. The prohibited-room response uses
`shard/room` identifiers; candidates are matched against that qualified key so identical room names
on different shards remain distinct. A shard that already has CPU is preferred when room scores are
otherwise available, avoiding an unnecessary shard-limit change. No target coordinate is printed to
the public workflow log.

Add these environment variables:

| Variable                       | Required         | Default                   | Meaning                                                               |
| ------------------------------ | ---------------- | ------------------------- | --------------------------------------------------------------------- |
| `SCREEPS_AUTO_RESPAWN_ENABLED` | yes for mutation | `false`                   | must equal `true` before scheduled recovery can mutate the account    |
| `SCREEPS_AUTO_ALLOCATE_CPU`    | no               | `true`                    | allocate CPU to a newly selected shard and verify the resulting limit |
| `SCREEPS_RESPAWN_NAME`         | no               | `Myrmex`                  | non-secret prefix for the generated spawn name                        |
| `SCREEPS_API_BASE_URL`         | no               | `https://screeps.com/api` | API base for MMO or an explicitly supported server                    |

Use a dedicated Screeps token scoped, where supported, to only the endpoints required by the two
workflows:

- deployment: `GET` and `POST /api/user/code`;
- shard discovery: `GET /api/game/shards/info`;
- health: `GET /api/user/world-status` and one aggregate `GET /api/user/rooms`;
- respawn transition: `POST /api/user/respawn`;
- target selection: `GET /api/user/respawn-prohibited-rooms`, `GET /api/user/world-start-room`,
  `GET /api/game/room-terrain`, and `GET /api/game/room-objects`;
- placement: `POST /api/game/place-spawn`.
- CPU selection and repair: `GET /api/auth/me` and `POST /api/user/console`.

Screeps officially documents auth tokens and code upload, but describes the wider Web API as
undocumented. The recovery script therefore validates critical responses, recognizes only known
world states, verifies successful spawn placement, and fails closed on malformed state or ownership
data. The prohibited-room endpoint is advisory: malformed or unavailable data is retried three
times, then candidate placement relies on the authoritative server-side validation performed by
`place-spawn` rather than leaving an already reset account permanently empty.

Foundation references:

- [Screeps authentication tokens](https://docs.screeps.com/auth-tokens.html);
- [committing scripts through the Screeps API](https://docs.screeps.com/commit.html);
- [Screeps respawning behavior](https://docs.screeps.com/respawn.html);
- [Screeps shard CPU allocation](https://docs.screeps.com/api/#Game.cpu.setShardLimits);
- [Screeps Wiki code-pushing guidance](https://wiki.screepspl.us/Pushing_code_to_Screeps/);
- [Screeps backend initial-spawn validation](https://github.com/screeps/backend-local/blob/9d079282303ec04e577ac2bb97f64312b25e4ccd/lib/game/api/game.js#L328-L375),
  used as maintained primary evidence for sanitized placement rejection classes;
- [TooAngel respawner reference](https://github.com/TooAngel/screeps/blob/master/utils/respawner.js),
  used as comparative operational evidence rather than copied implementation;
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
4. Leave `SCREEPS_AUTO_ALLOCATE_CPU=true` unless CPU is managed by separate trusted automation.
5. Set `SCREEPS_AUTO_RESPAWN_ENABLED=true` to authorize scheduled mutation.

The scheduled workflow always wakes up to perform a read-only health check. `world-status=normal` is
authoritative evidence of a valid spawn in a controlled room, so the script returns `healthy` even
if the aggregate room list is temporarily stale or empty. It never lets room-count disagreement
override `normal`.

A `lost` account has game objects but no valid spawn and is moved through respawn even if it still
owns a controller. Immediately before `POST /user/respawn`, the script re-reads world status and
returns without mutation if a valid spawn appeared. If that run completes the transition from `lost`
to `empty` after its own accepted `POST /user/respawn`, it may continue to placement. Otherwise a
manual workflow dispatch is required, including when a preflight reread changes from `lost` to
`empty`; a schedule stops with `manual-empty-placement-required` before target discovery. This
prevents an all-candidate failure from being replayed unchanged by the next schedule. After an
accepted respawn, the workflow waits 185 seconds, covering the documented 180-second timeout plus a
five-second buffer, and re-reads account state before discovery. If placement still reports the
global cooldown, it waits 185 seconds and retries the same candidate once without consuming the
remaining candidates. After `place-spawn`, the action requires `world-status=normal`.

When CPU allocation is enabled, candidates on an already funded shard are preferred. After
placement, the workflow uses `Game.cpu.setShardLimits` through the console endpoint and polls
`auth/me` until the selected shard has CPU. Screeps limits shard-allocation changes to once per 12
hours, so a recently respawned healthy account with exactly one owned shard and zero CPU is eligible
for bounded repair on later scheduled runs. Older or multi-shard healthy accounts are never
rebalanced by this workflow. Unknown states, inconsistent ownership, malformed API data, exhausted
targets, or changed critical responses fail closed. Advisory prohibited-room failures cannot bypass
Screeps placement rules and are logged without room or coordinate data.

Auto-respawn is disaster recovery, not expansion strategy. Once the initial spawn exists, the
runtime's cold-boot and colony systems own all further decisions.

### 2026-07-15 recovery incident and re-enable evidence

Scheduled run [29418973234](https://github.com/ralphschuler/screeps-myrmex/actions/runs/29418973234)
completed the destructive respawn transition but attempted placement before the global cooldown was
known to be clear; all candidates were rejected and no target data was logged. Mutation was rolled
back, and read-only run
[29419237571](https://github.com/ralphschuler/screeps-myrmex/actions/runs/29419237571) confirmed the
terminal state without changing the account.

The corrected controlled run
[29424387831](https://github.com/ralphschuler/screeps-myrmex/actions/runs/29424387831) classified
the cooldown, waited 185 seconds, rejected four candidates with sanitized reason classes, accepted a
later independently validated nearby candidate, and returned `respawned` only after
`world-status=normal`. Mutation was then left enabled; scheduled runs
[29426083857](https://github.com/ralphschuler/screeps-myrmex/actions/runs/29426083857) and
[29429032010](https://github.com/ralphschuler/screeps-myrmex/actions/runs/29429032010) both reported
`healthy`. No additional live mutation is required to validate the manual-only replay gate.

## Scenario Rules

A scenario has a stable id, deterministic initial world, bounded tick count, and outcome assertions.
Good scenarios include cold boot, zero-creep recovery, miner death, route blockage, hostile arrival,
nuke impact, lost spawn, failed claim, and portal arrival.

Do not assert implementation trivia such as a class name or event emission when the real requirement
is delivered energy, survival, replacement, or retreat.

## Wiki

Edit Markdown in `wiki/`. The Wiki workflow mirrors those files to the repository Wiki after a
successful `main` update. `_Sidebar.md` controls Wiki navigation.
