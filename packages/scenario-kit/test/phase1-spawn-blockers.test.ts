import { describe, expect, it } from "vitest";
import {
  SpawnBroker,
  SpawnExecutor,
  type SpawnBodyPart,
  type SpawnBrokerPolicy,
  type SpawnCommandIntent,
  type SpawnDemand,
  type SpawnExpectation,
  type SpawnSelection,
} from "../../bot/src/spawn";
import {
  emptyWorldSnapshot,
  freezeWorldSnapshot,
  type OwnedRoomSnapshot,
  type OwnedSpawnSnapshot,
  type StoreSnapshot,
  type WorldSnapshot,
} from "../../bot/src/world/snapshot";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

const FIRST_TICK = 42_100;
const ROOM_NAME = "W1N1";
const ENERGY_COST = 200;

const POLICY: SpawnBrokerPolicy = Object.freeze({
  maximumBodyParts: 50,
  maximumBodyEnergy: 3_000,
  maximumNonMovePartsPerMovePart: 2,
  nameCollisionRetryLimit: 2,
  retryDelayTicks: 3,
});

type Blocker = "busy" | "insufficient-energy" | "clear";

interface BlockerWorld {
  readonly expectations: readonly SpawnExpectation[];
}

interface BlockerInput {
  readonly blocker: Blocker;
  readonly demandIds: readonly string[];
  readonly energy: number;
  readonly reverse: boolean;
}

interface BlockerOutcome {
  readonly blocker: Blocker;
  readonly decisions: readonly {
    readonly reason: string;
    readonly retryAt: number | null;
    readonly status: string;
  }[];
  readonly executions: readonly {
    readonly reason: string;
    readonly status: string;
  }[];
  readonly commands: readonly {
    readonly name: string;
    readonly spawnId: string;
  }[];
  readonly selected: readonly {
    readonly demandId: string;
    readonly energyCost: number;
    readonly spawnId: string;
  }[];
}

interface BlockerHeap {
  readonly broker: SpawnBroker;
  readonly executor: SpawnExecutor;
}

describe("Phase 1 spawn blocker recovery replay", () => {
  it("defers busy and underfunded spawns, then issues exactly one command after recovery", () => {
    const { warm, reset, reordered } = collectSpawnBlockerEvidence();

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reordered.outcomes).toEqual(reset.outcomes);
    expect(reordered.finalWorld).toEqual(reset.finalWorld);
    expect(reordered.outcomeHash).toBe(reset.outcomeHash);

    const busy = requiredOutcome(reset.outcomes, 0);
    const insufficient = requiredOutcome(reset.outcomes, 1);
    const recovered = requiredOutcome(reset.outcomes, 2);
    const afterRecovery = requiredOutcome(reset.outcomes, 3);

    expect(busy.commands).toEqual([]);
    expect(busy.executions).toEqual([]);
    expect(busy.selected).toEqual([]);
    expect(busy.decisions).toEqual([
      {
        reason: "no-idle-spawn",
        retryAt: FIRST_TICK + POLICY.retryDelayTicks,
        status: "deferred",
      },
    ]);

    expect(insufficient.commands).toEqual([]);
    expect(insufficient.executions).toEqual([]);
    expect(insufficient.selected).toEqual([]);
    expect(insufficient.decisions).toEqual([
      {
        reason: "insufficient-energy",
        retryAt: FIRST_TICK + 1 + POLICY.retryDelayTicks,
        status: "deferred",
      },
    ]);

    expect(recovered.selected).toEqual([
      { demandId: "worker-a", energyCost: ENERGY_COST, spawnId: "spawn-a" },
    ]);
    expect(recovered.executions).toEqual([{ reason: "scheduled", status: "scheduled" }]);
    expect(recovered.commands).toHaveLength(1);
    expect(afterRecovery.commands).toEqual([]);
    expect(afterRecovery.executions).toEqual([]);
    expect(afterRecovery.selected).toEqual([]);
    expect(afterRecovery.decisions[0]).toMatchObject({
      reason: "expectation-pending",
      status: "deferred",
    });

    expect(reset.outcomes.flatMap(({ commands }) => commands)).toHaveLength(1);
    expect(reset.finalWorld.expectations).toHaveLength(1);
  });
});

export function collectSpawnBlockerEvidence() {
  return Object.freeze({
    warm: runScenario(spawnBlockerScenario(false)),
    reset: runScenario(spawnBlockerScenario(true)),
    reordered: runScenario(spawnBlockerScenario(true, true)),
  });
}

function spawnBlockerScenario(
  resetBetweenTicks: boolean,
  reverse = false,
): ReplayScenario<BlockerWorld, BlockerInput, BlockerOutcome, BlockerHeap> {
  const reset = (index: number): boolean => resetBetweenTicks && index > 0;
  return defineReplayScenario<BlockerWorld, BlockerInput, BlockerOutcome, BlockerHeap>({
    id: "phase1/spawn/blocker-recovery",
    seed: "phase1-spawn-blocker-recovery",
    initialWorld: { expectations: [] as readonly SpawnExpectation[] },
    ticks: [
      {
        gameTime: FIRST_TICK,
        input: input("busy", 300, reverse),
        cpuBudget: 4,
      },
      {
        gameTime: FIRST_TICK + 1,
        input: input("insufficient-energy", 100, reverse),
        cpuBudget: 4,
        resetHeap: reset(1),
      },
      {
        gameTime: FIRST_TICK + 2,
        input: input("clear", 300, reverse),
        cpuBudget: 4,
        resetHeap: reset(2),
      },
      {
        gameTime: FIRST_TICK + 3,
        input: input("clear", 300, reverse),
        cpuBudget: 4,
        resetHeap: reset(3),
      },
    ],
    createHeap: () => ({ broker: new SpawnBroker(), executor: new SpawnExecutor() }),
    resetHeap: () => ({ broker: new SpawnBroker(), executor: new SpawnExecutor() }),
    step: ({ gameTime, heap, input, world }) => {
      const broker = heap.broker.arbitrate({
        tick: gameTime,
        snapshot: snapshot(gameTime, input.energy, input.blocker),
        demands: input.demandIds.map(demand),
        expectations: world.expectations,
        policy: POLICY,
      });
      const intents = broker.selections.map((selection) => spawnIntent(selection, gameTime));
      const commands: Array<{ name: string; spawnId: string }> = [];
      const execution = heap.executor.execute(intents, (spawnId) => liveSpawn(spawnId, commands));
      const newExpectations = execution
        .filter(({ status }) => status === "scheduled")
        .map(({ command }) => ({
          creepName: command.name,
          demandId: command.demandId,
          expectedReadyAt: command.scheduledTick + command.spawnTicks,
          retryAt: command.scheduledTick + command.spawnTicks + POLICY.retryDelayTicks,
          revision: command.revision,
          scheduledAt: command.scheduledTick,
          spawnId: command.spawnId,
        }));

      return {
        nextWorld: { expectations: [...world.expectations, ...newExpectations] },
        outcome: {
          blocker: input.blocker,
          decisions: broker.decisions.map(({ reason, retryAt, status }) => ({
            reason,
            retryAt,
            status,
          })),
          executions: execution.map(({ reason, status }) => ({ reason, status })),
          commands,
          selected: broker.selections.map(({ demandId, energyCost, spawnId }) => ({
            demandId,
            energyCost,
            spawnId,
          })),
        },
        cpuUsed: 2,
      };
    },
  });
}

function input(blocker: Blocker, energy: number, reverse: boolean): BlockerInput {
  const demandIds = ["worker-a"];
  return {
    blocker,
    demandIds: reverse ? [...demandIds].reverse() : demandIds,
    energy,
    reverse,
  };
}

function demand(id: string): SpawnDemand {
  return {
    id,
    issuer: `colony/${ROOM_NAME}/${id}`,
    colonyId: ROOM_NAME,
    revision: 1,
    category: "emergency-recovery",
    priorityValue: 1_000,
    deadline: FIRST_TICK + 100,
    earliestTick: FIRST_TICK,
    destinationRoomName: ROOM_NAME,
    replacementCreepName: null,
    budgetId: `budget-${id}`,
    requiredPartCounts: {
      tough: 0,
      work: 1,
      carry: 1,
      attack: 0,
      ranged_attack: 0,
      heal: 0,
      claim: 0,
      move: 1,
    },
    energyCap: 300,
    nameBasis: "existing-worker",
  };
}

function spawnIntent(selection: SpawnSelection, tick: number): SpawnCommandIntent {
  return {
    intentId: `spawn/${selection.spawnId}/${selection.name}/${String(selection.revision)}`,
    demandId: selection.demandId,
    colonyId: selection.colonyId,
    issuer: selection.issuer,
    revision: selection.revision,
    reservationId: selection.budgetId,
    spawnId: selection.spawnId,
    spawnName: selection.spawnName,
    roomName: selection.destinationRoomName,
    body: selection.body,
    name: selection.name,
    energyCost: selection.energyCost,
    spawnTicks: selection.spawnTicks,
    scheduledTick: tick,
  };
}

function snapshot(tick: number, energy: number, blocker: Blocker): WorldSnapshot {
  const base = emptyWorldSnapshot(tick, "sim");
  const room: OwnedRoomSnapshot = {
    name: ROOM_NAME,
    observedAt: tick,
    energyAvailable: energy,
    energyCapacityAvailable: 300,
    controller: {
      id: "controller-W1N1",
      level: 1,
      ownerUsername: "Myrmex",
      ownership: "owned",
      pos: { roomName: ROOM_NAME, x: 25, y: 25 },
      progress: 0,
      progressTotal: 200,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 1,
      safeModeCooldown: null,
      ticksToDowngrade: 20_000,
      upgradeBlocked: null,
    },
    ownedSpawns: [spawn(blocker)],
    ownedCreeps: [],
    hostileCreeps: [],
    ownedExtensions: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    constructionSites: [],
  };
  return freezeWorldSnapshot({
    ...base,
    observation: { age: 0, shard: "sim", status: "observed", tick },
    observedAt: tick,
    rooms: [room],
    ownedRooms: [room],
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: [{ age: 0, observedAt: tick, roomName: ROOM_NAME, status: "visible" }],
      scope: "current-tick",
    },
  });
}

function spawn(blocker: Blocker): OwnedSpawnSnapshot {
  return {
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    name: "SpawnA",
    pos: { roomName: ROOM_NAME, x: 20, y: 20 },
    spawning:
      blocker === "busy" ? { creepName: "existing-worker", needTime: 9, remainingTime: 5 } : null,
    store: emptyStore(),
  };
}

function liveSpawn(spawnId: string, commands: Array<{ name: string; spawnId: string }>) {
  return {
    id: spawnId,
    name: "SpawnA",
    my: true,
    room: { name: ROOM_NAME },
    spawning: null,
    structureType: "spawn",
    isActive: () => true,
    spawnCreep: (body: readonly SpawnBodyPart[], name: string) => {
      void body;
      commands.push({ name, spawnId });
      return 0;
    },
  };
}

function emptyStore(): StoreSnapshot {
  return { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 };
}

function requiredOutcome(outcomes: readonly BlockerOutcome[], index: number): BlockerOutcome {
  const outcome = outcomes[index];
  if (outcome === undefined) {
    throw new Error(`missing blocker outcome ${String(index)}`);
  }
  return outcome;
}
