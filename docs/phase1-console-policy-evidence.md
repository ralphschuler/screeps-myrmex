# Phase 1 console policy evidence

Source version: `runtime-config-source-v13`.

Issue [#130](https://github.com/ralphschuler/screeps-myrmex/issues/130) defines fixed console
reporter caps and a pure redacted status projection for the renderer in issue #131.

## Outcome evidence

- Reporter limits are source-controlled and cannot become gameplay authority or persistent state.
- The projection is created only after the final kernel report, so it can expose bounded CPU and
  fault evidence without restructuring reconciliation or telemetry persistence.
- Raw shard values and telemetry identifiers are opaque references; only fixed codes and scalars
  cross into the renderer input.
- A null telemetry result becomes a bounded unavailable observer view and does not alter the tick.

## Mechanics sources consulted

- [Screeps API: Game.cpu](https://docs.screeps.com/api/#Game.cpu)
- [Screeps API: Game.notify](https://docs.screeps.com/api/#Game.notify)
- [Screeps documentation: Debugging](https://docs.screeps.com/debugging.html)
- [Screeps Wiki](https://wiki.screepspl.us/)
