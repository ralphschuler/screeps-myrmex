# Phase 1 movement and primary-action evidence

Roadmap outcomes: [issue #25](https://github.com/ralphschuler/screeps-myrmex/issues/25) and its
runtime follow-up [issue #112](https://github.com/ralphschuler/screeps-myrmex/issues/112).

The movement and primary-action boundary is deterministic before creep agents are enabled. The unit
outcome suite proves stable collision selection, reciprocal swaps, fatigue/no-path results, single
invocation of the accepted move, action exclusivity, expected out-of-range normalization, and
adapter-fault isolation. The runtime suite proves the bounded data-only proposal channels are sealed
before the canonical executors run, and mandatory spawn settlement, reconciliation, state commit,
and telemetry continue when movement lookup or command adapters fail. The local path seam uses only
cached reconstructible static matrices and direction lists: cold searches use configured
operation/cost limits and refuse to rebuild or search when the caller's CpuScheduler budget cannot
cover the estimate. Architecture tests prove the command surface remains restricted to the canonical
executors through direct and aliased call forms.

The production path service, tracked by
[#115](https://github.com/ralphschuler/screeps-myrmex/issues/115), observes detached
terrain/static-structure traversal data, builds the cache from that projection, and keeps
`PathFinder`/`RoomPosition` objects inside the runtime adapter. Its tests prove local-room
restriction, configured operation/cost propagation, static cache cold/warm behavior, CPU deferral,
and typed adapter faults.

Current-tick occupancy and reservations are overlaid by `MovementArbiter` after a path is selected;
they are never cached. Agents, contract translation, source/sink selection, and economic execution
are intentionally not part of this evidence. They remain tracked by #38 and #26.

Mechanics consulted: [Creep.move](https://docs.screeps.com/api/#Creep-move),
[PathFinder](https://docs.screeps.com/api/#PathFinder), the scoped
[Creep API](https://docs.screeps.com/api/),
[simultaneous actions](https://docs.screeps.com/simultaneous-actions.html), and the
[Screeps Wiki](https://wiki.screepspl.us/).
