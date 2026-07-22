# ADR 0076: Command-free stale-layout revision handoff

## Status

Accepted

## Context

The layouts owner previously dropped every record whose `algorithmRevision` differed from the
source-defined revision while opening owner state. That made ordinary rebuild deterministic, but it
also discarded bounded evacuation, construction-site, removal-receipt, and source-service issuance
evidence before current observation could prove a safe revision transition. The same planning tick
could then commit new geometry and publish a construction or removal command.

Issue #385 requires one bounded revision transition without creating a second layout owner,
migration queue, command path, or compatibility layer.

## Decision

- Layouts owner-local schema V25 separates `records` from `staleRecords`. `records` contains only
  the current algorithm and remains the sole input to gameplay, Logistics, mining, industry, health,
  site, and removal projections. `staleRecords` contains fully validated older-algorithm V24-shaped
  evidence and is inert.
- V1-V24 migration places a structurally valid older-algorithm record in `staleRecords` instead of
  dropping it. Current and stale records share the existing 64-room aggregate cap and one room may
  occur in only one collection. Malformed, duplicate, over-cap, misplaced, or current-algorithm
  stale evidence rejects the owner.
- One stale room may hand off only from visible current owned-room observation while the colony is
  developing or mature, unthreatened, free of controller risk, supplied by legal workforce, within
  RCL2-RCL8 policy, progression-authorized, and above its protected spawn reserve.
- The stale record must be quiescent: no evacuation, container migration, construction-site receipt,
  removal receipt, or in-progress source-service issuance coordinate may remain. Current source
  services are supplied to the existing selector so legal reachable positions retain continuity.
- The existing bounded `LayoutPlanner` must derive one complete current commitment with source and
  access proof. Failure or unsafe evidence preserves the stale record and emits no command.
- A successful handoff atomically replaces only that room's stale record through the existing
  layouts-owner precommit. The handoff tick publishes no layout, maintenance, site, migration,
  evacuation, dismantle, or destroy work. Ordinary bounded convergence may resume on the following
  tick.
- V24 code treats V25 as future, preserves it byte-for-byte, and authorizes no layout work.

## Consequences

A source revision can no longer erase pending irreversible evidence or issue a same-tick command.
Quiescent rooms advance deterministically across JSON/global-heap reconstruction and reordered world
facts. Active or unsafe records remain fail-closed until a later explicit policy handles them; this
slice does not reinterpret or cancel their work.

Persistent cost is one empty `staleRecords` array in normal owner state and at most one fully
bounded record per already-capped room during handoff. Planning retains the existing two-room
window, 256 anchors, eight transforms, and 2,500 flood cells per candidate. The transition spends no
game resource. No root owner, authority, dependency, cache, executor, command, queue, or unbounded
history is added.

Rollback to V24 pauses layout work without rewriting V25. Redeploying V25 resumes the exact bounded
handoff. Active revision migration, arbitrary geometry algorithms, defensive migration, dynamic room
routing, autonomous boost-manifest production, creep dismantling, and uninterrupted same-structure
availability remain outside this decision.

## Mechanics sources

Reviewed 2026-07-22:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite) define
  the irreversible owned-structure and scheduled site command boundaries that the handoff tick must
  not reach.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/) and
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/) provide layout,
  anchor, and flood-fill terminology only. The MYRMEX owner, handoff, access, and command boundaries
  are independently defined by repository contracts.
