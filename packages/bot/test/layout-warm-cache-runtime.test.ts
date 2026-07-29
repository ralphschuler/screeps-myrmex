import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnOnlyRcl2World } from "./support/spawn-only-rcl2-fixture";

const START_TICK = 10_000;
const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("warm layout runtime cache", () => {
  afterEach(() => {
    vi.doUnmock("../src/layout");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("reuses stable compiled placements and replans after observed layout facts change", async () => {
    vi.resetModules();
    const layout = await import("../src/layout");
    const planOwnedRoomLayout = vi.fn(layout.planOwnedRoomLayout);
    vi.doMock("../src/layout", () => ({ ...layout, planOwnedRoomLayout }));
    const { runTick } = await import("../src/runtime/tick");
    const world = spawnOnlyRcl2World();
    world.setForeignRampartPublic(true);
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
    vi.stubGlobal("RoomPosition", world.globals.RoomPosition);
    vi.stubGlobal("PathFinder", world.globals.PathFinder);

    const memory = {} as Memory;
    let tick = START_TICK;
    for (; tick < START_TICK + 100 && world.siteCount === 0; tick += 1) {
      runTick({ game: world.game(tick), memory });
    }
    expect(world.siteCount).toBeGreaterThan(0);

    for (let index = 0; index < 5; index += 1, tick += 1) {
      runTick({ game: world.game(tick), memory });
    }
    const stablePlanningCalls = planOwnedRoomLayout.mock.calls.length;
    world.setReverseCollections(true);

    for (let index = 0; index < 5; index += 1, tick += 1) {
      const outcome = runTick({ game: world.game(tick), memory });
      expect(outcome.kernel.faults).toEqual([]);
      expect(outcome.layout.planning).toEqual([
        expect.objectContaining({ roomName: "W1N1", status: "complete" }),
      ]);
    }

    expect(planOwnedRoomLayout).toHaveBeenCalledTimes(stablePlanningCalls);

    world.setForeignRampartPublic(false);
    runTick({ game: world.game(tick), memory });
    tick += 1;
    const rampartChangePlanningCalls = planOwnedRoomLayout.mock.calls.length;
    expect(rampartChangePlanningCalls).toBeGreaterThan(stablePlanningCalls);

    for (let index = 0; index < 200 && world.extensionCount === 0; index += 1, tick += 1) {
      runTick({ game: world.game(tick), memory });
    }
    expect(world.extensionCount).toBeGreaterThan(0);
    expect(planOwnedRoomLayout.mock.calls.length).toBeGreaterThan(rampartChangePlanningCalls);

    for (let index = 0; index < 3; index += 1, tick += 1) {
      runTick({ game: world.game(tick), memory });
    }
    const beforeEnergyChangePlanningCalls = planOwnedRoomLayout.mock.calls.length;
    world.setRoomEnergy(349);
    runTick({ game: world.game(tick), memory });
    expect(planOwnedRoomLayout).toHaveBeenCalledTimes(beforeEnergyChangePlanningCalls);
  }, 60_000);
});
