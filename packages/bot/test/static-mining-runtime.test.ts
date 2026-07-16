import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import type { RuntimeGame } from "../src/runtime/context";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("static mining runtime activation", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("activates one stable reservation-backed request per persisted source service", () => {
    const memory = {} as Memory;
    const commands = commandSpies();
    runTick({ game: miningGame(100, commands), memory });

    const first = runTick({ game: miningGame(101, commands), memory });
    const second = runTick({ game: miningGame(102, commands), memory });
    const firstMiningContracts = miningContractIds(first);

    expect(memory.myrmex?.layouts).toMatchObject({
      records: [
        expect.objectContaining({
          roomName: "W1N1",
          sourceServices: [
            expect.objectContaining({
              service: { kind: "source-container", sourceId: "source-a" },
            }),
            expect.objectContaining({
              service: { kind: "source-container", sourceId: "source-b" },
            }),
          ],
        }),
      ],
    });
    expect(first.kernel.systems).toContainEqual(
      expect.objectContaining({ systemId: "mining.contracts", status: "completed" }),
    );
    expect(first.kernel.faults).toEqual([]);
    expect(firstMiningContracts).toHaveLength(2);
    expect(firstMiningContracts[0]).toContain("mining/W1N1/source-a");
    expect(firstMiningContracts[1]).toContain("mining/W1N1/source-b");
    expect(
      first.colony.reservations
        .filter(({ issuer }) => issuer.startsWith("mining/"))
        .map(({ issuer, revision }) => [issuer, revision]),
    ).toEqual([
      ["mining/W1N1/source-a", 1],
      ["mining/W1N1/source-b", 1],
    ]);
    expect(
      second.colony.reservations
        .filter(({ issuer }) => issuer.startsWith("mining/"))
        .map(({ issuer, revision }) => [issuer, revision]),
    ).toEqual([
      ["mining/W1N1/source-a", 1],
      ["mining/W1N1/source-b", 1],
    ]);
    expect(commands.harvest).not.toHaveBeenCalled();
  });

  it.each([
    ["operator-disabled", ["phase2.mining"]],
    ["prerequisite-blocked", ["phase2.layout"]],
  ] as const)("is a no-op when %s", (_reason, disabled) => {
    const memory = {} as Memory;
    const commands = commandSpies();
    runTick({ game: miningGame(200, commands), memory });
    setDisabled(memory, disabled);

    const outcome = runTick({ game: miningGame(201, commands), memory });

    expect(outcome.config.features.gates["phase2.mining"].enabled).toBe(false);
    expect(miningContractIds(outcome)).toEqual([]);
    expect(outcome.colony.reservations.some(({ issuer }) => issuer.startsWith("mining/"))).toBe(
      false,
    );
    expect(commands.harvest).not.toHaveBeenCalled();
  });

  it("suspends static contracts on visible ownership loss", () => {
    const memory = {} as Memory;
    const commands = commandSpies();
    runTick({ game: miningGame(300, commands), memory });
    const active = runTick({ game: miningGame(301, commands), memory });
    expect(active.kernel.faults).toEqual([]);
    expect(miningContractIds(active)).toHaveLength(2);
    const funded = runTick({ game: miningGame(302, commands), memory });
    expect(funded.kernel.faults).toEqual([]);

    const lost = runTick({ game: miningGame(303, commands, false), memory });

    expect(lost.kernel.faults).toEqual([]);
    expect(miningContractStates(memory)).toEqual(["suspended", "suspended"]);
  });

  it("does not construct a source container or issue harvest directly at RCL1", () => {
    const memory = {} as Memory;
    const commands = commandSpies();
    const seeded = runTick({ game: miningGame(400, commands, true, 2), memory });
    expect(miningContractIds(seeded)).toEqual([]);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.harvest).not.toHaveBeenCalled();
    commands.createConstructionSite.mockClear();
    commands.harvest.mockClear();
    const outcome = runTick({ game: miningGame(401, commands, true, 1), memory });

    expect(outcome.kernel.faults).toEqual([]);
    const layouts = memory.myrmex?.layouts as unknown as {
      records?: Array<{ sourceServices?: Array<{ service?: { sourceId?: string } }> }>;
    };
    expect(layouts.records?.[0]?.sourceServices?.map(({ service }) => service?.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(miningContractIds(outcome)).toHaveLength(2);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.harvest).not.toHaveBeenCalled();
  });
});

function miningContractIds(outcome: ReturnType<typeof runTick>): string[] {
  return (outcome.contracts?.submissions ?? [])
    .flatMap((submission) =>
      submission.accepted && submission.contractId.includes("mining/")
        ? [submission.contractId]
        : [],
    )
    .sort();
}

function miningContractStates(memory: Memory): string[] {
  const contracts = memory.myrmex?.contracts as unknown as {
    active?: Array<{ issuer?: string; state?: string }>;
  };
  return (contracts.active ?? [])
    .filter(({ issuer }) => issuer?.startsWith("mining/"))
    .map(({ state }) => state ?? "missing")
    .sort();
}

function setDisabled(memory: Memory, disabled: readonly string[]): void {
  const config = memory.myrmex?.config as unknown as { candidate: unknown } | undefined;
  if (config === undefined) throw new Error("expected initialized config owner");
  config.candidate = { revision: 1, overrides: { features: { disabled } } };
}

function commandSpies() {
  return {
    createConstructionSite: vi.fn(() => 0),
    harvest: vi.fn(() => 0),
    moveTo: vi.fn(() => 0),
    spawnCreep: vi.fn(() => 0),
  };
}

function miningGame(
  time: number,
  commands: ReturnType<typeof commandSpies>,
  owned = true,
  controllerLevel = 2,
): RuntimeGame {
  const roomName = "W1N1";
  const pos = (x: number, y: number) => ({ roomName, x, y });
  const sources = ["source-a", "source-b"].map((id, index) => ({
    energy: 3_000,
    energyCapacity: 3_000,
    id,
    pos: pos(10 + index * 20, 10),
    ticksToRegeneration: 300,
    harvest: commands.harvest,
  })) as unknown as Source[];
  const creep = {
    body: [
      ...Array.from({ length: 5 }, () => ({ hits: 100, type: "work" })),
      ...Array.from({ length: 3 }, () => ({ hits: 100, type: "move" })),
      { hits: 100, type: "carry" },
    ],
    fatigue: 0,
    hits: 900,
    hitsMax: 900,
    id: "miner-capable",
    my: true,
    name: "miner-capable",
    owner: { username: "Myrmex" },
    pos: pos(25, 25),
    room: { name: roomName },
    spawning: false,
    store: {
      getCapacity: () => 50,
      getFreeCapacity: () => 50,
      getUsedCapacity: () => 0,
    },
    ticksToLive: 1_000,
    harvest: commands.harvest,
    moveTo: commands.moveTo,
  } as unknown as Creep;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24, 25),
    room: { name: roomName },
    spawnCreep: commands.spawnCreep,
    spawning: null,
    store: {
      getCapacity: () => 800,
      getFreeCapacity: () => 0,
      getUsedCapacity: () => 800,
    },
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const controller = {
    id: "controller-a",
    level: controllerLevel,
    my: owned,
    owner: { username: owned ? "Myrmex" : "Enemy" },
    pos: pos(25, 20),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: 10_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const room = {
    controller,
    createConstructionSite: commands.createConstructionSite,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    find: (kind: number): unknown[] =>
      kind === FIND_CREEPS_VALUE
        ? [creep]
        : kind === FIND_STRUCTURES_VALUE
          ? [spawn]
          : kind === FIND_SOURCES_VALUE
            ? sources
            : kind === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    getTerrain: () => PLAIN_ROOM_TERRAIN,
    name: roomName,
  } as unknown as Room;
  return {
    cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: { [creep.name]: creep },
    getObjectById: (id) =>
      id === creep.id
        ? creep
        : id === spawn.id
          ? spawn
          : sources.find((source) => source.id === id),
    rooms: { [roomName]: room },
    shard: { name: "shard3" },
    time,
  };
}
