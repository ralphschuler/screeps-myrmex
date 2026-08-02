import { afterEach, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { spawnOnlyRcl2World } from "./support/spawn-only-rcl2-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 10_000;
const MAXIMUM_TICKS = 1_400;
const MAXIMUM_MEMORY_BYTES = 250_000;

describe("spawn-only RCL2 production progression", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recovers through real movement and extension construction before resuming controller progress", async () => {
    const world = spawnOnlyRcl2World();
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
    vi.stubGlobal("RoomPosition", world.globals.RoomPosition);
    vi.stubGlobal("PathFinder", world.globals.PathFinder);

    expect(world.extensionCount).toBe(0);
    expect(world.siteCount).toBe(0);
    expect(world.roomEnergyCapacity).toBe(300);
    expect(world.controllerProgress).toBe(0);

    let memory = {} as Memory;
    let executeTick = runTick;
    let maximumMemoryBytes = 0;
    let extensionSiteExecutions = 0;
    let constrainedTicks = 0;
    let provisionalSpawnRevocations = 0;
    let resetApplied = false;
    let reordered = false;
    let deathTick: number | null = null;
    let replacementUsefulWork = false;
    let firstExecutedMove: { readonly actorId: string; readonly tick: number } | null = null;
    let initialEntityPositions: readonly string[] = [];
    let lastMode = "unknown";
    let lastColony: unknown = null;
    const killedActorIds = new Set<string>();
    const kernelFaults: unknown[] = [];

    world.setCpuBucket(4_000);
    world.setPathUnavailable(true);

    for (let tick = START_TICK; tick < START_TICK + MAXIMUM_TICKS; tick += 1) {
      if (tick === START_TICK + 10) world.setCpuBucket(10_000);
      if (tick === START_TICK + 20) world.setPathUnavailable(false);

      const outcome = executeTick({ game: world.game(tick), memory });
      lastMode = outcome.kernel.mode;
      lastColony = outcome.colony.colonies[0] ?? null;
      kernelFaults.push(...outcome.kernel.faults);
      if (outcome.kernel.mode === "constrained") constrainedTicks += 1;
      extensionSiteExecutions += outcome.layout.execution.filter(
        ({ called, code, intent }) =>
          called && code === "OK" && intent.structureType === "extension",
      ).length;
      const executedSpawnDemands = new Set(
        outcome.spawn.execution.map(({ command }) => command.demandId),
      );
      provisionalSpawnRevocations +=
        outcome.spawn.broker?.selections.filter(
          ({ demandId }) => !executedSpawnDemands.has(demandId),
        ).length ?? 0;
      firstExecutedMove ??=
        outcome.movement.movementExecution
          .filter(
            ({ intent, outcome: command, status }) =>
              intent.actorId === world.initialWorkerId &&
              status === "executed" &&
              command?.name === "OK",
          )
          .map(({ intent }) => ({ actorId: intent.actorId, tick }))[0] ?? null;
      if (deathTick !== null && tick > deathTick) {
        replacementUsefulWork ||= outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && !killedActorIds.has(intent.actorId),
        );
      }
      if (initialEntityPositions.length === 0) {
        const room = outcome.snapshot.rooms[0];
        if (room === undefined) throw new Error("spawn-only room was not observed");
        initialEntityPositions = [
          ...room.ownedCreeps.map(({ pos }) => `${String(pos.x)}:${String(pos.y)}`),
          ...room.sources.map(({ pos }) => `${String(pos.x)}:${String(pos.y)}`),
          ...room.ownedSpawns.map(({ pos }) => `${String(pos.x)}:${String(pos.y)}`),
          ...(room.controller === null
            ? []
            : [`${String(room.controller.pos.x)}:${String(room.controller.pos.y)}`]),
        ];
      }
      if ((tick - START_TICK) % 25 === 0)
        maximumMemoryBytes = Math.max(maximumMemoryBytes, JSON.stringify(memory).length);

      if (!resetApplied && world.moveEffects.length > 0) {
        memory = JSON.parse(JSON.stringify(memory)) as Memory;
        vi.resetModules();
        executeTick = (await import("../src/runtime/tick")).runTick;
        world.setReverseCollections(true);
        resetApplied = true;
        reordered = true;
      }

      if (deathTick === null && world.roomEnergyCapacity >= 400 && world.controllerProgress > 0) {
        for (const { id } of world.actorStates) killedActorIds.add(id);
        world.killAllWorkers();
        deathTick = tick;
      }

      if (
        deathTick !== null &&
        replacementUsefulWork &&
        world.roomEnergyCapacity >= 400 &&
        world.controllerProgress > 0
      )
        break;
    }
    maximumMemoryBytes = Math.max(maximumMemoryBytes, JSON.stringify(memory).length);

    if (world.roomEnergyCapacity < 400 || world.controllerProgress <= 0 || !replacementUsefulWork) {
      throw new Error(
        JSON.stringify({
          actors: world.actorStates,
          buildEffects: world.buildEffects.length,
          capacity: world.roomEnergyCapacity,
          controllerProgress: world.controllerProgress,
          deathTick,
          extensions: world.extensionCount,
          lastColony,
          lastMode,
          moveEffects: world.moveEffects.length,
          pathSearchCalls: world.pathSearchCalls,
          replacementUsefulWork,
          siteCalls: world.constructionSiteCalls.length,
          sites: world.siteCount,
          spawnCalls: world.spawnCalls.length,
        }),
      );
    }

    expect(new Set(initialEntityPositions).size).toBe(initialEntityPositions.length);
    const extensionSiteCalls = world.constructionSiteCalls.filter(
      ({ structureType }) => structureType === "extension",
    );
    const extensionSiteKeys = extensionSiteCalls.map(({ x, y }) => `${String(x)}:${String(y)}`);
    expect(extensionSiteCalls.filter(({ code }) => code === 0).length).toBeGreaterThanOrEqual(2);
    expect(new Set(extensionSiteKeys).size).toBe(extensionSiteCalls.length);
    expect(extensionSiteKeys.every((key) => !initialEntityPositions.includes(key))).toBe(true);
    expect(extensionSiteExecutions).toBeGreaterThanOrEqual(2);

    expect(firstExecutedMove).not.toBeNull();
    const appliedMove = world.moveEffects.find(
      ({ actorId, tick }) =>
        actorId === firstExecutedMove?.actorId && tick === firstExecutedMove.tick,
    );
    expect(appliedMove).toMatchObject({ visibleAt: (firstExecutedMove?.tick ?? 0) + 1 });
    expect(appliedMove?.to).not.toEqual(appliedMove?.from);
    expect(world.moveEffects.length).toBeGreaterThan(1);
    expect(world.pathSearchCalls).toBeGreaterThan(0);
    expect(world.pathUnavailableSearches).toBeGreaterThan(0);

    expect(
      world.buildEffects.some(
        ({ progressAfter, targetId }) =>
          targetId.startsWith("site-extension-") && progressAfter > 0,
      ),
    ).toBe(true);
    expect(world.extensionCount).toBeGreaterThanOrEqual(2);
    expect(world.roomEnergyCapacity).toBeGreaterThanOrEqual(400);
    expect(world.controllerProgress).toBeGreaterThan(0);
    expect(world.spawnCalls.length).toBeGreaterThan(0);
    expect(provisionalSpawnRevocations).toBe(0);
    expect(replacementUsefulWork).toBe(true);
    expect(constrainedTicks).toBeGreaterThan(0);
    expect(resetApplied).toBe(true);
    expect(reordered).toBe(true);
    expect(maximumMemoryBytes).toBeLessThanOrEqual(MAXIMUM_MEMORY_BYTES);
    expect(kernelFaults).toEqual([]);
  }, 120_000);
});
