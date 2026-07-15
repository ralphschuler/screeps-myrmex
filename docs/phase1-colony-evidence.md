# Phase 1 Colony Lifecycle and Budget Evidence

Evidence version: `phase1-colony-v1`

Roadmap outcome: [issue #37](https://github.com/ralphschuler/screeps-myrmex/issues/37)

This document is the versioned evidence contract for the Phase 1 `ColonyDirector`, its durable
lifecycle, and the authoritative local `BudgetLedger`. CI is authoritative for the referenced
commit. The outcome creates explicit objective-funding decisions and reservations; it does not
execute spawning, creep actions, movement, construction, or combat.

## Authority and integration

`ColonyDirector` is the sole owned-room lifecycle and local-objective authority. `BudgetLedger` is
the sole authority for local energy, spawn-time, and abstract CPU reservations. Both live inside the
single deployable bot and share the global runtime kernel, CPU scheduler, world snapshot, state
manager, diplomacy policy, and executors.

The director reads only:

- the current immutable `WorldSnapshot`;
- the detached `colonies` owner;
- resolved `RuntimeConfig` and its feature-gate decision; and
- the `CpuMode` and `CpuBudget` supplied by `RuntimeKernel`.

It does not read `Game`, `Memory`, or `Game.cpu`, maintain a room cache, call another planner, or
issue a Screeps command. The runtime composition stages at most the `colonies` owner from the
director result. `state.reconcile` performs the one normal `Memory.myrmex` commit. A kernel fault or
overrun discards both the staged owner and the tick-local view.

The output is recursively immutable and uses sorted arrays, stable IDs, bounded reason codes, and
one decision for every normalized request. A planner later in the phase must consume that explicit
output rather than observe hidden mutation.

## Persistent owner

The root remains schema 3. Its existing `colonies` owner gains local schema version 1:

```ts
interface ColoniesOwnerV1 {
  schemaVersion: 1;
  revision: number;
  colonies: readonly ColonyRecordV1[];
  ledger: readonly LedgerEntryV1[];
}
```

A colony record contains its room name, state, state-entry tick, revision, policy revision, and
transition reason. One ledger entry retains the latest canonical request for an issuer key,
deterministic reservation ID, requested and granted claims, cumulative consumption, creation and
update ticks, request expiry, status, and reason. Terminal entries preserve revision high-water and
make retries idempotent without an unbounded event history.

Exact `{}` is the only initialization shorthand. A non-empty malformed or future owner is preserved
unchanged and returns no objectives or grants. Root-unavailable state likewise produces no owner
replacement. Validation is exact and all-or-nothing:

- values are plain enumerable JSON data;
- arrays are sorted, unique, and within their caps;
- numbers are finite nonnegative safe integers and negative zero is rejected;
- each grant stays within its request and cumulative consumption stays within the grant;
- intervals and expiry ticks are internally consistent;
- ledger entries reference an existing colony; and
- a lost colony has no active reservation.

### Structural limits

| Area                         | Limit                                   |
| ---------------------------- | --------------------------------------- |
| Colonies per owner           | 64                                      |
| Normalized requests per tick | 256                                     |
| Raw request inputs per tick  | 512                                     |
| Active reservations          | 256                                     |
| Latest issuer entries        | 512                                     |
| Ledger transitions per tick  | 1,024                                   |
| Claims per request           | 3: energy, spawn time, and abstract CPU |
| Room or colony ID length     | 64 UTF-16 code units                    |
| Issuer or spawn ID length    | 128 UTF-16 code units                   |
| Deterministic reservation ID | 384 UTF-16 code units                   |
| One requested spawn interval | 150 ticks                               |

An owner beyond a persistent cap is malformed and preserved fail-closed. Within the 512-item raw
input boundary, tick-local requests are canonically ordered and every valid request beyond the 256
normalized slots receives an explicit cap denial. Input beyond the raw boundary fails the system
before planning, so the kernel discards its staged work instead of performing an unbounded scan.

## Lifecycle evidence

The Phase 1 states are:

`discovering -> bootstrapping -> developing -> mature -> threatened -> recovering`

`lost` is terminal. Phase 2 may add complete-colony policy such as layouts and stock targets without
creating another lifecycle authority.

Evidence has exact current-tick meaning:

- **Legal workforce:** one non-spawning owned creep has at least one active `WORK`, `CARRY`, and
  `MOVE` part. Separate partial creeps do not form one legal emergency worker.
- **Controller risk:** `ticksToDowngrade` is absent or no greater than
  `policy.recovery.controllerRiskWindowTicks`.
- **Mature:** controller ownership is current and owned at RCL8, an owned spawn and legal worker are
  present, controller risk is false, and no active threat exists.
- **Active threat:** current unowned creeps first resolve through configured diplomacy. The total
  active `ATTACK`, `RANGED_ATTACK`, `WORK`, and `CLAIM` parts belonging to identities with the
  `local-defense` ceiling meets `policy.safeMode.minimumHostileOffenseParts`. `HEAL` alone is
  support evidence, not local offense.
- **Visible loss:** the persisted room is in the current snapshot and has no owned controller.
- **Unknown observation:** the persisted room is absent from the current snapshot. Absence does not
  prove loss and authorizes no new live commitment. Its ledger bytes remain unchanged and are
  excluded from live totals until a known observation can reconcile expiry or ownership loss.

Configured self, ally, and NAP identities remain excluded before optional reputation is consulted.
The Screeps “hostile” collection is observation input meaning not owned, not diplomatic
authorization.

### Transition matrix

| Current state                    | Current evidence                             | Next state or result       |
| -------------------------------- | -------------------------------------------- | -------------------------- |
| New                              | owned, but no owned spawn                    | `discovering`              |
| New or `discovering`             | owned spawn, no legal worker                 | `bootstrapping`            |
| New or `discovering`             | active local threat                          | `threatened`               |
| New or `discovering`             | legal worker and mature evidence             | `mature`                   |
| New or `discovering`             | legal worker, controller risk                | `recovering`               |
| New or `discovering`             | owned spawn, legal worker, otherwise healthy | `developing`               |
| `bootstrapping`                  | active threat                                | `threatened`               |
| `bootstrapping`                  | healthy survival capability restored         | `developing` or `mature`   |
| `discovering` or `bootstrapping` | owned spawn lost                             | `recovering`               |
| `developing` or `mature`         | active threat                                | `threatened`               |
| `developing` or `mature`         | spawn/workforce loss or controller risk      | `recovering`               |
| `developing`                     | mature evidence                              | `mature`                   |
| `mature`                         | mature evidence lost, otherwise healthy      | `developing`               |
| `threatened`                     | threat cleared                               | `recovering` for that tick |
| `recovering`                     | threat returns                               | `threatened`               |
| `recovering`                     | mandatory capabilities/energy restored       | `developing` or `mature`   |
| Any non-lost state               | visible ownership loss                       | `lost`                     |
| Any state                        | observation unknown                          | preserve; authorize none   |
| `lost`                           | any evidence                                 | remain `lost`              |

Recovery exit requires current energy of at least
`min(protectedSpawnEnergy, energyCapacityAvailable)`. An ordinary energy dip does not move a healthy
developing or mature colony into recovery; that energy test applies only to recovery exit.

## Recovery objective

A bootstrapping or recovering colony with an owned spawn and no legal workforce produces exactly one
tick-local objective:

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Stable ID      | `colony/<room>/restore-workforce`        |
| Category       | `emergency-spawn`                        |
| Capability     | active `WORK 1`, `CARRY 1`, and `MOVE 1` |
| Minimum energy | 200                                      |
| Desired energy | `emergencyWorkerEnergyBudget`            |
| Reason         | `recovery-workforce-missing`             |

At the default policy and 300 available room energy, this objective receives one 300-energy grant.
Below 200 energy it remains exactly one blocked objective with `insufficient-energy`. The objective
is derived rather than appended to persistent history, so JSON round trips and heap reset cannot
duplicate it.

The director does not select a body or spawn slot. Those remain the later `SpawnBroker` authority.
The ledger nevertheless supports exact spawn intervals requested by that authority.

## Budget arbitration

The canonical category order is:

1. `emergency-spawn`;
2. `defense`;
3. `replacement`;
4. `harvesting-filling`;
5. `controller-risk`;
6. `critical-maintenance`; and
7. `optional-growth`.

A request identity is the stable tuple `(colonyId, category, issuer, revision)`. Requests are atomic
bundles with at most one claim per resource:

- energy: integer `{ minimum, desired }`;
- spawn time: exact `{ spawnId, startTick, endTick }` half-open interval; and
- CPU: integer `{ minimum, desired }` abstract units.

Active commitments and new requests are arbitrated together by category rank, expiry or deadline,
colony ID, issuer, and revision. Reordering colonies, requests, or JSON keys therefore cannot change
the result. Conservation is checked before category priority; priority is never permission to
overspend.

### Energy

Capacity is current `Room.energyAvailable`, the energy in room spawns and extensions. Capacity is
not `Room.energyCapacityAvailable`, storage, containers, towers, links, creep stores, or expected
future harvesting.

The protected tranche is:

```text
protected = min(protectedSpawnEnergy, observedEnergy)
protectedEligibleGranted = energy granted to emergency-spawn + defense + replacement
protectedRemaining = max(0, protected - protectedEligibleGranted)
unprotectedAvailable = max(0, remainingEnergy - protectedRemaining)
```

Only emergency-spawn, defense, and replacement work may consume the protected tranche.
Harvesting/filling, controller-risk, critical-maintenance, and optional-growth work must leave its
remaining balance intact even though some precede optional growth in category order. Optional growth
is denied while the colony is bootstrapping, threatened, recovering, or lost, and while kernel mode
is recovery, emergency, or constrained.

### Spawn time

- An observed spawn activity blocks `[tick, tick + remainingTime)`.
- Active ledger intervals on one spawn cannot overlap.
- Touching interval boundaries are legal.
- A new interval targets a currently observed owned spawn.
- One interval is at most 150 ticks, matching three ticks for each part of the 50-part body maximum.
- Live `spawning`, `needTime`, and `remainingTime` are authoritative; a non-null spawning object can
  remain busy while the completed creep waits for an exit tile.

### CPU

Ledger CPU uses integer milli-CPU derived from the kernel-admitted system capacity. Authorization is
re-arbitrated against that tick's admitted milli-CPU; request expiry remains the atomic bundle's
configured lease. A reservation cannot change kernel mode, admit another system, increase the system
hard ceiling, or authorize future system admission.

### Mutation operations

- `grant` creates or reproduces one deterministic reservation.
- `consume` accepts cumulative totals that may only increase and cannot exceed the grant.
- `release` terminates the commitment and returns unused capacity.
- `expire` terminates commitments whose expiry has passed.
- `reconcile` records final cumulative actual cost and releases unused capacity.

Repeating any operation with the same valid evidence returns a stable result. Reusing an issuer
revision for changed canonical content is rejected; lower revisions are stale. Capacity shrink
re-arbitrates existing and new commitments together and removes the lowest-priority active work
before funding anything new.

## Decision reasons

Lifecycle reasons are:

- `owned-room-discovered`, `spawn-without-workforce`, `survival-capability-restored`;
- `maturity-evidence-met`, `maturity-evidence-lost`;
- `local-threat-observed`, `local-threat-cleared`, `controller-downgrade-risk`;
- `survival-capability-lost`, `mandatory-floor-unrestored`, `visible-ownership-lost`,
  `observation-unknown`; and
- `lost-terminal`.

Ledger reasons are:

- `granted`, `granted-reduced`, `already-granted`, `consumed`, `already-consumed`;
- `released`, `already-released`, `expired`, `already-expired`, `reconciled`, `superseded`;
- `objective-satisfied`, `capacity-reconciled`, `posture-preempted`, `protected-energy-floor`;
- `insufficient-energy`, `insufficient-cpu`, `spawn-not-observed`, `spawn-observed-busy`,
  `spawn-interval-overlap`, `invalid-request`;
- `revision-reused`, `stale-revision`, `request-cap-exceeded`, `reservation-cap-exceeded`,
  `ledger-entry-cap-exceeded`, `transition-cap-exceeded`;
- `reservation-not-found`, `consumption-regressed`, `consumption-exceeded`; and
- `owner-malformed`, `owner-future-schema`, `owner-unavailable`, `observation-unknown`,
  `colony-lost`.

When multiple denials apply, precedence is owner/gate/observation, validation/caps/revision,
posture, energy, spawn time, then CPU. This keeps explanations invariant under evaluation order.

## Feature gate and source revision

Issue #37 advances the source revision to `runtime-config-source-v2`. Only `phase1.colony` is
source-available. Operational config may disable it; no operational value can activate another gate.
`phase1.contracts`, `phase1.spawn`, and every later Phase 1 gate remain source-unavailable until
their own outcome is proved.

An acceptance receipt from source v1 is incompatible by design. A present valid candidate is
revalidated against v2 and receives a new receipt. With `candidate: null` and only an incompatible
receipt, source defaults apply without rewriting operator-owned bytes.

## Bounded telemetry

The tick result may expose the immutable detailed view for direct consumers. General telemetry uses
fixed-cardinality values only:

- colony planning status and owner revision;
- counts by lifecycle state;
- objective count plus active and pending reservation counts;
- total reserved energy, spawn ticks, and abstract CPU;
- counts by bounded budget reason code; and
- config status plus source, config, policy, and accepted-candidate revisions.

It does not use unbounded room names, issuer IDs, objective IDs, or request payloads as metric
labels.

## Deterministic proof matrix

| Variant                                          | Required outcome                                             |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Empty owner, spawn, and 300 energy               | bootstrapping; one funded 300-energy recovery objective      |
| Same input after JSON/global reset               | identical owner, objective, grant, denial, and reasons       |
| Reordered request/entity arrays and request keys | canonical-equivalent output and durable owner                |
| Stable legal workforce                           | developing; no duplicate recovery objective                  |
| RCL8 with complete mature evidence               | mature                                                       |
| Active unexcluded offensive creep                | threatened; optional growth preempted                        |
| Configured exclusion or heal-only creep          | no local-threat transition                                   |
| Threat cleared                                   | recovering for at least the transition tick                  |
| Brownout while recovering                        | mandatory floor unrestored; growth blocked                   |
| Due replacement competing with growth            | replacement wins without violating protected energy          |
| Energy claims exceed current capacity            | reduced/denied grants conserve capacity                      |
| Existing and requested spawn intervals           | no overlap; touching boundaries accepted                     |
| CPU claims exceed admitted milli-CPU             | reduced/denied grants conserve admitted capacity             |
| Repeated lifecycle/ledger operation              | stable result and no duplicate/double accounting             |
| Unknown room observation                         | state preserved; no new live authorization                   |
| Visible controller loss                          | terminal lost; all local active reservations released        |
| Malformed or future non-empty owner              | owner preserved; no objective/grant; bounded reason          |
| Persistent colonies at 64 and 65                 | 64 accepted; oversized owner preserved malformed/fail-closed |
| Requests at 256 and bounded excess               | 256 normalized; every bounded excess gets an explicit denial |
| Ledger entries at 512 and 513                    | existing entries retained; new issuer gets explicit denial   |
| Spawn interval at 150 and 151 ticks              | 150 accepted; 151 rejected as invalid                        |

The Phase 1 replay covers discovery, zero-creep bootstrap, heap reset, stable development, growth
competition, threat entry and exit, brownout, replacement, unknown observation, and visible room
loss. Every tick asserts the following accounting identities; focused tests separately prove RCL8
maturity, controller risk, configured threat exclusions, persistence corruption, and cap edges:

```text
energy capacity = live grants + protected remainder + free
CPU capacity >= live CPU grants
no two live intervals overlap on one spawn
every normalized request has exactly one decision
```

The repository gate remains `npm run check`.

## Screeps mechanics foundation

The contract is constrained by these official references:

- [Game.rooms](https://docs.screeps.com/api/#Game.rooms) for current room visibility;
- [StructureController](https://docs.screeps.com/api/#StructureController) and
  [ticksToDowngrade](https://docs.screeps.com/api/#StructureController.ticksToDowngrade) for
  ownership, level, and survival risk;
- [Room.energyAvailable](https://docs.screeps.com/api/#Room.energyAvailable) and
  [Room.energyCapacityAvailable](https://docs.screeps.com/api/#Room.energyCapacityAvailable) for the
  current spawn/extension pool and its capacity;
- [StructureSpawn](https://docs.screeps.com/api/#StructureSpawn),
  [StructureSpawn.spawning](https://docs.screeps.com/api/#StructureSpawn.spawning), and
  [StructureSpawn.spawnCreep](https://docs.screeps.com/api/#StructureSpawn.spawnCreep) for busy
  state, live spawn timing, body limits, and energy use;
- [Creep](https://docs.screeps.com/api/#Creep),
  [Creep.body](https://docs.screeps.com/api/#Creep.body), and
  [Creep.ticksToLive](https://docs.screeps.com/api/#Creep.ticksToLive) for active capability and
  replacement evidence; and
- [CPU limit](https://docs.screeps.com/cpu-limit.html) and
  [Game.cpu](https://docs.screeps.com/api/#Game.cpu) for sustainable limit, hard tick limit, bucket,
  and measured-use semantics.

Maintained community guidance is recorded separately because it does not override API facts:

- [Screeps Wiki: Vision](https://wiki.screepspl.us/Vision/);
- [Screeps Wiki: StructureController](https://wiki.screepspl.us/StructureController/);
- [Screeps Wiki: StructureSpawn](https://wiki.screepspl.us/StructureSpawn/);
- [Screeps Wiki: Creep body setup strategies](https://wiki.screepspl.us/Creep_body_setup_strategies/);
  and
- [Screeps Wiki: CPU](https://wiki.screepspl.us/CPU/).
