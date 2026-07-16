import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../../bot/src/config/runtime-config";
import { executeDefenseIntents, planDefense, type DefenseIntentKind } from "../../bot/src/defense";
import { createIntentChannel, type IntentData } from "../../bot/src/execution";
import { freezeWorldSnapshot, type WorldSnapshot } from "../../bot/src/world/snapshot";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

const FIRST_TICK = 52_000;
const CPU_BUDGET = 3;
const CPU_USED = 2;

interface PressureInput {
  readonly hostilePressure: boolean;
  readonly reverseCollections: boolean;
}

interface PressureWorld {
  readonly threatPresent: boolean;
}

interface PressureOutcome {
  readonly accepted: readonly string[];
  readonly commands: readonly string[];
  readonly duplicateCommands: number;
  readonly normalWork: "resumed" | "suspended";
  readonly threat: "absent" | "present" | "removed";
}

interface PressureHeap {
  readonly rebuilt: boolean;
}

describe("Phase 1 hostile-pressure recovery replay (#30)", () => {
  it("bounds defense, resets safely, and returns to normal work after threat removal", () => {
    const warm = runScenario(pressureScenario(false, false));
    const reset = runScenario(pressureScenario(true, false));
    const reordered = runScenario(pressureScenario(true, true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reordered.outcomes).toEqual(reset.outcomes);
    expect(reordered.finalWorld).toEqual(reset.finalWorld);
    expect(reordered.outcomeHash).toBe(reset.outcomeHash);
    expect(reset.transcript.ticks.map(({ heapReset }) => heapReset)).toEqual([false, true, false]);

    expect(reset.outcomes.map(({ threat }) => threat)).toEqual(["absent", "removed", "absent"]);
    expect(reset.outcomes.map(({ normalWork }) => normalWork)).toEqual([
      "resumed",
      "suspended",
      "resumed",
    ]);
    expect(reset.outcomes[1]?.accepted).toHaveLength(1);
    expect(reset.outcomes[1]?.accepted[0]).toContain("tower.attack");
    expect(reset.outcomes[1]?.commands).toEqual(["tower-1:tower.attack:hostile-1"]);
    expect(reset.outcomes.every(({ duplicateCommands }) => duplicateCommands === 0)).toBe(true);
    expect(reset.outcomes[1]?.commands).toHaveLength(1);
    expect(reset.outcomes[1]?.normalWork).toBe("suspended");
    expect(reset.outcomes[2]?.commands).toEqual([]);
  });
});

function pressureScenario(
  resetHeap: boolean,
  reverseCollections: boolean,
): ReplayScenario<PressureWorld, PressureInput, PressureOutcome, PressureHeap> {
  return defineReplayScenario<PressureWorld, PressureInput, PressureOutcome, PressureHeap>({
    id: "phase1/hostile-pressure-recovery",
    seed: "phase1-hostile-pressure",
    initialWorld: { threatPresent: false },
    ticks: [
      {
        gameTime: FIRST_TICK,
        input: { hostilePressure: false, reverseCollections },
        cpuBudget: CPU_BUDGET,
      },
      {
        gameTime: FIRST_TICK + 1,
        input: { hostilePressure: true, reverseCollections },
        cpuBudget: CPU_BUDGET,
        resetHeap,
      },
      {
        gameTime: FIRST_TICK + 2,
        input: { hostilePressure: false, reverseCollections },
        cpuBudget: CPU_BUDGET,
      },
    ],
    createHeap: ({ reason }) => ({ rebuilt: reason === "reset" }),
    resetHeap: () => ({ rebuilt: true }),
    assertCpu: ({ budget, used }) => {
      expect(budget).toBe(CPU_BUDGET);
      expect(used).toBe(CPU_USED);
      expect(used).toBeLessThanOrEqual(budget);
    },
    step: ({ gameTime, input }) => {
      const snapshot = pressureSnapshot(gameTime, input);
      const intents = planDefense(snapshot, buildRuntimeConfig());
      const channel = createIntentChannel<DefenseIntentKind, IntentData>({
        maximumSubmitted: 1,
        maximumAccepted: 1,
        maximumBudget: 1,
        overloadPolicy: "reject",
      });
      const producer = channel.openProducer("defense.plan");
      for (const intent of intents) producer.producer.submit(intent);
      producer.stage().commit();
      const batch = channel.arbiter.arbitrate({
        tick: gameTime,
        snapshotRevision: snapshotRevision(snapshot),
      });
      const commands: string[] = [];
      executeDefenseIntents(batch, gameTime, (id) => liveObject(id, commands), {
        getUsed: () => 0,
      });
      const threatRemoved = commands.length === 1;
      const nextThreatPresent = false;
      return {
        nextWorld: { threatPresent: nextThreatPresent },
        outcome: {
          accepted: batch.accepted.map(({ id }) => id),
          commands,
          duplicateCommands: commands.length - new Set(commands).size,
          normalWork: input.hostilePressure ? "suspended" : "resumed",
          threat: input.hostilePressure ? (threatRemoved ? "removed" : "present") : "absent",
        },
        cpuUsed: CPU_USED,
      };
    },
  });
}

function pressureSnapshot(tick: number, input: PressureInput): WorldSnapshot {
  const hostile = creep("hostile-1", "Enemy", 2);
  const decoy = creep("hostile-2", "Enemy", 1);
  const hostiles = input.reverseCollections ? [decoy, hostile] : [hostile, decoy];
  const room = {
    name: "W1N1",
    observedAt: tick,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controller: {
      id: "controller-1",
      level: 2,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: pos("W1N1", 25, 24),
      progress: 0,
      progressTotal: 1,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 10_000,
      upgradeBlocked: null,
    },
    hostileCreeps: input.hostilePressure ? hostiles : [],
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [
      {
        active: true,
        id: "spawn-1",
        name: "Spawn1",
        pos: pos("W1N1", 24, 25),
        hits: 5_000,
        hitsMax: 5_000,
        spawning: null,
        store: store(300),
      },
    ],
    ownedTowers: [
      { id: "tower-1", pos: pos("W1N1", 25, 25), hits: 3_000, hitsMax: 3_000, store: store(800) },
    ],
    constructionSites: [],
    droppedResources: [],
    ruins: [],
    sources: [],
    storedStructures: [],
    tombstones: [],
  };
  return freezeWorldSnapshot({
    schemaVersion: 1,
    observation: { age: 0, shard: "shard2", status: "observed", tick },
    observedAt: tick,
    rooms: [room],
    ownedRooms: [room],
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: [{ roomName: "W1N1", status: "visible", observedAt: tick, age: 0 }],
      scope: "current-tick",
    },
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: room.hostileCreeps.length,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 1,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: 3 + room.hostileCreeps.length,
      },
      estimatedPayloadBytes: 0,
    },
  });
}

function snapshotRevision(snapshot: WorldSnapshot): string {
  return `${snapshot.observation.shard}:${String(snapshot.observedAt)}:${String(
    snapshot.stats.estimatedPayloadBytes,
  )}`;
}

function liveObject(id: string, commands: string[]): unknown {
  if (id === "tower-1") {
    return {
      attack: (target: { readonly id: string }) => (
        commands.push(`tower-1:tower.attack:${target.id}`),
        0
      ),
      heal: () => 0,
      repair: () => 0,
    };
  }
  return { id };
}

function creep(id: string, ownerUsername: string, attack: number) {
  const part = (active: number) => ({ active, boosted: 0, total: active });
  return {
    id,
    name: id,
    ownerUsername,
    pos: pos("W1N1", 20, 20),
    body: {
      activeParts: attack,
      attack: part(attack),
      carry: part(0),
      claim: part(0),
      heal: part(0),
      move: part(attack),
      rangedAttack: part(0),
      size: attack,
      tough: part(0),
      work: part(0),
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    spawning: false,
    store: store(0),
    ticksToLive: 1_000,
  };
}

function pos(roomName: string, x: number, y: number) {
  return { roomName, x, y };
}

function store(energy: number) {
  return {
    capacity: 1_000,
    freeCapacity: 1_000 - energy,
    resources: [{ resourceType: "energy", amount: energy }],
    usedCapacity: energy,
  };
}
