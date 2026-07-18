import { describe, expect, it, vi } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import type { ArbitrationBatch } from "../src/execution";
import {
  composeLabRuntime,
  createPendingLabAttempt,
  executeLabIntents,
  projectLabTelemetry,
  settleLabComposition,
  type LabCommandIntent,
  type ReactionObjective,
} from "../src/industry";
import type { WorldSnapshot } from "../src/world/snapshot";

const reactions = { H: { O: "OH" } };
const reactionTimes = { OH: 10 };

describe("composed lab runtime", () => {
  it("projects deterministic forward and explicitly funded reverse commands", () => {
    const forward = compose(world("forward"), objective("forward"));
    const reverse = compose(world("reverse"), objective("reverse"));

    expect(forward.intents[0]?.kind).toBe("lab.run-reaction");
    expect(forward.intents[0]?.exclusiveResourceKey).toMatch(/^lab-cluster\//);
    expect(reverse.intents[0]?.kind).toBe("lab.reverse-reaction");
    expect(reverse.intents[0]?.exclusiveResourceKey).toMatch(/^lab-cluster\//);
    expect(reverse.policy.dispositions).toEqual([
      expect.objectContaining({ status: "ready", objectiveId: "objective/reverse" }),
    ]);
  });

  it("settles only exact reverse deltas and makes no-effect attempts retry-ready", () => {
    const first = compose(world("reverse"), objective("reverse"));
    const intent = required(first.intents[0]);
    const pending = required(createPendingLabAttempt(intent, "OK"));
    const exactProjection = compose(
      world("reverse-settled", 101),
      objective("reverse"),
      first.policy.commitments,
      [pending],
    );
    const exact = settleLabComposition({
      execution: [],
      previousAttempts: [pending],
      projection: exactProjection,
    });
    expect(exactProjection.settlements).toEqual([
      expect.objectContaining({
        accounting: { energyInput: 0, resourceInput: 5, resourceOutput: 10 },
        reason: "exact-effect",
        settledAmount: 5,
        status: "settled",
      }),
    ]);
    expect(exact.commitments).toEqual([expect.objectContaining({ settledAmount: 5 })]);
    expect(exact.attempts).toEqual([]);
    expect(projectLabTelemetry(exactProjection, []).accounting).toEqual([0, 5, 10]);

    const noEffectProjection = compose(
      world("reverse", 101),
      objective("reverse"),
      first.policy.commitments,
      [pending],
    );
    const retry = settleLabComposition({
      execution: [],
      previousAttempts: [pending],
      projection: noEffectProjection,
    });
    expect(retry.attempts).toEqual([expect.objectContaining({ retry: 1, retryReady: true })]);
  });

  it("issues reverseReaction only through an accepted shared-channel intent", () => {
    const projection = compose(world("reverse"), objective("reverse"));
    const intent = required(projection.intents[0]);
    const source = liveLab("out", "OH", 5);
    const resultA = liveLab("a", null, 0);
    const resultB = liveLab("b", null, 0);
    const reverseReaction = vi.fn((): ScreepsReturnCode => 0);
    source.reverseReaction = reverseReaction;
    const execution = executeLabIntents(batch(intent), 100, {
      creepFingerprint: () => "unused",
      resolveCreep: () => null,
      resolveLab: (id) => [source, resultA, resultB].find((lab) => lab.id === id) ?? null,
    });
    expect(reverseReaction).toHaveBeenCalledWith(resultA, resultB);
    expect(execution).toEqual([expect.objectContaining({ status: "executed", reason: "OK" })]);
  });
});

function compose(
  snapshot: WorldSnapshot,
  reactionObjective: ReactionObjective,
  previousCommitments = [] as ReturnType<typeof composeLabRuntime>["policy"]["commitments"],
  pendingAttempts = [] as Parameters<typeof composeLabRuntime>[0]["pendingAttempts"],
) {
  return composeLabRuntime({
    fundedBudgetIds: new Set([reactionObjective.industryBudgetId]),
    pendingAttempts,
    policy: buildRuntimeConfig().policy.industry,
    previousCommitments,
    reactionObjectives: [reactionObjective],
    reactions,
    reactionTimes,
    snapshot,
    snapshotRevision: `snapshot/${String(snapshot.observation.tick)}`,
  });
}

function objective(direction: "forward" | "reverse"): ReactionObjective {
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

function world(mode: "forward" | "reverse" | "reverse-settled", tick = 100): WorldSnapshot {
  const labs =
    mode === "forward"
      ? [lab("a", "H", 5, 10), lab("b", "O", 5, 11), lab("out", null, 0, 12)]
      : mode === "reverse"
        ? [lab("a", null, 0, 10), lab("b", null, 0, 11), lab("out", "OH", 5, 12)]
        : [lab("a", "H", 5, 10), lab("b", "O", 5, 11), lab("out", null, 0, 12)];
  const resources =
    mode === "forward"
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

function lab(id: string, mineralType: string | null, mineralAmount: number, x: number) {
  return {
    active: true,
    cooldown: 0,
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

function liveLab(id: string, mineralType: string | null, mineralAmount: number): StructureLab {
  return {
    id,
    my: true,
    cooldown: 0,
    mineralType,
    pos: { getRangeTo: () => 1 },
    isActive: () => true,
    store: {
      getUsedCapacity: (resource?: string) => (resource === mineralType ? mineralAmount : 0),
      getFreeCapacity: () => 3_000 - mineralAmount,
    },
    reverseReaction: vi.fn(() => 0),
  } as unknown as StructureLab;
}

function batch(intent: LabCommandIntent): ArbitrationBatch {
  return { accepted: [intent], acceptedBudget: 1, decisions: [], submitted: 1, tick: 100 };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected fixture value");
  return value;
}
