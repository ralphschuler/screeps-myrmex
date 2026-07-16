# Vitest worker budget

## Current contract

The canonical `vitest run` gate uses a fixed maximum of two workers. This keeps the suite parallel
enough for a reasonable feedback time without allowing the test runner to scale with host CPU
availability.

## Evidence

On 2026-07-16, the full suite completed in 19.77-20.29 seconds with one worker and in 12.17 seconds
with two workers. The two-worker run completed all 56 test files and 518 tests. The
architecture-boundary test retains its 15-second focused-scan ceiling because the current evidence
does not establish a safe 5-second ceiling under host contention.

## Revisit rule

Re-measure one, two, and four workers when the suite gains 20% more test files, when CI hardware
changes, or when two consecutive canonical runs exceed the architecture-boundary ceiling. Keep the
lowest fixed cap that completes the canonical suite reliably without increasing architecture-scan
failures; update this document and the Vitest configuration together.
