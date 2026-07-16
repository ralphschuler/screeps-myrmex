import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LocalPathSearch, LocalPathSearchInput } from "../src/movement";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick, type TickOutcome } from "../src/runtime/tick";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;
const LAST_TICK = START_TICK + 1_499;
const MAX_CPU_PER_DELIVERED_ENERGY = 1;

describe("survival-flow runtime recovery", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("recovers a zero-creep RCL1 room through bounded movement, batched harvest, and delivery", async () => {
    const world = survivalWorld();
    let memory = {} as Memory;
    let executeTick = runTick;
    let memoryResetAt: number | null = null;
    let sourcesReversed = false;
    const outcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];

    for (let tick = START_TICK; tick <= LAST_TICK; tick += 1) {
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      outcomes.push({ outcome, tick });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);

      if (memoryResetAt === null && world.workerEnergy >= 10 && world.firstHarvestAt !== null) {
        memory = JSON.parse(JSON.stringify(memory)) as Memory;
        vi.resetModules();
        executeTick = (await import("../src/runtime/tick")).runTick;
        world.reverseSources = true;
        sourcesReversed = true;
        memoryResetAt = tick;
      }

      if (world.controllerLevel >= 2) break;
    }

    expect(world.spawnCalls).toEqual([
      expect.objectContaining({
        body: ["work", "carry", "move"],
        cost: 200,
        tick: START_TICK,
      }),
    ]);
    expect(world.workerVisibleAt).not.toBeNull();
    expect(world.workerVisibleAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 10);
    expect(world.firstHarvestAt).not.toBeNull();
    expect(world.firstHarvestAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 30);
    expect(world.firstDeliveryAt).not.toBeNull();
    expect(world.firstDeliveryAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 120);

    expect(world.firstHarvestTargetId).toBe("source-a");
    expect(world.cargoAtFirstDelivery).toBe(50);
    expect(world.sourceAEnergy).toBe(0);
    expect(world.sourceBHarvested).toBeGreaterThanOrEqual(50);
    expect(world.sourceBDelivered).toBeGreaterThanOrEqual(50);
    expect(world.spawnEnergy).toBeGreaterThanOrEqual(200);
    expect(world.spawnEnergy).toBe(300);
    expect(world.controllerLevel).toBe(2);
    expect(world.controllerUpgradeCalls).toBeGreaterThan(0);
    expect(world.fullSinkObservations).toBeGreaterThan(0);
    expect(world.fatiguedObservations).toBeGreaterThan(0);
    expect(world.sinkVanishedAt).not.toBeNull();
    expect(world.sinkResolverMisses).toBeGreaterThan(0);
    expect(world.moveCalls).toBeGreaterThan(0);
    expect(world.pathSearchCalls).toBeGreaterThan(0);
    expect(memoryResetAt).not.toBeNull();
    expect(sourcesReversed).toBe(true);
    const sourceAContractId = outcomes
      .flatMap(({ outcome }) => outcome.contractExecution.leases)
      .find(({ targetId }) => targetId === "source-a")?.contractId;
    expect(sourceAContractId).toBeDefined();
    expect(
      outcomes.some(({ outcome }) =>
        outcome.contracts?.transitions.some(
          (transition) =>
            transition.accepted &&
            transition.contractId === sourceAContractId &&
            transition.to === "cancelled",
        ),
      ),
    ).toBe(true);

    const postResetActions = outcomes
      .filter(({ tick }) => memoryResetAt !== null && tick > memoryResetAt)
      .flatMap(({ outcome }) => outcome.movement.actionExecution)
      .filter(({ status }) => status === "executed");
    expect(postResetActions.length).toBeGreaterThan(0);
    expect(
      postResetActions.some(
        ({ intent }) => intent.kind === "harvest" && intent.targetId === "source-b",
      ),
    ).toBe(true);

    const deliveredEnergy = outcomes.reduce(
      (total, { outcome }) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
      0,
    );
    const recoveryCpu = outcomes.reduce((total, { outcome }) => total + outcome.kernel.cpuUsed, 0);
    expect(deliveredEnergy).toBeGreaterThanOrEqual(100);
    expect(recoveryCpu).toBeGreaterThan(0);
    expect(recoveryCpu / deliveredEnergy).toBeLessThanOrEqual(MAX_CPU_PER_DELIVERED_ENERGY);

    const last = outcomes[outcomes.length - 1];
    const liveContractId = [...outcomes]
      .reverse()
      .flatMap(({ outcome }) => outcome.contractExecution.leases)
      .find(({ actorId }) => actorId === world.workerId)?.contractId;
    expect(last).toBeDefined();
    expect(liveContractId).toBeDefined();
    if (last === undefined || liveContractId === undefined)
      throw new Error("expected one live worker contract before death");

    const deliveredBeforeDeath = world.sourceBDelivered;
    world.killWorker();
    const afterDeath = executeTick({
      game: world.game(last.tick + 1),
      localPathSearch: world.pathSearch,
      memory,
    });
    expect(afterDeath.contracts?.transitions).toContainEqual(
      expect.objectContaining({ contractId: liveContractId, to: "cancelled" }),
    );
    expect(afterDeath.contracts?.allocation.assignments).toEqual([]);
    expect(world.spawnCalls).toHaveLength(2);
    expect(world.spawnCalls[1]).toMatchObject({
      body: ["work", "carry", "move"],
      cost: 200,
      tick: last.tick + 1,
    });
    expect(afterDeath.spawn.execution).toEqual([expect.objectContaining({ status: "scheduled" })]);
    world.assertEnergyConserved();

    const replacementOutcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];
    for (let tick = last.tick + 2; tick <= last.tick + 122; tick += 1) {
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      replacementOutcomes.push({ outcome, tick });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);
      if (world.sourceBDelivered > deliveredBeforeDeath) break;
    }
    expect(world.sourceBDelivered).toBeGreaterThan(deliveredBeforeDeath);
    expect(
      replacementOutcomes
        .flatMap(({ outcome }) => outcome.movement.actionExecution)
        .some(
          ({ intent, status }) =>
            status === "executed" && intent.kind === "harvest" && intent.targetId === "source-b",
        ),
    ).toBe(true);
    expect(
      replacementOutcomes
        .flatMap(({ outcome }) => outcome.movement.actionExecution)
        .some(({ intent, status }) => status === "executed" && intent.kind === "transfer"),
    ).toBe(true);
  }, 15_000);
});

interface SpawnCall {
  readonly body: readonly string[];
  readonly cost: number;
  readonly name: string;
  readonly tick: number;
}

interface SurvivalWorld {
  readonly cargoAtFirstDelivery: number | null;
  readonly firstDeliveryAt: number | null;
  readonly firstHarvestAt: number | null;
  readonly firstHarvestTargetId: string | null;
  readonly fatiguedObservations: number;
  readonly fullSinkObservations: number;
  readonly moveCalls: number;
  readonly pathSearch: LocalPathSearch;
  readonly pathSearchCalls: number;
  readonly sourceAEnergy: number;
  readonly sourceBDelivered: number;
  readonly sourceBHarvested: number;
  readonly controllerLevel: number;
  readonly controllerUpgradeCalls: number;
  readonly sinkVanishedAt: number | null;
  readonly sinkResolverMisses: number;
  readonly spawnCalls: readonly SpawnCall[];
  readonly spawnEnergy: number;
  readonly workerEnergy: number;
  readonly workerId: string;
  readonly workerVisibleAt: number | null;
  reverseSources: boolean;
  assertEnergyConserved(): void;
  game(tick: number): RuntimeGame;
  killWorker(): void;
}

function survivalWorld(): SurvivalWorld {
  const initialSpawnEnergy = 300;
  const initialSourceEnergy = 50 + 3_000;
  const state = {
    cargoAtFirstDelivery: null as number | null,
    currentTick: START_TICK - 1,
    firstDeliveryAt: null as number | null,
    firstHarvestAt: null as number | null,
    firstHarvestTargetId: null as string | null,
    fatiguedObservations: 0,
    fullSinkInjected: false,
    fullSinkObservations: 0,
    injectedSpawnEnergy: 0,
    lastAdvancedTick: START_TICK - 1,
    moveCalls: 0,
    pathSearchCalls: 0,
    pendingSpawn: null as { readonly name: string; readonly readyAt: number } | null,
    reverseSources: false,
    sinkFullUntil: null as number | null,
    sinkResolverFailurePending: false,
    sinkResolverMisses: 0,
    sinkVanishedAt: null as number | null,
    sourceAEnergy: 50,
    sourceBEnergy: 3_000,
    sourceBDelivered: 0,
    sourceBHarvested: 0,
    controllerLevel: 1,
    controllerProgress: 0,
    controllerUpgradeCalls: 0,
    lostWorkerEnergy: 0,
    spawnCalls: [] as SpawnCall[],
    spawnEnergy: initialSpawnEnergy,
    successfulSpawnCost: 0,
    workerEnergy: 0,
    workerFatigue: 0,
    workerName: null as string | null,
    workerPosition: { roomName: "W1N1", x: 10, y: 10 },
    workerTicksToLive: null as number | null,
    workerVisibleAt: null as number | null,
  };
  const sourceA = source("source-a", { roomName: "W1N1", x: 15, y: 10 }, () => state.sourceAEnergy);
  const sourceB = source("source-b", { roomName: "W1N1", x: 20, y: 20 }, () => state.sourceBEnergy);
  const roomReference = { name: "W1N1" };
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-1",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 10, y: 10 },
    room: roomReference,
    get spawning() {
      const pending = state.pendingSpawn;
      return pending === null
        ? null
        : {
            name: pending.name,
            needTime: 9,
            remainingTime: Math.max(1, pending.readyAt - state.currentTick),
          };
    },
    spawnCreep: (body: readonly string[], name: string): number => {
      const cost = body.reduce((total, part) => total + bodyPartCost(part), 0);
      state.spawnCalls.push({ body: [...body], cost, name, tick: state.currentTick });
      if (state.pendingSpawn !== null) return -4;
      if (state.workerName === name) return -3;
      if (body.join(",") !== "work,carry,move") return -10;
      if (cost !== 200 || state.spawnEnergy < cost) return -6;
      state.spawnEnergy -= cost;
      state.successfulSpawnCost += cost;
      state.pendingSpawn = { name, readyAt: state.currentTick + body.length * 3 };
      return 0;
    },
    store: energyStore(() => state.spawnEnergy, 300),
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const worker = {
    body: [
      { hits: 100, type: "work" },
      { hits: 100, type: "carry" },
      { hits: 100, type: "move" },
    ],
    build: () => -7,
    get fatigue() {
      return state.workerFatigue;
    },
    harvest: (target: Source): number => {
      if (range(state.workerPosition, target.pos) > 1) return -9;
      const available = target.id === sourceA.id ? state.sourceAEnergy : state.sourceBEnergy;
      if (available <= 0) return -6;
      const amount = Math.min(2, 50 - state.workerEnergy, available);
      if (amount <= 0) return -8;
      state.workerEnergy += amount;
      if (target.id === sourceA.id) {
        state.sourceAEnergy -= amount;
      } else {
        state.sourceBEnergy -= amount;
        state.sourceBHarvested += amount;
      }
      state.firstHarvestAt ??= state.currentTick;
      state.firstHarvestTargetId ??= String(target.id);
      return 0;
    },
    hits: 300,
    hitsMax: 300,
    id: "worker-1",
    move: (direction: DirectionConstant): number => {
      if (state.workerFatigue > 0) return -11;
      const delta = directionDelta(direction);
      if (delta === null) return -10;
      state.workerPosition = {
        roomName: state.workerPosition.roomName,
        x: state.workerPosition.x + delta.x,
        y: state.workerPosition.y + delta.y,
      };
      state.workerFatigue = 4;
      state.moveCalls += 1;
      return 0;
    },
    my: true,
    get name() {
      return state.workerName ?? "pending-worker";
    },
    owner: { username: "Myrmex" },
    pickup: () => -7,
    get pos() {
      return state.workerPosition;
    },
    repair: () => -7,
    spawning: false,
    store: energyStore(() => state.workerEnergy, 50),
    get ticksToLive() {
      return state.workerTicksToLive ?? 0;
    },
    transfer: (target: StructureSpawn, resource: ResourceConstant, requested?: number): number => {
      if (range(state.workerPosition, target.pos) > 1) return -9;
      if (resource !== "energy" || state.workerEnergy <= 0) return -6;
      const free = 300 - state.spawnEnergy;
      if (free <= 0) return -8;
      const amount = Math.min(requested ?? state.workerEnergy, state.workerEnergy, free);
      if (amount <= 0) return -8;
      state.cargoAtFirstDelivery ??= state.workerEnergy;
      state.workerEnergy -= amount;
      state.spawnEnergy += amount;
      if (state.firstDeliveryAt !== null) state.sourceBDelivered += amount;
      state.firstDeliveryAt ??= state.currentTick;
      return 0;
    },
    upgradeController: () => {
      if (range(state.workerPosition, controller.pos) > 3) return -9;
      if (state.workerEnergy <= 0) return -6;
      state.workerEnergy -= 1;
      state.controllerProgress += 1;
      state.controllerUpgradeCalls += 1;
      if (state.controllerProgress >= 200) {
        state.controllerLevel = 2;
        state.controllerProgress = 0;
      }
      return 0;
    },
    withdraw: () => -7,
  } as unknown as Creep;
  const controller = {
    id: "controller-1",
    get level() {
      return state.controllerLevel;
    },
    my: true,
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 25, y: 25 },
    get progress() {
      return state.controllerProgress;
    },
    progressTotal: 200,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: 10_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const room = {
    controller,
    get energyAvailable() {
      return state.spawnEnergy;
    },
    energyCapacityAvailable: 300,
    find: (findType: number): unknown[] =>
      findType === FIND_CREEPS_VALUE
        ? state.workerName === null
          ? []
          : [worker]
        : findType === FIND_STRUCTURES_VALUE
          ? [spawn]
          : findType === FIND_SOURCES_VALUE
            ? state.reverseSources
              ? state.sourceAEnergy > 0
                ? [sourceB, sourceA]
                : [sourceB]
              : state.sourceAEnergy > 0
                ? [sourceA, sourceB]
                : [sourceB]
            : findType === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    getTerrain: () => ({ get: () => 0 }),
    name: "W1N1",
  } as unknown as Room;
  const pathSearch: LocalPathSearch = {
    search(input: LocalPathSearchInput) {
      state.pathSearchCalls += 1;
      const directions = straightPath(input);
      return { cost: directions.length, directions, incomplete: false };
    },
  };

  const advanceTo = (tick: number): void => {
    if (tick <= state.lastAdvancedTick) throw new Error("world ticks must advance monotonically");
    const elapsed = tick - state.lastAdvancedTick;
    if (state.workerTicksToLive !== null) state.workerTicksToLive -= elapsed;
    state.workerFatigue = Math.max(0, state.workerFatigue - elapsed * 2);
    state.currentTick = tick;
    state.lastAdvancedTick = tick;
    if (state.pendingSpawn !== null && tick >= state.pendingSpawn.readyAt) {
      state.workerName = state.pendingSpawn.name;
      state.workerVisibleAt = state.pendingSpawn.readyAt;
      state.workerTicksToLive = 1_500 - (tick - state.pendingSpawn.readyAt);
      state.pendingSpawn = null;
    }
    if (
      state.firstDeliveryAt === null &&
      state.workerEnergy === 50 &&
      !state.fullSinkInjected &&
      state.injectedSpawnEnergy === 0 &&
      state.sinkFullUntil === null
    ) {
      state.injectedSpawnEnergy = 300 - state.spawnEnergy;
      state.spawnEnergy += state.injectedSpawnEnergy;
      state.fullSinkInjected = true;
      state.sinkFullUntil = tick + 3;
    }
    if (state.sinkFullUntil !== null && tick < state.sinkFullUntil) {
      state.fullSinkObservations += 1;
    }
    if (state.sinkFullUntil !== null && tick >= state.sinkFullUntil) {
      state.spawnEnergy -= state.injectedSpawnEnergy;
      state.injectedSpawnEnergy = 0;
      state.sinkFullUntil = null;
      state.sinkResolverFailurePending = true;
    }
    if (state.workerName !== null && state.workerFatigue > 0) state.fatiguedObservations += 1;
  };
  const world: SurvivalWorld = {
    get cargoAtFirstDelivery() {
      return state.cargoAtFirstDelivery;
    },
    get firstDeliveryAt() {
      return state.firstDeliveryAt;
    },
    get firstHarvestAt() {
      return state.firstHarvestAt;
    },
    get firstHarvestTargetId() {
      return state.firstHarvestTargetId;
    },
    get fatiguedObservations() {
      return state.fatiguedObservations;
    },
    get fullSinkObservations() {
      return state.fullSinkObservations;
    },
    get moveCalls() {
      return state.moveCalls;
    },
    pathSearch,
    get pathSearchCalls() {
      return state.pathSearchCalls;
    },
    get reverseSources() {
      return state.reverseSources;
    },
    set reverseSources(value: boolean) {
      state.reverseSources = value;
    },
    get sourceAEnergy() {
      return state.sourceAEnergy;
    },
    get sourceBDelivered() {
      return state.sourceBDelivered;
    },
    get sourceBHarvested() {
      return state.sourceBHarvested;
    },
    get sinkVanishedAt() {
      return state.sinkVanishedAt;
    },
    get sinkResolverMisses() {
      return state.sinkResolverMisses;
    },
    get spawnCalls() {
      return state.spawnCalls;
    },
    get spawnEnergy() {
      return state.spawnEnergy;
    },
    get controllerLevel() {
      return state.controllerLevel;
    },
    get controllerUpgradeCalls() {
      return state.controllerUpgradeCalls;
    },
    get workerEnergy() {
      return state.workerEnergy;
    },
    workerId: "worker-1",
    get workerVisibleAt() {
      return state.workerVisibleAt;
    },
    assertEnergyConserved: () => {
      const harvested = initialSourceEnergy - state.sourceAEnergy - state.sourceBEnergy;
      expect(initialSpawnEnergy + harvested + state.injectedSpawnEnergy).toBe(
        state.spawnEnergy +
          state.workerEnergy +
          state.successfulSpawnCost +
          state.controllerUpgradeCalls +
          state.lostWorkerEnergy,
      );
    },
    game: (tick: number): RuntimeGame => {
      advanceTo(tick);
      let cpuUsed = 0;
      return {
        cpu: {
          bucket: 10_000,
          getUsed: () => {
            const sample = cpuUsed;
            cpuUsed += 0.001;
            return sample;
          },
          limit: 20,
          tickLimit: 500,
        },
        creeps: state.workerName === null ? {} : { [state.workerName]: worker },
        getObjectById: (id: string) => {
          if (id === spawn.id) {
            if (state.sinkResolverFailurePending && state.workerEnergy > 0) {
              state.sinkResolverFailurePending = false;
              state.sinkResolverMisses += 1;
              state.sinkVanishedAt = state.currentTick;
              return null;
            }
            return spawn;
          }
          if (id === worker.id) return state.workerName === null ? null : worker;
          if (id === sourceA.id) return state.sourceAEnergy > 0 ? sourceA : null;
          if (id === sourceB.id) return sourceB;
          if (id === controller.id) return controller;
          return null;
        },
        rooms: { W1N1: room },
        shard: { name: "shard3" },
        time: tick,
      };
    },
    killWorker: () => {
      state.lostWorkerEnergy += state.workerEnergy;
      state.workerEnergy = 0;
      state.workerFatigue = 0;
      state.workerName = null;
      state.workerTicksToLive = null;
    },
  };
  return world;
}

function assertSingleTickAuthorities(outcome: TickOutcome, workerId: string): void {
  expect(
    outcome.kernel.systems.find(({ systemId }) => systemId === "contracts.reconcile")?.status,
  ).not.toBe("failed");
  expect(
    outcome.kernel.systems.find(({ systemId }) => systemId === "agents.plan")?.status,
  ).not.toBe("failed");
  const leased = outcome.contractExecution.leases.filter(({ actorId }) => actorId === workerId);
  expect(leased.length).toBeLessThanOrEqual(1);
  const assigned =
    outcome.contracts?.allocation.assignments.filter(({ actorId }) => actorId === workerId) ?? [];
  expect(assigned.length).toBeLessThanOrEqual(1);
  const movementDecisions = outcome.movement.movementDecisions.filter(
    ({ intent }) => intent.actorId === workerId,
  );
  const actionDecisions = outcome.movement.actionDecisions.filter(
    ({ intent }) => intent.actorId === workerId,
  );
  expect(movementDecisions.length + actionDecisions.length).toBeLessThanOrEqual(1);
  const activeEconomyReservations = outcome.colony.reservations.filter(
    ({ issuer, status }) => status === "active" && issuer.startsWith("economy/W1N1/"),
  );
  expect(activeEconomyReservations.length).toBeLessThanOrEqual(1);
}

function source(
  id: string,
  pos: { readonly roomName: string; readonly x: number; readonly y: number },
  energy: () => number,
): Source {
  return {
    energyCapacity: 3_000,
    get energy() {
      return energy();
    },
    id,
    pos,
    ticksToRegeneration: 2_000,
  } as unknown as Source;
}

function energyStore(energy: () => number, capacity: number): StoreDefinition {
  return {
    get energy() {
      return energy();
    },
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity - energy(),
    getUsedCapacity: () => energy(),
  } as unknown as StoreDefinition;
}

function straightPath(input: LocalPathSearchInput): readonly DirectionConstant[] {
  const directions: DirectionConstant[] = [];
  let x = input.origin.x;
  let y = input.origin.y;
  while (Math.max(Math.abs(x - input.goal.x), Math.abs(y - input.goal.y)) > input.range) {
    const dx = Math.sign(input.goal.x - x);
    const dy = Math.sign(input.goal.y - y);
    const direction = deltaDirection(dx, dy);
    if (direction === null || directions.length >= 50) break;
    directions.push(direction);
    x += dx;
    y += dy;
  }
  return directions;
}

function deltaDirection(dx: number, dy: number): DirectionConstant | null {
  const value =
    dx === 0 && dy === -1
      ? 1
      : dx === 1 && dy === -1
        ? 2
        : dx === 1 && dy === 0
          ? 3
          : dx === 1 && dy === 1
            ? 4
            : dx === 0 && dy === 1
              ? 5
              : dx === -1 && dy === 1
                ? 6
                : dx === -1 && dy === 0
                  ? 7
                  : dx === -1 && dy === -1
                    ? 8
                    : null;
  return value;
}

function directionDelta(
  direction: DirectionConstant,
): { readonly x: number; readonly y: number } | null {
  const deltas = {
    1: { x: 0, y: -1 },
    2: { x: 1, y: -1 },
    3: { x: 1, y: 0 },
    4: { x: 1, y: 1 },
    5: { x: 0, y: 1 },
    6: { x: -1, y: 1 },
    7: { x: -1, y: 0 },
    8: { x: -1, y: -1 },
  } as const;
  return deltas[direction];
}

function range(
  left: { readonly roomName: string; readonly x: number; readonly y: number },
  right: { readonly roomName: string; readonly x: number; readonly y: number },
): number {
  return left.roomName === right.roomName
    ? Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y))
    : Number.POSITIVE_INFINITY;
}

function bodyPartCost(part: string): number {
  return part === "move" || part === "carry" ? 50 : part === "work" ? 100 : 0;
}
