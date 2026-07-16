# ADR 0002: Runtime Configuration Authority

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Phase 1 introduces survival thresholds, roadmap feature gates, and configured player exclusions.
Reading an arbitrary `Memory` subtree in planners would create multiple policy authorities, make
heap-reset behavior depend on object order, and let malformed operational data weaken ally safety.
The existing durable schema also had no owner whose authority matched configuration lifecycle.

## Decision

MYRMEX has one `RuntimeConfigAuthority` under `packages/bot/src/config/`. It constructs a detached,
recursively immutable planner view from source-controlled defaults and one strictly validated
operational candidate. Planners import only the public typed view through `TickContext`; they cannot
read the raw owner or the validation and persistence modules.

Durable Memory schema v3 adds the `config` owner. Its owner-local schema v2 contains:

- operator-owned `candidate`, with a nonnegative safe-integer revision and one complete override
  document; and
- bot-owned `lastValid`, with the source revision, candidate revision, canonical accepted override,
  resolved revision, and an optional diagnostic expiry anchor.

Exact `{}` is the only initialization shorthand. The bot may normalize that shorthand or update
`lastValid`, but never rewrites `candidate`. Changed canonical content requires a greater candidate
revision; an equal revision is accepted only for canonically equivalent content. Non-empty malformed
or future owner schemas are preserved and fail closed to source defaults. An invalid newer candidate
retains a source-compatible, revalidated last-valid override; otherwise source defaults apply.
Candidate acceptance compares canonical data and does not trust the compact revision hash as
equality evidence.

`candidate: null` means that the operator has made no new proposal. A compatible `lastValid`
configuration and its revision receipt remain active and unchanged; without compatible evidence,
source defaults apply. Null is not rollback. Returning to defaults or a prior override requires a
newer candidate revision with the complete desired override.

The only time-varying override is an observer diagnostic request. It is deliberately outside the
survival policy and accepts only fixed redacted categories, a debug or trace level, and a bounded
duration. Acceptance records one expiry tick in `lastValid`; resolution rebuilds the safe observer
view each tick and makes it inactive exactly at that tick. It cannot alter gameplay, reporter caps,
redaction, or policy revisions. The reader accepts v1 receipts without an expiry anchor as a
diagnostic-free compatibility case.

The historical v1-to-v2 migration protocol remains valid. Its final bounded step transitions to a
separate v2-to-v3 cursor, which installs the config owner and completes the migration. This
preserves partially migrated live state across an upload. A cursor receives only the exact fixed
metadata allowance above the normal aggregate JSON cap and is accepted only if its projected final
v3 root fits the normal cap. A completion diagnostic is omitted when it alone would exceed that cap;
valid authority-owned state always has priority over diagnostic evidence.

Feature availability and prerequisite edges are source controlled. Operational overrides can only
disable known, source-available gates. A gate is effective only when its outcome is available, it is
not disabled, and every prerequisite is effective. Issue #36 leaves all Phase 1 gameplay gates
unavailable; the change that proves a later outcome is responsible for enabling its own gate.

Configured self, ally, and non-aggression-pact identities are evaluated before optional reputation.
They always receive the `excluded` targeting ceiling. Invalid observed identities are also excluded.
Fresh optional reputation may reduce a ceiling, but Phase 1 caps every unconfigured valid identity
at `local-defense`; that ceiling is not authorization to attack. Empty, stale, malformed,
future-version, or future-assessed reputation becomes neutral and cannot weaken a configured
exclusion.

## Consequences

- Candidate validation is bounded and runs only after a heap reset or candidate-revision change; the
  derived observer window is evaluated each tick against its persisted expiry anchor.
- Resolved config, policy, feature-gate, and relation decisions are deterministic across JSON and
  heap round trips.
- Architecture enforcement rejects another config authority and raw candidate parsing outside
  `config/`.
- Telemetry can identify source, config, and policy revisions without exposing identities or
  operational values.
- Adding a policy field requires a documented source default, unit, bound, validation rule, and
  outcome consumer in the same authority.
- Rollback uses a newer candidate revision or removal of the code change; arbitrary schema downgrade
  and opportunistic owner repair remain forbidden.
