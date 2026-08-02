import type { RuntimeGame } from "../../src/runtime/context";

const ROOM_NAME = "W1N1";
const START_TICK = 10_000;
const OK = 0;
const ERR_NAME_EXISTS = -3;
const ERR_BUSY = -4;
const ERR_NOT_ENOUGH_ENERGY = -6;
const ERR_INVALID_TARGET = -7;
const ERR_FULL = -8;
const ERR_NOT_IN_RANGE = -9;
const ERR_INVALID_ARGS = -10;
const ERR_TIRED = -11;
const BUILD_POWER = 5;

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

interface Position {
  readonly roomName: string;
  readonly x: number;
  readonly y: number;
}

interface MutableActor {
  readonly body: readonly BodyPartConstant[];
  energy: number;
  fatigue: number;
  readonly id: string;
  readonly name: string;
  position: Position;
  spawning: boolean;
  ticksToLive: number;
}

interface MutableSite {
  readonly id: string;
  readonly position: Position;
  progress: number;
  readonly progressTotal: number;
  readonly structureType: BuildableStructureConstant;
}

interface MutableStructure {
  energy: number;
  readonly energyCapacity: number;
  readonly id: string;
  isPublic: boolean | null;
  my: boolean;
  readonly position: Position;
  readonly structureType: StructureConstant;
}

interface MutableSource {
  energy: number;
  readonly id: string;
  readonly position: Position;
  regeneration: number;
}

type PendingAction =
  | {
      readonly actorId: string;
      readonly commandTick: number;
      readonly kind: "build";
      readonly targetId: string;
    }
  | {
      readonly actorId: string;
      readonly commandTick: number;
      readonly kind: "harvest";
      readonly targetId: string;
    }
  | {
      readonly actorId: string;
      readonly commandTick: number;
      readonly kind: "pickup";
      readonly targetId: string;
    }
  | {
      readonly actorId: string;
      readonly amount: number | undefined;
      readonly commandTick: number;
      readonly kind: "transfer";
      readonly targetId: string;
    }
  | {
      readonly actorId: string;
      readonly commandTick: number;
      readonly kind: "upgrade";
      readonly targetId: string;
    };

export interface SpawnOnlyRcl2WorldOptions {
  readonly controllerInitialProgress?: number;
  readonly controllerInitialTicksToDowngrade?: number;
  readonly reverseCollections?: boolean;
}

export interface SpawnOnlyMoveCall {
  readonly actorId: string;
  readonly direction: DirectionConstant;
  readonly from: Position;
  readonly tick: number;
}

export interface SpawnOnlyMoveEffect extends SpawnOnlyMoveCall {
  readonly to: Position;
  readonly visibleAt: number;
}

export interface SpawnOnlyBuildEffect {
  readonly actorId: string;
  readonly commandTick: number;
  readonly energy: number;
  readonly progressAfter: number;
  readonly progressBefore: number;
  readonly progressDelta: number;
  readonly targetId: string;
  readonly visibleAt: number;
}

export interface SpawnOnlyHarvestEffect {
  readonly actorId: string;
  readonly carriedEnergy: number;
  readonly commandTick: number;
  readonly droppedEnergy: number;
  readonly energy: number;
  readonly sourceEnergyAfter: number;
  readonly targetId: string;
  readonly visibleAt: number;
}

export interface SpawnOnlyPickupEffect {
  readonly actorId: string;
  readonly commandTick: number;
  readonly energy: number;
  readonly remainingEnergy: number;
  readonly targetId: string;
  readonly visibleAt: number;
}

export interface SpawnOnlyTransferEffect {
  readonly actorId: string;
  readonly commandTick: number;
  readonly energy: number;
  readonly targetId: string;
  readonly visibleAt: number;
}

export interface SpawnOnlySpawnEffect {
  readonly body: readonly BodyPartConstant[];
  readonly commandTick: number;
  readonly cost: number;
  readonly name: string;
  readonly readyAt: number;
  readonly visibleAt: number;
}

export interface SpawnOnlyUpgradeEffect {
  readonly actorId: string;
  readonly commandTick: number;
  readonly energy: number;
  readonly levelAfter: number;
  readonly levelBefore: number;
  readonly progressAfter: number;
  readonly progressBefore: number;
  readonly targetId: string;
  readonly visibleAt: number;
}

export interface SpawnOnlyRcl2World {
  readonly actorStates: readonly {
    readonly energy: number;
    readonly id: string;
    readonly position: Position;
    readonly ticksToLive: number;
  }[];
  readonly buildEffects: readonly SpawnOnlyBuildEffect[];
  readonly constructionSiteCalls: readonly {
    readonly code: number;
    readonly structureType: string;
    readonly tick: number;
    readonly x: number;
    readonly y: number;
  }[];
  readonly controllerLevel: number;
  readonly controllerProgress: number;
  readonly controllerProgressTotal: number;
  readonly controllerTicksToDowngrade: number;
  readonly extensionCount: number;
  readonly harvestEffects: readonly SpawnOnlyHarvestEffect[];
  readonly pickupEffects: readonly SpawnOnlyPickupEffect[];
  readonly droppedEnergy: readonly { readonly amount: number; readonly id: string }[];
  readonly initialWorkerId: string;
  readonly moveCalls: readonly SpawnOnlyMoveCall[];
  readonly moveEffects: readonly SpawnOnlyMoveEffect[];
  readonly pathSearchCalls: number;
  readonly pathUnavailableSearches: number;
  readonly roomEnergyCapacity: number;
  readonly siteCount: number;
  readonly spawnEffects: readonly SpawnOnlySpawnEffect[];
  readonly transferEffects: readonly SpawnOnlyTransferEffect[];
  readonly spawnCalls: readonly {
    readonly body: readonly BodyPartConstant[];
    readonly name: string;
    readonly tick: number;
  }[];
  readonly upgradeEffects: readonly SpawnOnlyUpgradeEffect[];
  readonly globals: {
    readonly PathFinder: unknown;
    readonly RoomPosition: unknown;
  };
  game(tick: number): RuntimeGame;
  killAllWorkers(): void;
  setCpuBucket(bucket: number): void;
  setForeignRampartPublic(isPublic: boolean): void;
  setPathUnavailable(unavailable: boolean): void;
  setReverseCollections(reverse: boolean): void;
  setRoomEnergy(energy: number): void;
}

type InitialWorldProfile = "phase2-rcl2-exit" | "spawn-only";

export function spawnOnlyRcl2World(options: SpawnOnlyRcl2WorldOptions = {}): SpawnOnlyRcl2World {
  return createRcl2World("spawn-only", options);
}

/** Versioned legal Phase 1 exit used as the production RCL2 progression start. */
export function phase2Rcl2ExitWorld(options: SpawnOnlyRcl2WorldOptions = {}): SpawnOnlyRcl2World {
  return createRcl2World("phase2-rcl2-exit", options);
}

function createRcl2World(
  profile: InitialWorldProfile,
  options: SpawnOnlyRcl2WorldOptions,
): SpawnOnlyRcl2World {
  const firstTick = profile === "phase2-rcl2-exit" ? 100 : START_TICK;
  const controllerInitialProgress = options.controllerInitialProgress ?? 0;
  if (
    !Number.isSafeInteger(controllerInitialProgress) ||
    controllerInitialProgress < 0 ||
    controllerInitialProgress >= controllerProgressTotalFor(2)
  ) {
    throw new Error("fixture controller progress is outside RCL2");
  }
  const controllerInitialTicksToDowngrade =
    options.controllerInitialTicksToDowngrade ??
    controllerDowngradeMaximumFor(2) / 2 + (profile === "phase2-rcl2-exit" ? 100 : 0);
  if (
    !Number.isSafeInteger(controllerInitialTicksToDowngrade) ||
    controllerInitialTicksToDowngrade <= 0 ||
    controllerInitialTicksToDowngrade > controllerDowngradeMaximumFor(2)
  ) {
    throw new Error("fixture controller downgrade timer is outside RCL2");
  }
  let currentTick = firstTick - 1;
  let cpuBucket = 10_000;
  let reverseCollections = options.reverseCollections ?? false;
  let pathUnavailable = false;
  let controllerLevel = 2;
  let controllerProgress = controllerInitialProgress;
  let controllerTicksToDowngrade = controllerInitialTicksToDowngrade;
  let pendingSpawn: {
    readonly actorId: string;
    readonly body: readonly BodyPartConstant[];
    readonly name: string;
    readonly readyAt: number;
  } | null = null;
  let pendingSpawnCommand: {
    readonly body: readonly BodyPartConstant[];
    readonly commandTick: number;
    readonly name: string;
  } | null = null;
  const actors = new Map<string, MutableActor>();
  const sites = new Map<string, MutableSite>();
  const structures = new Map<string, MutableStructure>();
  const sources = new Map<string, MutableSource>();
  const drops = new Map<string, { amount: number; position: Position }>();
  const pendingMoves = new Map<string, DirectionConstant>();
  const pendingActions = new Map<string, PendingAction>();
  const pendingSites: Array<{
    readonly position: Position;
    readonly structureType: BuildableStructureConstant;
  }> = [];
  const moveCalls: SpawnOnlyMoveCall[] = [];
  const moveEffects: SpawnOnlyMoveEffect[] = [];
  const buildEffects: SpawnOnlyBuildEffect[] = [];
  const harvestEffects: SpawnOnlyHarvestEffect[] = [];
  const pickupEffects: SpawnOnlyPickupEffect[] = [];
  const transferEffects: SpawnOnlyTransferEffect[] = [];
  const spawnEffects: SpawnOnlySpawnEffect[] = [];
  const upgradeEffects: SpawnOnlyUpgradeEffect[] = [];
  const siteCalls: Array<{
    readonly code: number;
    readonly structureType: string;
    readonly tick: number;
    readonly x: number;
    readonly y: number;
  }> = [];
  const spawnCalls: Array<{
    readonly body: readonly BodyPartConstant[];
    readonly name: string;
    readonly tick: number;
  }> = [];
  let pathSearchCalls = 0;
  let pathUnavailableSearches = 0;

  const spawn = addStructure("spawn-a", "spawn", 25, 25, 300, 300);
  if (profile === "phase2-rcl2-exit") {
    addStructure("extension-initial-a", "extension", 24, 25, 0, 50);
    addStructure("extension-initial-b", "extension", 26, 25, 0, 50);
    sites.set("road-site", {
      id: "road-site",
      position: position(25, 24),
      progress: 5,
      progressTotal: constructionCost("road"),
      structureType: "road",
    });
    addActor("worker-initial", "worker-initial", ["work", "carry", "carry", "move"], 18, 21, 50);
  } else {
    addActor(
      "worker-initial",
      "worker-initial",
      [
        ...Array<BodyPartConstant>(20).fill("work"),
        ...Array<BodyPartConstant>(10).fill("carry"),
        ...Array<BodyPartConstant>(20).fill("move"),
      ],
      18,
      21,
      0,
    );
  }
  addSource("source-a", 21, 21);
  addSource("source-b", 21, 29);

  class FakeRoomPosition {
    public constructor(
      public readonly x: number,
      public readonly y: number,
      public readonly roomName: string,
    ) {}
  }

  class FakeCostMatrix {
    private readonly costs = new Uint8Array(2_500);
    public set(x: number, y: number, value: number): void {
      if (x >= 0 && x < 50 && y >= 0 && y < 50) this.costs[y * 50 + x] = value;
    }
    public get(x: number, y: number): number {
      return x >= 0 && x < 50 && y >= 0 && y < 50 ? (this.costs[y * 50 + x] ?? 0) : 255;
    }
  }

  const pathFinder = {
    CostMatrix: FakeCostMatrix,
    search: (
      origin: FakeRoomPosition,
      goal: { readonly pos: FakeRoomPosition; readonly range: number },
      options: {
        readonly maxCost?: number;
        readonly maxOps?: number;
        readonly roomCallback?: (roomName: string) => FakeCostMatrix | false | undefined;
      },
    ) => {
      pathSearchCalls += 1;
      if (pathUnavailable) {
        pathUnavailableSearches += 1;
        return { cost: 0, incomplete: true, ops: 0, path: [] };
      }
      const matrix = options.roomCallback?.(origin.roomName);
      if (matrix === false || matrix === undefined)
        return { cost: 0, incomplete: true, ops: 0, path: [] };
      return searchPath(origin, goal.pos, goal.range, matrix, options.maxOps ?? 2_000);
    },
  };

  function addActor(
    id: string,
    name: string,
    body: readonly BodyPartConstant[],
    x: number,
    y: number,
    energy: number,
    spawning = false,
  ): MutableActor {
    const actor: MutableActor = {
      body: [...body],
      energy,
      fatigue: 0,
      id,
      name,
      position: position(x, y),
      spawning,
      ticksToLive: 1_500,
    };
    actors.set(id, actor);
    return actor;
  }

  function addSource(id: string, x: number, y: number): void {
    sources.set(id, { energy: 3_000, id, position: position(x, y), regeneration: 300 });
  }

  function addStructure(
    id: string,
    structureType: StructureConstant,
    x: number,
    y: number,
    energy = 0,
    energyCapacity = 0,
  ): MutableStructure {
    const structure = {
      energy,
      energyCapacity,
      id,
      isPublic: null,
      my: true,
      position: position(x, y),
      structureType,
    };
    structures.set(id, structure);
    return structure;
  }

  function advanceWorld(tick: number): void {
    if (tick !== currentTick + 1)
      throw new Error("spawn-only RCL2 fixture requires consecutive ticks");
    const visibleAt = tick;
    // The first call exposes the pinned exit directly; later calls settle one elapsed game tick.
    // The engine restores the downgrade deadline once per tick with any successful controller
    // upgrade, regardless of how many creeps or WORK parts contributed during that tick.
    const settlesElapsedTick = currentTick >= firstTick;
    let upgradedController = false;

    if (pendingSpawnCommand !== null) {
      const command = pendingSpawnCommand;
      const cost = command.body.reduce((sum, part) => sum + bodyPartCost(part), 0);
      if (roomEnergy() < cost)
        throw new Error("accepted fixture spawn command lost its reserved room energy");
      consumeRoomEnergy(cost);
      const actor = addActor(
        `spawned-${command.name}`,
        command.name,
        command.body,
        spawn.position.x,
        spawn.position.y,
        0,
        true,
      );
      pendingSpawn = {
        actorId: actor.id,
        body: command.body,
        name: command.name,
        readyAt: command.commandTick + command.body.length * 3,
      };
      spawnEffects.push({
        body: [...command.body],
        commandTick: command.commandTick,
        cost,
        name: command.name,
        readyAt: pendingSpawn.readyAt,
        visibleAt,
      });
      pendingSpawnCommand = null;
    }

    for (const pending of pendingSites.splice(0)) {
      const id = `site-${pending.structureType}-${String(pending.position.x)}-${String(pending.position.y)}`;
      if (!sites.has(id) && structureAt(pending.position) === null) {
        sites.set(id, {
          id,
          position: pending.position,
          progress: 0,
          progressTotal: constructionCost(pending.structureType),
          structureType: pending.structureType,
        });
      }
    }

    for (const [actorId, direction] of pendingMoves) {
      const actor = actors.get(actorId);
      if (actor === undefined) continue;
      const from = actor.position;
      const delta = directionDelta(direction);
      if (delta === null) continue;
      const to = position(from.x + delta.x, from.y + delta.y);
      if (
        walkable(to) &&
        ![...actors.values()].some((other) => other.id !== actorId && same(other.position, to))
      ) {
        actor.position = to;
        actor.fatigue += spawnOnlyMovementFatigue(
          actor.body,
          actor.energy,
          structureAt(to)?.structureType === "road",
        );
        const call = [...moveCalls]
          .reverse()
          .find((entry) => entry.actorId === actorId && entry.tick === tick - 1);
        if (call !== undefined) moveEffects.push({ ...call, to, visibleAt });
      }
    }
    pendingMoves.clear();

    for (const action of [...pendingActions.values()].sort((a, b) =>
      a.actorId.localeCompare(b.actorId),
    )) {
      const upgradeEffectCount = upgradeEffects.length;
      applyAction(action, visibleAt);
      if (action.kind === "upgrade" && upgradeEffects.length > upgradeEffectCount)
        upgradedController = true;
    }
    pendingActions.clear();

    if (settlesElapsedTick) {
      controllerTicksToDowngrade = upgradedController
        ? Math.min(controllerDowngradeMaximumFor(controllerLevel), controllerTicksToDowngrade + 100)
        : Math.max(0, controllerTicksToDowngrade - 1);
    }

    for (const actor of [...actors.values()]) {
      if (actor.spawning) continue;
      actor.fatigue = Math.max(0, actor.fatigue - activeParts(actor, "move") * 2);
      actor.ticksToLive -= 1;
      if (actor.ticksToLive <= 0) actors.delete(actor.id);
    }
    for (const source of sources.values()) {
      if (source.energy >= 3_000) continue;
      source.regeneration -= 1;
      if (source.regeneration <= 0) {
        source.energy = 3_000;
        source.regeneration = 300;
      }
    }
    if (pendingSpawn !== null && tick >= pendingSpawn.readyAt) {
      const actor = actors.get(pendingSpawn.actorId);
      if (actor === undefined)
        throw new Error("fixture lost the creep object for an active spawn process");
      actor.spawning = false;
      pendingSpawn = null;
    }
    currentTick = tick;
  }

  function applyAction(action: PendingAction, visibleAt: number): void {
    const actor = actors.get(action.actorId);
    if (actor === undefined) return;
    if (action.kind === "harvest") {
      const source = sources.get(action.targetId);
      if (source === undefined || range(actor.position, source.position) > 1 || source.energy <= 0)
        return;
      const amount = Math.min(activeParts(actor, "work") * 2, source.energy);
      source.energy -= amount;
      const capacity = carryCapacity(actor);
      const carried = Math.min(amount, Math.max(0, capacity - actor.energy));
      actor.energy += carried;
      const dropped = amount - carried;
      if (dropped > 0) {
        const prior = drops.get(`drop-${source.id}`);
        drops.set(`drop-${source.id}`, {
          amount: (prior?.amount ?? 0) + dropped,
          position: actor.position,
        });
      }
      harvestEffects.push({
        actorId: actor.id,
        carriedEnergy: carried,
        commandTick: action.commandTick,
        droppedEnergy: dropped,
        energy: amount,
        sourceEnergyAfter: source.energy,
        targetId: source.id,
        visibleAt,
      });
      return;
    }
    if (action.kind === "pickup") {
      const drop = drops.get(action.targetId);
      if (drop === undefined || range(actor.position, drop.position) > 1) return;
      const amount = Math.min(drop.amount, carryCapacity(actor) - actor.energy);
      actor.energy += amount;
      drop.amount -= amount;
      pickupEffects.push({
        actorId: actor.id,
        commandTick: action.commandTick,
        energy: amount,
        remainingEnergy: Math.max(0, drop.amount),
        targetId: action.targetId,
        visibleAt,
      });
      if (drop.amount <= 0) drops.delete(action.targetId);
      return;
    }
    if (action.kind === "transfer") {
      const target = structures.get(action.targetId);
      if (target === undefined || range(actor.position, target.position) > 1) return;
      const amount = Math.min(
        action.amount ?? actor.energy,
        actor.energy,
        target.energyCapacity - target.energy,
      );
      actor.energy -= Math.max(0, amount);
      target.energy += Math.max(0, amount);
      if (amount > 0)
        transferEffects.push({
          actorId: actor.id,
          commandTick: action.commandTick,
          energy: amount,
          targetId: action.targetId,
          visibleAt,
        });
      return;
    }
    if (action.kind === "build") {
      const site = sites.get(action.targetId);
      if (site === undefined || range(actor.position, site.position) > 3) return;
      const progressBefore = site.progress;
      const energy = Math.min(
        activeParts(actor, "work"),
        actor.energy,
        Math.ceil((site.progressTotal - site.progress) / BUILD_POWER),
      );
      if (energy <= 0) return;
      const progressDelta = Math.min(site.progressTotal - site.progress, energy * BUILD_POWER);
      actor.energy -= energy;
      site.progress += progressDelta;
      buildEffects.push({
        actorId: actor.id,
        commandTick: action.commandTick,
        energy,
        progressAfter: site.progress,
        progressBefore,
        progressDelta,
        targetId: site.id,
        visibleAt,
      });
      if (site.progress >= site.progressTotal) {
        sites.delete(site.id);
        addCompletedStructure(site);
      }
      return;
    }
    if (
      action.targetId !== "controller-a" ||
      controllerLevel >= 8 ||
      range(actor.position, controllerPosition) > 3
    )
      return;
    const progressTotal = controllerProgressTotalFor(controllerLevel);
    const energy = Math.min(activeParts(actor, "work"), actor.energy);
    if (energy <= 0) return;
    const levelBefore = controllerLevel;
    const progressBefore = controllerProgress;
    actor.energy -= energy;
    controllerProgress += energy;
    if (
      controllerProgress >= progressTotal &&
      controllerTicksToDowngrade + 100 >= controllerDowngradeMaximumFor(controllerLevel) &&
      controllerLevel < 8
    ) {
      controllerLevel += 1;
      controllerProgress -= progressTotal;
      controllerTicksToDowngrade = controllerDowngradeMaximumFor(controllerLevel) / 2;
    }
    upgradeEffects.push({
      actorId: actor.id,
      commandTick: action.commandTick,
      energy,
      levelAfter: controllerLevel,
      levelBefore,
      progressAfter: controllerProgress,
      progressBefore,
      targetId: action.targetId,
      visibleAt,
    });
  }

  function addCompletedStructure(site: MutableSite): void {
    const energyCapacity =
      site.structureType === "extension" ? 50 : site.structureType === "container" ? 2_000 : 0;
    addStructure(
      `built-${site.structureType}-${String(site.position.x)}-${String(site.position.y)}`,
      site.structureType,
      site.position.x,
      site.position.y,
      0,
      energyCapacity,
    );
  }

  function actorObject(actor: MutableActor): Creep {
    const body = actor.body;
    return {
      body: body.map((type) => ({ hits: 100, type })),
      build: (target: ConstructionSite) => scheduleBuild(actor, target),
      get fatigue() {
        return actor.fatigue;
      },
      harvest: (target: Source) => scheduleHarvest(actor, target),
      hits: body.length * 100,
      hitsMax: body.length * 100,
      id: actor.id,
      move: (direction: DirectionConstant) => scheduleMove(actor, direction),
      my: true,
      name: actor.name,
      owner: { username: "Myrmex" },
      pickup: (target: Resource) => schedulePickup(actor, target),
      get pos() {
        return actor.position;
      },
      repair: () => ERR_INVALID_TARGET,
      room,
      get spawning() {
        return actor.spawning;
      },
      store: energyStore(() => actor.energy, carryCapacity(actor)),
      get ticksToLive() {
        return actor.spawning ? undefined : actor.ticksToLive;
      },
      transfer: (target: AnyStoreStructure, resource: ResourceConstant, amount?: number) =>
        scheduleTransfer(actor, target, resource, amount),
      upgradeController: (target: StructureController) => scheduleUpgrade(actor, target),
      withdraw: () => ERR_INVALID_TARGET,
    } as unknown as Creep;
  }

  function scheduleMove(actor: MutableActor, direction: DirectionConstant): number {
    if (actor.spawning) return ERR_BUSY;
    if (directionDelta(direction) === null) return ERR_INVALID_ARGS;
    if (actor.fatigue > 0) return ERR_TIRED;
    pendingMoves.set(actor.id, direction);
    moveCalls.push({ actorId: actor.id, direction, from: actor.position, tick: currentTick });
    return OK;
  }

  function scheduleHarvest(actor: MutableActor, target: Source): number {
    if (actor.spawning) return ERR_BUSY;
    const source = sources.get(String(target.id));
    if (source === undefined) return ERR_INVALID_TARGET;
    if (range(actor.position, source.position) > 1) return ERR_NOT_IN_RANGE;
    if (source.energy <= 0) return ERR_NOT_ENOUGH_ENERGY;
    pendingActions.set(actor.id, {
      actorId: actor.id,
      commandTick: currentTick,
      kind: "harvest",
      targetId: source.id,
    });
    return OK;
  }

  function schedulePickup(actor: MutableActor, target: Resource): number {
    if (actor.spawning) return ERR_BUSY;
    const drop = drops.get(String(target.id));
    if (drop === undefined || drop.amount <= 0) return ERR_INVALID_TARGET;
    if (range(actor.position, drop.position) > 1) return ERR_NOT_IN_RANGE;
    if (actor.energy >= carryCapacity(actor)) return ERR_FULL;
    pendingActions.set(actor.id, {
      actorId: actor.id,
      commandTick: currentTick,
      kind: "pickup",
      targetId: String(target.id),
    });
    return OK;
  }

  function scheduleTransfer(
    actor: MutableActor,
    target: AnyStoreStructure,
    resource: ResourceConstant,
    amount?: number,
  ): number {
    if (actor.spawning) return ERR_BUSY;
    const structure = structures.get(String(target.id));
    if (resource !== "energy" || structure === undefined) return ERR_INVALID_TARGET;
    if (range(actor.position, structure.position) > 1) return ERR_NOT_IN_RANGE;
    if (actor.energy <= 0) return ERR_NOT_ENOUGH_ENERGY;
    if (structure.energy >= structure.energyCapacity) return ERR_FULL;
    pendingActions.set(actor.id, {
      actorId: actor.id,
      amount,
      commandTick: currentTick,
      kind: "transfer",
      targetId: structure.id,
    });
    return OK;
  }

  function scheduleBuild(actor: MutableActor, target: ConstructionSite): number {
    if (actor.spawning) return ERR_BUSY;
    const site = sites.get(String(target.id));
    if (site === undefined) return ERR_INVALID_TARGET;
    if (range(actor.position, site.position) > 3) return ERR_NOT_IN_RANGE;
    if (actor.energy <= 0) return ERR_NOT_ENOUGH_ENERGY;
    pendingActions.set(actor.id, {
      actorId: actor.id,
      commandTick: currentTick,
      kind: "build",
      targetId: site.id,
    });
    return OK;
  }

  function scheduleUpgrade(actor: MutableActor, target: StructureController): number {
    if (actor.spawning) return ERR_BUSY;
    if (String(target.id) !== "controller-a") return ERR_INVALID_TARGET;
    if (range(actor.position, controllerPosition) > 3) return ERR_NOT_IN_RANGE;
    if (actor.energy <= 0) return ERR_NOT_ENOUGH_ENERGY;
    pendingActions.set(actor.id, {
      actorId: actor.id,
      commandTick: currentTick,
      kind: "upgrade",
      targetId: "controller-a",
    });
    return OK;
  }

  function structureObject(structure: MutableStructure): AnyStructure {
    const common = {
      hits: structure.structureType === "spawn" ? 5_000 : 1_000,
      hitsMax: structure.structureType === "spawn" ? 5_000 : 1_000,
      id: structure.id,
      isActive: () => true,
      my: structure.my,
      owner: { username: structure.my ? "Myrmex" : "Other" },
      pos: structure.position,
      room: { name: ROOM_NAME },
      structureType: structure.structureType,
    };
    if (structure.structureType === "rampart") {
      return { ...common, isPublic: structure.isPublic === true } as unknown as StructureRampart;
    }
    if (structure.structureType === "spawn") {
      return {
        ...common,
        name: "Spawn1",
        get spawning() {
          return pendingSpawn === null
            ? null
            : {
                name: pendingSpawn.name,
                needTime: pendingSpawn.body.length * 3,
                remainingTime: Math.max(1, pendingSpawn.readyAt - currentTick),
              };
        },
        spawnCreep: (body: BodyPartConstant[], name: string) => {
          spawnCalls.push({ body: [...body], name, tick: currentTick });
          if (pendingSpawn !== null || pendingSpawnCommand !== null) return ERR_BUSY;
          if ([...actors.values()].some((actor) => actor.name === name)) return ERR_NAME_EXISTS;
          const cost = body.reduce((sum, part) => sum + bodyPartCost(part), 0);
          if (roomEnergy() < cost) return ERR_NOT_ENOUGH_ENERGY;
          pendingSpawnCommand = {
            body: [...body],
            commandTick: currentTick,
            name,
          };
          return OK;
        },
        store: energyStore(() => structure.energy, structure.energyCapacity),
      } as unknown as StructureSpawn;
    }
    if (structure.energyCapacity > 0) {
      return {
        ...common,
        store: energyStore(() => structure.energy, structure.energyCapacity),
      } as unknown as AnyStoreStructure;
    }
    return common as unknown as AnyStructure;
  }

  function sourceObject(source: MutableSource): Source {
    return {
      energyCapacity: 3_000,
      get energy() {
        return source.energy;
      },
      id: source.id,
      pos: source.position,
      get ticksToRegeneration() {
        return source.regeneration;
      },
    } as unknown as Source;
  }

  function siteObject(site: MutableSite): ConstructionSite {
    return {
      id: site.id,
      my: true,
      owner: { username: "Myrmex" },
      pos: site.position,
      get progress() {
        return site.progress;
      },
      progressTotal: site.progressTotal,
      structureType: site.structureType,
    } as unknown as ConstructionSite;
  }

  function dropObject(id: string, drop: { amount: number; position: Position }): Resource {
    return {
      get amount() {
        return drop.amount;
      },
      id,
      pos: drop.position,
      resourceType: "energy",
    } as unknown as Resource;
  }

  const controllerPosition = position(30, 30);
  const controller = {
    id: "controller-a",
    get level() {
      return controllerLevel;
    },
    my: true,
    owner: { username: "Myrmex" },
    pos: controllerPosition,
    get progress() {
      return controllerProgress;
    },
    get progressTotal() {
      return controllerProgressTotalFor(controllerLevel);
    },
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    get ticksToDowngrade() {
      return controllerTicksToDowngrade;
    },
    upgradeBlocked: undefined,
  } as unknown as StructureController;

  const room = {
    controller,
    createConstructionSite: (
      x: number,
      y: number,
      structureType: BuildableStructureConstant,
    ): ScreepsReturnCode => {
      const target = position(x, y);
      let code: number = OK;
      if (!interior(target) || structureAt(target) !== null || siteAt(target) !== null)
        code = ERR_INVALID_TARGET;
      else if (sites.size + pendingSites.length >= 10) code = ERR_FULL;
      else pendingSites.push({ position: target, structureType });
      siteCalls.push({ code, structureType, tick: currentTick, x, y });
      return code as ScreepsReturnCode;
    },
    get energyAvailable() {
      return roomEnergy();
    },
    get energyCapacityAvailable() {
      return roomEnergyCapacity();
    },
    find: (findType: number): unknown[] => {
      const values =
        findType === FIND_CREEPS_VALUE
          ? [...actors.values()].map(actorObject)
          : findType === FIND_SOURCES_VALUE
            ? [...sources.values()].map(sourceObject)
            : findType === FIND_DROPPED_RESOURCES_VALUE
              ? [...drops].map(([id, drop]) => dropObject(id, drop))
              : findType === FIND_STRUCTURES_VALUE
                ? [...structures.values()].map(structureObject)
                : findType === FIND_CONSTRUCTION_SITES_VALUE
                  ? [...sites.values()].map(siteObject)
                  : [];
      return reverseCollections ? values.reverse() : values;
    },
    getTerrain: () => ({
      get: (x: number, y: number) =>
        x < 0 ||
        x > 49 ||
        y < 0 ||
        y > 49 ||
        x === 0 ||
        x === 49 ||
        y === 49 ||
        (y === 0 && (x === 0 || x === 49))
          ? 1
          : 0,
    }),
    name: ROOM_NAME,
  } as unknown as Room;

  function game(tick: number): RuntimeGame {
    advanceWorld(tick);
    const actorObjects = [...actors.values()].map(actorObject);
    const siteObjects = [...sites.values()].map(siteObject);
    let cpuUsed = 0;
    return {
      constructionSites: Object.fromEntries(siteObjects.map((site) => [String(site.id), site])),
      cpu: {
        bucket: cpuBucket,
        getUsed: () => {
          const sample = cpuUsed;
          cpuUsed += 0.001;
          return sample;
        },
        limit: 20,
        tickLimit: 500,
      },
      creeps: Object.fromEntries(actorObjects.map((actor) => [actor.name, actor])),
      getObjectById: (id: string) => {
        const actor = actors.get(id);
        if (actor !== undefined) return actorObject(actor);
        const source = sources.get(id);
        if (source !== undefined) return sourceObject(source);
        const structure = structures.get(id);
        if (structure !== undefined) return structureObject(structure);
        const site = sites.get(id);
        if (site !== undefined) return siteObject(site);
        const drop = drops.get(id);
        if (drop !== undefined) return dropObject(id, drop);
        if (id === "controller-a") return controller;
        return null;
      },
      rooms: { [ROOM_NAME]: room },
      shard: { name: "shard3" },
      time: tick,
    };
  }

  function roomEnergy(): number {
    return [...structures.values()]
      .filter(({ structureType }) => structureType === "spawn" || structureType === "extension")
      .reduce((sum, structure) => sum + structure.energy, 0);
  }

  function roomEnergyCapacity(): number {
    return [...structures.values()]
      .filter(({ structureType }) => structureType === "spawn" || structureType === "extension")
      .reduce((sum, structure) => sum + structure.energyCapacity, 0);
  }

  function consumeRoomEnergy(amount: number): void {
    let remaining = amount;
    const consumers = [...structures.values()]
      .filter(({ structureType }) => structureType === "extension" || structureType === "spawn")
      .sort((left, right) =>
        left.structureType === right.structureType
          ? left.id.localeCompare(right.id)
          : left.structureType === "extension"
            ? -1
            : 1,
      );
    for (const structure of consumers) {
      const consumed = Math.min(remaining, structure.energy);
      structure.energy -= consumed;
      remaining -= consumed;
      if (remaining === 0) return;
    }
    throw new Error("fixture spawn consumed unavailable room energy");
  }

  function structureAt(target: Position): MutableStructure | null {
    return [...structures.values()].find(({ position: value }) => same(value, target)) ?? null;
  }

  function siteAt(target: Position): MutableSite | null {
    return [...sites.values()].find(({ position: value }) => same(value, target)) ?? null;
  }

  function walkable(target: Position): boolean {
    if (!interior(target)) return false;
    const structure = structureAt(target);
    return (
      structure === null ||
      structure.structureType === "road" ||
      structure.structureType === "container" ||
      (structure.structureType === "rampart" && (structure.my || structure.isPublic === true))
    );
  }

  const world: SpawnOnlyRcl2World = {
    get actorStates() {
      return [...actors.values()]
        .filter(({ spawning }) => !spawning)
        .map(({ energy, id, position, ticksToLive }) => ({
          energy,
          id,
          position,
          ticksToLive,
        }));
    },
    get buildEffects() {
      return [...buildEffects];
    },
    get constructionSiteCalls() {
      return [...siteCalls];
    },
    get controllerLevel() {
      return controllerLevel;
    },
    get controllerProgress() {
      return controllerProgress;
    },
    get controllerProgressTotal() {
      return controllerProgressTotalFor(controllerLevel);
    },
    get controllerTicksToDowngrade() {
      return controllerTicksToDowngrade;
    },
    get extensionCount() {
      return [...structures.values()].filter(({ structureType }) => structureType === "extension")
        .length;
    },
    game,
    globals: { PathFinder: pathFinder, RoomPosition: FakeRoomPosition },
    get harvestEffects() {
      return [...harvestEffects];
    },
    get pickupEffects() {
      return [...pickupEffects];
    },
    get droppedEnergy() {
      return [...drops]
        .map(([id, { amount }]) => ({ amount, id }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    initialWorkerId: "worker-initial",
    killAllWorkers: () => {
      for (const [actorId, actor] of actors) if (!actor.spawning) actors.delete(actorId);
      pendingActions.clear();
      pendingMoves.clear();
    },
    get moveCalls() {
      return [...moveCalls];
    },
    get moveEffects() {
      return [...moveEffects];
    },
    get pathSearchCalls() {
      return pathSearchCalls;
    },
    get pathUnavailableSearches() {
      return pathUnavailableSearches;
    },
    get roomEnergyCapacity() {
      return roomEnergyCapacity();
    },
    setCpuBucket: (bucket: number) => {
      cpuBucket = bucket;
    },
    setForeignRampartPublic: (isPublic: boolean) => {
      const rampart =
        structures.get("foreign-rampart") ?? addStructure("foreign-rampart", "rampart", 10, 10);
      rampart.isPublic = isPublic;
      rampart.my = false;
    },
    setPathUnavailable: (unavailable: boolean) => {
      pathUnavailable = unavailable;
    },
    setReverseCollections: (reverse: boolean) => {
      reverseCollections = reverse;
    },
    setRoomEnergy: (energy: number) => {
      if (!Number.isSafeInteger(energy) || energy < 0 || energy > roomEnergyCapacity())
        throw new Error("fixture room energy is outside capacity");
      let remaining = energy;
      const stores = [...structures.values()]
        .filter(({ structureType }) => structureType === "spawn" || structureType === "extension")
        .sort((left, right) =>
          left.structureType === right.structureType
            ? left.id.localeCompare(right.id)
            : left.structureType === "spawn"
              ? -1
              : 1,
        );
      for (const store of stores) {
        store.energy = Math.min(store.energyCapacity, remaining);
        remaining -= store.energy;
      }
    },
    get siteCount() {
      return sites.size;
    },
    get spawnEffects() {
      return [...spawnEffects];
    },
    get transferEffects() {
      return [...transferEffects];
    },
    get spawnCalls() {
      return [...spawnCalls];
    },
    get upgradeEffects() {
      return [...upgradeEffects];
    },
  };
  return world;
}

function position(x: number, y: number): Position {
  return { roomName: ROOM_NAME, x, y };
}

function same(left: Position, right: Position): boolean {
  return left.roomName === right.roomName && left.x === right.x && left.y === right.y;
}

function range(left: Position, right: Position): number {
  return left.roomName === right.roomName
    ? Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y))
    : Number.POSITIVE_INFINITY;
}

function interior(target: Position): boolean {
  return (
    target.roomName === ROOM_NAME && target.x > 0 && target.x < 49 && target.y > 0 && target.y < 49
  );
}

function activeParts(actor: MutableActor, part: BodyPartConstant): number {
  return actor.body.filter((candidate) => candidate === part).length;
}

function carryCapacity(actor: MutableActor): number {
  return activeParts(actor, "carry") * 50;
}

/** Gross fatigue produced by one fixture movement intent before MOVE recovery settles. */
export function spawnOnlyMovementFatigue(
  body: readonly BodyPartConstant[],
  carriedEnergy: number,
  finishedRoad: boolean,
): number {
  const carryParts = body.filter((part) => part === "carry").length;
  const occupiedCarryParts = Math.min(carryParts, Math.ceil(carriedEnergy / 50));
  const weightedNonCarryParts = body.filter((part) => part !== "move" && part !== "carry").length;
  const terrainFatigue = finishedRoad ? 1 : 2;
  return (weightedNonCarryParts + occupiedCarryParts) * terrainFatigue;
}

function bodyPartCost(part: BodyPartConstant): number {
  return {
    attack: 80,
    carry: 50,
    claim: 600,
    heal: 250,
    move: 50,
    ranged_attack: 150,
    tough: 10,
    work: 100,
  }[part];
}

function controllerProgressTotalFor(level: number): number {
  const totals: Readonly<Record<number, number>> = {
    1: 200,
    2: 45_000,
    3: 135_000,
    4: 405_000,
    5: 1_215_000,
    6: 3_645_000,
    7: 10_935_000,
    8: 0,
  };
  const total = totals[level];
  if (total === undefined) throw new Error("fixture controller level is unsupported");
  return total;
}

function controllerDowngradeMaximumFor(level: number): number {
  const maxima: Readonly<Record<number, number>> = {
    1: 20_000,
    2: 10_000,
    3: 20_000,
    4: 40_000,
    5: 80_000,
    6: 120_000,
    7: 150_000,
    8: 200_000,
  };
  const maximum = maxima[level];
  if (maximum === undefined) throw new Error("fixture controller level is unsupported");
  return maximum;
}

function constructionCost(structureType: BuildableStructureConstant): number {
  return {
    constructedWall: 1,
    container: 5_000,
    extension: 3_000,
    extractor: 5_000,
    factory: 100_000,
    lab: 50_000,
    link: 5_000,
    nuker: 100_000,
    observer: 8_000,
    powerSpawn: 100_000,
    rampart: 1,
    road: 300,
    spawn: 15_000,
    storage: 30_000,
    terminal: 100_000,
    tower: 5_000,
  }[structureType];
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

function directionDelta(
  direction: DirectionConstant,
): { readonly x: number; readonly y: number } | null {
  const values: Partial<Record<DirectionConstant, { readonly x: number; readonly y: number }>> = {
    1: { x: 0, y: -1 },
    2: { x: 1, y: -1 },
    3: { x: 1, y: 0 },
    4: { x: 1, y: 1 },
    5: { x: 0, y: 1 },
    6: { x: -1, y: 1 },
    7: { x: -1, y: 0 },
    8: { x: -1, y: -1 },
  };
  return values[direction] ?? null;
}

function searchPath(
  origin: Position,
  goal: Position,
  goalRange: number,
  matrix: { get(x: number, y: number): number },
  maximumOperations: number,
): {
  readonly cost: number;
  readonly incomplete: boolean;
  readonly ops: number;
  readonly path: readonly Position[];
} {
  const key = (x: number, y: number) => y * 50 + x;
  const queue: Array<{ readonly x: number; readonly y: number }> = [{ x: origin.x, y: origin.y }];
  const previous = new Int32Array(2_500).fill(-1);
  const visited = new Uint8Array(2_500);
  visited[key(origin.x, origin.y)] = 1;
  let cursor = 0;
  let found = -1;
  let operations = 0;
  const directions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
  while (cursor < queue.length && operations < maximumOperations) {
    const current = queue[cursor++];
    if (current === undefined) break;
    operations += 1;
    if (Math.max(Math.abs(current.x - goal.x), Math.abs(current.y - goal.y)) <= goalRange) {
      found = key(current.x, current.y);
      break;
    }
    for (const direction of directions) {
      const delta = directionDelta(direction);
      if (delta === null) continue;
      const x = current.x + delta.x;
      const y = current.y + delta.y;
      if (x < 0 || x > 49 || y < 0 || y > 49 || matrix.get(x, y) >= 255) continue;
      const next = key(x, y);
      if (visited[next] === 1) continue;
      visited[next] = 1;
      previous[next] = key(current.x, current.y);
      queue.push({ x, y });
    }
  }
  if (found < 0) return { cost: 0, incomplete: true, ops: operations, path: [] };
  const reverse: Position[] = [];
  for (let value = found; value !== key(origin.x, origin.y); value = previous[value] ?? -1) {
    if (value < 0) return { cost: 0, incomplete: true, ops: operations, path: [] };
    reverse.push(position(value % 50, Math.floor(value / 50)));
  }
  const path = reverse.reverse();
  return { cost: path.length, incomplete: false, ops: operations, path };
}
