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
migration queue, command path, or compatibility layer. Issue #387 extends that transition only far
enough to reconcile one already-successful stale construction-site command from current observation.
Issue #389 adds the equivalent observation-only continuation for one terminal-success non-storage
removal receipt. Issues #391, #393, #395, and #397 permit that receipt to retain one exact completed
extension-, tower-, spawn-, or reserve-link-evacuation term, respectively, until newer observation
proves the target absent.

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
  removal receipt, or in-progress source-service issuance coordinate may remain. Before this gate,
  one `OK` construction-site receipt may settle only when its canonical `site-v1` identity binds the
  stale fingerprint and exact room/position/type, a newer observation contains the matching owned
  site or completed owned structure, and deterministic receipt ordering selects it. The settlement
  removes only that receipt and ends new layout site/removal planning command-free for the tick.
  Previously authorized unrelated current-layout Logistics and lease work is neither cancelled nor
  reclassified. Every malformed, failed, foreign, absent, mismatched, same-tick, or uncertain result
  remains active. Current source services are supplied to the existing selector so legal reachable
  positions retain continuity.
- One otherwise-quiescent stale non-storage removal receipt with `OK` or `TARGET_ABSENT` may settle
  only while the same handoff safety policy holds and a newer complete visible owned-room structure
  projection omits its exact target ID. Settlement removes only that receipt and ends new layout
  planning globally for the tick. Issues #391, #393, #395, and #397 also admit one exact paired
  extension, tower, spawn, or reserve-link evacuation, respectively, only when receipt type, target,
  replacement, terminal result, and receipt tick within the fixed evacuation interval all match.
  That settlement atomically removes both bounded terms. Storage keeps its specialized
  stock-conservation and retained-terminal continuity proof. Present, incomplete, same-tick, unsafe,
  unrelated-active, mismatched, storage, or failed evidence remains inert.
- The existing bounded `LayoutPlanner` must derive one complete current commitment with source and
  access proof. Failure or unsafe evidence preserves the stale record and emits no command.
- A successful handoff atomically replaces only that room's stale record through the existing
  layouts-owner precommit. The handoff tick publishes no layout, maintenance, site, migration,
  evacuation, dismantle, or destroy work. Ordinary bounded convergence may resume on the following
  tick.
- V24 code treats V25 as future, preserves it byte-for-byte, and authorizes no layout work.

## Consequences

A source revision can no longer erase pending irreversible evidence or issue a same-tick command.
One observed successful site receipt, one terminal-success non-storage removal receipt, and one
exact completed extension-, tower-, spawn-, or reserve-link-evacuation/receipt pair can now converge
toward quiescence without reissuing or cancelling their commands; the separate handoff remains
delayed until a later tick. Rooms advance deterministically across JSON/global-heap reconstruction
and reordered world facts. Other active, mismatched, storage, failed, or unsafe records remain
fail-closed until a later explicit policy handles them; this decision does not reinterpret or cancel
their work.

Persistent cost is one empty `staleRecords` array in normal owner state and at most one fully
bounded record per already-capped room during handoff. Planning retains the existing two-room
window, 256 anchors, eight transforms, and 2,500 flood cells per candidate. The transition spends no
game resource. No root owner, authority, dependency, cache, executor, command, queue, or unbounded
history is added.

Rollback to V24 pauses layout work without rewriting V25. Redeploying V25 resumes the exact bounded
settlement or handoff. Unfinished or other evacuation continuation, storage/failed removal-receipt
and source-service reconciliation, arbitrary geometry algorithms, defensive migration, dynamic room
routing, autonomous boost-manifest production, creep dismantling, and uninterrupted same-structure
availability remain outside this decision.

## Mechanics sources

Reviewed 2026-07-22 for #385 and #387; `Structure.destroy` and both indexes rechecked 2026-07-23 for
issues #389, #391, #393, #395, and #397; `StructureTower` was also checked for #393,
`StructureSpawn` for #395, and `StructureLink` for #397:

- Official [Screeps documentation](https://docs.screeps.com/),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite), and
  [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) define the irreversible
  owned-structure command, successful site scheduling result, and current site facts. `OK` schedules
  destruction while `ERR_NOT_OWNER` and `ERR_BUSY` are failures; issues #389, #391, #393, #395, and
  #397 additionally require newer complete target absence. The paired #391, #393, #395, and #397
  settlements also require the exact extension, tower, spawn, or link target/replacement and a
  terminal receipt produced within its fixed evacuation interval. Official
  [`StructureTower`](https://docs.screeps.com/api/#StructureTower) defines the 1,000-energy capacity
  and 10-energy action cost already enforced by the original migration path; #393 does not
  reinterpret stock or operational readiness. Official
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn) defines the 300-energy capacity,
  5,000 hits, and creep-production service already enforced by the original spawn migration path;
  #395 does not reinterpret stock, activity, or spawn-slot readiness. Official
  [`StructureLink`](https://docs.screeps.com/api/#StructureLink) defines the 800-energy capacity and
  cooldown-governed native transfer already enforced by the original reserve-link migration path;
  #397 does not reinterpret stock, cooldown, role, or transfer readiness. Settlement consumes newer
  observation only; neither settlement nor handoff reaches a command boundary.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/),
  [`StructureLink`](https://wiki.screepspl.us/StructureLink/),
  [`StructureSpawn`](https://wiki.screepspl.us/StructureSpawn/), and
  [`StructureTower`](https://wiki.screepspl.us/StructureTower/) provide layout, link, spawn, and
  tower terminology only. The MYRMEX owner, handoff, access, and command boundaries are
  independently defined by repository contracts.
