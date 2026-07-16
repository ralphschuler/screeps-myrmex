# Phase 1 recovery gate evidence

Source version: `runtime-config-source-v9`.

Issue [#124](https://github.com/ralphschuler/screeps-myrmex/issues/124) records the recovery-gate
decision after the completed workforce recovery implementation in
[#27](https://github.com/ralphschuler/screeps-myrmex/issues/27).

## Outcome evidence

- `tick.test.ts` cold-boots an owned room with zero workers, executes the bounded recovery spawn,
  resumes harvesting and delivery, serializes Memory to simulate a heap reset, then continues to a
  positive delivery action.
- `colony-director.test.ts` proves the proactive deadline, and composed `tick.test.ts` evidence
  first creates a generated incumbent through zero-worker recovery, then proves its TTL 60-to-59
  boundary publishes and schedules exactly one distinct revision-qualified successor.
- The same composed replay serializes Memory after scheduling and observes the exact successor still
  spawning, proving terminal-ledger name reconstruction suppresses a duplicate after heap reset.
- A failed-scheduling replay proves stable retry backoff followed by one new bounded reconstructible
  successor identity at the next durable demand revision.
- `tick.test.ts` also proves the one-short brownout denial, then resets the heap and raises
  available energy to the legal recovery cost. The selected name, exact grant, executed API
  argument, and terminal entry all bind to the same advanced revision, and a second reset observes
  that exact in-flight name without duplicating it.
- A rollout replay observes the previously deployed logical-only recovery name at zero remaining
  spawn time beside another idle spawn and proves the bounded observation fallback suppresses a
  duplicate without making that name a new allocation candidate.

The gate is source-available only with its existing `phase1.economy` prerequisite. Growth and
critical maintenance remain source-unavailable until their own outcomes pass.
