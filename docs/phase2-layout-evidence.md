# Phase 2 layout and construction-site evidence

Issue [#45](https://github.com/ralphschuler/screeps-myrmex/issues/45) establishes the complete
layout-to-construction authority chain without authorizing dismantling.

## Runtime order

1. `world.observe` publishes one immutable normalized snapshot.
2. `colony.director` publishes lifecycle, RCL policy, progression, and budget authority.
3. `layout.plan` plans at most two visible owned rooms, persists only complete commitments, diffs
   against the same snapshot, and invokes pure site arbitration.
4. `layout.execute` alone resolves a live room and calls `Room.createConstructionSite`.
5. `layout.reconcile` converts results to bounded fingerprinted receipts and stages `layouts`.
6. `state.reconcile` atomically commits layouts with the other staged owners.
7. A following tick's `growth.contracts` turns each visible owned site into at most one funded build
   contract under existing controller, maintenance, recovery, and reserve precedence.

Planning is optional and fails closed under CPU pressure. Execution and receipt reconciliation are
mandatory tails. Unknown/lost rooms, disabled or blocked gates, denied progression, stale
fingerprints, occupancy conflicts, and global or room pressure authorize no command.

## Fixed bounds

- two planned rooms per tick;
- 256 anchors, eight transforms, and 2,500 flood cells per candidate;
- official site cap 100 with five reserved slots;
- two accepted globally and one per room per tick;
- 64 inspected proposals and ten active sites per room;
- 32 receipts per room;
- `OK` expectation retry capped at 32 ticks, `ERR_FULL` at 100, and unexpected faults at 64.

## Outcome evidence

Focused tests cover one-call execution, next-tick duplicate suppression, every documented return
code, adapter isolation, stale/ownership/loss guards, cap pressure, complete/degraded commitments,
durable reset-safe receipts, reorder equivalence, no dismantling, mandatory runtime tails, and
mature-structure build publication. `npm run check` supplies repository-wide format, lint, type,
test, documentation, bundle, and package evidence.

## Mechanics sources

- Official
  [`Room.createConstructionSite`](https://docs.screeps.com/api/#Room.createConstructionSite)
  documents return codes and the 100-site player cap.
- Official [`ConstructionSite`](https://docs.screeps.com/api/#ConstructionSite) defines the observed
  object consumed by build work.
- Official [Control guide](https://docs.screeps.com/control.html) constrains RCL structure access.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  provides community operational context only; MYRMEX remains clean-room and source-defined.
