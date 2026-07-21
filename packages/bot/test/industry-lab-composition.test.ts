import { describe, expect, it, vi } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import type { ArbitrationBatch } from "../src/execution";
import {
  composeLabRuntime,
  createPendingLabAttempt,
  executeLabIntents,
  fingerprintCreepSnapshot,
  projectLabTelemetry,
  settleLabComposition,
  type BoostManifest,
  type LabCommandIntent,
  type ReactionObjective,
} from "../src/industry";
import type { CreepSnapshot, WorldSnapshot } from "../src/world/snapshot";

const reactions = { H: { O: "OH" } };
const reactionTimes = { OH: 10 };

describe("composed lab runtime", () => {
  it("publishes one current quiescence view without exposing lab policy internals", () => {
    const snapshot = world("forward");
    const idle = composeLabRuntime({
      fundedBudgetIds: new Set(),
      pendingAttempts: [],
      policy: buildRuntimeConfig().policy.industry,
      previousCommitments: [],
      reactionObjectives: [],
      reactions,
      reactionTimes,
      snapshot,
      snapshotRevision: "snapshot/100",
    });
    const active = compose(snapshot, objective("forward"));

    expect(idle.migrationRooms).toHaveLength(1);
    expect(idle.migrationRooms[0]).toMatchObject({
      activity: [],
      evacuationStorageId: "storage",
      observedAt: 100,
      quiescent: true,
      roomName: "W1N1",
    });
    expect(idle.migrationRooms[0]?.assignment?.roomName).toBe("W1N1");
    const room = required(snapshot.ownedRooms[0]);
    for (const roomOverride of [
      { ownedStorages: [{ ...required(room.ownedStorages?.[0]), active: false }] },
      {
        ownedStorages: [
          required(room.ownedStorages?.[0]),
          { ...required(room.ownedStorages?.[0]), id: "storage-b" },
        ],
      },
      {
        ownedStorages: [],
        ownedTerminals: [{ ...required(room.ownedStorages?.[0]), cooldown: 0 }],
      },
    ]) {
      expect(
        composeLabRuntime({
          fundedBudgetIds: new Set(),
          pendingAttempts: [],
          policy: buildRuntimeConfig().policy.industry,
          previousCommitments: [],
          reactionObjectives: [],
          reactions,
          reactionTimes,
          snapshot: { ...snapshot, ownedRooms: [{ ...room, ...roomOverride }] },
          snapshotRevision: "snapshot/100",
        }).migrationRooms[0]?.evacuationStorageId,
      ).toBeNull();
    }
    expect(active.migrationRooms[0]).toMatchObject({
      observedAt: 100,
      quiescent: false,
      roomName: "W1N1",
    });
    expect(active.migrationRooms[0]?.activity).toContain("commitment");
    expect(active.migrationRooms[0]?.activity).toContain("intent");

    const stagingSnapshot = world("forward");
    const stagingRoom = required(stagingSnapshot.ownedRooms[0]);
    const staging = compose(
      {
        ...stagingSnapshot,
        ownedRooms: [
          {
            ...stagingRoom,
            ownedLabs: (stagingRoom.ownedLabs ?? []).map((value) => ({
              ...value,
              energy: 0,
              mineralAmount: 0,
              mineralType: null,
            })),
          },
        ],
      },
      objective("forward"),
    );
    expect(staging.migrationRooms[0]).toMatchObject({ quiescent: false });
    expect(staging.migrationRooms[0]?.activity).toContain("demand-endpoint");
    expect(staging.migrationRooms[0]?.activity).toContain("staging-demand");

    const pending = required(createPendingLabAttempt(required(active.intents[0]), "OK"));
    const pendingOnly = composeLabRuntime({
      fundedBudgetIds: new Set(),
      pendingAttempts: [pending],
      policy: buildRuntimeConfig().policy.industry,
      previousCommitments: [],
      reactionObjectives: [],
      reactions,
      reactionTimes,
      snapshot,
      snapshotRevision: "snapshot/100",
    });
    expect(pendingOnly.migrationRooms[0]).toMatchObject({
      activity: ["pending-attempt"],
      quiescent: false,
    });
  });

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

  it("durably rebinds one reaction before publishing retained-lab work", () => {
    const objectiveValue = { ...objective("forward"), amount: 30 };
    const first = composeHandoff(handoffWorld(100), objectiveValue);
    const previous = required(first.policy.commitments[0]);
    if (previous.kind !== "reaction") throw new Error("expected reaction commitment");

    const pending = composeHandoff(handoffWorld(101, true), objectiveValue, [
      { ...previous, settledAmount: 5 },
    ]);
    expect(pending.intents).toEqual([]);
    expect(pending.policy.commitments).toEqual([
      {
        ...previous,
        assignmentFingerprint: pending.assignments[0]?.fingerprint,
        settledAmount: 5,
      },
    ]);
    expect(pending.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      objectiveId: objectiveValue.id,
      objectiveRevision: objectiveValue.revision,
      status: "pending",
      targetLabId: "external",
    });

    const resetCommitments = roundTrip(pending.policy.commitments);
    const ready = composeHandoff(handoffWorld(102), objectiveValue, resetCommitments);
    const reordered = composeHandoff(handoffWorld(102, true), objectiveValue, resetCommitments);
    expect(ready.policy.commitments).toEqual(pending.policy.commitments);
    expect(ready.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      status: "ready",
      targetLabId: "external",
    });
    expect(ready.intents).toEqual([expect.objectContaining({ kind: "lab.run-reaction" })]);
    const refilledTarget = composeHandoff(
      withExternalEnergy(handoffWorld(102), 100),
      objectiveValue,
      ready.policy.commitments,
    );
    expect(refilledTarget.policy.commitments).toEqual(ready.policy.commitments);
    expect(refilledTarget.migrationRooms[0]?.assignmentHandoff?.status).toBe("ready");
    expect(JSON.stringify(reordered.policy)).toBe(JSON.stringify(ready.policy));
    expect(reordered.migrationRooms[0]?.assignmentHandoff).toEqual(
      ready.migrationRooms[0]?.assignmentHandoff,
    );

    const intent = required(ready.intents[0]);
    const attempt = required(createPendingLabAttempt(intent, "OK"));
    const noEffect = composeHandoff(handoffWorld(103), objectiveValue, ready.policy.commitments, [
      attempt,
    ]);
    expect(noEffect.settlements).toEqual([
      expect.objectContaining({ reason: "no-effect", status: "retry" }),
    ]);
    expect(noEffect.migrationRooms[0]?.activity).toContain("pending-attempt");
    expect(noEffect.migrationRooms[0]?.assignmentHandoff?.status).toBe("ready");
    expect(noEffect.migrationRooms[0]?.quiescent).toBe(false);
    const observed = composeHandoff(
      handoffWorld(103, false, true),
      objectiveValue,
      ready.policy.commitments,
      [attempt],
    );
    const settled = settleLabComposition({
      execution: [],
      previousAttempts: [attempt],
      projection: observed,
    });
    expect(observed.settlements).toEqual([
      expect.objectContaining({ reason: "exact-effect", settledAmount: 5, status: "settled" }),
    ]);
    expect(settled).toMatchObject({
      attempts: [],
      commitments: [
        {
          assignmentFingerprint: ready.assignments[0]?.fingerprint,
          settledAmount: 10,
        },
      ],
    });
  });

  it("durably rebinds one reaction around an energy-only external lab", () => {
    const objectiveValue = { ...objective("forward"), amount: 30 };
    const first = composeHandoff(handoffWorld(100), objectiveValue);
    const previous = required(first.policy.commitments[0]);
    if (previous.kind !== "reaction") throw new Error("expected reaction commitment");

    const pending = composeHandoff(
      withExternalEnergy(handoffWorld(101, true), 100),
      objectiveValue,
      [{ ...previous, settledAmount: 5 }],
    );
    expect(pending.intents).toEqual([]);
    expect(pending.policy.commitments).toEqual([
      {
        ...previous,
        assignmentFingerprint: pending.assignments[0]?.fingerprint,
        settledAmount: 5,
      },
    ]);
    expect(pending.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      status: "pending",
      targetLabId: "external",
    });

    const durable = roundTrip(pending.policy.commitments);
    const ready = composeHandoff(
      withExternalEnergy(handoffWorld(102), 100),
      objectiveValue,
      durable,
    );
    const reordered = composeHandoff(
      withExternalEnergy(handoffWorld(102, true), 100),
      objectiveValue,
      durable,
    );
    expect(ready.migrationRooms[0]?.assignmentHandoff?.status).toBe("ready");
    expect(ready.intents).toEqual([expect.objectContaining({ kind: "lab.run-reaction" })]);
    expect(JSON.stringify(reordered.policy)).toBe(JSON.stringify(ready.policy));
  });

  it("durably rebinds one reaction around a mineral-only external lab", () => {
    const objectiveValue = { ...objective("forward"), amount: 30 };
    const first = composeHandoff(handoffWorld(100), objectiveValue);
    const previous = required(first.policy.commitments[0]);
    if (previous.kind !== "reaction") throw new Error("expected reaction commitment");

    const pending = composeHandoff(
      withExternalMineral(handoffWorld(101, true), 100),
      objectiveValue,
      [{ ...previous, settledAmount: 5 }],
    );
    expect(pending.intents).toEqual([]);
    expect(pending.policy.commitments).toEqual([
      {
        ...previous,
        assignmentFingerprint: pending.assignments[0]?.fingerprint,
        settledAmount: 5,
      },
    ]);
    expect(pending.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      status: "pending",
      targetLabId: "external",
    });

    const durable = roundTrip(pending.policy.commitments);
    const ready = composeHandoff(
      withExternalMineral(handoffWorld(102), 100),
      objectiveValue,
      durable,
    );
    const reordered = composeHandoff(
      withExternalMineral(handoffWorld(102, true), 100),
      objectiveValue,
      durable,
    );
    expect(ready.migrationRooms[0]?.assignmentHandoff?.status).toBe("ready");
    expect(ready.intents).toEqual([expect.objectContaining({ kind: "lab.run-reaction" })]);
    expect(JSON.stringify(reordered.policy)).toBe(JSON.stringify(ready.policy));
  });

  it("keeps assignment handoff closed for pending effects, mixed stock, and changed roles", () => {
    const objectiveValue = { ...objective("forward"), amount: 30 };
    const first = composeHandoff(handoffWorld(100), objectiveValue);
    const previous = required(first.policy.commitments[0]);
    const attempt = required(createPendingLabAttempt(required(first.intents[0]), "OK"));
    const pending = composeHandoff(handoffWorld(101), objectiveValue, [previous], [attempt]);
    expect(pending.migrationRooms[0]?.assignmentHandoff).toBeNull();
    expect(pending.policy.commitments).toEqual([previous]);

    const stocked = composeHandoff(
      withExternalMixedStock(handoffWorld(101), 100, 100),
      objectiveValue,
      [previous],
    );
    expect(stocked.migrationRooms[0]?.assignmentHandoff).toBeNull();
    expect(stocked.policy.commitments).toEqual([previous]);

    const malformedWorld = withExternalMineral(handoffWorld(101), 100);
    const malformedRoom = required(malformedWorld.ownedRooms[0]);
    const malformed = composeHandoff(
      {
        ...malformedWorld,
        ownedRooms: [
          {
            ...malformedRoom,
            ownedLabs: (malformedRoom.ownedLabs ?? []).map((lab) =>
              lab.id === "external"
                ? { ...lab, store: { ...lab.store, usedCapacity: lab.store.usedCapacity + 1 } }
                : lab,
            ),
          },
        ],
      },
      objectiveValue,
      [previous],
    );
    expect(malformed.migrationRooms[0]?.assignmentHandoff).toBeNull();

    const boost = withBoostCandidate(withExternalMineral(handoffWorld(101), 100));
    const boostActive = composeHandoff(boost.snapshot, objectiveValue, [previous], [], undefined, [
      boost.manifest,
    ]);
    expect(boostActive.migrationRooms[0]?.assignmentHandoff).toBeNull();
    expect(boostActive.policy.commitments).toEqual([expect.objectContaining({ kind: "boost" })]);

    const changedRoles = composeHandoff(
      handoffWorld(101),
      objectiveValue,
      [previous],
      [],
      ["a", "b", "c", "d", "e", "f", "g", "h", "external"],
    );
    expect(changedRoles.migrationRooms[0]?.assignmentHandoff).toBeNull();
    expect(changedRoles.policy.commitments).toEqual([previous]);
  });

  it("holds a durable rebound while layout evidence or reaction staging is unavailable", () => {
    const objectiveValue = { ...objective("forward"), amount: 30 };
    const first = composeHandoff(handoffWorld(100), objectiveValue);
    const rebound = composeHandoff(handoffWorld(101), objectiveValue, [
      required(first.policy.commitments[0]),
    ]);
    const durable = roundTrip(rebound.policy.commitments);

    const missingLayout = composeWithoutCommittedLayout(handoffWorld(102), objectiveValue, durable);
    expect(missingLayout.policy.commitments).toEqual(durable);
    expect(missingLayout.resourceDemands.edges).toEqual([]);
    expect(missingLayout.intents).toEqual([]);
    expect(missingLayout.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      layoutFingerprint: null,
      status: "blocked",
      targetLabId: "external",
    });

    const staleLayout = composeHandoff(
      handoffWorld(102),
      objectiveValue,
      durable,
      [],
      ["a", "b", "c", "d", "e", "f", "g", "h", "external"],
    );
    expect(staleLayout.policy.commitments).toEqual(durable);
    expect(staleLayout.resourceDemands.edges).toEqual([]);
    expect(staleLayout.intents).toEqual([]);
    expect(staleLayout.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      layoutFingerprint: "layout-commitment",
      status: "blocked",
      targetLabId: "external",
    });

    const staging = composeHandoff(emptyRetainedLabs(handoffWorld(102)), objectiveValue, durable);
    expect(staging.policy.commitments).toEqual(durable);
    expect(staging.intents).toEqual([]);
    expect(staging.migrationRooms[0]?.assignmentHandoff).toMatchObject({
      layoutFingerprint: "layout-commitment",
      status: "blocked",
      targetLabId: "external",
    });
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

function composeHandoff(
  snapshot: WorldSnapshot,
  reactionObjective: ReactionObjective,
  previousCommitments = [] as ReturnType<typeof composeLabRuntime>["policy"]["commitments"],
  pendingAttempts = [] as Parameters<typeof composeLabRuntime>[0]["pendingAttempts"],
  committedLabIds?: readonly string[],
  boostManifests = [] as readonly BoostManifest[],
) {
  const labs = required(snapshot.ownedRooms[0]?.ownedLabs);
  const committed =
    committedLabIds === undefined
      ? labs.filter(({ id }) => id !== "external")
      : labs.filter(({ id }) => committedLabIds.includes(id));
  return composeLabRuntime({
    boostManifests,
    committedLabLayouts: [
      {
        labPositions: [
          ...committed.map(({ pos }) => pos),
          { roomName: "W1N1", x: 13, y: 12 },
        ].reverse(),
        layoutFingerprint: "layout-commitment",
        roomName: "W1N1",
      },
    ],
    fundedBudgetIds: new Set([
      reactionObjective.industryBudgetId,
      ...boostManifests.map(({ industryBudgetId }) => industryBudgetId),
    ]),
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

function composeWithoutCommittedLayout(
  snapshot: WorldSnapshot,
  reactionObjective: ReactionObjective,
  previousCommitments: ReturnType<typeof composeLabRuntime>["policy"]["commitments"],
) {
  return composeLabRuntime({
    committedLabLayouts: [],
    fundedBudgetIds: new Set([reactionObjective.industryBudgetId]),
    pendingAttempts: [],
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

function emptyRetainedLabs(snapshot: WorldSnapshot): WorldSnapshot {
  const room = required(snapshot.ownedRooms[0]);
  return {
    ...snapshot,
    ownedRooms: [
      {
        ...room,
        ownedLabs: (room.ownedLabs ?? []).map((value) =>
          value.id === "external"
            ? value
            : {
                ...value,
                energy: 0,
                mineralAmount: 0,
                mineralType: null,
                store: {
                  ...value.store,
                  freeCapacity: 5_000,
                  resources: [],
                  usedCapacity: 0,
                },
              },
        ),
      },
    ],
  };
}

function withExternalEnergy(snapshot: WorldSnapshot, energy: number): WorldSnapshot {
  const room = required(snapshot.ownedRooms[0]);
  return {
    ...snapshot,
    ownedRooms: [
      {
        ...room,
        ownedLabs: (room.ownedLabs ?? []).map((value) =>
          value.id === "external"
            ? {
                ...value,
                energy,
                store: {
                  ...value.store,
                  capacity: null,
                  freeCapacity: null,
                  resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
                  usedCapacity: energy,
                },
              }
            : value,
        ),
      },
    ],
  };
}

function withExternalMineral(snapshot: WorldSnapshot, mineralAmount: number): WorldSnapshot {
  const room = required(snapshot.ownedRooms[0]);
  return {
    ...snapshot,
    ownedRooms: [
      {
        ...room,
        ownedLabs: (room.ownedLabs ?? []).map((value) =>
          value.id === "external"
            ? {
                ...value,
                mineralAmount,
                mineralType: "Z",
                store: {
                  ...value.store,
                  freeCapacity: 5_000 - mineralAmount,
                  resources: [{ amount: mineralAmount, resourceType: "Z" }],
                  usedCapacity: mineralAmount,
                },
              }
            : value,
        ),
      },
    ],
  };
}

function withExternalMixedStock(
  snapshot: WorldSnapshot,
  energy: number,
  mineralAmount: number,
): WorldSnapshot {
  const room = required(snapshot.ownedRooms[0]);
  return {
    ...snapshot,
    ownedRooms: [
      {
        ...room,
        ownedLabs: (room.ownedLabs ?? []).map((value) =>
          value.id === "external"
            ? {
                ...value,
                energy,
                mineralAmount,
                mineralType: "Z",
                store: {
                  ...value.store,
                  capacity: null,
                  freeCapacity: null,
                  resources: [
                    { amount: energy, resourceType: "energy" },
                    { amount: mineralAmount, resourceType: "Z" },
                  ],
                  usedCapacity: energy + mineralAmount,
                },
              }
            : value,
        ),
      },
    ],
  };
}

function withBoostCandidate(snapshot: WorldSnapshot): {
  readonly manifest: BoostManifest;
  readonly snapshot: WorldSnapshot;
} {
  const room = required(snapshot.ownedRooms[0]);
  const none = { active: 0, boosted: 0, total: 0 };
  const creep: CreepSnapshot = {
    body: {
      activeParts: 1,
      attack: { active: 1, boosted: 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 1,
      tough: none,
      work: none,
    },
    boosts: [],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "boost-creep",
    name: "boost-creep",
    ownerUsername: "me",
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
  return {
    manifest: {
      colonyId: "W1N1",
      compound: "OH",
      creepFingerprint: fingerprintCreepSnapshot(creep),
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
      ownedRooms: [{ ...room, ownedCreeps: [creep] }],
    },
  };
}

function handoffWorld(tick: number, reversed = false, settled = false): WorldSnapshot {
  const labs = [
    labAt("a", "H", settled ? 25 : 30, 10, 10),
    labAt("b", "O", settled ? 25 : 30, 12, 10),
    labAt("c", settled ? "OH" : null, settled ? 5 : 0, 11, 10),
    labAt("d", null, 0, 10, 11),
    labAt("e", null, 0, 11, 11),
    labAt("f", null, 0, 12, 11),
    labAt("g", null, 0, 10, 12),
    labAt("h", null, 0, 11, 12),
    labAt("i", null, 0, 12, 12),
    ...(settled ? [] : [labAt("external", null, 0, 40, 40, 0)]),
  ];
  const ordered = reversed ? [...labs].reverse() : labs;
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedRooms: [
      {
        name: "W1N1",
        observedAt: tick,
        ownedCreeps: [],
        ownedLabs: ordered,
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
  return labAt(id, mineralType, mineralAmount, x, 10);
}

function labAt(
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

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
