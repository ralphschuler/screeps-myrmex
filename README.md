# MYRMEX

> Build. Endure. Retaliate. Expand.

MYRMEX is a clean-room, autonomous Screeps bot. It compounds economy first, treats territory as an
investment portfolio, makes aggression expensive, and expands only when the measured return
justifies the CPU, energy, spawn time, and diplomatic risk.

This repository intentionally preserves no source files or framework packages from the previous bot.
Legacy lessons survive only as independently written requirements and outcome scenarios.

## Status

Bootstrap phase. The repository currently provides:

- a single deployable `@myrmex/bot` package;
- a dev-only `@myrmex/scenario-kit` for executable outcome specifications;
- strict TypeScript, lint, formatting, test, documentation, and bundle gates;
- a deterministic seven-phase tick skeleton;
- versioned persistent-memory initialization;
- GitHub Actions for CI, security review, package publishing, Screeps deployment, terminal-loss
  respawn recovery, dependency updates, and Wiki synchronization.

No gameplay feature is considered complete until it passes a deterministic scenario and a
private-server outcome gate.

## Quick Start

Prerequisites: Node.js 24 and npm 11.

```bash
npm ci
npm run check
```

The Screeps bundle is written to `dist/main.js`.

Release tags publish the same bundle as `@ralphschuler/screeps-myrmex` on GitHub Packages. Live
deployment and auto-respawn remain disabled until the `screeps-production` environment is configured
as described in [the development guide](docs/development.md).

## Repository Shape

```text
packages/bot/           the only deployable runtime
packages/scenario-kit/  dev-only outcome-scenario primitives
docs/                   versioned technical documentation
wiki/                   source of truth for the GitHub Wiki mirror
scripts/                narrow build and repository checks
```

Read [the architecture](docs/architecture.md), [the strategy](docs/strategy.md), and
[the roadmap](docs/roadmap.md) before adding features. AI agents should execute
[the autonomous build loop](loop.md) one outcome slice at a time.

## Non-Negotiable Rules

1. One runtime, one memory authority, one scheduler, and one observation pipeline.
2. Work is represented as capability contracts, not a growing taxonomy of creep roles.
3. Defense, economy, and ally safety may preempt every optional planner.
4. Every remote, claim, market trade, and military operation has a budget and exit condition.
5. Tests prove game outcomes; import tests and placeholder assertions do not count.
6. Generated bundles, performance captures, and runtime artifacts never enter source control.

## License

MIT. See [LICENSE](LICENSE).
