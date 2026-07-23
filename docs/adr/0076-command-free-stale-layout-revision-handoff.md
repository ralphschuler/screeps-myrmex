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
removal receipt. Issues #391, #393, #395, #397, #399, #401, #403, and #405 permit that receipt to
retain one exact completed extension-, tower-, spawn-, reserve-link-, container-, lab-, terminal-,
or storage-evacuation/migration term, respectively, until newer observation proves the target
absent. Issue #407 adds the complementary no-effect proof for one otherwise-quiescent failed receipt
whose exact target remains present in newer complete observation. Issue #409 extends that proof to
one failed receipt carrying its sole exact evacuation/migration term.

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
- One otherwise-quiescent stale removal receipt with `OK` or `TARGET_ABSENT` may settle only while
  the same handoff safety policy holds and a newer complete visible owned-room structure projection
  omits its exact target ID. A bare storage receipt remains excluded from #389's generic path.
  Settlement removes only that receipt and ends new layout planning globally for the tick. Issues
  #391, #393, #395, #397, #399, #401, #403, and #405 also admit one exact paired extension, tower,
  spawn, reserve-link, container, lab, terminal, or storage evacuation/migration, respectively, only
  when receipt type, target, replacement, terminal result, and receipt tick within the fixed
  interval all match. Energy-only, mineral-only, and mixed lab forms use those same
  source/replacement/interval terms whether mineral destination is storage or terminal. Scalar and
  manifest terminal forms likewise share source, storage replacement, and interval identity. Scalar,
  manifest, and two-batch storage forms share source, terminal replacement, and their 150- or
  300-tick interval identity, then additionally require newer complete target absence, one exact
  active/quiescent retained terminal, complete generic/Store facts, and conservation of every
  original resource gain. That settlement atomically removes both bounded terms. Present,
  incomplete, same-tick, unsafe, unrelated-active, mismatched, unpaired storage,
  terminal/conservation drift, or failed evidence remains inert.
- One otherwise-quiescent stale removal receipt with `ERR_NOT_OWNER`, `ERR_BUSY`,
  `ERR_INVALID_TARGET`, or `UNEXPECTED` may settle only while the same handoff safety policy holds
  and a newer complete visible owned-room structure projection still contains its exact target ID.
  Fresh target presence is no-effect evidence for the recorded attempt; settlement emits no command
  and leaves the revision handoff to a later tick. The receipt may retain exactly one container,
  extension, lab, reserve-link, spawn, storage, terminal, or tower evacuation/migration only when
  receipt type, target, replacement, and tick within the fixed interval match. The recorded destroy
  attempt proves that the old authority reached its removal boundary; current target presence proves
  no removal effect, so both terms clear atomically without inventing new inventory-conservation
  evidence. Target absence, incomplete or same-tick observation, unsafe policy, an evacuation-
  bearing record without one sole exact match, site receipts, or source-service issuance preserves
  the record.
- The existing bounded `LayoutPlanner` must derive one complete current commitment with source and
  access proof. Failure or unsafe evidence preserves the stale record and emits no command.
- A successful handoff atomically replaces only that room's stale record through the existing
  layouts-owner precommit. The handoff tick publishes no layout, maintenance, site, migration,
  evacuation, dismantle, or destroy work. Ordinary bounded convergence may resume on the following
  tick.
- V24 code treats V25 as future, preserves it byte-for-byte, and authorizes no layout work.

## Consequences

A source revision can no longer erase pending irreversible evidence or issue a same-tick command.
One observed successful site receipt, one terminal-success non-storage removal receipt, one exact
completed extension-, tower-, spawn-, reserve-link-, container-, lab-, terminal-, or storage-
evacuation/migration receipt pair, and one otherwise-quiescent failed receipt—alone or paired with
its sole exact evacuation/migration term—can now converge toward quiescence without reissuing or
cancelling its command; the separate handoff remains delayed until a later tick. Rooms advance
deterministically across JSON/global-heap reconstruction and reordered world facts. Other active,
evacuation-bearing records without one sole exact match, unpaired storage, unsafe, terminal-drifted,
or conservation-incomplete records remain fail-closed until a later explicit policy handles them;
this decision does not reinterpret or cancel their work.

Persistent cost is one empty `staleRecords` array in normal owner state and at most one fully
bounded record per already-capped room during handoff. Planning retains the existing two-room
window, 256 anchors, eight transforms, and 2,500 flood cells per candidate. The transition spends no
game resource. No root owner, authority, dependency, cache, executor, command, queue, or unbounded
history is added.

Rollback to V24 pauses layout work without rewriting V25. Redeploying V25 resumes the exact bounded
settlement or handoff. Unfinished migration/evacuation continuation, mismatched or multiple failed
pairs, source-service reconciliation, arbitrary geometry algorithms, defensive migration, dynamic
room routing, autonomous boost-manifest production, creep dismantling, and uninterrupted same-
structure availability remain outside this decision.

## Mechanics sources

Reviewed 2026-07-22 for #385 and #387. `Structure.destroy` and both indexes were rechecked
2026-07-23 for issues #389, #391, #393, #395, #397, #399, #401, #403, #405, #407, and #409. The
relevant pages were also checked: `StructureTower` for issue #393, `StructureSpawn` for issue #395,
`StructureLink` for issue #397, `StructureContainer` for issue #399, `StructureLab` for issue #401,
and `StructureTerminal` plus `Store` for
[issue #403](https://github.com/ralphschuler/screeps-myrmex/issues/403), and `StructureStorage`,
`StructureTerminal`, and `Store` for
[issue #405](https://github.com/ralphschuler/screeps-myrmex/issues/405):

- Official [Screeps documentation](https://docs.screeps.com/),
  [`Structure.destroy`](https://docs.screeps.com/api/#Structure.destroy), and
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite), and
  [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) define the irreversible
  owned-structure command, successful site scheduling result, and current site facts. `OK` schedules
  destruction while `ERR_NOT_OWNER` and `ERR_BUSY` are failures; issues #389, #391, #393, #395,
  #397, #399, #401, #403, and #405 additionally require newer complete target absence. Issue #407
  instead requires newer complete exact-target presence before one otherwise-quiescent failed
  receipt can clear; a normalized adapter failure receives the same observation proof. Issue #409
  applies that no-effect proof to one sole exact pair whose failed receipt demonstrates that the old
  evacuation reached the destroy boundary. Both terms clear only after structure kind, target,
  replacement, and fixed interval match. The paired #391, #393, #395, #397, #399, #401, #403, and
  #405 settlements also require the exact extension, tower, spawn, link, container, lab, terminal,
  or storage target/replacement and a terminal receipt produced within its fixed interval. Official
  [`StructureTower`](https://docs.screeps.com/api/#StructureTower) defines the 1,000-energy capacity
  and 10-energy action cost already enforced by the original migration path; #393 does not
  reinterpret stock or operational readiness. Official
  [`StructureSpawn`](https://docs.screeps.com/api/#StructureSpawn) defines the 300-energy capacity,
  5,000 hits, and creep-production service already enforced by the original spawn migration path;
  #395 does not reinterpret stock, activity, or spawn-slot readiness. Official
  [`StructureLink`](https://docs.screeps.com/api/#StructureLink) defines the 800-energy capacity and
  cooldown-governed native transfer already enforced by the original reserve-link migration path;
  #397 does not reinterpret stock, cooldown, role, or transfer readiness. Official
  [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer) defines the walkable
  2,000-unit general-purpose Store and decay-bearing local service already enforced by the original
  container migration path; #399 does not reinterpret stock, selected service, decay, or replacement
  readiness. Official [`StructureLab`](https://docs.screeps.com/api/#StructureLab) defines the RCL8
  allowance of ten, 3,000-mineral/2,000-energy capacities, range-two reaction geometry, cooldown
  behavior, and 30-mineral/20-energy boost cost already enforced by lab migration and Industry; #401
  does not reinterpret any stock, destination, assignment, reaction, boost, or replacement
  readiness. Official [`StructureTerminal`](https://docs.screeps.com/api/#StructureTerminal) and
  [`Store`](https://docs.screeps.com/api/#Store) define the one-per-room RCL6+ terminal,
  300,000-unit shared capacity, resource rows, and cooldown already enforced by terminal migration;
  #403 does not reinterpret stock, delivery, endpoint retirement, Industry quiescence, or storage
  continuity. Official [`StructureStorage`](https://docs.screeps.com/api/#StructureStorage) defines
  the one-per-room 1,000,000-unit general-purpose Store; #405 retains exact current terminal
  capacity and activity plus resource-specific Store conservation before clearing completed storage
  evidence. Settlement consumes newer observation only; neither settlement nor handoff reaches a
  command boundary.
- Screeps Wiki [index](https://wiki.screepspl.us/Main_Page/),
  [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/),
  [`StructureLink`](https://wiki.screepspl.us/StructureLink/),
  [`StructureSpawn`](https://wiki.screepspl.us/StructureSpawn/), and
  [`StructureTower`](https://wiki.screepspl.us/StructureTower/),
  [`StructureLab`](https://wiki.screepspl.us/StructureLab/),
  [`StructureStorage`](https://wiki.screepspl.us/StructureStorage/),
  [Energy](https://wiki.screepspl.us/Energy/), and
  [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) provide layout, link, spawn,
  tower, lab, local-inventory, hauling, and container-service terminology only. The MYRMEX owner,
  handoff, access, and command boundaries are independently defined by repository contracts.
