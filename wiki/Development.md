# Development

Use Node.js 24 and npm 11.

```bash
npm ci
npm run check
```

The gate covers formatting, lint, TypeScript, tests, Markdown, the production bundle, and the
publishable package layout.

Release tags publish `@ralphschuler/screeps-myrmex` to GitHub Packages. The manual deployment
workflow uploads a commit-marked bundle and verifies the same code from Screeps.

The scheduled auto-respawn workflow discovers and ranks available shards automatically. It is
disabled until the `screeps-production` environment contains a dedicated Screeps token and
`SCREEPS_AUTO_RESPAWN_ENABLED=true`. It reads account health, acts only on recognized terminal
states, selects a viable start-room tile, verifies placement, and keeps target coordinates out of
workflow logs. Start selection examines bounded nearby rooms on every shard, prefers an already
funded shard, and independently validates neutral two-source rooms and safe terrain.

The scheduled job always performs a health check, but `world-status=normal` is an unconditional
no-respawn result even when room-list data is temporarily stale. A `lost` state means no valid
spawn; the script checks that state a second time immediately before destructive account mutation.

After an accepted respawn, automation honors the documented 180-second cooldown with a 185-second
wait and a guarded same-target retry. It verifies CPU on the selected shard after placement. A
recently respawned account with one owned shard and zero CPU may complete that repair on a later
run; established and multi-shard healthy accounts are not rebalanced.

Spawn placement is manual-dispatch only unless the current scheduled invocation submitted the
guarded respawn transition itself and then observed `empty`. A later schedule, or a preflight that
changes from `lost` to `empty` without this run's mutation, will not replay the same failed
candidate set without a new operator-controlled dispatch.

See the repository's `docs/development.md` for exact secrets, variables, token scope, dry-run,
deployment, and rollback instructions.

Architecture and strategy changes update both versioned docs and the corresponding Wiki source.
