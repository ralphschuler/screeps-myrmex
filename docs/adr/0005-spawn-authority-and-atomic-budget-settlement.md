# ADR 0005: Spawn Authority and Atomic Budget Settlement

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

The Phase 1 colony slice can derive and provisionally fund one zero-worker recovery objective, but a
provisional energy grant is not enough to issue a legal spawn command. Spawn selection must account
for all idle spawns and the one room-wide current energy pool, body construction must obey engine
limits, and the command result must be reconciled without persisting a grant that did not schedule
work.

Screeps command timing creates a second problem. `StructureSpawn.spawnCreep` returns whether the
request was scheduled; the new creep is observed later. A global heap reset or an observation gap
between those events must not cause a second recovery order. Conversely, a rejected command must not
leave energy or spawn time reserved indefinitely.

Giving the spawn system its own energy ledger, persistent queue, or direct `colonies` write would
split the existing `BudgetLedger` and `ColonyDirector` authorities. Staging the provisional owner
before Execute would also require a second owner mutation to record actual consumption, violating
the one-transaction and one-root-commit design.

## Decision

### Spawn arbitration

`SpawnBroker` under `packages/bot/src/spawn/` is the sole spawn-slot, body, and creep-name arbiter.
It is a pure, bounded function over immutable demands, the current `WorldSnapshot`, source-resolved
spawn policy, and durable command expectations supplied by the colony owner. It owns no persistent
queue, reservation ledger, world cache, or live Screeps object.

The broker collapses byte-equivalent submissions with the same demand ID and rejects conflicting
terms under one ID. It sorts logical demands by:

1. category: emergency recovery, replacement, upgrading, then construction;
2. descending numeric priority;
3. ascending deadline;
4. ascending required energy; and
5. stable demand ID.

Only active, owned, local, idle spawns are eligible. They are sorted by stable spawn ID and name.
All selected commands in one room debit one tick-local copy of `Room.energyAvailable`; multiple
spawns do not each receive the full room balance. A selection contains the exact body cost and the
half-open spawn claim `[tick, tick + 3 * bodyParts)`.

The pure body builder uses the official body-part costs, canonical part ordering, the configured
non-`MOVE`-parts-per-`MOVE` ratio, and both policy and engine limits. It distinguishes temporary
current-energy shortage from terminal capacity, energy-policy, part-count, and movement-policy
impossibility. It never scales an impossible request silently.

Generated recovery names encode `(demand ID, issuer, colony, demand revision)`: a fixed hash of the
logical triple plus the durable revision in base 36. The revision distinguishes each successor
generation and remains available in the terminal demand record after reset; rotating budget IDs and
behavioral roles remain excluded. Revision qualification is restricted to emergency recovery;
generic generated-name producers retain one logical name across budget-only revisions. Generated
names never receive a collision suffix. An explicit caller-chosen name basis may use configured
bounded suffix attempts. The broker checks observed and in-progress names, reserves every chosen
name within the batch, and never treats a demand's declared predecessor as satisfaction of that
successor demand.

### Exact colony authorization

The runtime derives the issue #24 emergency-recovery demand from the director's provisional
restore-workforce objective. A selected body and spawn interval are then passed back into a
tick-local `ColonyDirectorSession`. The director re-arbitrates energy, spawn time, and its admitted
CPU as one exact `BudgetLedger` request. Only a selection backed by that exact active grant becomes
a `SpawnCommandIntent`. If attaching the spawn claim advances a retained provisional request, the
director projects the resulting revision and reservation ID into the broker demand, then derives and
checks both values again during exact admission. The broker-selected name, executed command, exact
grant, and terminal record therefore share one revision after pending-to-funded, busy-to-idle, and
heap-reset transitions. The projection uses the same maximum of the current colony-record revision
and the prior ledger revision plus one as exact request construction, including when unrelated
policy changes advanced the colony while its energy-denied reservation remained pending.

The session keeps its replacement owner private until command settlement. External callers cannot
submit the reserved `colony/<room>/restore-workforce` issuer identity, and a selection that does not
match a current recovery objective fails closed. A session is valid only for its planning tick. An
identical settlement retry is idempotent; a different second settlement is rejected.

At the default 300-energy recovery budget, the canonical `WORK,CARRY,MOVE` body costs 200 energy and
occupies the spawn for nine ticks. The exact atomic grant may reserve the 300-energy desired amount,
the nine-tick spawn interval, and the director's admitted CPU units. If the command schedules, the
ledger atomically records actual energy 200, the CPU grant, and spawn use, then releases the unused
100 energy. If it does not schedule, the exact reservation is released with no spawn or energy
consumption.

### Command execution and results

`SpawnExecutor` under `packages/bot/src/spawn/` is the only runtime code allowed to call
`StructureSpawn.spawnCreep`. It receives validated data intents and a narrow live-object resolver.
Immediately before issuing each command it checks structure type, object ID, spawn name, room,
ownership, busy state, and activity. It issues the selected body and name exactly once per intent
and records measured CPU.

Before resolving any live object, the executor canonicalizes the whole batch and rejects duplicate
intent IDs, inconsistent body cost or duration, and any batch that targets one spawn ID more than
once. Duplicate-slot rejection is deterministic under input reordering and issues no partial
commands.

The executor normalizes every documented `spawnCreep` result used by this API:

|  Code | Executor reason       |
| ----: | --------------------- |
|   `0` | `scheduled`           |
|  `-1` | `non-owner`           |
|  `-3` | `name-collision`      |
|  `-4` | `busy`                |
|  `-6` | `insufficient-energy` |
| `-10` | `invalid-arguments`   |
| `-14` | `inactive`            |

Missing or mismatched live objects produce typed live-spawn rejections without a command. Unknown or
malformed return values and thrown resolver, property, activity, or command boundaries become
bounded failures; one fault does not suppress later deterministic intents.

### Reconciliation, reset, and persistence

`spawn.execute` and the immediately following `spawn.settle` are separate mandatory Execute-tail
systems. Execution records results in a private tick draft before publishing them. `spawn.settle`
settles the director session and stages at most one literal `colonies` transaction; operational
contract reconciliation runs afterward in Reconcile. `state.reconcile` remains the only normal root
commit. The provisional owner is never staged, and one tick advances the colonies owner revision at
most once. Discard or root-commit failure clears the published colony and spawn results.

The separation is required because a Screeps command is irreversible even if `spawn.execute`
subsequently exceeds its kernel CPU estimate and its staged publication is discarded. The private
result survives that system boundary, mandatory-tail `spawn.settle` records the acknowledged command
and actual consumption, and the sole root commit persists it. Contract reconciliation is allowed to
run only after settlement was staged.

This supersedes only ADR 0003's composition detail that the director's Plan result could stage the
`colonies` transaction directly. ADR 0003's lifecycle, ledger, owner schema, and sole-authority
decisions remain in force; staging moves later so irreversible command evidence and budget
consumption enter one owner draft.

A successful command is represented durably by the existing terminal ledger entry: its exact spawn
request remains present and cumulative consumption records `spawn: true`. No new owner schema, spawn
queue, or expectation store is introduced. On any heap reconstruction, the runtime derives a bounded
`SpawnExpectation`, including the exact `creepName`, from that entry. The name is reproducible
because the recovery demand's stable issuer, colony identity, and demand revision are durable; the
generated-name function excludes only the rotating budget ID.

During rollout from the previously deployed logical-only name format, expectation reconstruction
prefers the current revision-qualified name when it is observed, accepts the one logical-only name
only when that exact creep or spawn activity is visible, and otherwise reconstructs the current
name. The observed fallback is never offered as a fresh broker candidate, so it cannot widen name
allocation or become a permanent compatibility authority. Snapshot scanning retains only names in
the bounded two-candidate set derived from terminal recovery entries.

The exact-name expectation suppresses the same demand until the later of its expected spawn
completion and reservation expiry and applies across a recovery objective revision change. Current
observation supersedes it when that named creep is live or that exact name is visibly spawning; a
non-null matching `spawning` object remains busy even at `remainingTime === 0`. Unrelated activity
on the formerly selected spawn is not proof of the expected creep. At the bounded retry tick, an
observed exact-name creep satisfies the demand only if it retains every active required capability
and is not the declared predecessor. For proactive handoff, runtime reconstructs the previously
scheduled incumbent from its terminal revision when visible, with a canonical expiring-worker
fallback for preexisting or failed-attempt state. The current revision therefore publishes one
distinct successor. A damaged creep under the current target name remains a bounded collision.

A released exact entry with `spawn: false` records failed scheduling and supplies the configured
bounded retry delay. After that delay, the next durable revision reconstructs one new bounded name
without collision retries. This reuses the colony owner's bounded latest-issuer history rather than
creating another persistent authority.

Issue #24 makes `phase1.spawn` source-available with `phase1.colony` as its prerequisite and
advances the runtime configuration source to `runtime-config-source-v4`. This slice wires emergency
zero-worker recovery only. Proactive replacement timing, economy demand, agents, movement, and the
complete Phase 1 recovery exit remain separate outcomes.

## Consequences

- Two spawns with 300 shared room energy schedule one 200-energy recovery body; with 400 they may
  schedule two. Spawn count cannot multiply the energy budget.
- Emergency recovery and replacement have deterministic precedence over upgrading and construction,
  but priority never permits overcommitting energy, a spawn slot, or a name.
- A scheduled command and its exact budget consumption reach persistence together through one
  colonies transaction and one root commit; a rejected command leaves no active exact grant.
- A heap reset after `OK` does not duplicate the command while the durable expectation is live.
- An expiring generated incumbent cannot satisfy its revision-qualified successor demand; one
  successor is selected at the handoff boundary and remains deduplicated after reset.
- An `OK` result is settled even when command execution overruns its CPU estimate; mandatory
  settlement cannot be skipped between the irreversible API result and persistence.
- At 199 current energy, zero-creep recovery remains one blocked objective and issues no command or
  exact spawn grant. At 300 it issues the canonical 200-energy body once.
- Duplicate commands for one spawn slot fail the complete executor batch before live resolution.
- The root Memory schema and colonies owner-local schema do not change.
- Structural guards enforce the canonical broker/executor paths, the sole `spawnCreep` caller, the
  sole `BudgetLedger` construction boundary, and exactly one colonies transaction and root-commit
  call site.

## Mechanics Basis

The authoritative mechanics are the official Screeps references for
[StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep),
[StructureSpawn.spawning](https://docs.screeps.com/api/#StructureSpawn.spawning),
[StructureSpawn.Spawning](https://docs.screeps.com/api/#StructureSpawn.Spawning),
[Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable),
[Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable),
[body costs and spawn time](https://docs.screeps.com/creeps.html),
[constants](https://docs.screeps.com/api/#Constants), and
[simultaneous actions](https://docs.screeps.com/simultaneous-actions.html). Engine implementation
was checked against
[`structures.js`](https://github.com/screeps/engine/blob/master/src/game/structures.js) and
[`create-creep.js`](https://github.com/screeps/engine/blob/master/src/processor/intents/spawns/create-creep.js)
for validation and intent-processing context; official API behavior remains the contract.

The maintained Screeps Wiki pages on [StructureSpawn](https://wiki.screepspl.us/StructureSpawn/) and
[creep body setup](https://wiki.screepspl.us/Creep_body_setup_strategies/) provide operational
guidance without overriding the API.
