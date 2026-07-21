import { buildRuntimeConfig } from "../../src/config/runtime-config";
import type { ArbitrationBatch } from "../../src/execution";
import {
  composeLabRuntime,
  executeLabIntents,
  fingerprintCreepSnapshot,
  fingerprintLiveLabCreep,
  type BoostManifest,
  type LabCommandIntent,
  type LabPolicyCommitment,
  type PendingLabAttempt,
  type ReactionObjective,
} from "../../src/industry";
import type { CreepSnapshot, WorldSnapshot } from "../../src/world/snapshot";

export type LabFixtureMode =
  "forward" | "reverse" | "reverse-settled" | "contaminated" | "cooldown" | "full" | "missing-lab";

export function composeLabFixture(
  snapshot: WorldSnapshot,
  reactionObjective: ReactionObjective,
  previousCommitments: readonly LabPolicyCommitment[] = [],
  pendingAttempts: readonly PendingLabAttempt[] = [],
) {
  return composeLabRuntime({
    fundedBudgetIds: new Set([reactionObjective.industryBudgetId]),
    pendingAttempts,
    policy: buildRuntimeConfig().policy.industry,
    previousCommitments,
    reactionObjectives: [reactionObjective],
    reactions: { H: { O: "OH" } },
    reactionTimes: { OH: 10 },
    snapshot,
    snapshotRevision: `snapshot/${String(snapshot.observation.tick)}`,
  });
}

export function composeBoostFixture(
  snapshot: WorldSnapshot,
  manifest: BoostManifest,
  previousCommitments: readonly LabPolicyCommitment[] = [],
  pendingAttempts: readonly PendingLabAttempt[] = [],
) {
  return composeLabRuntime({
    boostManifests: [manifest],
    fundedBudgetIds: new Set([manifest.industryBudgetId]),
    pendingAttempts,
    policy: buildRuntimeConfig().policy.industry,
    previousCommitments,
    reactionObjectives: [],
    reactions: { H: { O: "OH" } },
    reactionTimes: { OH: 10 },
    snapshot,
    snapshotRevision: `snapshot/${String(snapshot.observation.tick)}`,
  });
}

export function executeBoostFixture(intent: LabCommandIntent) {
  if (intent.kind !== "lab.boost-creep") throw new Error("expected boost fixture intent");
  const creep = {
    body: [{ hits: 100, type: "attack" }],
    id: intent.payload.creepId,
    name: "boost-creep",
    pos: {},
    spawning: false,
  } as unknown as Creep;
  const lab = {
    boostCreep: (): ScreepsReturnCode => 0,
    id: intent.payload.labId,
    isActive: () => true,
    mineralType: intent.payload.compound,
    my: true,
    pos: { getRangeTo: () => 1 },
    store: {
      getUsedCapacity: (resource?: string) =>
        resource === "energy"
          ? intent.payload.energyBefore
          : resource === intent.payload.compound
            ? intent.payload.mineralBefore
            : 0,
    },
  } as unknown as StructureLab;
  const batch: ArbitrationBatch = {
    accepted: [intent],
    acceptedBudget: 1,
    decisions: [],
    submitted: 1,
    tick: intent.tick,
  };
  return executeLabIntents(batch, intent.tick, {
    creepFingerprint: fingerprintLiveLabCreep,
    resolveCreep: (id) => (id === creep.id ? creep : null),
    resolveLab: (id) => (id === lab.id ? lab : null),
  });
}

export function labFixtureObjective(direction: "forward" | "reverse"): ReactionObjective {
  return {
    amount: 5,
    colonyId: "W1N1",
    deadline: 110,
    direction,
    funded: true,
    id: `objective/${direction}`,
    industryBudgetId: `budget/${direction}`,
    priority: 10,
    product: "OH",
    revision: 1,
  };
}

export function labFixtureBoostWorld(
  settled: boolean,
  tick = 100,
): { readonly manifest: BoostManifest; readonly snapshot: WorldSnapshot } {
  const snapshot = labFixtureWorld("forward", tick);
  const room = snapshot.ownedRooms[0];
  if (room === undefined) throw new Error("expected lab fixture room");
  const none = { active: 0, boosted: 0, total: 0 };
  const creep: CreepSnapshot = {
    body: {
      activeParts: 1,
      attack: { active: 1, boosted: settled ? 1 : 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 1,
      tough: none,
      work: none,
    },
    boosts: settled ? [{ bodyPart: "attack", compound: "XUH2O", count: 1 }] : [],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "boost-creep",
    name: "boost-creep",
    ownerUsername: "me",
    pos: { roomName: "W1N1", x: 12, y: 11 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
  const energy = settled ? 1_980 : 2_000;
  const mineralAmount = settled ? 0 : 30;
  return {
    manifest: {
      colonyId: "W1N1",
      compound: "XUH2O",
      creepFingerprint: fingerprintCreepSnapshot({ ...creep, boosts: [] }),
      creepId: creep.id,
      deadline: 110,
      funded: true,
      id: "boost",
      industryBudgetId: "budget/boost",
      partCount: 1,
      partType: "attack",
      priority: 100,
      revision: 1,
    },
    snapshot: {
      ...snapshot,
      ownedRooms: [
        {
          ...room,
          ownedCreeps: [creep],
          ownedLabs: (room.ownedLabs ?? []).map((value) =>
            value.id === "out"
              ? {
                  ...value,
                  energy,
                  mineralAmount,
                  mineralType: settled ? null : "XUH2O",
                  store: {
                    ...value.store,
                    freeCapacity: 5_000 - energy - mineralAmount,
                    resources: [
                      { amount: energy, resourceType: "energy" },
                      ...(settled ? [] : [{ amount: mineralAmount, resourceType: "XUH2O" }]),
                    ],
                    usedCapacity: energy + mineralAmount,
                  },
                }
              : value,
          ),
        },
      ],
    },
  };
}

export function labFixtureWorld(mode: LabFixtureMode, tick = 100): WorldSnapshot {
  const labs =
    mode === "forward"
      ? [lab("a", "H", 5, 10), lab("b", "O", 5, 11), lab("out", null, 0, 12)]
      : mode === "reverse-settled"
        ? [lab("a", "H", 5, 10), lab("b", "O", 5, 11), lab("out", null, 0, 12)]
        : mode === "contaminated"
          ? [lab("a", "U", 5, 10), lab("b", "O", 5, 11), lab("out", null, 0, 12)]
          : mode === "cooldown"
            ? [lab("a", null, 0, 10), lab("b", null, 0, 11), lab("out", "OH", 5, 12, 1)]
            : mode === "full"
              ? [lab("a", "H", 3_000, 10), lab("b", "O", 3_000, 11), lab("out", "OH", 5, 12)]
              : mode === "missing-lab"
                ? [lab("a", "H", 5, 10), lab("out", null, 0, 12)]
                : [lab("a", null, 0, 10), lab("b", null, 0, 11), lab("out", "OH", 5, 12)];
  const resources =
    mode === "forward" || mode === "contaminated" || mode === "missing-lab"
      ? [
          { resourceType: "H", amount: 5 },
          { resourceType: "O", amount: 5 },
        ]
      : [{ resourceType: "OH", amount: 5 }];
  const endpoint = {
    active: true,
    id: "storage",
    pos: { roomName: "W1N1", x: 20, y: 20 },
    store: { capacity: 1_000_000, freeCapacity: 999_990, resources, usedCapacity: 10 },
  };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedRooms: [
      {
        name: "W1N1",
        observedAt: tick,
        ownedCreeps: [],
        ownedLabs: labs,
        ownedStorages: [endpoint],
        ownedTerminals: [],
      },
    ],
  } as unknown as WorldSnapshot;
}

function lab(
  id: string,
  mineralType: string | null,
  mineralAmount: number,
  x: number,
  cooldown = 0,
) {
  return {
    active: true,
    cooldown,
    energy: 2_000,
    energyCapacity: 2_000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount,
    mineralCapacity: 3_000,
    mineralType,
    pos: { roomName: "W1N1", x, y: 10 },
    store: {
      capacity: 5_000,
      freeCapacity: 3_000 - mineralAmount,
      resources: [],
      usedCapacity: mineralAmount + 2_000,
    },
  };
}
