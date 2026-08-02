import { describe, expect, it } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import {
  phase2Rcl2ExitWorld,
  spawnOnlyMovementFatigue,
  spawnOnlyRcl2World,
} from "./support/spawn-only-rcl2-fixture";

const ROOM_NAME = "W1N1";
const OK = 0;
const RIGHT = 3 as DirectionConstant;
const BOTTOM_RIGHT = 4 as DirectionConstant;

describe("Phase 2 RCL2 exit fixture", () => {
  it("starts from the legal Phase 1 exit and settles work on the next tick", () => {
    const world = phase2Rcl2ExitWorld();
    let game = world.game(100);
    let worker = objectById(game, world.initialWorkerId);
    const source = objectById(game, "source-a");
    const roadSite = objectById(game, "road-site");
    const spawn = objectById(game, "spawn-a");

    expect(world.controllerLevel).toBe(2);
    expect(world.controllerProgress).toBe(0);
    expect(world.controllerProgressTotal).toBe(45_000);
    expect(world.controllerTicksToDowngrade).toBe(5_100);
    expect(objectById(game, "controller-a").ticksToDowngrade).toBe(5_100);
    expect(world.extensionCount).toBe(2);
    expect(world.siteCount).toBe(1);
    expect(world.roomEnergyCapacity).toBe(400);
    expect(game.rooms[ROOM_NAME]?.energyAvailable).toBe(300);
    expect(worker.body.map(({ type }) => type)).toEqual(["work", "carry", "carry", "move"]);
    expect(worker.store.getUsedCapacity("energy")).toBe(50);
    expect(roadSite).toMatchObject({
      id: "road-site",
      progress: 5,
      progressTotal: 300,
      structureType: "road",
    });

    expect(worker.move(RIGHT)).toBe(OK);
    game = world.game(101);
    worker = objectById(game, world.initialWorkerId);
    expect(worker.pos.x).toBe(19);
    expect(worker.fatigue).toBe(2);
    expect(worker.move(RIGHT)).toBe(-11);
    game = world.game(102);
    worker = objectById(game, world.initialWorkerId);
    expect(worker.fatigue).toBe(0);
    expect(worker.move(RIGHT)).toBe(OK);
    game = world.game(103);
    worker = objectById(game, world.initialWorkerId);

    expect(worker.harvest(source)).toBe(OK);
    expect(world.harvestEffects).toEqual([]);
    expect(worker.store.getUsedCapacity("energy")).toBe(50);
    game = world.game(104);
    expect(world.harvestEffects).toEqual([
      {
        actorId: world.initialWorkerId,
        carriedEnergy: 2,
        commandTick: 103,
        droppedEnergy: 0,
        energy: 2,
        sourceEnergyAfter: 2_998,
        targetId: "source-a",
        visibleAt: 104,
      },
    ]);
    worker = objectById(game, world.initialWorkerId);
    expect(worker.store.getUsedCapacity("energy")).toBe(52);

    expect(worker.move(BOTTOM_RIGHT)).toBe(OK);
    world.game(105);
    game = world.game(106);
    worker = objectById(game, world.initialWorkerId);
    expect(worker.fatigue).toBe(2);
    expect(worker.move(BOTTOM_RIGHT)).toBe(-11);
    game = world.game(107);
    worker = objectById(game, world.initialWorkerId);
    expect(worker.fatigue).toBe(0);
    expect(worker.move(BOTTOM_RIGHT)).toBe(OK);
    game = world.game(108);
    worker = objectById(game, world.initialWorkerId);

    expect(worker.build(roadSite)).toBe(OK);
    expect(world.buildEffects).toEqual([]);
    expect(roadSite.progress).toBe(5);
    game = world.game(109);
    expect(world.buildEffects).toEqual([
      {
        actorId: world.initialWorkerId,
        commandTick: 108,
        energy: 1,
        progressAfter: 10,
        progressBefore: 5,
        progressDelta: 5,
        targetId: "road-site",
        visibleAt: 109,
      },
    ]);
    expect(roadSite.progress).toBe(10);

    expect(spawn.spawnCreep(["work", "carry", "move"], "fixture-new")).toBe(OK);
    expect(world.spawnEffects).toEqual([]);
    expect(spawn.spawning).toBeNull();
    expect(game.rooms[ROOM_NAME]?.energyAvailable).toBe(300);
    game = world.game(110);
    expect(game.rooms[ROOM_NAME]?.energyAvailable).toBe(100);
    expect(spawn.spawning).not.toBeNull();
    expect(game.creeps["fixture-new"]).toMatchObject({ spawning: true });
    expect(game.creeps["fixture-new"]?.ticksToLive).toBeUndefined();
    expect(world.spawnEffects).toEqual([
      {
        body: ["work", "carry", "move"],
        commandTick: 109,
        cost: 200,
        name: "fixture-new",
        readyAt: 118,
        visibleAt: 110,
      },
    ]);
  });

  it("charges official plain and completed-road fatigue with empty CARRY parts weightless", () => {
    const loadedRcl2Worker = [
      "work",
      "work",
      "work",
      "carry",
      "carry",
      "move",
      "move",
      "move",
    ] as const satisfies readonly BodyPartConstant[];

    expect(spawnOnlyMovementFatigue(loadedRcl2Worker, 100, false)).toBe(10);
    expect(spawnOnlyMovementFatigue(loadedRcl2Worker, 0, false)).toBe(6);
    expect(spawnOnlyMovementFatigue(loadedRcl2Worker, 100, true)).toBe(5);
    // Six points of MOVE recovery leave a loaded worker fatigued after a plain move.
    expect(spawnOnlyMovementFatigue(loadedRcl2Worker, 100, false) - 3 * 2).toBe(4);
  });

  it("settles controller work on the next tick and exposes the RCL3 transition", () => {
    const world = phase2Rcl2ExitWorld({
      controllerInitialProgress: 44_999,
      controllerInitialTicksToDowngrade: 10_000,
    });
    let tick = 100;
    let game = world.game(tick);
    const controller = objectById(game, "controller-a");

    while (roomRange(objectById(game, world.initialWorkerId).pos, controller.pos) > 3) {
      const worker = objectById(game, world.initialWorkerId);
      const result = worker.move(BOTTOM_RIGHT);
      expect([OK, -11]).toContain(result);
      tick += 1;
      game = world.game(tick);
    }

    const worker = objectById(game, world.initialWorkerId);
    expect(worker.upgradeController(controller)).toBe(OK);
    expect(controller.level).toBe(2);
    expect(controller.progress).toBe(44_999);
    expect(world.upgradeEffects).toEqual([]);

    tick += 1;
    game = world.game(tick);
    expect(controller.level).toBe(3);
    expect(controller.progress).toBe(0);
    expect(controller.progressTotal).toBe(135_000);
    expect(world.controllerLevel).toBe(3);
    expect(world.controllerProgressTotal).toBe(135_000);
    expect(world.controllerTicksToDowngrade).toBe(10_100);
    expect(controller.ticksToDowngrade).toBe(10_100);
    expect(world.upgradeEffects).toEqual([
      {
        actorId: world.initialWorkerId,
        commandTick: tick - 1,
        energy: 1,
        levelAfter: 3,
        levelBefore: 2,
        progressAfter: 0,
        progressBefore: 44_999,
        targetId: "controller-a",
        visibleAt: tick,
      },
    ]);
    expect(objectById(game, world.initialWorkerId).store.getUsedCapacity("energy")).toBe(49);
  });

  it("preserves the original spawn-only profile by default", () => {
    const world = spawnOnlyRcl2World();
    const game = world.game(10_000);
    const worker = objectById(game, world.initialWorkerId);

    expect(world.extensionCount).toBe(0);
    expect(world.siteCount).toBe(0);
    expect(world.roomEnergyCapacity).toBe(300);
    expect(worker.body).toHaveLength(50);
    expect(worker.store.getUsedCapacity("energy")).toBe(0);
  });
});

function objectById(game: RuntimeGame, id: "controller-a"): StructureController;
function objectById(game: RuntimeGame, id: "road-site"): ConstructionSite;
function objectById(game: RuntimeGame, id: "source-a"): Source;
function objectById(game: RuntimeGame, id: "spawn-a"): StructureSpawn;
function objectById(game: RuntimeGame, id: string): Creep;
function objectById(game: RuntimeGame, id: string): unknown {
  const value = game.getObjectById?.(id);
  if (value === null || value === undefined) throw new Error(`fixture object ${id} is missing`);
  return value;
}

function roomRange(left: RoomPosition, right: RoomPosition): number {
  return left.roomName === right.roomName
    ? Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y))
    : Number.POSITIVE_INFINITY;
}
