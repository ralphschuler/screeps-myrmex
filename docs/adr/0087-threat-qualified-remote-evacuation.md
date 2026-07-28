# ADR 0087: Threat-qualified remote evacuation

## Status

Accepted

## Context

ADR 0082 lets `RemotePortfolio` release a commitment when a caller supplies nonzero threat risk, but
no production projection derives that risk from current remote evidence. Issues #58–#60 already stop
new reservation, extraction, capital, and hauling work after the portfolio objective disappears.
They do not move an already leased miner or reserver home. Suspending such a lease immediately also
removes the actor identity needed for a multi-room retreat, while letting the ordinary lease
continue would keep issuing exposed work actions.

The solution must preserve the existing diplomacy, intelligence, route, portfolio, contract,
movement, logistics, and command authorities. Phase 5 still owns a general threat model and owned-
room defense; issue #62 still owns realized loss accounting.

## Decision

- `assessRemoteSafety` is a pure, request-driven evidence projection, not a persistent threat
  authority. It consumes at most eight exact remote candidates, current/fresh `IntelService`
  results, their existing `RoutePlanner` result, detached recent-loss/confidence values, and the
  authoritative runtime relation configuration.
- Configured self, ally, and NAP exclusions are resolved through `classifyPlayerRelation` before a
  visible creep can contribute danger. An unexcluded creep is credible when it has an active
  `ATTACK`, `RANGED_ATTACK`, `WORK`, or `CLAIM` part. A move-only scout is harmless. This classifies
  operational exposure only; it authorizes no attack.
- Previous-tick attack or controller-attack events, a deployed or policy-imminent Invader Core, a
  risky route, stale/partial/unavailable intel, low caller confidence, or excessive detached recent-
  loss evidence fails closed. One fixed reason and risk value are emitted per room. Attack events
  from a currently identified configured exclusion are ignored; an unattributed attack remains
  unsafe.
- The projection copies that risk into `RemoteCandidateEvidence`. `RemotePortfolio` remains the sole
  lifecycle and capacity owner: it releases energy, spawn-time, CPU, and Memory commitment
  atomically, enters its existing threat/suspension/cooldown states, and requires consecutive fresh
  safe probes before restoring an active objective. No remotes-owner field or schema changes.
- `planRemoteEvacuations` consumes only the assessment, the current portfolio disposition, a bounded
  `ContractExecutionView`, current detached actors, and one independently ready zero-risk
  remote-to-donor route. Threat, suspension, and cooldown continue an already-started retreat until
  the remote becomes active again.
- A remote reservation, mining, or acquire-stage hauling lease receives one tick-local
  `LeaseTravelOverride`. `planLeaseAgents` suppresses the exposed primary action and uses the same
  local path service and cardinal border decomposition to emit a priority-10,000 movement intent.
  `MovementArbiter` and `MovementExecutor` retain sole movement command authority.
- A V6 delivery lease already using the exact safe return route stays under `LogisticsPlanner` and
  preserves its loaded cargo. Reaching the donor, actor loss, or unavailable safe return route emits
  one ordinary bounded suspension transition through `ContractLedger`. Donor-arrival and
  route-unavailable cases also use the override's tick-local `hold` mode, so the opening execution
  view cannot issue exposed ordinary work before Reconcile applies that transition. This creates no
  retry loop, actor task Memory, or second queue.
- Assessment costs 25 milli-CPU per candidate and rejects the whole batch when the supplied CPU
  admission cannot fit. Assessment is capped at eight candidates; evacuation is capped by the
  existing 64-lease/64-actor view and 16-room route limit. Outputs are fixed metrics and bounded
  reason-coded rows. There is no new energy, spawn, persistent-Memory, or command budget.

## Consequences

A credible NPC or player threat, recent attack, impending core, unsafe route, or insufficiently
qualified resumption evidence now removes portfolio authorization before replacement or capital
spend and redirects exposed leased actors through existing movement authority. Harmless scouts and
configured exclusions do not trigger false hostile classification. Loaded haulers can still return
value rather than becoming ghost delivery or abandoned cargo.

The projection is request-driven with the rest of the current Phase 3 modules. Autonomous candidate,
grant, and scheduled runtime composition remains a later integration concern and cannot be inferred
from this leaf. A safe route may be unavailable; fail-closed suspension then avoids issuing an
unsafe move but can strand the actor. Phase 5 defense, combat escort, and retaliation remain out of
scope.

Rollback removes the safety projection and lease travel override. No persistent migration is
required. Before rollback, operators should allow or cancel active retreats; older code will
otherwise resume or suspend their underlying ordinary contracts from current portfolio evidence.

## Mechanics sources

Reviewed 2026-07-28:

- Official [Screeps documentation index](https://docs.screeps.com/) and
  [`Creep`](https://docs.screeps.com/api/#Creep): creep ownership, body parts, hits, lifetime, and
  movement-capable actor evidence.
- Official [`Room.getEventLog`](https://docs.screeps.com/api/#Room.getEventLog): the event batch
  describes the previous tick; attack and controller-attack rows identify the acting object.
- Official [`StructureInvaderCore`](https://docs.screeps.com/api/#StructureInvaderCore): level,
  deployment countdown, and spawning evidence.
- Official [`Game.map.findRoute`](https://docs.screeps.com/api/#Game.map.findRoute) and
  [creep movement](https://docs.screeps.com/creeps.html#Movement): room-sequence selection remains
  distinct from executable tile movement and fatigue.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/),
  [Invader](https://wiki.screepspl.us/Invader/), and [Vision](https://wiki.screepspl.us/Vision/):
  community terminology and operational guidance distinguish vision, NPC/player pressure,
  reservation, remote defenders, multi-room return logistics, and stale visibility.

Official contracts govern. No predecessor-bot or public-bot source was consulted.
