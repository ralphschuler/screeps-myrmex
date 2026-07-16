import { describe, expect, it } from "vitest";
import {
  MAX_BROKER_PAIR_WORK,
  MAX_BROKER_SPAWNS,
  MAX_CREEP_NAME_CODE_UNITS,
  MAX_LOGICAL_SPAWN_DEMANDS,
  MAX_RAW_SPAWN_DEMANDS,
  SpawnBroker,
  generatedSpawnCreepName,
  type SpawnBrokerPolicy,
  type SpawnDemand,
  type SpawnExpectation,
} from "../src/spawn/spawn-broker";
import type { SpawnBodyPartCounts } from "../src/spawn/body-builder";
import {
  emptyWorldSnapshot,
  freezeWorldSnapshot,
  type BodyCapabilitiesSnapshot,
  type CreepSnapshot,
  type OwnedRoomSnapshot,
  type OwnedSpawnSnapshot,
  type StoreSnapshot,
  type WorldSnapshot,
} from "../src/world/snapshot";

const TICK = 100;

const POLICY: SpawnBrokerPolicy = Object.freeze({
  maximumBodyParts: 50,
  maximumBodyEnergy: 3_000,
  maximumNonMovePartsPerMovePart: 2,
  nameCollisionRetryLimit: 2,
  retryDelayTicks: 3,
});

describe("SpawnBroker", () => {
  it("uses one shared room-energy pool and emits exact half-open claims", () => {
    for (const energy of [300, 399]) {
      const result = arbitrate({
        snapshot: snapshot([{ energy, spawns: [spawn("spawn-b"), spawn("spawn-a")] }]),
        demands: [demand({ id: "worker-b" }), demand({ id: "worker-a" })],
      });

      expect(result.selections).toHaveLength(1);
      expect(result.selections[0]).toMatchObject({
        demandId: "worker-a",
        spawnId: "spawn-a",
        body: ["work", "carry", "move"],
        energyCost: 200,
        spawnTicks: 9,
        spawnClaim: { spawnId: "spawn-a", startTick: TICK, endTick: TICK + 9 },
      });
      expect(result.decisions[1]).toMatchObject({
        demandId: "worker-b",
        status: "deferred",
        reason: "insufficient-energy",
        retryAt: TICK + POLICY.retryDelayTicks,
      });
    }

    const fourHundred = arbitrate({
      snapshot: snapshot([{ energy: 400, spawns: [spawn("spawn-b"), spawn("spawn-a")] }]),
      demands: [demand({ id: "worker-b" }), demand({ id: "worker-a" })],
    });
    expect(fourHundred.selections.map(({ demandId, spawnId }) => [demandId, spawnId])).toEqual([
      ["worker-a", "spawn-a"],
      ["worker-b", "spawn-b"],
    ]);
    expect(fourHundred.selections.reduce((sum, item) => sum + item.energyCost, 0)).toBe(400);
    expectDeeplyFrozen(fourHundred);
  });

  it("is byte-stable under input reordering and collapses byte-equivalent duplicates", () => {
    const workerA = demand({ id: "worker-a" });
    const workerB = demand({ id: "worker-b" });
    const forward = arbitrate({
      snapshot: snapshot([{ energy: 400, spawns: [spawn("spawn-b"), spawn("spawn-a")] }]),
      demands: [workerB, workerA, { ...workerA }],
    });
    const reversed = arbitrate({
      snapshot: snapshot([{ energy: 400, spawns: [spawn("spawn-a"), spawn("spawn-b")] }]),
      demands: [{ ...workerA }, workerA, workerB],
    });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(forward.decisions).toHaveLength(2);
    expect(forward.selections).toHaveLength(2);
  });

  it("fails one conflicting identity closed without admitting either submission", () => {
    const original = demand({ id: "same-id" });
    const result = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [original, { ...original, priorityValue: original.priorityValue + 1 }],
    });

    expect(result.decisions).toEqual([
      {
        demandId: "same-id",
        revision: null,
        status: "invalid",
        reason: "identity-conflict",
        retryAt: null,
        bodyReason: null,
        energyCost: null,
        spawnId: null,
        name: null,
      },
    ]);
    expect(result.selections).toEqual([]);
  });

  it("orders by category, priority, deadline, body cost, and stable identity", () => {
    const oneSpawn = snapshot([{ energy: 1_000, spawns: [spawn("spawn-a")] }]);
    const categories = arbitrate({
      snapshot: oneSpawn,
      demands: [
        demand({ id: "construction", category: "construction", priorityValue: 999 }),
        demand({ id: "upgrading", category: "upgrading", priorityValue: 999 }),
        demand({ id: "replacement", category: "replacement", priorityValue: 999 }),
        demand({ id: "emergency", category: "emergency-recovery", priorityValue: -999 }),
      ],
    });
    expect(categories.decisions.map(({ demandId }) => demandId)).toEqual([
      "emergency",
      "replacement",
      "upgrading",
      "construction",
    ]);
    expect(categories.selections[0]?.demandId).toBe("emergency");

    const priority = arbitrate({
      snapshot: oneSpawn,
      demands: [demand({ id: "low", priorityValue: 1 }), demand({ id: "high", priorityValue: 2 })],
    });
    expect(priority.selections[0]?.demandId).toBe("high");

    const deadline = arbitrate({
      snapshot: oneSpawn,
      demands: [demand({ id: "later", deadline: 200 }), demand({ id: "sooner", deadline: 150 })],
    });
    expect(deadline.selections[0]?.demandId).toBe("sooner");

    const cost = arbitrate({
      snapshot: oneSpawn,
      demands: [
        demand({ id: "costly" }),
        demand({ id: "cheap", requiredPartCounts: counts({ move: 1 }) }),
      ],
    });
    expect(cost.selections[0]).toMatchObject({ demandId: "cheap", energyCost: 50 });

    const identity = arbitrate({
      snapshot: oneSpawn,
      demands: [demand({ id: "z" }), demand({ id: "a" })],
    });
    expect(identity.selections[0]?.demandId).toBe("a");
  });

  it("keeps explicit 100-code-unit bases legal and truncates only for suffix retries", () => {
    const basis = "x".repeat(MAX_CREEP_NAME_CODE_UNITS);
    const result = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")], creepNames: [basis] }]),
      demands: [demand({ nameBasis: basis })],
    });

    expect(result.selections[0]?.nameBasis).toBe(basis);
    expect(result.selections[0]?.name).toHaveLength(MAX_CREEP_NAME_CODE_UNITS);
    expect(result.selections[0]?.name.endsWith("~1")).toBe(true);
    expect(result.selections[0]?.name.slice(0, -2)).toBe("x".repeat(98));

    const tooLong = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand({ nameBasis: "x".repeat(MAX_CREEP_NAME_CODE_UNITS + 1) })],
    });
    expect(tooLong.decisions[0]).toMatchObject({
      status: "invalid",
      reason: "invalid-name-basis",
    });
    expect(tooLong.selections).toEqual([]);
  });

  it("retries explicit-name collisions within the configured bound and then defers", () => {
    const result = arbitrate({
      snapshot: snapshot([
        {
          energy: 300,
          spawns: [spawn("spawn-a")],
          creepNames: ["worker", "worker~1", "worker~2"],
        },
      ]),
      demands: [demand({ nameBasis: "worker" })],
    });

    expect(result.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "name-collision-exhausted",
      retryAt: TICK + POLICY.retryDelayTicks,
    });
    expect(result.selections).toEqual([]);
  });

  it("adopts generated identity names observed as live or spawning", () => {
    const first = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
    });
    const generatedName = first.selections[0]?.name;
    expect(generatedName).toMatch(/^mx-[0-9a-f]{8}-1$/u);
    if (generatedName === undefined) {
      throw new Error("generated name missing");
    }

    const live = arbitrate({
      snapshot: snapshot([
        { energy: 300, spawns: [spawn("spawn-a")], creepNames: [generatedName] },
      ]),
      demands: [demand()],
    });
    expect(live.decisions[0]).toMatchObject({
      status: "satisfied",
      reason: "observed-creep",
      retryAt: null,
    });
    expect(live.selections).toEqual([]);

    const damaged = arbitrate({
      snapshot: snapshot([
        {
          energy: 300,
          spawns: [spawn("spawn-a")],
          illegalCreepNames: [generatedName],
        },
      ]),
      demands: [demand()],
    });
    expect(damaged.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "name-collision-exhausted",
      retryAt: TICK + POLICY.retryDelayTicks,
    });
    expect(damaged.selections).toEqual([]);

    const spawning = arbitrate({
      snapshot: snapshot([
        {
          energy: 300,
          spawns: [spawn("spawn-a", { creepName: generatedName, remainingTime: 0 })],
        },
      ]),
      demands: [demand()],
    });
    expect(spawning.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "observed-spawning",
      retryAt: TICK + 1,
    });
    expect(spawning.selections).toEqual([]);
  });

  it("qualifies only recovery names by durable revision and never suffixes them", () => {
    const logicalDemand = demand({ id: "worker-z" });
    const changedAttempt = {
      ...logicalDemand,
      revision: logicalDemand.revision + 1,
      budgetId: "replacement-budget",
    };
    const generatedName = generatedSpawnCreepName(logicalDemand);

    const changedName = generatedSpawnCreepName(changedAttempt);
    expect(changedName).not.toBe(generatedName);
    expect(generatedName).toMatch(/^mx-[0-9a-f]{8}-1$/u);
    expect(changedName).toMatch(/^mx-[0-9a-f]{8}-2$/u);
    const firstAttempt = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [logicalDemand],
    });
    const nextAttempt = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [changedAttempt],
    });
    expect(firstAttempt.selections[0]?.name).toBe(generatedName);
    expect(nextAttempt.selections[0]?.name).toBe(changedName);

    const genericAttempt = demand({ category: "replacement" });
    const genericRevision = {
      ...genericAttempt,
      revision: genericAttempt.revision + 1,
      budgetId: "replacement-budget-next",
    };
    expect(generatedSpawnCreepName(genericRevision)).toBe(generatedSpawnCreepName(genericAttempt));
    expect(generatedSpawnCreepName(genericAttempt)).toMatch(/^mx-[0-9a-f]{8}$/u);

    const reservedByExplicitDemand = arbitrate({
      snapshot: snapshot([{ energy: 400, spawns: [spawn("spawn-b"), spawn("spawn-a")] }]),
      demands: [demand({ id: "worker-a", nameBasis: generatedName }), logicalDemand],
    });
    expect(reservedByExplicitDemand.selections).toHaveLength(1);
    expect(reservedByExplicitDemand.selections[0]).toMatchObject({
      demandId: "worker-a",
      name: generatedName,
    });
    expect(reservedByExplicitDemand.decisions[1]).toMatchObject({
      demandId: "worker-z",
      status: "deferred",
      reason: "name-collision-exhausted",
      name: null,
    });
  });

  it("does not let a declared predecessor satisfy its successor demand", () => {
    const predecessorDemand = demand({ revision: 1 });
    const predecessorName = generatedSpawnCreepName(predecessorDemand);
    const successorDemand = demand({
      revision: 2,
      replacementCreepName: predecessorName,
    });
    const successorName = generatedSpawnCreepName(successorDemand);
    const expectation: SpawnExpectation = {
      demandId: predecessorDemand.id,
      revision: predecessorDemand.revision,
      spawnId: "spawn-a",
      creepName: predecessorName,
      scheduledAt: 90,
      expectedReadyAt: 99,
      retryAt: 110,
    };

    const expectedPredecessor = arbitrate({
      snapshot: snapshot([
        { energy: 300, spawns: [spawn("spawn-a")], creepNames: [predecessorName] },
      ]),
      demands: [successorDemand],
      expectations: [expectation],
    });
    expect(expectedPredecessor.decisions[0]).toMatchObject({
      status: "selected",
      reason: "selected",
      name: successorName,
    });
    expect(expectedPredecessor.selections[0]).toMatchObject({
      replacementCreepName: predecessorName,
      name: successorName,
    });

    const directPredecessor = demand({ replacementCreepName: generatedSpawnCreepName(demand()) });
    const directName = generatedSpawnCreepName(directPredecessor);
    const collision = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")], creepNames: [directName] }]),
      demands: [directPredecessor],
    });
    expect(collision.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "name-collision-exhausted",
    });
    expect(collision.selections).toEqual([]);
  });

  it("honors unexpired expectations and retries at, but not before, retryAt", () => {
    const pending: SpawnExpectation = {
      demandId: "worker",
      revision: 1,
      spawnId: "spawn-a",
      creepName: "expected-worker",
      scheduledAt: 99,
      expectedReadyAt: 108,
      retryAt: 110,
    };
    const blocked = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
      expectations: [pending],
    });
    expect(blocked.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "expectation-pending",
      retryAt: 110,
    });

    const generatedDemand = demand();
    const generatedName = generatedSpawnCreepName(generatedDemand);
    const damagedBeforeRetry = arbitrate({
      snapshot: snapshot([
        {
          energy: 300,
          spawns: [spawn("spawn-a")],
          illegalCreepNames: [generatedName],
        },
      ]),
      demands: [generatedDemand],
      expectations: [{ ...pending, creepName: generatedName }],
    });
    expect(damagedBeforeRetry.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "name-collision-exhausted",
      retryAt: TICK + POLICY.retryDelayTicks,
    });
    expect(damagedBeforeRetry.selections).toEqual([]);

    const expired = arbitrate({
      tick: 110,
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }], 110),
      demands: [demand()],
      expectations: [pending],
    });
    expect(expired.selections).toHaveLength(1);

    const nextRevisionStillBlocked = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
      expectations: [{ ...pending, revision: 2 }],
    });
    expect(nextRevisionStillBlocked.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "expectation-pending",
      retryAt: 110,
    });

    const exactLiveAtRetry = arbitrate({
      tick: 110,
      snapshot: snapshot(
        [
          {
            energy: 300,
            spawns: [spawn("spawn-a")],
            creepNames: ["recovery-worker~1"],
          },
        ],
        110,
      ),
      demands: [demand({ nameBasis: "recovery-worker" })],
      expectations: [{ ...pending, creepName: "recovery-worker~1" }],
    });
    expect(exactLiveAtRetry.decisions[0]).toMatchObject({
      status: "satisfied",
      reason: "observed-creep",
      retryAt: null,
    });
    expect(exactLiveAtRetry.selections).toEqual([]);

    const exactSpawningAtRetry = arbitrate({
      tick: 110,
      snapshot: snapshot(
        [
          {
            energy: 300,
            spawns: [
              spawn("spawn-a", { creepName: "expected-worker", remainingTime: 0 }),
              spawn("spawn-b"),
            ],
          },
        ],
        110,
      ),
      demands: [demand()],
      expectations: [pending],
    });
    expect(exactSpawningAtRetry.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "observed-spawning",
      retryAt: 111,
    });
    expect(exactSpawningAtRetry.selections).toEqual([]);

    const unrelatedExpectedSpawnActivity = arbitrate({
      tick: 110,
      snapshot: snapshot(
        [
          {
            energy: 300,
            spawns: [
              spawn("spawn-a", { creepName: "different-name", remainingTime: 0 }),
              spawn("spawn-b"),
            ],
          },
        ],
        110,
      ),
      demands: [demand()],
      expectations: [{ ...pending, revision: 2 }],
    });
    expect(unrelatedExpectedSpawnActivity.decisions[0]).toMatchObject({
      status: "selected",
      reason: "selected",
      spawnId: "spawn-b",
    });
    expect(unrelatedExpectedSpawnActivity.selections).toHaveLength(1);

    const invalidName = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
      expectations: [{ ...pending, creepName: "" }],
    });
    expect(invalidName).toMatchObject({ status: "invalid", reason: "invalid-expectation" });
  });

  it("never uses inactive, busy, or remote-room spawns", () => {
    const noLocalSlot = arbitrate({
      snapshot: snapshot([
        {
          roomName: "W1N1",
          energy: 300,
          spawns: [
            spawn("inactive", null, false),
            spawn("busy", { creepName: "unrelated", remainingTime: 0 }),
          ],
        },
        { roomName: "W2N2", energy: 300, spawns: [spawn("remote-idle")] },
      ]),
      demands: [demand()],
    });
    expect(noLocalSlot.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "no-idle-spawn",
    });
    expect(noLocalSlot.selections).toEqual([]);

    const remoteDestination = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand({ destinationRoomName: "W2N2" })],
    });
    expect(remoteDestination.decisions[0]).toMatchObject({
      status: "impossible",
      reason: "remote-destination-unsupported",
    });
  });

  it("distinguishes one-short energy, terminal body limits, and time deferrals", () => {
    const oneShort = arbitrate({
      snapshot: snapshot([{ energy: 199, capacity: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
    });
    expect(oneShort.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "insufficient-energy",
      bodyReason: "insufficient-available-energy",
      energyCost: 200,
    });

    const impossibleCapacity = arbitrate({
      snapshot: snapshot([{ energy: 199, capacity: 199, spawns: [spawn("spawn-a")] }]),
      demands: [demand()],
    });
    expect(impossibleCapacity.decisions[0]).toMatchObject({
      status: "impossible",
      reason: "body-impossible",
      bodyReason: "energy-capacity-exceeded",
      energyCost: 200,
    });

    const impossiblePolicy = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand({ energyCap: 199 })],
    });
    expect(impossiblePolicy.decisions[0]).toMatchObject({
      status: "impossible",
      reason: "body-impossible",
      bodyReason: "energy-policy-limit-exceeded",
    });

    const notBefore = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand({ earliestTick: TICK + 5 })],
    });
    expect(notBefore.decisions[0]).toMatchObject({
      status: "deferred",
      reason: "not-before",
      retryAt: TICK + 5,
    });

    const expired = arbitrate({
      snapshot: snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]),
      demands: [demand({ deadline: TICK - 1 })],
    });
    expect(expired.decisions[0]).toMatchObject({
      status: "impossible",
      reason: "deadline-expired",
    });
  });

  it("fails closed at raw, logical, spawn, and pair-work structural caps", () => {
    const baseSnapshot = snapshot([{ energy: 300, spawns: [spawn("spawn-a")] }]);
    const raw = arbitrate({
      snapshot: baseSnapshot,
      demands: Array.from({ length: MAX_RAW_SPAWN_DEMANDS + 1 }, () => demand()),
    });
    expect(raw).toMatchObject({ status: "invalid", reason: "raw-demand-cap-exceeded" });

    const logical = arbitrate({
      snapshot: baseSnapshot,
      demands: Array.from({ length: MAX_LOGICAL_SPAWN_DEMANDS + 1 }, (_, index) =>
        demand({ id: `worker-${String(index)}` }),
      ),
    });
    expect(logical).toMatchObject({ status: "invalid", reason: "logical-demand-cap-exceeded" });

    const tooManySpawns = arbitrate({
      snapshot: snapshot([
        {
          energy: 300,
          spawns: Array.from({ length: MAX_BROKER_SPAWNS + 1 }, (_, index) =>
            spawn(`spawn-${String(index)}`),
          ),
        },
      ]),
      demands: [demand()],
    });
    expect(tooManySpawns).toMatchObject({ status: "invalid", reason: "spawn-cap-exceeded" });
    expect(MAX_LOGICAL_SPAWN_DEMANDS * MAX_BROKER_SPAWNS).toBe(MAX_BROKER_PAIR_WORK);
  });
});

function arbitrate(overrides: {
  readonly tick?: number;
  readonly snapshot: WorldSnapshot;
  readonly demands: readonly SpawnDemand[];
  readonly expectations?: readonly SpawnExpectation[];
  readonly policy?: SpawnBrokerPolicy;
}) {
  return new SpawnBroker().arbitrate({
    tick: overrides.tick ?? TICK,
    snapshot: overrides.snapshot,
    demands: overrides.demands,
    expectations: overrides.expectations ?? [],
    policy: overrides.policy ?? POLICY,
  });
}

function demand(overrides: Partial<SpawnDemand> = {}): SpawnDemand {
  return {
    id: "worker",
    issuer: "colony/W1N1/recovery",
    colonyId: "W1N1",
    revision: 1,
    category: "emergency-recovery",
    priorityValue: 100,
    deadline: 200,
    earliestTick: TICK,
    destinationRoomName: "W1N1",
    replacementCreepName: null,
    budgetId: "budget-worker",
    requiredPartCounts: counts({ work: 1, carry: 1 }),
    energyCap: 300,
    nameBasis: null,
    ...overrides,
  };
}

function counts(overrides: Partial<SpawnBodyPartCounts> = {}): SpawnBodyPartCounts {
  return {
    tough: 0,
    work: 0,
    carry: 0,
    attack: 0,
    ranged_attack: 0,
    heal: 0,
    claim: 0,
    move: 0,
    ...overrides,
  };
}

interface RoomFixture {
  readonly roomName?: string;
  readonly energy: number;
  readonly capacity?: number;
  readonly spawns: readonly OwnedSpawnSnapshot[];
  readonly creepNames?: readonly string[];
  readonly illegalCreepNames?: readonly string[];
}

function snapshot(fixtures: readonly RoomFixture[], tick = TICK): WorldSnapshot {
  const rooms = fixtures.map((fixture) => room(fixture, tick));
  const base = emptyWorldSnapshot(tick, "sim");
  return freezeWorldSnapshot({
    ...base,
    observation: { age: 0, shard: "sim", status: "observed", tick },
    observedAt: tick,
    rooms,
    ownedRooms: rooms,
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: rooms.map(({ name }) => ({
        age: 0,
        observedAt: tick,
        roomName: name,
        status: "visible",
      })),
      scope: "current-tick",
    },
  });
}

function room(fixture: RoomFixture, tick: number): OwnedRoomSnapshot {
  const name = fixture.roomName ?? "W1N1";
  return {
    name,
    observedAt: tick,
    energyAvailable: fixture.energy,
    energyCapacityAvailable: fixture.capacity ?? Math.max(300, fixture.energy),
    controller: {
      id: `controller-${name}`,
      level: 1,
      ownerUsername: "me",
      ownership: "owned",
      pos: { roomName: name, x: 25, y: 25 },
      progress: 0,
      progressTotal: 200,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 20_000,
      upgradeBlocked: null,
    },
    ownedSpawns: fixture.spawns.map((item) => ({
      ...item,
      pos: { ...item.pos, roomName: name },
    })),
    ownedCreeps: [
      ...(fixture.creepNames ?? []).map((creepName, index) =>
        creep(creepName, `creep-${String(index)}`, name, true),
      ),
      ...(fixture.illegalCreepNames ?? []).map((creepName, index) =>
        creep(creepName, `illegal-creep-${String(index)}`, name, false),
      ),
    ],
    hostileCreeps: [],
    ownedExtensions: [],
    ownedTowers: [],
    droppedResources: [],
    ruins: [],
    sources: [],
    storedStructures: [],
    constructionSites: [],
    tombstones: [],
  };
}

function spawn(
  id: string,
  spawning: { readonly creepName: string; readonly remainingTime: number } | null = null,
  active = true,
): OwnedSpawnSnapshot {
  return {
    id,
    name: id,
    active,
    hits: 5_000,
    hitsMax: 5_000,
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning:
      spawning === null
        ? null
        : {
            creepName: spawning.creepName,
            needTime: 9,
            remainingTime: spawning.remainingTime,
          },
    store: emptyStore(),
  };
}

function creep(name: string, id: string, roomName: string, legal: boolean): CreepSnapshot {
  return {
    id,
    name,
    ownerUsername: "me",
    pos: { roomName, x: 10, y: 10 },
    body: legal ? workerBody() : emptyBody(),
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    spawning: false,
    store: emptyStore(),
    ticksToLive: 1_000,
  };
}

function workerBody(): BodyCapabilitiesSnapshot {
  const none = { active: 0, boosted: 0, total: 0 };
  const one = { active: 1, boosted: 0, total: 1 };
  return {
    activeParts: 3,
    attack: none,
    carry: one,
    claim: none,
    heal: none,
    move: one,
    rangedAttack: none,
    size: 3,
    tough: none,
    work: one,
  };
}

function emptyStore(): StoreSnapshot {
  return { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 };
}

function emptyBody(): BodyCapabilitiesSnapshot {
  const none = { active: 0, boosted: 0, total: 0 };
  return {
    activeParts: 0,
    attack: none,
    carry: none,
    claim: none,
    heal: none,
    move: none,
    rangedAttack: none,
    size: 0,
    tough: none,
    work: none,
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}
