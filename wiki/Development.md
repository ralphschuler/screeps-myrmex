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

The scheduled auto-respawn workflow discovers and ranks available shards automatically and reads the
aggregate account room map once per run. It is disabled until the `screeps-production` environment
contains a dedicated Screeps token and `SCREEPS_AUTO_RESPAWN_ENABLED=true`. It acts only on
recognized terminal states, selects a viable start-room tile, verifies placement, and keeps target
coordinates out of workflow logs.

See the repository's `docs/development.md` for exact secrets, variables, token scope, dry-run,
deployment, and rollback instructions.

Architecture and strategy changes update both versioned docs and the corresponding Wiki source.
