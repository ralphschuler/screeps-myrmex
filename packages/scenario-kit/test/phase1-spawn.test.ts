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

const FIRST_TICK = 42_000;
const ROOM_NAME = "W1N1";

const POLICY: SpawnBrokerPolicy = Object.freeze({
  maximumBodyParts: 50,
  maximumBodyEnergy: 3_000,
  maximumNonMovePartsPerMovePart: 2,
  nameCollisionRetryLimit: 2,
  retryDelayTicks: 3,
});

interface SpawnScenarioWorld {
  readonly expectations: readonly SpawnExpectation[];
}

interface SpawnScenarioInput {
  readonly demandIds: readonly string[];
  readonly energy: number;
  readonly reverse: boolean;
}

interface SpawnScenarioOutcome {
  readonly decisions: readonly {
    readonly demandId: string;
    readonly reason: string;
    readonly retryAt: number | null;
    readonly status: string;
  }[];
  readonly executions: readonly {
    readonly demandId: string;
    readonly reason: string;
    readonly spawnId: string;
    readonly status: string;
  }[];
  readonly issued: readonly {
    readonly body: readonly SpawnBodyPart[];
    readonly name: string;
    readonly spawnId: string;
  }[];
  readonly selected: readonly {
    readonly body: readonly SpawnBodyPart[];
    readonly demandId: string;
    readonly energyCost: number;
    readonly spawnId: string;
    readonly spawnTicks: number;
  }[];
}

interface SpawnScenarioHeap {
  readonly broker: SpawnBroker;
  readonly executor: SpawnExecutor;
}

describe("Phase 1 spawn broker replay scenarios", () => {
  it("shares room energy deterministically across two idle spawns", () => {
    for (const energy of [300, 400]) {
      const ordered = runScenario(sharedEnergyScenario(energy, false));
      const reordered = runScenario(sharedEnergyScenario(energy, true));

      expect(reordered.outcomes).toEqual(ordered.outcomes);
      expect(reordered.finalWorld).toEqual(ordered.finalWorld);
      expect(reordered.outcomeHash).toBe(ordered.outcomeHash);

      const outcome = requiredOutcome(ordered.outcomes, 0);
      const expectedSelections =
        energy === 300
          ? [["worker-a", "spawn-a"]]
          : [
              ["worker-a", "spawn-a"],
              ["worker-b", "spawn-b"],
            ];
      expect(outcome.selected.map(({ demandId, spawnId }) => [demandId, spawnId])).toEqual(
        expectedSelections,
      );
      expect(outcome.selected.every(({ body }) => body.join(",") === "work,carry,move")).toBe(true);
      expect(
        outcome.selected.every(
          ({ energyCost, spawnTicks }) => energyCost === 200 && spawnTicks === 9,
        ),
      ).toBe(true);
      expect(outcome.selected.reduce((total, selection) => total + selection.energyCost, 0)).toBe(
        energy === 300 ? 200 : 400,
      );
      expect(outcome.issued.map(({ spawnId }) => spawnId)).toEqual(
        expectedSelections.map(([, spawnId]) => spawnId),
      );
      expect(
        outcome.executions.every(
          ({ status, reason }) => status === "scheduled" && reason === "scheduled",
        ),
      ).toBe(true);
    }

    const threeHundred = requiredOutcome(runScenario(sharedEnergyScenario(300, false)).outcomes, 0);
    expect(threeHundred.decisions).toEqual([
      { demandId: "worker-a", reason: "selected", retryAt: null, status: "selected" },
      {
        demandId: "worker-b",
        reason: "insufficient-energy",
        retryAt: FIRST_TICK + POLICY.retryDelayTicks,
        status: "deferred",
      },
    ]);
  });

  it("does not duplicate an acknowledged command after a heap reset", () => {
    const warm = runScenario(resetDedupeScenario(false, false));
    const reset = runScenario(resetDedupeScenario(true, false));
    const resetAndReordered = runScenario(resetDedupeScenario(true, true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reset.transcript.ticks.map(({ heapReset }) => heapReset)).toEqual([false, true]);
    expect(resetAndReordered.outcomes).toEqual(reset.outcomes);
    expect(resetAndReordered.finalWorld).toEqual(reset.finalWorld);

    const first = requiredOutcome(reset.outcomes, 0);
    const afterReset = requiredOutcome(reset.outcomes, 1);
    expect(first.issued).toHaveLength(1);
    expect(first.executions).toEqual([
      {
        demandId: "worker-a",
        reason: "scheduled",
        spawnId: "spawn-a",
        status: "scheduled",
      },
    ]);
    expect(afterReset.selected).toEqual([]);
    expect(afterReset.issued).toEqual([]);
    expect(afterReset.executions).toEqual([]);
    expect(afterReset.decisions).toEqual([
      {
        demandId: "worker-a",
        reason: "expectation-pending",
        retryAt: FIRST_TICK + 11,
        status: "deferred",
      },
    ]);
    expect(reset.finalWorld.expectations).toEqual([
      {
        creepName: first.issued[0]?.name,
        demandId: "worker-a",
        expectedReadyAt: FIRST_TICK + 9,
        retryAt: FIRST_TICK + 11,
        revision: 1,
        scheduledAt: FIRST_TICK,
        spawnId: "spawn-a",
      },
    ]);
  });
});

function sharedEnergyScenario(
  energy: number,
  reverse: boolean,
): ReplayScenario<SpawnScenarioWorld, SpawnScenarioInput, SpawnScenarioOutcome, SpawnScenarioHeap> {
  return spawnScenario("shared-room-energy", [
    {
      gameTime: FIRST_TICK,
      input: orderedInput(energy, reverse, ["worker-b", "worker-a"]),
      cpuBudget: 2,
    },
  ]);
}

function resetDedupeScenario(
  resetHeap: boolean,
  reverse: boolean,
): ReplayScenario<SpawnScenarioWorld, SpawnScenarioInput, SpawnScenarioOutcome, SpawnScenarioHeap> {
  return spawnScenario("reset-dedupe", [
    {
      gameTime: FIRST_TICK,
      input: orderedInput(300, reverse, ["worker-a"]),
      cpuBudget: 2,
    },
    {
      gameTime: FIRST_TICK + 1,
      input: orderedInput(300, reverse, ["worker-a"]),
      cpuBudget: 2,
      resetHeap,
    },
  ]);
}

function spawnScenario(
  id: string,
  ticks: ReplayScenario<
    SpawnScenarioWorld,
    SpawnScenarioInput,
    SpawnScenarioOutcome,
    SpawnScenarioHeap
  >["ticks"],
): ReplayScenario<SpawnScenarioWorld, SpawnScenarioInput, SpawnScenarioOutcome, SpawnScenarioHeap> {
  return defineReplayScenario<
    SpawnScenarioWorld,
    SpawnScenarioInput,
    SpawnScenarioOutcome,
    SpawnScenarioHeap
  >({
    id: `phase1/spawn/${id}`,
    seed: `phase1-spawn-${id}`,
    initialWorld: { expectations: [] },
    ticks,
    createHeap,
    resetHeap: createHeap,
    step: ({ gameTime, heap, input, world }) => {
      const broker = heap.broker.arbitrate({
        tick: gameTime,
        snapshot: snapshot(gameTime, input.energy, input.reverse),
        demands: input.demandIds.map((id) => demand(id)),
        expectations: world.expectations,
        policy: POLICY,
      });
      const intents = broker.selections.map((selection) => spawnIntent(selection, gameTime));
      const issued: Array<{
        body: readonly SpawnBodyPart[];
        name: string;
        spawnId: string;
      }> = [];
      const execution = heap.executor.execute(intents, (spawnId) => liveSpawn(spawnId, issued));
      const newExpectations = execution
        .filter(({ status }) => status === "scheduled")
        .map(({ command }) => ({
          creepName: command.name,
          demandId: command.demandId,
          revision: command.revision,
          spawnId: command.spawnId,
          scheduledAt: command.scheduledTick,
          expectedReadyAt: command.scheduledTick + command.spawnTicks,
          retryAt: command.scheduledTick + command.spawnTicks + 2,
        }));

      return {
        nextWorld: {
          expectations: [...world.expectations, ...newExpectations],
        },
        outcome: {
          decisions: broker.decisions.map(({ demandId, reason, retryAt, status }) => ({
            demandId,
            reason,
            retryAt,
            status,
          })),
          executions: execution.map(({ command, reason, status }) => ({
            demandId: command.demandId,
            reason,
            spawnId: command.spawnId,
            status,
          })),
          issued,
          selected: broker.selections.map(
            ({ body, demandId, energyCost, spawnId, spawnTicks }) => ({
              body,
              demandId,
              energyCost,
              spawnId,
              spawnTicks,
            }),
          ),
        },
        cpuUsed: 1,
      };
    },
  });
}

function createHeap(): SpawnScenarioHeap {
  return { broker: new SpawnBroker(), executor: new SpawnExecutor() };
}

function orderedInput(
  energy: number,
  reverse: boolean,
  demandIds: readonly string[],
): SpawnScenarioInput {
  return {
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
    nameBasis: null,
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

function liveSpawn(
  spawnId: string,
  issued: Array<{ body: readonly SpawnBodyPart[]; name: string; spawnId: string }>,
): unknown {
  const name = spawnId === "spawn-a" ? "SpawnA" : spawnId === "spawn-b" ? "SpawnB" : null;
  if (name === null) {
    return null;
  }
  return {
    id: spawnId,
    name,
    my: true,
    room: { name: ROOM_NAME },
    spawning: null,
    structureType: "spawn",
    isActive: () => true,
    spawnCreep: (body: readonly SpawnBodyPart[], creepName: string) => {
      issued.push({ body: [...body], name: creepName, spawnId });
      return 0;
    },
  };
}

function snapshot(tick: number, energy: number, reverse: boolean): WorldSnapshot {
  const spawns = order([spawn("spawn-b", "SpawnB"), spawn("spawn-a", "SpawnA")], reverse);
  const room: OwnedRoomSnapshot = {
    name: ROOM_NAME,
    observedAt: tick,
    energyAvailable: energy,
    energyCapacityAvailable: Math.max(300, energy),
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
    ownedSpawns: spawns,
    ownedCreeps: [],
    hostileCreeps: [],
    ownedExtensions: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    constructionSites: [],
  };
  const base = emptyWorldSnapshot(tick, "sim");
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

function spawn(id: string, name: string): OwnedSpawnSnapshot {
  return {
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id,
    name,
    pos: { roomName: ROOM_NAME, x: 20, y: 20 },
    spawning: null,
    store: emptyStore(),
  };
}

function emptyStore(): StoreSnapshot {
  return { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 };
}

function order<Value>(values: readonly Value[], reverse: boolean): readonly Value[] {
  return reverse ? [...values].reverse() : values;
}

function requiredOutcome(
  outcomes: readonly SpawnScenarioOutcome[],
  index: number,
): SpawnScenarioOutcome {
  const outcome = outcomes[index];
  if (outcome === undefined) {
    throw new Error(`missing spawn outcome ${String(index)}`);
  }
  return outcome;
}
