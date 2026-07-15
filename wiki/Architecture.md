# Architecture

MYRMEX is a deterministic modular monolith: one deployable bot, one runtime kernel, one CPU
scheduler, one persistent-state authority, one heap-cache authority, and one world-observation
pipeline.

Each tick runs:

`boot → observe → safety → plan → execute → reconcile → telemetry`

## Core integration model

1. `MemoryManager` validates versioned persistent state.
2. `RuntimeConfigAuthority` resolves source defaults and one validated operational candidate into a
   recursively immutable planner view.
3. `CacheManager` provides disposable, reconstructible heap-derived data.
4. `SegmentManager` schedules large optional data; no survival behavior depends on it.
5. `WorldObserver` creates one immutable snapshot of visible state.
6. `ColonyDirector` owns the room-survival lifecycle and `BudgetLedger` conserves local energy,
   spawn time, and kernel-admitted CPU before downstream work is funded.
7. Safety and domain planners read snapshots and explicit outputs, then emit typed contracts or
   intents.
8. Sole-authority arbiters resolve conflicts for spawn slots, creep actions, movement, structures,
   market actions, and military authorization.
9. Narrow executors alone call Screeps command methods.
10. `Reconciler` applies results through the owning state repositories.
11. `TelemetryService` records bounded decisions, costs, failures, and outcomes.

The executable substrate uses schema-v3 transactional Memory. The v2-to-v3 migration adds the
dedicated `config` owner, and interrupted historical v1-to-v2 migrations remain resumable before
chaining into v3. Runtime configuration is resolved during bounded Boot preflight and enters
`TickContext`; the raw candidate does not. Invalid candidates are rejected atomically, and malformed
or future config owners are preserved while source defaults keep the runtime safe. Fixed migration
metadata has a separate narrow transient allowance, but every projected final root must pass the
normal persistent cap; diagnostic evidence never displaces valid owner state.

Feature availability and prerequisites are source-controlled. Operational Memory may only disable a
known gate, never activate incomplete work. The proved `phase1.colony`, `phase1.contracts`, and
`phase1.spawn` gates are available under source v4, with contracts and spawn depending on colony;
later gates remain unavailable. Configured self, ally, and NAP identities are checked before
optional reputation and always remain excluded from targeting.

The schema-v3 `colonies` owner has an exact owner-local schema for durable lifecycle and bounded
ledger commitments. Exact `{}` initializes it. Malformed or future non-empty owners are preserved
and authorize no work. Losing room vision preserves state but authorizes nothing new; current
visible ownership loss enters terminal lost state and releases local reservations.

The Phase 0 substrate also provides one immutable tick-local world snapshot, recovery-aware CPU
admission, mandatory Execute/Reconcile/Telemetry tail systems, typed arbitration, a reconstructible
CacheManager, and a bounded deterministic replay matrix. Its versioned evidence is maintained in
`docs/phase0-evidence.md`; the Phase 1 config, colony, contract, and spawn matrices are in the
repository's `docs/phase1-*-evidence.md` files.

## Phase 1 spawn authority

`SpawnBroker` is the one pure authority for spawn slots, deterministic bodies, and creep names. It
reads immutable snapshot data and detached demands, owns no persistent queue or energy ledger, and
sorts emergency recovery before replacement, upgrading, and construction. Every selection debits the
room's one shared `energyAvailable` balance, so multiple spawns cannot each spend the full room
pool. Body construction applies official part costs, three ticks per part, the 50-part engine cap,
and configured energy/movement limits.

The broker's selected cost and exact half-open spawn interval return to the existing colony
`BudgetLedger` as one atomic energy/spawn/CPU request. Only an exact grant becomes a command intent.
`SpawnExecutor` is the only `spawnCreep` caller; it revalidates the live spawn and turns all API
codes or adapter faults into typed results. On `OK`, the ledger records actual body cost and spawn
use and releases unused grant. On rejection it releases the exact reservation without claiming
energy. Duplicate intents for one spawn reject the complete batch before live resolution. A separate
mandatory-tail `spawn.settle` preserves an acknowledged result even if command execution overruns,
stages the one `colonies` transaction, and runs before contract reconciliation. The state reconciler
still performs the only root commit.

Successful terminal ledger entries also provide bounded expectations across heap reset. They supply
the exact expected creep name by reapplying the stable logical recovery identity. Generated recovery
names never use suffix retries; explicit name bases retain bounded suffix attempts. The expectation
suppresses duplicates until that exact creep with every required active capability or exact spawning
name is observed, or its bound expires. A damaged same-name creep remains a bounded collision. No
new Memory schema or spawn queue is required. The full evidence is in
`docs/phase1-spawn-evidence.md`.

## Phase 1 contract foundation

Persistent work now has one owner: `ContractLedger`. It creates idempotent contract IDs from a
monotonic issuer sequence and issuer-local key, validates the lifecycle, owns assignment leases,
terminal outcomes, and bounded issuer retirement frontiers, and stages the `contracts` Memory
subtree. The root stays schema v3 while that owner uses its own schema v1. Only an exact empty
object initializes it; malformed or future owner data is preserved and faults closed. Evicting
compact outcome history cannot resurrect a retired issuance after heap reset.

Each contract keeps a stable BudgetLedger binding for its owner colony, category, and budget issuer.
The reconciler validates the current active reservation before funding or assignment; rotating
reservation revisions do not change contract identity, and one binding may back only one active
contract. Missing or terminal authorization suspends known work and removes a lease. Unknown colony
vision authorizes no new assignment while preserving the commitment. Disabled or
prerequisite-blocked contract gates do not parse or initialize the contracts owner.

`WorkforceAllocator` is a separate pure policy. It compares snapshot-derived active body parts,
known travel, deadlines, remaining life, and switching cost, then proposes deterministic matches for
the ledger to persist. It considers at most 64 contracts, 64 owned creeps, and 4,096 pairs per pass.
`Game.creeps` is the canonical owned-actor inventory, and no lease or task is mirrored into
per-creep Memory. New leases account for Reconcile occurring after Execute, while incumbent
feasibility deducts elapsed modeled work instead of recharging the full estimate each tick.
Pre-Execute travel observations are advanced by the modeled current Execute opportunity before
comparison with the lease schedule. Unknown travel is deferred until the movement slice supplies an
estimate.

The contract reconciler is operational work in the Reconcile phase. When admitted, it runs before
the mandatory state reconciler and after exact recovery-spawn settlement; the latter prevents a
consumed or released spawn grant from authorizing contract work. The state reconciler remains the
only root Memory commit. This foundation is one Phase 1 foundation slice—bootstrap economy,
proactive replacement, movement, and end-to-end zero-creep recovery remain separate roadmap
outcomes. Its evidence is maintained in `docs/phase1-contracts-evidence.md`.

Gameplay domains never call each other as hidden control flow. They coordinate through typed,
tick-local buffers and persistent contracts with explicit owners. Global heap resets, unavailable
segments, stale vision, command failures, and low CPU must degrade quality without breaking basic
survival.

The complete normative specification—including ownership tables, state machines, cache invalidation,
CPU admission, intent arbitration, failure recovery, module boundaries, and AI-agent implementation
rules—is maintained in
[`docs/architecture.md`](https://github.com/ralphschuler/screeps-myrmex/blob/main/docs/architecture.md).
