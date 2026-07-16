import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;
const MAX_TICKS = 150;
const REPLACEMENT_DEADLINE = 50;

describe("Phase 1 gate established RCL2 row", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("replaces its established worker once and resumes useful RCL2 work", () => {
    const world = establishedRcl2World();
    const memory = {} as Memory;
    const outcomes = [] as ReturnType<typeof runTick>[];
    let nextTick = START_TICK;

    for (; nextTick < START_TICK + MAX_TICKS; nextTick += 1) {
      const outcome = runTick({ game: world.game(nextTick), memory });
      outcomes.push(outcome);
      expect(world.spawnEnergy()).toBe(300);
      if (world.roomEnergy() === 400 && world.siteProgress() > 0) {
        nextTick += 1;
        break;
      }
    }

    expect(world.extensionEnergy()).toBe(100);
    expect(world.roomEnergy()).toBe(400);
    expect(world.spawnEnergy()).toBe(300);
    expect(world.siteProgress()).toBeGreaterThan(0);
    const deathTick = nextTick - 1;
    const progressBeforeDeath = world.siteProgress();
    world.killWorker();

    for (; nextTick < START_TICK + MAX_TICKS; nextTick += 1) {
      outcomes.push(runTick({ game: world.game(nextTick), memory }));
      if (
        world.replacementUsefulWorkAt() !== null &&
        world.roomEnergy() >= 300 &&
        world.siteProgress() >= progressBeforeDeath
      ) {
        break;
      }
    }

    expect(world.spawnCalls()).toHaveLength(1);
    expect(world.spawnCalls()[0]).toMatchObject({ body: ["work", "carry", "move"], cost: 200 });
    expect(world.replacementWorkerId()).not.toBeNull();
    expect(world.replacementWorkerId()).not.toBe("worker-a");
    expect(world.replacementVisibleAt()).not.toBeNull();
    expect(world.replacementUsefulWorkAt()).not.toBeNull();
    expect(world.replacementUsefulWorkAt() ?? Infinity).toBeLessThanOrEqual(
      deathTick + REPLACEMENT_DEADLINE,
    );
    expect(world.roomEnergy()).toBeGreaterThanOrEqual(300);
    expect(world.siteProgress()).toBeGreaterThanOrEqual(progressBeforeDeath);
    expect(world.constructionSiteCalls()).toBe(0);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && intent.kind === "pickup",
        ),
      ),
    ).toBe(true);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && intent.kind === "transfer",
        ),
      ),
    ).toBe(true);
  });
});
