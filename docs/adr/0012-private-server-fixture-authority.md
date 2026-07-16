# ADR 0012: Private-server fixture authority

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

The private-server integration gate needs a real hostile in the controlled MYRMEX room and a bounded
heap-loss event. The stock standalone server's authenticated hostile endpoint requires a player
token, while its administrator CLI evaluates arbitrary JavaScript. Neither is an acceptable fixture
authority.

## Decision

The test harness loads one committed fixture module through the standalone server's documented
`mods.json` mechanism. It is loaded only from ignored server state and is not imported by the bot.
The module accepts one strict, 4 KiB JSON definition with a fixed room, controlled user,
coordinates, ticks, and the canonical `smallMelee` invader body. It exposes no CLI command, HTTP
route, credential, arbitrary path, arbitrary JavaScript, or database query.

At the pinned `screeps@4.3.0` / `@screeps/driver@5.3.0` boundary, the module uses `processRoom` and
the engine bulk writer to schedule a user `"2"` invader. The normal engine invader processor
supplies its movement and attacks on the following tick. A bounded heap reset publishes the pinned
`RUNTIME_RESTART` key once; the runner's existing driver subscriber clears user VMs. The fixture
records only a fixed namespaced receipt in server env storage; the runner hashes it through the
private-server evidence contract and removes it in cleanup.

## Consequences

- Hostile pressure is real game capability in the controlled room, not an unrelated bot.
- Reset proof is bounded restoration (`T+2`), not a claim of same-tick or byte-identical engine
  timing.
- This is an intentionally version-pinned extension contract. Any runtime dependency update must
  rerun the private-server hostile and heap-reset smoke tests before the integration gate can pass.
- A future official public fixture API replaces this module. Raw CLI database writes and forged
  player authentication remain prohibited.
