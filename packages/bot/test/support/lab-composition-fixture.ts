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

export function composeBoostHandoffFixture(
  snapshot: WorldSnapshot,
  manifest: BoostManifest,
  previousCommitments: readonly LabPolicyCommitment[] = [],
  pendingAttempts: readonly PendingLabAttempt[] = [],
) {
  const labs = snapshot.ownedRooms[0]?.ownedLabs;
  if (labs === undefined) throw new Error("expected boost-handoff labs");
  return composeLabRuntime({
    boostManifests: [manifest],
    committedLabLayouts: [
      {
        labPositions: [
          ...labs.filter(({ id }) => id !== "external").map(({ pos }) => pos),
          { roomName: "W1N1", x: 13, y: 12 },
        ].reverse(),
        layoutFingerprint: "layout-commitment",
        roomName: "W1N1",
      },
    ],
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
  return labFixtureBoostProgressWorld({
    boostedParts: settled ? 1 : 0,
    energy: settled ? 1_980 : 2_000,
    mineralAmount: settled ? 0 : 30,
    partCount: 1,
    tick,
  });
}

export function labFixtureBoostProgressWorld(input: {
  readonly boostedParts: number;
  readonly energy: number;
  readonly mineralAmount: number;
  readonly partCount: number;
  readonly tick: number;
}): { readonly manifest: BoostManifest; readonly snapshot: WorldSnapshot } {
  const snapshot = labFixtureWorld("forward", input.tick);
  const room = snapshot.ownedRooms[0];
  if (room === undefined) throw new Error("expected lab fixture room");
  const none = { active: 0, boosted: 0, total: 0 };
  const creep: CreepSnapshot = {
    body: {
      activeParts: input.partCount,
      attack: {
        active: input.partCount,
        boosted: input.boostedParts,
        total: input.partCount,
      },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: input.partCount,
      tough: none,
      work: none,
    },
    boosts:
      input.boostedParts === 0
        ? []
        : [{ bodyPart: "attack", compound: "XUH2O", count: input.boostedParts }],
    fatigue: 0,
    hits: input.partCount * 100,
    hitsMax: input.partCount * 100,
    id: "boost-creep",
    name: "boost-creep",
    ownerUsername: "me",
    pos: { roomName: "W1N1", x: 12, y: 11 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
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
      partCount: input.partCount,
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
                  energy: input.energy,
                  mineralAmount: input.mineralAmount,
                  mineralType: input.mineralAmount === 0 ? null : "XUH2O",
                  store: {
                    ...value.store,
                    freeCapacity: 5_000 - input.energy - input.mineralAmount,
                    resources: [
                      { amount: input.energy, resourceType: "energy" },
                      ...(input.mineralAmount === 0
                        ? []
                        : [{ amount: input.mineralAmount, resourceType: "XUH2O" }]),
                    ],
                    usedCapacity: input.energy + input.mineralAmount,
                  },
                }
              : value,
          ),
        },
      ],
    },
  };
}

export function labBoostHandoffFixtureWorld(
  tick: number,
  reversed = false,
  boostSettled = false,
): { readonly manifest: BoostManifest; readonly snapshot: WorldSnapshot } {
  const snapshot = labHandoffFixtureWorld(tick, reversed);
  const room = snapshot.ownedRooms[0];
  if (room === undefined) throw new Error("expected boost-handoff room");
  const none = { active: 0, boosted: 0, total: 0 };
  const creep: CreepSnapshot = {
    body: {
      activeParts: 1,
      attack: { active: 1, boosted: boostSettled ? 1 : 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 1,
      tough: none,
      work: none,
    },
    boosts: boostSettled ? [{ bodyPart: "attack", compound: "XUH2O", count: 1 }] : [],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "boost-creep",
    name: "boost-creep",
    ownerUsername: "me",
    pos: { roomName: "W1N1", x: 11, y: 13 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
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
            value.id === "h"
              ? {
                  ...value,
                  energy: boostSettled ? 1_980 : 2_000,
                  mineralAmount: boostSettled ? 0 : 30,
                  mineralType: boostSettled ? null : "XUH2O",
                  store: {
                    ...value.store,
                    freeCapacity: boostSettled ? 3_020 : 2_970,
                    resources: [
                      { amount: boostSettled ? 1_980 : 2_000, resourceType: "energy" },
                      ...(boostSettled ? [] : [{ amount: 30, resourceType: "XUH2O" }]),
                    ],
                    usedCapacity: boostSettled ? 1_980 : 2_030,
                  },
                }
              : value,
          ),
        },
      ],
    },
  };
}

export function labHandoffFixtureWorld(tick: number, reversed = false): WorldSnapshot {
  const labs = [
    handoffLab("a", "H", 30, 10, 10),
    handoffLab("b", "O", 30, 12, 10),
    handoffLab("c", null, 0, 11, 10),
    handoffLab("d", null, 0, 10, 11),
    handoffLab("e", null, 0, 11, 11),
    handoffLab("f", null, 0, 12, 11),
    handoffLab("g", null, 0, 10, 12),
    handoffLab("h", null, 0, 11, 12),
    handoffLab("i", null, 0, 12, 12),
    handoffLab("external", null, 0, 40, 40, 0),
  ];
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedRooms: [
      {
        name: "W1N1",
        observedAt: tick,
        ownedCreeps: [],
        ownedLabs: reversed ? labs.reverse() : labs,
        ownedStorages: [
          {
            active: true,
            id: "storage",
            pos: { roomName: "W1N1", x: 20, y: 20 },
            store: {
              capacity: 1_000_000,
              freeCapacity: 999_940,
              resources: [
                { amount: 30, resourceType: "H" },
                { amount: 30, resourceType: "O" },
              ],
              usedCapacity: 60,
            },
          },
        ],
        ownedTerminals: [],
      },
    ],
  } as unknown as WorldSnapshot;
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

function handoffLab(
  id: string,
  mineralType: string | null,
  mineralAmount: number,
  x: number,
  y: number,
  energy = 2_000,
) {
  return {
    active: true,
    cooldown: 0,
    energy,
    energyCapacity: 2_000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount,
    mineralCapacity: 3_000,
    mineralType,
    pos: { roomName: "W1N1", x, y },
    store: {
      capacity: 5_000,
      freeCapacity: 5_000 - mineralAmount - energy,
      resources: [
        ...(energy > 0 ? [{ amount: energy, resourceType: "energy" }] : []),
        ...(mineralType === null ? [] : [{ amount: mineralAmount, resourceType: mineralType }]),
      ],
      usedCapacity: mineralAmount + energy,
    },
  };
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
