# Phase 1 movement and primary-action evidence

Roadmap outcome: [issue #25](https://github.com/ralphschuler/screeps-myrmex/issues/25).

The movement and primary-action boundary is deterministic before creep agents are enabled. The unit
outcome suite proves stable collision selection, reciprocal swaps, fatigue/no-path results, single
invocation of the accepted move, action exclusivity, expected out-of-range normalization, and
adapter-fault isolation. Architecture tests prove the command surface remains restricted to the
canonical executors through direct and aliased call forms.

Agents, contract translation, source/sink selection, and economic execution are intentionally not
part of this evidence. They remain tracked by #38 and #26.

Mechanics consulted: [Creep.move](https://docs.screeps.com/api/#Creep-move),
[PathFinder](https://docs.screeps.com/api/#PathFinder), the scoped
[Creep API](https://docs.screeps.com/api/),
[simultaneous actions](https://docs.screeps.com/simultaneous-actions.html), and the
[Screeps Wiki](https://wiki.screepspl.us/).
