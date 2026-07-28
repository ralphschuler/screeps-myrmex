import type { RuntimeGame } from "../../src/runtime/context";
import type { MatureRuntimeWorld } from "./mature-runtime-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;

export interface RemoteRuntimeGameOptions {
  readonly bucket?: number;
  readonly fundOperations?: boolean;
  readonly hideRemote?: boolean;
  readonly reducedPrimarySourceCapacity?: boolean;
  readonly removePrimarySources?: boolean;
  readonly reverseCollections?: boolean;
  readonly routeClosed?: boolean;
  readonly secondRemote?: boolean;
  readonly spawnReturnCode?: ScreepsReturnCode;
  readonly threat?: boolean;
  readonly totalWorkerLoss?: boolean;
}

export function remoteRuntimeGame(
  world: MatureRuntimeWorld,
  time: number,
  options: RemoteRuntimeGameOptions = {},
): RuntimeGame {
  const base = world.game(time, options.bucket ?? 10_000);
  const primary = remoteRoom({
    roomName: "W1N2",
    sourceCapacity: options.reducedPrimarySourceCapacity === true ? 1_500 : 3_000,
    sourceCount: options.removePrimarySources === true ? 0 : 2,
    sourcePrefix: "remote",
    threat: options.threat === true,
    reverseCollections: options.reverseCollections === true,
  });
  const secondary = remoteRoom({
    roomName: "W1N3",
    sourceCapacity: 3_000,
    sourceCount: 1,
    sourcePrefix: "secondary",
    threat: false,
    reverseCollections: options.reverseCollections === true,
  });
  const donor = base.rooms.W1N1;
  if (donor === undefined) throw new Error("remote runtime fixture requires donor W1N1");
  const donorFind = (kind: number): unknown[] => donor.find(kind as FindConstant);
  const donorView: Room = Object.assign({}, donor, {
    energyAvailable: options.fundOperations === false ? 300 : 10_000,
    energyCapacityAvailable: options.fundOperations === false ? 300 : 10_000,
    find: (kind: number): unknown[] =>
      options.totalWorkerLoss === true && kind === FIND_CREEPS_VALUE ? [] : donorFind(kind),
    getEventLog: () => [],
  });
  const map = {
    describeExits: (name: string) =>
      name === "W1N1"
        ? options.secondRemote === true
          ? { 1: primary.roomName, 3: secondary.roomName }
          : { 1: primary.roomName }
        : name === primary.roomName
          ? { 5: "W1N1" }
          : name === secondary.roomName
            ? { 7: "W1N1" }
            : {},
    getRoomStatus: (name: string) => ({
      status: name === primary.roomName && options.routeClosed === true ? "closed" : "normal",
      timestamp: null,
    }),
  };
  const remoteObjects = new Map<string, unknown>([
    ...primary.objects,
    ...(options.secondRemote === true ? secondary.objects : []),
  ]);
  const resolveBase = base.getObjectById;
  const spawn = resolveBase?.("spawn");
  const commandSpawn =
    options.spawnReturnCode === undefined || spawn === null || spawn === undefined
      ? spawn
      : { ...spawn, spawnCreep: () => options.spawnReturnCode };
  const rooms: Record<string, Room> = { ...base.rooms, W1N1: donorView };
  if (options.hideRemote !== true) rooms[primary.roomName] = primary.room;
  if (options.secondRemote === true) rooms[secondary.roomName] = secondary.room;
  return {
    ...base,
    creeps: options.totalWorkerLoss === true ? {} : base.creeps,
    getObjectById: (id) =>
      id === "spawn" && commandSpawn !== undefined
        ? commandSpawn
        : (remoteObjects.get(id) ?? resolveBase?.(id) ?? null),
    map,
    rooms,
  };
}

function remoteRoom(input: {
  readonly roomName: string;
  readonly sourceCapacity: number;
  readonly sourceCount: number;
  readonly sourcePrefix: string;
  readonly threat: boolean;
  readonly reverseCollections: boolean;
}): {
  readonly roomName: string;
  readonly room: Room;
  readonly objects: readonly (readonly [string, unknown])[];
} {
  const pos = (x: number, y: number) => ({ roomName: input.roomName, x, y });
  const controller = {
    id: `${input.sourcePrefix}-controller`,
    level: 0,
    my: false,
    owner: undefined,
    pos: pos(25, 25),
    progress: undefined,
    progressTotal: undefined,
    reservation: undefined,
    safeMode: undefined,
    safeModeAvailable: 0,
    safeModeCooldown: undefined,
    ticksToDowngrade: undefined,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const sources = Array.from({ length: input.sourceCount }, (_, index) => ({
    energy: input.sourceCapacity,
    energyCapacity: input.sourceCapacity,
    id: `${input.sourcePrefix}-source-${String.fromCharCode(97 + index)}`,
    pos: pos(10 + index * 10, 10 + index * 10),
    ticksToRegeneration: 300,
  })) as unknown as Source[];
  const containers: StructureContainer[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    containers.push(
      remoteContainer(
        `${input.sourcePrefix}-container-${String.fromCharCode(97 + index)}`,
        pos(9 + index * 10, 9 + index * 10),
      ),
    );
  }
  const hostile = {
    body: [{ boost: undefined, hits: 100, type: "attack" }],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: `${input.sourcePrefix}-hostile`,
    my: false,
    name: `${input.sourcePrefix}-hostile`,
    owner: { username: "Enemy" },
    pos: pos(15, 15),
    spawning: false,
    store: {
      getCapacity: () => 0,
      getFreeCapacity: () => 0,
      getUsedCapacity: () => 0,
    },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const orderedSources = input.reverseCollections ? [...sources].reverse() : sources;
  const orderedContainers = input.reverseCollections ? [...containers].reverse() : containers;
  const find = (kind: number): unknown[] =>
    kind === FIND_CREEPS_VALUE && input.threat
      ? [hostile]
      : kind === FIND_SOURCES_VALUE
        ? orderedSources
        : kind === FIND_STRUCTURES_VALUE
          ? orderedContainers
          : [];
  const room = {
    controller,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    find,
    getEventLog: () => [],
    getTerrain: () => ({ get: () => 0 }),
    name: input.roomName,
  } as unknown as Room;
  return {
    roomName: input.roomName,
    room,
    objects: [
      [String(controller.id), controller],
      ...sources.map((source): readonly [string, unknown] => [String(source.id), source]),
      ...containers.map((container): readonly [string, unknown] => [
        String(container.id),
        container,
      ]),
    ],
  };
}

function remoteContainer(
  id: string,
  pos: { readonly roomName: string; readonly x: number; readonly y: number },
): StructureContainer {
  const energy = 2_000;
  return {
    hits: 250_000,
    hitsMax: 250_000,
    id,
    owner: undefined,
    pos,
    store: {
      energy,
      getCapacity: () => 2_000,
      getFreeCapacity: () => 0,
      getUsedCapacity: (resource?: string) =>
        resource === undefined || resource === "energy" ? energy : 0,
    },
    structureType: "container",
    ticksToDecay: 100_000,
  } as unknown as StructureContainer;
}
