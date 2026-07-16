# Phase 1 recovery gate evidence

Source version: `runtime-config-source-v9`.

Issue [#124](https://github.com/ralphschuler/screeps-myrmex/issues/124) records the recovery-gate
decision after the completed workforce recovery implementation in
[#27](https://github.com/ralphschuler/screeps-myrmex/issues/27).

## Outcome evidence

- `tick.test.ts` cold-boots an owned room with zero workers, executes the bounded recovery spawn,
  resumes harvesting and delivery, serializes Memory to simulate a heap reset, then continues to a
  positive delivery action.
- `colony-director.test.ts` proves proactive replacement before the last worker cannot outlive its
  successor handoff, including exact recovery-spawn budget settlement.
- `tick.test.ts` also proves the one-short brownout denial: a room below the legal recovery-body
  cost does not stage an unsafe spawn grant.

The gate is source-available only with its existing `phase1.economy` prerequisite. Growth and
critical maintenance remain source-unavailable until their own outcomes pass.
