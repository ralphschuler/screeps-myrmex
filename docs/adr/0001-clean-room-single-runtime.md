# ADR 0001: Clean-Room Single Runtime

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

The predecessor bot accumulated many publishable packages, duplicate authorities, compatibility
layers, and a build graph whose maintenance burden competed with gameplay outcomes.

## Decision

MYRMEX is implemented from scratch. No predecessor source, tests, schemas, workflows, or generated
files are copied. The project has one deployable runtime package. A separate private scenario-kit
workspace is allowed because it is development-only and cannot enter the runtime bundle.

New workspace packages, persistent authorities, or cross-cutting event systems require an ADR and
evidence that an internal module cannot satisfy the need.

## Consequences

- The runtime bundle and dependency graph remain inspectable.
- Internal refactoring does not create release/version work.
- Legacy compatibility is intentionally unavailable.
- Outcome scenarios, not copied tests, preserve lessons.
