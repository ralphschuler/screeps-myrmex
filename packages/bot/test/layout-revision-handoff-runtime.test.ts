import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLayoutsOwner, type LayoutsOwnerV25 } from "../src/layout";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const ROOM_NAME = "W1N1";

interface GameOptions {
  readonly blockedTerrain?: boolean;
  readonly controllerLevel?: number;
  readonly controllerRisk?: boolean;
  readonly reverse?: boolean;
  readonly threat?: boolean;
  readonly visible?: boolean;
}

interface Commands {
  readonly createConstructionSite: ReturnType<typeof vi.fn<() => number>>;
}

describe("stale layout revision runtime handoff (#385)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("persists one command-free handoff, then resumes ordinary convergence", () => {
    const forward = runHandoffVariant(false, false);
    const reset = runHandoffVariant(false, true);
    const reordered = runHandoffVariant(true, false);

    expect(forward.handoffCalls).toBe(0);
    expect(forward.followingCalls).toBe(1);
    expect(forward.followingAccepted).toBe(1);
    expect(forward.followingPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "complete" }),
    ]);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.owner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      schemaVersion: 25,
      staleRecords: [],
    });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("suppresses every room's layout commands while admitting only one stale handoff", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(300, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(301, firstCommands, secondCommands), memory });
    seedStaleOwner(memory, null, "W1N1");
    firstCommands.createConstructionSite.mockClear();
    secondCommands.createConstructionSite.mockClear();

    const handoff = runTick({ game: twoRoomGame(302, firstCommands, secondCommands), memory });

    expect(handoff.layout.planning).toEqual([
      expect.objectContaining({ roomName: "W1N1", status: "handoff" }),
    ]);
    expect(handoff.layout.arbitration?.accepted).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();

    runTick({ game: twoRoomGame(303, firstCommands, secondCommands), memory });
    expect(
      firstCommands.createConstructionSite.mock.calls.length +
        secondCommands.createConstructionSite.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("preserves active or unsafe stale evidence and authorizes no command", () => {
    for (const testCase of [
      { name: "active evacuation", active: "evacuation", options: {} },
      { name: "active source handoff", active: "source-handoff", options: {} },
      { name: "threat", active: null, options: { threat: true } },
      { name: "controller risk", active: null, options: { controllerRisk: true } },
      { name: "RCL outside policy", active: null, options: { controllerLevel: 1 } },
      { name: "blocked source access", active: null, options: { blockedTerrain: true } },
      { name: "unknown vision", active: null, options: { visible: false } },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(200, commands), memory });
      runTick({ game: game(201, commands), memory });
      seedStaleOwner(memory, testCase.active);
      commands.createConstructionSite.mockClear();

      const outcome = runTick({ game: game(202, commands, testCase.options), memory });
      const owner = parseLayoutsOwner(memory.myrmex?.layouts);
      if (owner === null) throw new Error("expected parsed layouts owner");

      expect(outcome.kernel.faults, testCase.name).toEqual([]);
      expect(outcome.stateCommit?.committed, testCase.name).toBe(true);
      expect(
        (memory.myrmex?.layouts as { readonly schemaVersion?: unknown } | undefined)?.schemaVersion,
        testCase.name,
      ).toBe(25);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(owner.records, testCase.name).toEqual([]);
      expect(owner.staleRecords, testCase.name).toHaveLength(1);
      if (testCase.options.visible === false) expect(outcome.layout.planning).toEqual([]);
      else expect(outcome.layout.planning[0], testCase.name).toMatchObject({ status: "degraded" });
      if (testCase.active !== null)
        expect(outcome.layout.planning[0]).toMatchObject({ blocker: "revision-handoff-active" });
    }
  });
});

function runHandoffVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  runTick({ game: game(100, commands, { reverse }), memory });
  runTick({ game: game(101, commands, { reverse }), memory });
  seedStaleOwner(memory, null);
  if (reset) memory = JSON.parse(JSON.stringify(memory)) as Memory;
  commands.createConstructionSite.mockClear();

  const handoff = runTick({ game: game(102, commands, { reverse }), memory });
  const owner = JSON.parse(JSON.stringify(layoutsOwner(memory))) as unknown;
  const handoffCalls = commands.createConstructionSite.mock.calls.length;
  commands.createConstructionSite.mockClear();
  const following = runTick({ game: game(103, commands, { reverse }), memory });

  return {
    followingAccepted: following.layout.arbitration?.accepted.length ?? 0,
    followingCalls: commands.createConstructionSite.mock.calls.length,
    followingPlanning: following.layout.planning,
    handoffCalls,
    handoffPlanning: handoff.layout.planning,
    owner,
  };
}

function seedStaleOwner(
  memory: Memory,
  active: "evacuation" | "source-handoff" | null,
  roomName = ROOM_NAME,
): void {
  const owner = layoutsOwner(memory);
  const current = owner.records.find((record) => record.roomName === roomName);
  if (current === undefined) throw new Error("expected initialized layout record");
  const {
    containerMigration: _containerMigration,
    extensionEvacuation: _extensionEvacuation,
    labEvacuation: _labEvacuation,
    linkEvacuation: _linkEvacuation,
    removalReceipt: _removalReceipt,
    siteReceipts: _siteReceipts,
    spawnEvacuation: _spawnEvacuation,
    storageEvacuation: _storageEvacuation,
    terminalEvacuation: _terminalEvacuation,
    towerEvacuation: _towerEvacuation,
    ...stable
  } = current;
  void [
    _containerMigration,
    _extensionEvacuation,
    _labEvacuation,
    _linkEvacuation,
    _removalReceipt,
    _siteReceipts,
    _spawnEvacuation,
    _storageEvacuation,
    _terminalEvacuation,
    _towerEvacuation,
  ];
  const staleRecord = {
    ...stable,
    algorithmRevision: "owned-room-layout-v1",
    ...(active === "evacuation"
      ? {
          extensionEvacuation: {
            amount: 50,
            expiresAt: 350,
            replacementId: "extension-replacement",
            replacementInitialEnergy: 0,
            sourceId: "extension-obsolete",
            startedAt: 200,
          },
        }
      : {}),
    ...(active === "source-handoff" && stable.sourceServices !== undefined
      ? {
          sourceServices: stable.sourceServices.map((placement) => ({
            ...placement,
            ...(placement.service === undefined
              ? {}
              : { service: { ...placement.service, issuerSequence: 2 } }),
          })),
        }
      : {}),
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      records: owner.records.map((record) => (record.roomName === roomName ? staleRecord : record)),
      revision: owner.revision,
      schemaVersion: 24,
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
}

function layoutsOwner(memory: Memory): LayoutsOwnerV25 {
  const owner = parseLayoutsOwner(memory.myrmex?.layouts);
  if (owner === null) throw new Error("expected layouts owner");
  return owner;
}

function commandSpies(): Commands {
  return { createConstructionSite: vi.fn(() => 0) };
}

function twoRoomGame(time: number, firstCommands: Commands, secondCommands: Commands): RuntimeGame {
  const first = game(time, firstCommands, {}, "W1N1");
  const second = game(time, secondCommands, {}, "W2N2");
  return {
    ...first,
    creeps: { ...first.creeps, ...second.creeps },
    getObjectById: (id) => first.getObjectById?.(id) ?? second.getObjectById?.(id) ?? null,
    rooms: { ...first.rooms, ...second.rooms },
  };
}

function game(
  time: number,
  commands: Commands,
  options: GameOptions = {},
  roomName = ROOM_NAME,
): RuntimeGame {
  if (options.visible === false)
    return {
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    };
  const pos = (x: number, y: number) => ({ roomName, x, y });
  const source = {
    energy: 3_000,
    energyCapacity: 3_000,
    id: `source-${roomName}`,
    pos: pos(10, 10),
    ticksToRegeneration: 300,
  } as unknown as Source;
  const worker = {
    body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: `worker-${roomName}`,
    my: true,
    name: `worker-${roomName}`,
    owner: { username: "Myrmex" },
    pos: pos(25, 25),
    room: { name: roomName },
    spawning: false,
    store: { getCapacity: () => 50, getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: `spawn-${roomName}`,
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24, 25),
    room: { name: roomName },
    spawnCreep: () => 0,
    spawning: null,
    store: { getCapacity: () => 300, getFreeCapacity: () => 0, getUsedCapacity: () => 300 },
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const hostile = {
    body: [{ hits: 100, type: "attack" }],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: `hostile-${roomName}`,
    my: false,
    name: `hostile-${roomName}`,
    owner: { username: "Enemy" },
    pos: pos(20, 20),
    spawning: false,
    store: { getCapacity: () => 0, getFreeCapacity: () => 0, getUsedCapacity: () => 0 },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const controller = {
    id: `controller-${roomName}`,
    level: options.controllerLevel ?? 3,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(25, 20),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: options.controllerRisk ? 100 : 10_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const structures = options.reverse ? [spawn].reverse() : [spawn];
  const creeps = options.threat ? [worker, hostile] : [worker];
  const room = {
    controller,
    createConstructionSite: commands.createConstructionSite,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    find: (kind: number): unknown[] =>
      kind === FIND_CREEPS_VALUE
        ? options.reverse
          ? [...creeps].reverse()
          : creeps
        : kind === FIND_STRUCTURES_VALUE
          ? structures
          : kind === FIND_SOURCES_VALUE
            ? [source]
            : kind === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    getTerrain: () => (options.blockedTerrain ? { get: () => 1 } : PLAIN_ROOM_TERRAIN),
    name: roomName,
  } as unknown as Room;
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: { [worker.name]: worker },
    getObjectById: (id) =>
      id === worker.id ? worker : id === spawn.id ? spawn : id === source.id ? source : null,
    rooms: { [roomName]: room },
    shard: { name: "shard3" },
    time,
  };
}
