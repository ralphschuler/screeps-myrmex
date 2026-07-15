# Development

Use Node.js 24 and npm 11.

```bash
npm ci
npm run check
```

The gate covers formatting, lint, TypeScript, tests, Markdown, the production bundle, and the
publishable package layout.

## Runtime policy

Operators may change only `Memory.myrmex.config.candidate`. Use a nonnegative safe-integer revision
greater than the accepted candidate revision whenever content changes. The candidate is one complete
override, not a merge with the previous candidate. To return to source defaults, publish a newer
candidate with `overrides: {}`.

Do not use `candidate: null` as rollback. Null means no new proposal and leaves a compatible
`lastValid` policy and revision receipt active. A rollback is always a newer complete candidate.

```js
Memory.myrmex.config.candidate = {
  revision: 12,
  overrides: {
    policy: { recovery: { protectedSpawnEnergy: 400 } },
    relations: { self: ["MyUser"], allies: ["AllyA"], naps: [] },
    features: { disabled: ["phase1.growth"] },
  },
};
```

Do not edit the owner `schemaVersion` or bot-owned `lastValid`. Unknown keys, invalid values, and
malformed or overlapping identities reject the whole candidate. Operational feature values can only
disable source-available gates; they cannot activate incomplete gameplay. Confirm the bounded
status/reason plus the config and policy revisions after changing a candidate. Keep real identities
and operational values out of repository logs and issues.

For a malformed or future config-owner schema, the runtime preserves the value and uses source
defaults. Save and diagnose it privately before explicitly resetting the owner to exact `{}`. The
full workflow and policy bounds are in the repository's `docs/development.md` and
`docs/phase1-config-evidence.md`.

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
