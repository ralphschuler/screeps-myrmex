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
and typed adapter faults. Issue [#369](https://github.com/ralphschuler/screeps-myrmex/issues/369)
aligns that projection with current rampart mechanics: Observe marks private foreign ramparts
blocked and owned/public ramparts walkable, changed effective passability produces a different
traversal revision, and the lease agent emits typed `path-unavailable` suspension with no movement
intent for a blocked single corridor. No persistent invalidation state or second structure scan is
added.

The issue #26 repair also composes that service with contract allocation. A runtime-owned,
tick-local adapter combines cached route cost with current fatigue, active `MOVE`, and conservative
non-`MOVE` body weight. It converts PathFinder's 1/5 plain/swamp cost scale to the 2/10 movement
fatigue scale and deliberately overestimates arrival rather than equating directions with ticks.
Cold searches cost 0.5 scheduler CPU only from allowance left after the enclosing contract/agent
system's base estimate; cache hits remain available when that allowance is exhausted. Geometry is
memoized up to the allocator pair cap, and cross-room or unavailable routes fail closed. Neither
`WorkforceAllocator` nor economy policy receives `PathFinder` or a live game object.

Current-tick occupancy and reservations are overlaid by `MovementArbiter` after a path is selected;
they are never cached. Agents and economic execution remain tracked by #38 and #26; the allocator
adapter establishes route feasibility but does not take movement or collision authority.

Mechanics consulted: [Creep.move](https://docs.screeps.com/api/#Creep.move),
[PathFinder](https://docs.screeps.com/api/#PathFinder),
[`StructureRampart.isPublic`](https://docs.screeps.com/api/#StructureRampart.isPublic), the scoped
[Creep API](https://docs.screeps.com/api/),
[simultaneous actions](https://docs.screeps.com/simultaneous-actions.html), current engine 4.3.2
[`movement.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/movement.js#L16-L29)
and
[`creeps/move.js`](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/intents/creeps/move.js#L34-L43),
and the Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/) and
[Pathfinding](https://wiki.screepspl.us/Pathfinding/). Wiki pages supply matrix terminology only;
official contracts and engine source govern rampart passability.
