import { describe, expect, it } from "vitest";
import type { LabClusterAssignment } from "../src/industry/lab-cluster";
import type { LabPolicyCommitment, LabPolicyDisposition } from "../src/industry/lab-policy";
import {
  arbitrateLabCommands,
  createPendingLabAttempt,
  isPendingLabAttempt,
  reconcilePendingLabAttempts,
} from "../src/industry/lab-runtime";
import type { WorldSnapshot } from "../src/world/snapshot";

const assignment: LabClusterAssignment = {
  boostLabIds: ["out"],
  fingerprint: "cluster:v1",
  layoutFingerprint: "layout:v1",
  productLabIds: ["out"],
  reagentLabIds: ["a", "b"],
  roomName: "W1N1",
};

describe("pure lab command arbitration", () => {
  it("filters to current ready commitments and lets boost preempt reaction on one cluster key", () => {
    const commitments = [reaction(), boost()];
    const intents = arbitrateLabCommands({
      assignments: [assignment],
      commitments,
      creepFingerprints: new Map([["creep", "creep:v1"]]),
      dispositions: commitments.map(ready),
      snapshot: snapshot({
        labs: [
          lab("a", "H", 100, 0, 10),
          lab("b", "O", 100, 1, 10),
          lab("out", "XUH2O", 90, 2, 60),
        ],
      }),
      snapshotRevision: "shard0:100:fixture",
    });

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: "lab.boost-creep",
      snapshotRevision: "shard0:100:fixture",
      exclusiveResourceKey: "lab-cluster/W1N1/cluster:v1",
      payload: { bodyPartsCount: 2, creepId: "creep", labId: "out" },
    });
    expect(JSON.stringify(intents)).not.toMatch(/command|Game|StructureLab/);
  });

  it("uses stable identities under reordered inputs and suppresses existing pending work", () => {
    const commitments = [reaction(), boost()];
    const input = {
      assignments: [assignment],
      commitments,
      creepFingerprints: new Map([["creep", "creep:v1"]]),
      dispositions: commitments.map(ready),
      snapshot: snapshot({
        labs: [lab("a", "H", 100, 0, 10), lab("b", "O", 100, 1, 10), lab("out", null, 0, 2, 10)],
      }),
      snapshotRevision: "revision",
    };
    const first = arbitrateLabCommands(input);
    expect(arbitrateLabCommands({ ...input, commitments: [...commitments].reverse() })).toEqual(
      first,
    );
    const pending = createPendingLabAttempt(required(first[0]), "OK");
    expect(pending).not.toBeNull();
    expect(arbitrateLabCommands({ ...input, pendingAttempts: [required(pending)] })).toEqual([]);
  });
});

describe("next-observation lab settlement", () => {
  it("creates persistable pending data only for OK and settles an exact reaction delta of five", () => {
    const intent = required(
      arbitrateLabCommands({
        assignments: [assignment],
        commitments: [reaction()],
        creepFingerprints: new Map(),
        dispositions: [ready(reaction())],
        snapshot: snapshot({
          labs: [lab("a", "H", 100, 0, 10), lab("b", "O", 100, 1, 10), lab("out", null, 0, 2, 10)],
        }),
        snapshotRevision: "revision",
      })[0],
    );
    const pending = createPendingLabAttempt(intent, "OK");
    expect(isPendingLabAttempt(pending)).toBe(true);
    expect(createPendingLabAttempt(intent, "ERR_TIRED")).toBeNull();

    const result = reconcilePendingLabAttempts({
      assignments: [assignment],
      commitments: [reaction()],
      creepFingerprints: new Map(),
      pendingAttempts: [required(pending)],
      snapshot: snapshot({
        tick: 101,
        labs: [lab("a", "H", 95, 0, 10), lab("b", "O", 95, 1, 10), lab("out", "OH", 5, 2, 10)],
      }),
    });
    expect(result).toEqual([
      expect.objectContaining({
        accounting: { energyInput: 0, resourceInput: 10, resourceOutput: 5 },
        reason: "exact-effect",
        settledAmount: 5,
        status: "settled",
      }),
    ]);
  });

  it("settles only a corroborated partial boost and deterministically bounds no-effect retries", () => {
    const intent = required(
      arbitrateLabCommands({
        assignments: [assignment],
        commitments: [boost()],
        creepFingerprints: new Map([["creep", "creep:v1"]]),
        dispositions: [ready(boost())],
        snapshot: snapshot(),
        snapshotRevision: "revision",
      })[0],
    );
    const pending = required(createPendingLabAttempt(intent, "OK"));
    const exact = reconcilePendingLabAttempts({
      assignments: [assignment],
      commitments: [boost()],
      creepFingerprints: new Map([["creep", "creep:v1"]]),
      pendingAttempts: [pending],
      snapshot: snapshot({ tick: 101, boostCount: 1, boostLabMineral: 60, boostLabEnergy: 40 }),
    });
    expect(exact[0]).toMatchObject({
      accounting: { energyInput: 20, resourceInput: 30, resourceOutput: 0 },
      reason: "exact-effect",
      settledAmount: 1,
      status: "settled",
    });

    const exhausted = reconcilePendingLabAttempts({
      assignments: [assignment],
      commitments: [boost()],
      creepFingerprints: new Map([["creep", "creep:v1"]]),
      pendingAttempts: [required(createPendingLabAttempt(intent, "OK", 2))],
      snapshot: snapshot({ tick: 101 }),
    });
    expect(exhausted[0]).toMatchObject({
      accounting: { energyInput: 0, resourceInput: 0, resourceOutput: 0 },
      reason: "retry-cap",
      status: "cancelled",
    });
  });

  it("fails closed for conflict and fingerprint drift while surviving reset-shaped replay", () => {
    const commitment = boost();
    const intent = required(
      arbitrateLabCommands({
        assignments: [assignment],
        commitments: [commitment],
        creepFingerprints: new Map([["creep", "creep:v1"]]),
        dispositions: [ready(commitment)],
        snapshot: snapshot(),
        snapshotRevision: "revision",
      })[0],
    );
    const pending = required(createPendingLabAttempt(intent, "OK"));
    const base = {
      assignments: [assignment],
      commitments: [commitment],
      pendingAttempts: [pending],
      snapshot: snapshot({ tick: 101 }),
    };
    expect(
      reconcilePendingLabAttempts({ ...base, creepFingerprints: new Map([["creep", "other"]]) })[0],
    ).toMatchObject({ reason: "fingerprint-changed", status: "cancelled" });
    expect(
      reconcilePendingLabAttempts({
        ...base,
        creepFingerprints: new Map([["creep", "creep:v1"]]),
        snapshot: snapshot({ tick: 101, boostCount: 1 }),
      })[0],
    ).toMatchObject({ reason: "conflicting-effect", status: "cancelled" });
    const replay = reconcilePendingLabAttempts({
      ...roundTrip(base),
      creepFingerprints: new Map([["creep", "creep:v1"]]),
    });
    expect(replay).toEqual(
      reconcilePendingLabAttempts({
        ...base,
        creepFingerprints: new Map([["creep", "creep:v1"]]),
      }),
    );
  });
});

function reaction(): Extract<LabPolicyCommitment, { kind: "reaction" }> {
  return {
    assignmentFingerprint: assignment.fingerprint,
    batchAmount: 100,
    catalogFingerprint: "catalog:v1",
    colonyId: "W1N1",
    deadline: 110,
    kind: "reaction",
    objectiveFingerprint: "reaction:fingerprint",
    objectiveId: "reaction",
    objectiveRevision: 1,
    priority: 100,
    product: "OH",
    reagents: ["H", "O"],
    settledAmount: 0,
    targetProduct: "OH",
  };
}

function boost(): Extract<LabPolicyCommitment, { kind: "boost" }> {
  return {
    assignmentFingerprint: assignment.fingerprint,
    catalogFingerprint: "catalog:v1",
    colonyId: "W1N1",
    compound: "XUH2O",
    creepFingerprint: "creep:v1",
    creepId: "creep",
    deadline: 110,
    kind: "boost",
    objectiveFingerprint: "boost:fingerprint",
    objectiveId: "boost",
    objectiveRevision: 1,
    partCount: 2,
    partType: "attack",
    priority: 1,
    settledParts: 0,
  };
}

function ready(value: LabPolicyCommitment): LabPolicyDisposition {
  return {
    blockers: [],
    kind: value.kind,
    objectiveId: value.objectiveId,
    objectiveRevision: value.objectiveRevision,
    reason: null,
    status: "ready",
  };
}

function snapshot(
  options: {
    readonly boostCount?: number;
    readonly boostLabEnergy?: number;
    readonly boostLabMineral?: number;
    readonly labs?: readonly ReturnType<typeof lab>[];
    readonly tick?: number;
  } = {},
): WorldSnapshot {
  const tick = options.tick ?? 100;
  const labs = options.labs ?? [
    lab("a", "H", 100, 0, 10),
    lab("b", "O", 100, 1, 10),
    lab("out", "XUH2O", options.boostLabMineral ?? 90, 2, options.boostLabEnergy ?? 60),
  ];
  const none = { active: 0, boosted: 0, total: 0 };
  const attack = { active: 2, boosted: options.boostCount ?? 0, total: 2 };
  const creep = {
    body: {
      activeParts: 2,
      attack,
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 2,
      tough: none,
      work: none,
    },
    boosts: options.boostCount
      ? [{ bodyPart: "attack" as const, compound: "XUH2O", count: options.boostCount }]
      : [],
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id: "creep",
    name: "creep",
    ownerUsername: "me",
    pos: { roomName: "W1N1", x: 12, y: 10 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1000,
  };
  const room = {
    constructionSites: [],
    controller: {
      id: "controller",
      level: 8,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: 0,
      progressTotal: 1,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 1000,
      upgradeBlocked: null,
    },
    droppedResources: [],
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name: "W1N1",
    observedAt: tick,
    ownedCreeps: [creep],
    ownedExtensions: [],
    ownedLabs: labs,
    ownedSpawns: [],
    ownedTowers: [],
    roads: [],
    sources: [],
    storedStructures: [],
  };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [room],
    rooms: [room],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: 0,
        storedStructures: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function lab(
  id: string,
  mineralType: string | null,
  mineralAmount: number,
  x: number,
  energy: number,
) {
  return {
    active: true,
    cooldown: 0,
    energy,
    energyCapacity: 2000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount,
    mineralCapacity: 3000,
    mineralType,
    pos: { roomName: "W1N1", x: 10 + x, y: 10 },
    store: {
      capacity: 5000,
      freeCapacity: 5000 - mineralAmount - energy,
      resources: [],
      usedCapacity: mineralAmount + energy,
    },
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected fixture value");
  return value;
}
