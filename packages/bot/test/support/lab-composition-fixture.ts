import { buildRuntimeConfig } from "../../src/config/runtime-config";
import {
  composeLabRuntime,
  type LabPolicyCommitment,
  type PendingLabAttempt,
  type ReactionObjective,
} from "../../src/industry";
import type { WorldSnapshot } from "../../src/world/snapshot";

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
