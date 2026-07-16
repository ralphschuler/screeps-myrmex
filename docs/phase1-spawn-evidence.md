# Phase 1 Spawn Authority Evidence

Evidence version: `phase1-spawn-v1`

Primary slice: [issue #24](https://github.com/ralphschuler/screeps-myrmex/issues/24)

This document is the evidence contract for deterministic body construction, exclusive spawn-slot
arbitration, narrow command execution, and atomic colony-budget settlement. CI is authoritative for
the referenced commit. This slice schedules the zero-worker emergency recovery body; it does not by
itself implement harvesting, filling, movement, proactive replacement, or the complete Phase 1 exit.

## Outcome matrix

| Outcome                                                              | Evidence                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Official part costs/order and three ticks per part                   | `spawn-body-builder.test.ts`                                            |
| Canonical `WORK,CARRY,MOVE` body costs 200 and takes nine ticks      | `spawn-body-builder.test.ts`, `spawn-broker.test.ts`                    |
| Current-energy shortage differs from terminal body impossibility     | `spawn-body-builder.test.ts`, `spawn-broker.test.ts`                    |
| Body, energy, movement-ratio, and 50-part limits fail closed         | `spawn-body-builder.test.ts`                                            |
| Emergency/replacement ordering and stable tie-breakers are fixed     | `spawn-broker.test.ts`                                                  |
| Reordered and byte-equivalent demand inputs produce identical output | `spawn-broker.test.ts`, `phase1-spawn.test.ts`                          |
| Conflicting reuse of one demand identity authorizes neither request  | `spawn-broker.test.ts`                                                  |
| Two spawns share one current room-energy pool                        | `spawn-broker.test.ts`, `phase1-spawn.test.ts`                          |
| Only active, idle, local spawns receive exact half-open claims       | `spawn-broker.test.ts`                                                  |
| Live creeps, spawning names, and durable expectations suppress retry | `spawn-broker.test.ts`, `phase1-spawn.test.ts`                          |
| Missing observation retries only after the bounded expectation       | `spawn-broker.test.ts`                                                  |
| Name collisions and all input/work caps defer or fail closed         | `spawn-broker.test.ts`                                                  |
| Every documented `spawnCreep` code becomes one typed result          | `spawn-executor.test.ts`                                                |
| Live mismatch, malformed code, and thrown adapters never escape      | `spawn-executor.test.ts`                                                |
| One validated intent issues the exact body/name exactly once         | `spawn-executor.test.ts`                                                |
| Two intents for one spawn reject the whole batch before resolution   | `spawn-executor.test.ts`                                                |
| Body energy and duration must agree with the command body            | `spawn-executor.test.ts`                                                |
| Exact grant remains private until same-tick command settlement       | `colony-director.test.ts`, `tick.test.ts`                               |
| Scheduled cost is consumed atomically and unused grant is released   | `colony-director.test.ts`, `tick.test.ts`                               |
| Unscheduled commands release exact energy/spawn authorization        | `colony-director.test.ts`, `tick.test.ts`                               |
| Zero-creep 199 energy issues no command or exact spawn grant         | `tick.test.ts`                                                          |
| Exact legal current target suppresses retry; damaged target defers   | `spawn-broker.test.ts`                                                  |
| Declared predecessor cannot satisfy its distinct successor demand    | `spawn-broker.test.ts`, `tick.test.ts`                                  |
| Failed runtime scheduling backs off then advances one name revision  | `tick.test.ts`                                                          |
| Execute CPU overrun still reaches mandatory settlement and commit    | `tick.test.ts`                                                          |
| One colonies transaction precedes one normal root commit             | `tick.test.ts`, `architecture-boundaries.test.mjs`                      |
| Canonical broker/executor and sole command/ledger authorities hold   | `architecture-boundaries.test.mjs`, production bundle checks in `check` |
| `phase1.spawn` is available only through its colony prerequisite     | `runtime-config.test.ts`, `phase1-config.test.ts`, `tick.test.ts`       |
| Warm/reset/reordered replay preserves spawn outcome bytes            | `phase1-spawn.test.ts`                                                  |

The named tests assert outcomes rather than imports. All broker and executor outputs are detached,
recursively immutable data, so input reordering and heap reconstruction cannot change selection or
result bytes.

The scenario replay proves the 300-versus-400 shared-energy outcomes under reversed room, spawn, and
demand collections. Its second scenario reconstructs both broker and executor heap state while
carrying the serialized exact-name expectation between ticks; it preserves the same outcome hash and
issues no duplicate command. The scenario deliberately does not emulate Memory settlement. Runtime
derivation of that expectation from the terminal colony-ledger entry is proved separately by
`tick.test.ts`.

## Demand and arbitration contract

`SpawnDemand` contains a stable ID and revision, issuer, owner colony, category, numeric priority,
earliest tick, inclusive deadline, destination, optional replacement name, BudgetLedger ID, required
body-part counts, energy cap, and either an explicit creep-name basis or the generated identity
basis.

The broker category order is:

1. `emergency-recovery`;
2. `replacement`;
3. `upgrading`; and
4. `construction`.

Within a category, higher numeric priority wins, followed by earlier deadline, lower required body
energy, and demand ID. Byte-identical repeats under one demand ID collapse to one logical demand;
different canonical terms under one ID produce `identity-conflict` and no selection.

For a generated recovery name, identity is exactly
`(demand ID, issuer, colony ID, demand revision)`. The logical triple is represented by a fixed
eight-hex hash and the durable revision by an explicit base-36 suffix, so consecutive recovery
generations are distinct while a terminal BudgetLedger entry can reconstruct the exact bounded name
after a JSON round trip or heap reset. Budget ID remains excluded. Generated names have exactly one
candidate and are never collision-suffixed; only an explicit caller-selected `nameBasis` receives
configured bounded suffix candidates. The revision suffix is recovery-specific: other generated
categories retain the logical hash across budget-only revisions.

The issue #24 runtime producer emits only the derived `colony/<room>/restore-workforce` emergency
demand. It requests one active `WORK`, `CARRY`, and `MOVE`, uses the currently visible owner room as
both colony and destination, and cannot borrow a remote spawn. Generic later categories are already
bounded arbitration vocabulary, not active economy or replacement producers.

Eligible spawns are current owned snapshot entries with `active === true` and `spawning === null`.
They are canonicalized by room, spawn ID, and spawn name. The broker starts each room with exactly
one `Room.energyAvailable` balance and debits every selection from it. Therefore:

| Current energy | Idle local spawns | 200-energy selections |
| -------------: | ----------------: | --------------------: |
|            199 |                 1 |                     0 |
|            300 |                 2 |                     1 |
|            400 |                 2 |                     2 |

Each selection owns one spawn for `[tick, tick + spawnTicks)`. A three-part recovery body has
`spawnTicks = 9`.

## Body construction contract

The builder accepts all official body types in this canonical order:

`TOUGH, WORK, CARRY, ATTACK, RANGED_ATTACK, HEAL, CLAIM, MOVE`

| Part            | Energy |
| --------------- | -----: |
| `TOUGH`         |     10 |
| `WORK`          |    100 |
| `CARRY`         |     50 |
| `ATTACK`        |     80 |
| `RANGED_ATTACK` |    150 |
| `HEAL`          |    250 |
| `CLAIM`         |    600 |
| `MOVE`          |     50 |

Explicit `MOVE` parts are never removed. If required non-`MOVE` parts exceed the configured ratio,
the builder adds the minimum required `MOVE` count, then applies the 50-part engine maximum, policy
part maximum, room energy capacity, policy energy maximum, and current available energy in that
order. Current-energy shortage is `deferred`; a request that cannot fit capacity or configured
limits is `impossible`; malformed demand or policy data is `invalid`.

## Atomic authorization and settlement

The colony director remains the only constructor and owner of `BudgetLedger`. Spawn planning uses
two views in one Plan phase:

1. a provisional director session exposes the derived recovery objective and available energy/CPU;
2. the broker selects a body and spawn from that immutable view;
3. a new exact director session re-arbitrates the selected body cost, exact spawn interval, and CPU
   as one bundle; and
4. only a selection whose exact grant matches every field becomes a command intent.

The exact replacement owner is not exposed or staged before execution. `spawn.execute` stores its
immutable results in a private tick draft. The immediately following mandatory-tail `spawn.settle`
validates the complete same-tick settlement set before touching the ledger.

For the default 300-energy recovery case:

```text
exact grant: energy 300, spawn [tick, tick + 9), CPU 100
spawnCreep OK: consume energy 200 + spawn true + CPU 100; release unused energy 100
spawnCreep not scheduled: consume nothing; release the exact grant
```

The terminal entry preserves the exact request and cumulative actuals. The owner revision advances
at most once. `spawn.settle` stages at most one `colonies` transaction, and `state.reconcile`
performs the one `Memory.myrmex` root commit. Contract reconciliation runs after spawn settlement,
so a consumed or released recovery authorization cannot be mistaken for active contract funding.

Both `spawn.execute` and `spawn.settle` are mandatory Execute-tail systems. If the command call
returns `OK` and pushes execution over its CPU budget, the kernel may mark `spawn.execute` failed at
its budget boundary and discard its publication, but it does not erase the private result.
`spawn.settle` still consumes and releases the grant, stages the sole colonies transaction, and
publishes the honest command outcome for the root commit.

## Command boundary

Before calling the command, `SpawnExecutor` resolves the selected ID and verifies:

- the object exists and is a spawn;
- ID, spawn name, and room name still match the intent;
- the spawn is owned, idle, and active; and
- `spawnCreep` is callable.

The executor validates and canonicalizes the complete batch first. Duplicate intent IDs, a body
whose declared energy/duration does not match official mechanics, or two intents targeting one spawn
ID reject the whole batch before resolver or command access. Only then does it call
`spawnCreep(body, name)` once per surviving command. Results are:

| Screeps code              | Numeric | Typed outcome                   |
| ------------------------- | ------: | ------------------------------- |
| `OK`                      |       0 | scheduled                       |
| `ERR_NOT_OWNER`           |      -1 | rejected: `non-owner`           |
| `ERR_NAME_EXISTS`         |      -3 | rejected: `name-collision`      |
| `ERR_BUSY`                |      -4 | rejected: `busy`                |
| `ERR_NOT_ENOUGH_ENERGY`   |      -6 | rejected: `insufficient-energy` |
| `ERR_INVALID_ARGS`        |     -10 | rejected: `invalid-arguments`   |
| `ERR_RCL_NOT_ENOUGH`      |     -14 | rejected: `inactive`            |
| other finite number       |       — | failed: `unknown-code`          |
| non-finite or non-numeric |       — | failed: `invalid-return-code`   |
| thrown adapter boundary   |       — | failed: bounded `adapter-fault` |

A live-object mismatch is rejected before the API call. Results retain the immutable cloned command
and a nonnegative measured CPU delta. Intents are sorted by stable intent ID, and a fault in one
does not suppress later intents.

## Reset and observation contract

`OK` means the command was scheduled; it does not mean the new creep is already available in the
same observation. The successful terminal BudgetLedger entry is therefore also durable expectation
evidence when all of these are true:

- category is `emergency-spawn`;
- the request contains the exact spawn interval; and
- cumulative consumption records `spawn: true`.

The tick-local `SpawnExpectation` contains demand ID/revision, spawn ID, exact `creepName`,
scheduled tick, expected-ready tick, and retry tick. It is rederived after reset from the terminal
entry plus its logical recovery identity and durable demand revision; no separate expectation record
is persisted. The exact name is therefore reproducible even though it is not duplicated inside the
owner schema.

If an already-running deployment exposes the previous logical-only recovery name, reconstruction
adopts it only while that exact name is observed as a creep or spawn activity. It prefers the
current revision-qualified name when both are observed and otherwise defaults to current format.
This second value is observation-only and is never submitted as a new generated-name candidate.
Runtime first derives at most two candidates per bounded terminal recovery entry, then retains only
matching names while scanning the snapshot.

The expectation is keyed by stable demand ID rather than only its current revision. It blocks retry
until `max(expectedReadyAt, request.expiresAt)`. Observation of its exact `creepName` marks the
demand satisfied only when the creep still has every active capability required by the demand,
including policy-required movement, and is not the demand's declared predecessor. The runtime
reconstructs a previously scheduled incumbent from its terminal revision when possible and otherwise
chooses the deterministic last-surviving expiring WCM worker. That predecessor cannot satisfy the
revision-qualified successor demand. Visible spawning defers only when the activity carries the
expected successor name, even when `remainingTime` is zero because the completed creep may still be
blocked from exiting. A damaged creep under the current successor name remains a bounded collision;
an observed predecessor instead permits the distinct current generation to proceed.

A command that did not schedule leaves a released exact entry with `spawn: false`. Its `updatedAt`
anchors the configured bounded retry delay; it does not become a success expectation. The next
admitted revision reconstructs one new bounded name without collision retries, so a failed attempt
cannot reserve or satisfy its successor generation.

## Runtime recovery matrix

| Beginning-of-tick evidence                                | Required outcome                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Zero workers, idle active spawn, 199 current/300 capacity | one blocked objective; no broker demand, exact spawn grant, resolver, or command |
| Prior pending 199 reservation, then 300 after heap reset  | broker, exact grant, command name, and terminal entry bind to one new revision   |
| Pending entry across two unrelated policy revisions       | exact binding uses the latest colony revision; admission does not diverge        |
| Zero legal workers, idle active spawn, 300 current energy | one WCM command; consume 200/CPU/spawn and release unused 100                    |
| Prior `OK`, exact generated creep now present and legal   | no recovery objective and no second command                                      |
| Prior `OK`, generated incumbent reaches handoff boundary  | one distinct revision-qualified successor; incumbent cannot satisfy its demand   |
| Prior `OK`, exact generated creep present but damaged     | one distinct recovery generation; no false satisfaction by the damaged incumbent |
| Failed command, retry delay not elapsed                   | stable `not-before`; no duplicate command                                        |
| Failed command, retry delay elapsed                       | one reconstructible bounded name at the next durable revision                    |
| Previous-format name spawning beside another idle spawn   | adopt only the observed name and defer; no duplicate command                     |
| Prior `OK`, command execution exceeds its admitted CPU    | `spawn.execute` budget fault; `spawn.settle` still persists exact consumption    |
| Two validated intents target the same spawn ID            | deterministic whole-batch rejection before any live resolution or API command    |

The 199 case differs intentionally from a direct broker unit test at 199: runtime provisional
BudgetLedger planning cannot fund the 200 minimum, so it emits no `SpawnDemand` and preserves the
single pending/blocked objective. The pure broker still exposes `insufficient-energy` when called
directly with such a demand.

## Hard budgets

| Area                                     | Limit |
| ---------------------------------------- | ----: |
| Raw spawn demands per broker pass        |   128 |
| Logical demands per broker pass          |    64 |
| Owned spawns inspected                   |    64 |
| Demand/spawn pair work                   | 4,096 |
| Durable expectations inspected           |   128 |
| Observed owned creep names               | 4,096 |
| Explicit-base collision suffix attempts  |    10 |
| Spawn command intents per executor batch |   128 |
| Commands targeting one spawn per batch   |     1 |
| Body parts per command                   |    50 |
| Creep-name UTF-16 code units             |   100 |
| General command text UTF-16 code units   |   256 |
| Exact spawn interval                     |   150 |
| Colony recovery selections/objective IDs |    64 |
| Same-tick command settlement records     |   256 |

Caps are checked before pair expansion or live-object resolution. Batch-invalid structural input
returns no partial selections. Per-demand invalid, impossible, and deferred outcomes are typed and
bounded.

## Decision vocabulary

Broker batch failures are `invalid-input`, `invalid-policy`, `invalid-expectation`,
`raw-demand-cap-exceeded`, `logical-demand-cap-exceeded`, `spawn-cap-exceeded`,
`pair-work-cap-exceeded`, and `observed-name-cap-exceeded`.

Per-demand outcomes distinguish:

- satisfaction: `observed-creep`;
- transient deferral: `observed-spawning`, `expectation-pending`, `not-before`,
  `local-room-unobserved`, `no-idle-spawn`, `insufficient-energy`, and `name-collision-exhausted`;
- terminal impossibility: expired or inconsistent deadline, unsupported remote destination, body
  impossibility, and tick overflow; and
- invalid input: identity conflict, malformed demand/name basis, or invalid body input.

## Feature activation and authority guards

Issue #24 advances the config source to `runtime-config-source-v4` and makes `phase1.spawn`
available with `phase1.colony` as its source-controlled prerequisite. Operational Memory may disable
it but cannot enable a missing prerequisite or any later gate. A source-v3 receipt is incompatible:
a present candidate is revalidated under v4, while a null candidate with only stale evidence uses
source defaults without rewriting operator bytes.

Static architecture checks require:

- exactly one `SpawnBroker` at `spawn/spawn-broker.ts`;
- exactly one `SpawnExecutor` at `spawn/spawn-executor.ts`;
- no `spawnCreep` direct, destructured, aliased, bound, `call`, or `apply` invocation elsewhere;
- live spawn collection only in observation and narrow ID resolution only in composition;
- `BudgetLedger` construction only inside the canonical colony authority;
- exactly one literal `colonies` transaction call site; and
- exactly one root reconciliation commit call site.

The root remains schema v3 and `colonies` remains owner-local schema v1. No spawn queue or separate
energy ledger is persisted.

## Mechanics sources

The behavior and boundary tests were constrained by these official sources:

- [StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep) defines the
  body/name request, validation limits, scheduling return codes, energy use, and spawn duration.
- [StructureSpawn.spawning](https://docs.screeps.com/api/#StructureSpawn.spawning) and
  [StructureSpawn.Spawning](https://docs.screeps.com/api/#StructureSpawn.Spawning) define the
  current spawn activity, requested creep name, total need, and remaining time.
- [Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable) defines the current
  shared spawn/extension pool;
  [Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable) defines
  its maximum capacity rather than spendable current energy.
- [Creep bodies and spawning](https://docs.screeps.com/creeps.html) defines body costs, the 50-part
  limit, and three-ticks-per-part construction time.
- [Constants](https://docs.screeps.com/api/#Constants) defines the normalized result codes.
- [Simultaneous actions](https://docs.screeps.com/simultaneous-actions.html) explains deferred
  intent processing and why the following observation, not the command call alone, confirms the
  resulting world state.

The Screeps engine's
[`structures.js`](https://github.com/screeps/engine/blob/master/src/game/structures.js) and
[`create-creep.js`](https://github.com/screeps/engine/blob/master/src/processor/intents/spawns/create-creep.js)
were inspected for command validation and intent-processing context. Maintained community context
comes from [StructureSpawn](https://wiki.screepspl.us/StructureSpawn/) and
[creep body setup strategies](https://wiki.screepspl.us/Creep_body_setup_strategies/). Official API
semantics remain authoritative.

## Repository gate

The required command is:

```bash
npm run check
```

It must pass formatting, lint, both TypeScript projects, all deterministic tests, Markdown, the
production bundle graph check, and package staging. GitHub Actions on the issue #24 pull request is
the final merge evidence. The broader Phase 1 recovery exit remains open until the economy, agent,
movement, and follow-up recovery outcomes are proved.
