import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";
import { ContractLedger } from "../src/contracts";
import { observeLogisticsGraph } from "../src/logistics/runtime";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("logistics runtime authority chain", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("admits, funds, spawns, leases, acquires, and exactly completes a partial delivery", () => {
    const memory = {} as Memory;
    const world = logisticsWorld();
    expect(world.roomEnergy()).toBe(400);
    expect(world.roomEnergy() - 300).toBe(100);
    let sawActiveBudget = false;
    let sawV3Contract = false;
    let sawPopulationLoad = false;
    let sawPopulationDemand = false;
    let sawPopulationCapability = false;
    let sawSpawnSelection = false;
    let sawAuthorizedSpawnExecution = false;
    let sawAllocation = false;
    let sawCapableAllocatorActor = false;
    let sawLease = false;
    let sawAcquireReceipt = false;
    const deliveredAmounts: number[] = [];
    const selectedBodies: BodyPartConstant[][] = [];
    const selectedEnergyCosts: number[] = [];
    const selectedNames: string[] = [];
    const spawnRejections: string[] = [];
    const observedFlowIds = new Set<string>();
    let latestReservationStates: string[] = [];

    for (let tick = 100; tick <= 140 && deliveredAmounts.length < 1; tick += 1) {
      const outcome = runTick({ game: world.game(tick), memory });
      for (const edge of observeLogisticsGraph(outcome.snapshot, true).edges)
        observedFlowIds.add(edge.id);
      expect(
        outcome.kernel.faults,
        JSON.stringify({
          colonies: outcome.colony.colonies.map(({ id, populationPolicy }) => ({
            demands: populationPolicy.demands,
            id,
          })),
          reservations: outcome.colony.reservations,
          selections: outcome.spawn.broker?.selections ?? [],
          tick,
        }),
      ).toEqual([]);
      sawActiveBudget ||= outcome.colony.reservations.some(
        ({ issuer, status }) => issuer.startsWith("logistics/") && status === "active",
      );
      latestReservationStates = outcome.colony.reservations
        .filter(({ issuer }) => issuer.startsWith("logistics/"))
        .map(({ issuer, status }) => `${issuer}:${status}`);
      const active = logisticsContracts(memory);
      sawV3Contract ||= active.some(
        ({ execution, issuer }) => issuer.startsWith("logistics/") && execution?.version === 3,
      );
      const opened = ContractLedger.open(memory.myrmex?.contracts);
      if (opened.status === "ready") {
        const population = opened.ledger.populationView();
        sawPopulationLoad ||= population.loads.some(
          ({ mode, objectiveId }) => mode === "logistics" && objectiveId.includes("logistics/"),
        );
      }
      sawPopulationDemand ||= outcome.colony.colonies.some(({ populationPolicy }) =>
        populationPolicy.demands.some(({ objectiveId }) => objectiveId.includes("logistics/")),
      );
      sawPopulationCapability ||= outcome.colony.colonies.some(({ populationPolicy }) =>
        populationPolicy.demands.some(
          ({ objectiveId, requiredCapability }) =>
            objectiveId.includes("logistics/") &&
            requiredCapability.carry === 1 &&
            requiredCapability.move === 1 &&
            requiredCapability.work === 0,
        ),
      );
      for (const selection of outcome.spawn.broker?.selections ?? []) {
        if (selection.category !== "funded-workforce" || !selection.issuer.includes("logistics/"))
          continue;
        sawSpawnSelection = true;
        selectedBodies.push([...selection.body]);
        selectedEnergyCosts.push(selection.energyCost);
        selectedNames.push(selection.name);
      }
      sawAuthorizedSpawnExecution ||= outcome.spawn.execution.some(
        ({ command, status }) => status === "scheduled" && command.issuer.includes("logistics/"),
      );
      spawnRejections.push(
        ...outcome.spawn.execution.flatMap(({ reason, status }) =>
          status === "scheduled" ? [] : [reason],
        ),
      );
      sawCapableAllocatorActor ||= outcome.snapshot.rooms.some((room) =>
        room.ownedCreeps.some(
          ({ body, id }) => id === "hauler-a" && body.carry.active >= 1 && body.move.active >= 1,
        ),
      );
      sawAllocation ||=
        outcome.contracts?.allocation.assignments.some(({ contractId }) =>
          contractId.includes("logistics/"),
        ) === true;
      sawLease ||= outcome.contractExecution.leases.some(
        ({ execution }) => execution.version === 3 && execution.flowId.includes("container"),
      );
      for (const receipt of outcome.movement.actionExecution) {
        if (receipt.status !== "executed" || receipt.intent.contractId === null) continue;
        if (receipt.intent.kind === "withdraw") sawAcquireReceipt = true;
        if (receipt.intent.kind === "transfer" && receipt.intent.amount !== null)
          deliveredAmounts.push(receipt.intent.amount);
      }
    }

    expect(sawActiveBudget).toBe(true);
    expect(sawV3Contract).toBe(true);
    const finalLedger = ContractLedger.open(memory.myrmex?.contracts);
    const finalLoads =
      finalLedger.status === "ready"
        ? finalLedger.ledger.populationView().loads.map(({ mode, objectiveId }) => ({
            mode,
            objectiveId,
          }))
        : [];
    expect(
      sawPopulationLoad,
      JSON.stringify({
        contracts: logisticsContracts(memory),
        flows: [...observedFlowIds],
        loads: finalLoads,
        reservations: latestReservationStates,
      }),
    ).toBe(true);
    expect(sawPopulationDemand).toBe(true);
    expect(sawPopulationCapability).toBe(true);
    expect(sawSpawnSelection).toBe(true);
    expect(
      sawAuthorizedSpawnExecution,
      JSON.stringify({
        bodies: selectedBodies,
        costs: selectedEnergyCosts,
        names: selectedNames,
        rejections: spawnRejections,
        roomEnergy: world.roomEnergy(),
        spawnCalls: world.spawnCalls(),
      }),
    ).toBe(true);
    expect(selectedBodies).toContainEqual(["carry", "move"]);
    expect(selectedEnergyCosts).toContain(100);
    expect(world.spawnCalls()[0]?.name).toBe(selectedNames[0]);
    expect(spawnRejections).not.toContain("room-mismatch");
    expect(spawnRejections).toEqual([]);
    expect(sawCapableAllocatorActor).toBe(true);
    expect(sawAllocation).toBe(true);
    expect(sawLease).toBe(true);
    expect(sawAcquireReceipt).toBe(true);
    expect(world.spawnCalls()).toEqual([expect.objectContaining({ body: ["carry", "move"] })]);
    expect(deliveredAmounts).toEqual([50]);
    expect(world.commands()).toEqual(["withdraw:50", "transfer:50"]);
    expect(world.containerEnergy()).toBe(100);
    expect(world.haulerEnergy()).toBe(0);
    expect(world.extensionEnergy()).toBe(50);
    const nonterminalLogistics = logisticsContracts(memory).filter(
      ({ state }) =>
        state !== "completed" && state !== "cancelled" && state !== "expired" && state !== "failed",
    );
    expect(new Set(nonterminalLogistics.map(({ execution }) => execution?.flowId))).toHaveProperty(
      "size",
      nonterminalLogistics.length,
    );
  });
});

function logisticsContracts(memory: Memory): Array<{
  execution?: { flowId?: string; version?: number };
  issuer: string;
  state?: string;
}> {
  const owner = memory.myrmex?.contracts as unknown as {
    active?: Array<{
      execution?: { flowId?: string; version?: number };
      issuer?: string;
      state?: string;
    }>;
  };
  return (owner.active ?? []).flatMap((contract) => {
    const issuer = contract.issuer;
    return issuer?.startsWith("logistics/")
      ? [
          {
            ...(contract.execution === undefined ? {} : { execution: contract.execution }),
            issuer,
            ...(contract.state === undefined ? {} : { state: contract.state }),
          },
        ]
      : [];
  });
}

function logisticsWorld() {
  let currentTick = 99;
  let containerEnergy = 150;
  let spawnEnergy = 300;
  let extensionEnergy = 0;
  let haulerEnergy = 0;
  let hauler: Creep | null = null;
  let pending: {
    readonly body: readonly BodyPartConstant[];
    readonly completeAt: number;
    readonly name: string;
  } | null = null;
  const spawnCalls: Array<{ readonly body: readonly BodyPartConstant[]; readonly name: string }> =
    [];
  const commands: string[] = [];
  const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });
  const container = {
    hits: 250_000,
    hitsMax: 250_000,
    id: "container-a",
    pos: position(10, 11),
    store: storeFor(() => containerEnergy, 2_000),
    structureType: "container",
    ticksToDecay: 5_000,
  } as unknown as StructureContainer;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: position(10, 10),
    room: { name: "W1N1" },
    get spawning() {
      return pending === null
        ? null
        : {
            name: pending.name,
            needTime: pending.body.length * 3,
            remainingTime: pending.completeAt - currentTick,
          };
    },
    spawnCreep: (body: BodyPartConstant[], name: string) => {
      if (pending !== null) return -4;
      const cost = body.reduce(
        (sum, part) => sum + (part === "carry" || part === "move" ? 50 : 100),
        0,
      );
      if (spawnEnergy < cost) return -6;
      spawnEnergy -= cost;
      pending = { body: [...body], completeAt: currentTick + body.length * 3, name };
      spawnCalls.push({ body: [...body], name });
      return 0;
    },
    store: storeFor(() => spawnEnergy, 300),
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const extension = {
    hits: 1_000,
    hitsMax: 1_000,
    id: "extension-a",
    isActive: () => true,
    my: true,
    pos: position(11, 10),
    store: storeFor(() => extensionEnergy, 50),
    structureType: "extension",
  } as unknown as StructureExtension;
  const fundingExtensions = ["extension-funded-a", "extension-funded-b"].map((id, index) => ({
    hits: 1_000,
    hitsMax: 1_000,
    id,
    isActive: () => true,
    my: true,
    pos: position(12 + index, 10),
    store: storeFor(() => 50, 50),
    structureType: "extension",
  })) as unknown as StructureExtension[];
  const createHauler = (body: readonly BodyPartConstant[], name: string): Creep =>
    ({
      body: body.map((type) => ({ hits: 100, type })),
      fatigue: 0,
      hits: body.length * 100,
      hitsMax: body.length * 100,
      id: "hauler-a",
      my: true,
      name,
      owner: { username: "Myrmex" },
      pos: position(10, 10),
      spawning: false,
      store: storeFor(() => haulerEnergy, body.filter((part) => part === "carry").length * 50),
      ticksToLive: 1_000,
      move: () => 0,
      pickup: () => -7,
      withdraw: (target: Structure, resource: ResourceConstant, amount?: number) => {
        if (target.id !== container.id || resource !== "energy") return -7;
        const moved = Math.min(amount ?? 50, containerEnergy, 50 - haulerEnergy);
        if (moved <= 0) return -6;
        containerEnergy -= moved;
        haulerEnergy += moved;
        commands.push(`withdraw:${String(moved)}`);
        return 0;
      },
      transfer: (target: Structure, resource: ResourceConstant, amount?: number) => {
        if (target.id !== extension.id || resource !== "energy") return -7;
        const moved = Math.min(amount ?? haulerEnergy, haulerEnergy, 50 - extensionEnergy);
        if (moved <= 0) return -8;
        haulerEnergy -= moved;
        extensionEnergy += moved;
        commands.push(`transfer:${String(moved)}`);
        return 0;
      },
    }) as unknown as Creep;
  // Keep the room above the emergency-recovery lead while placing this worker below the longer
  // logistics travel/spawn lead, so the funded flow must source a successor through SpawnBroker.
  const establishedWorker = {
    body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "established-worker",
    my: true,
    name: "established-worker",
    owner: { username: "Myrmex" },
    pos: position(20, 20),
    spawning: false,
    store: storeFor(() => 0, 50),
    ticksToLive: 65,
    move: () => 0,
  } as unknown as Creep;
  const controller = {
    id: "controller-a",
    level: 2,
    my: true,
    owner: { username: "Myrmex" },
    pos: position(8, 10),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: 20_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const room = {
    controller,
    get energyAvailable() {
      return spawnEnergy + 100 + extensionEnergy;
    },
    energyCapacityAvailable: 450,
    find: (kind: number): unknown[] =>
      kind === FIND_CREEPS_VALUE
        ? [establishedWorker, ...(hauler === null ? [] : [hauler])]
        : kind === FIND_STRUCTURES_VALUE
          ? [spawn, ...fundingExtensions, extension, container]
          : kind === FIND_SOURCES_VALUE ||
              kind === FIND_DROPPED_RESOURCES_VALUE ||
              kind === FIND_CONSTRUCTION_SITES_VALUE
            ? []
            : [],
    getTerrain: () => PLAIN_ROOM_TERRAIN,
    name: "W1N1",
  } as unknown as Room;

  return {
    commands: () => [...commands],
    containerEnergy: () => containerEnergy,
    game: (tick: number): RuntimeGame => {
      currentTick = tick;
      if (pending !== null && tick >= pending.completeAt) {
        hauler = createHauler(pending.body, pending.name);
        pending = null;
      }
      return {
        cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: {
          [establishedWorker.name]: establishedWorker,
          ...(hauler === null ? {} : { [hauler.name]: hauler }),
        },
        getObjectById: (id) =>
          id === spawn.id
            ? spawn
            : id === extension.id
              ? extension
              : (fundingExtensions.find((candidate) => candidate.id === id) ??
                (id === container.id
                  ? container
                  : id === establishedWorker.id
                    ? establishedWorker
                    : id === hauler?.id
                      ? hauler
                      : null)),
        rooms: { W1N1: room },
        shard: { name: "shard3" },
        time: tick,
      };
    },
    extensionEnergy: () => extensionEnergy,
    haulerEnergy: () => haulerEnergy,
    roomEnergy: () => room.energyAvailable,
    spawnCalls: () => [...spawnCalls],
  };
}

function storeFor(energy: () => number, capacity: number): StoreDefinition {
  return {
    get energy() {
      return energy();
    },
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity - energy(),
    getUsedCapacity: () => energy(),
  } as unknown as StoreDefinition;
}
