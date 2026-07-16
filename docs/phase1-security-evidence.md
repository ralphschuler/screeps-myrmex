# Phase 1 security-redaction evidence

Issue [#98](https://github.com/ralphschuler/screeps-myrmex/issues/98) establishes a no-raw-data
observability boundary before the console reporter in issue #110.

## Outcome evidence

- `security/redaction` is pure and bounded: it emits deterministic opaque identifiers for hostile
  values and a fixed fallback when a value cannot be safely read.
- Telemetry detail identities are opaque references; status and reason fields accept only bounded
  code syntax.
- Kernel, command, arbiter, spawn, and contract exception paths no longer serialize exception
  messages into results or diagnostics.
- Architecture tests reject direct production `console` output, `console.logUnsafe`, `eval`, and
  `Function` constructors.
- Adversarial tests cover markup, terminal control data, bidirectional controls, oversized text,
  token-like values, malformed surrogate data, and objects whose accessors throw.

## Mechanics sources consulted

- [Screeps API: Game](https://docs.screeps.com/api/#Game)
- [Screeps API: Game.notify](https://docs.screeps.com/api/#Game.notify)
- [Screeps documentation: auth tokens](https://docs.screeps.com/auth-tokens.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
