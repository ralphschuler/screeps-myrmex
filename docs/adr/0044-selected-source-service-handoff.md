# ADR 0044: Selected source-service handoff

## Status

Accepted

## Context

Issue #302 gives one persisted source-service position continuity precedence. This prevents a new
container observation from changing the executable terms of the stable `mining/{room}/{source}`
contract, but it also leaves a source drop-mining on the old tile after its selected container
disappears. It also prevents convergence when a later-built exact reachable container strictly
outranks the selected exact container under the existing canonical source-service policy.

Changing the work position under issuer sequence 1 is correctly rejected by `ContractLedger` as an
idempotency conflict. Submitting sequence 2 while sequence 1 still owns the same BudgetLedger
binding is also correctly rejected. Retiring sequence 1 before validating sequence 2 would create a
partial handoff if successor admission failed.

## Decision

- `LayoutPlanner` remains the sole source-service selection and persistence authority. A selected
  matching site remains pinned. A selected tile whose container is absent may switch only to a
  different current exact legal and reachable container for the same source. Issue #306 also permits
  a selected exact container to switch only when a different current exact candidate strictly
  precedes it under the existing adoption, route-distance, terrain, y, and x ordering. A worse or
  equal candidate cannot advance the coordinate, preventing oscillation while both containers
  remain. Every structurally valid persisted source-service position stays reserved to its source
  during the bounded selection pass, so overlapping adjacent candidate sets cannot steal another
  source's executable service.
- Runtime composition authorizes that switch only from fresh visible ownership with no active threat
  or controller risk, a legal workforce, and restored protected spawn reserve. Missing, stale,
  malformed, unsafe, or non-exact evidence preserves the prior executable terms or fails closed.
- A source service has one optional positive safe-integer `issuerSequence`. Absence means initial
  sequence 1; persisted values begin at 2 and advance exactly once per authorized position change.
  Selection remains bounded to eight adjacent candidates per source.
- The layouts owner advances to schema V4. Valid V1-V3 records migrate without inventing a handoff
  coordinate. A legacy-version record that already contains the V4 field is rejected. Older code
  sees V4 as future and preserves its bytes.
- `StaticMiningPlanner` converts an exact next coordinate into one typed
  `ContractReplacementRequest`; it does not issue commands or mutate either owner.
- The existing bounded contract channel counts a replacement as one request and one transition.
  `ContractLedger` atomically validates the predecessor, same issuer/key/kind/target/owner/funding
  binding, and exact next sequence; it then retires the predecessor and creates the successor. Any
  transition or submission failure restores byte-identical predecessor state and quota counters.
- The predecessor execution view remains available while the new layout coordinate commits. On the
  following tick, `StaticMiningPlanner` consumes that durable coordinate; the successor is funded
  and eligible for assignment in the same Reconcile pass that atomically retires the predecessor.
  Thus persistent contract state contains exactly one extraction commitment and never a partially
  retired binding.
- `layout.handoff-reconcile` is a narrow continuation of the existing layout owner, not a new
  authority. Only on a selected-service handoff does it reconcile the complete layout draft and
  stage that owner before `state.reconcile`; the regular mandatory-tail `layout.reconcile` then
  publishes the already-reconciled draft. This makes the next issuance coordinate durable for the
  following tick without changing ordinary layout timing.
- No destroy, harvest, movement, spawn, or hauling command path is added.

## Consequences

A source can move from a vanished selected container or a still-existing selected exact container to
one strictly preferred exact replacement without an idempotency or funding-binding conflict,
duplicate extraction commitment, durable zero-contract state, ranking oscillation, or cross-source
service theft. The same actor may be reassigned by the existing allocator; movement and action
arbiters retain command authority.

The layouts owner gains at most one optional integer per selected source inside its existing
64-room/eight-service bounds. Rollback to V3 disables layout work while preserving V4 bytes;
redeploying V4 resumes. Stock movement, old-container removal, other structure classes, and creep
dismantling remain issue #99.

## Mechanics sources

- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest): the source must be
  adjacent, and resource without free carry capacity drops on the creep's current tile.
- Official [`StructureContainer`](https://docs.screeps.com/api/#StructureContainer): containers are
  walkable, hold 2,000 units, and receive resources dropped on their tile.
- Official [`Source`](https://docs.screeps.com/api/#Source).
- Official [Screeps documentation index](https://docs.screeps.com/) reviewed 2026-07-19.
- Screeps Wiki [Static Harvesting](https://wiki.screepspl.us/Static_Harvesting/) supplies stationary
  miner/container terminology and notes that a replacement miner must reach its assigned container.
- Screeps Wiki [Automatic Base Building](https://wiki.screepspl.us/Automatic_base_building/)
  supplies layout-convergence terminology only. MYRMEX policy remains independently source-defined.
