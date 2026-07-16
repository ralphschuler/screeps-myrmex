# Contributing to MYRMEX

MYRMEX is outcome-driven. A change is valuable when it improves survival, energy profit, CPU
efficiency, deterrence, or strategic reach without weakening a guardrail.

## Development Flow

1. Start from a concrete game outcome or failure scenario.
2. Write or extend a deterministic scenario.
3. Implement the smallest coherent behavior.
4. Run `npm run check`.
5. Explain the strategic effect, CPU/memory impact, and rollback condition in the pull request.

## Pull Request Requirements

- Keep the runtime package deployable as one bundle.
- Add no new workspace without an accepted ADR.
- Add no direct Screeps API call outside an executor or runtime adapter.
- Include schema migration behavior for persistent-memory changes.
- State how the behavior is measured in deterministic scenario evidence and, for Phase 6 production
  work, MMO canary telemetry.

See [Development](docs/development.md) for commands and repository conventions.
