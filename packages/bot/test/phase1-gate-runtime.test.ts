import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;
const MAX_TICKS = 150;

describe("Phase 1 gate established RCL2 row", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("refills RCL2 capacity, advances the observed road site, and preserves reserve", () => {
    const world = establishedRcl2World();
    const memory = {} as Memory;
    const outcomes = [] as ReturnType<typeof runTick>[];

    for (let tick = START_TICK; tick < START_TICK + MAX_TICKS; tick += 1) {
      const outcome = runTick({ game: world.game(tick), memory });
      outcomes.push(outcome);
      expect(world.spawnEnergy()).toBe(300);
      if (world.roomEnergy() === 400 && world.siteProgress() > 0) break;
    }

    expect(world.extensionEnergy()).toBe(100);
    expect(world.roomEnergy()).toBe(400);
    expect(world.spawnEnergy()).toBe(300);
    expect(world.siteProgress()).toBeGreaterThan(0);
    expect(world.constructionSiteCalls()).toBe(0);
    expect(world.siteCount()).toBe(1);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && intent.kind === "transfer",
        ),
      ),
    ).toBe(true);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) =>
            status === "executed" && intent.kind === "build" && intent.targetId === "road-site",
        ),
      ),
    ).toBe(true);
    expect(
      outcomes.some((outcome) =>
        outcome.colony.reservations.some(
          ({ category, status }) =>
            status === "active" && ["optional-growth", "critical-maintenance"].includes(category),
        ),
      ),
    ).toBe(true);
  });
});
