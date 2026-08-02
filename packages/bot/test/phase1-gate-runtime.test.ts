import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContractLedger } from "../src/contracts";
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

  it("builds the first RCL2 extension from carried energy while preserving the spawn reserve", async () => {
    const world = establishedRcl2World({
      constructionSite: {
        controllerLevel: 2,
        id: "first-extension-site",
        initialProgress: 45,
        pos: { x: 10, y: 11 },
        progressTotal: 50,
        structureType: "extension",
        workerBody: ["work", "carry", "move"],
        workerEnergy: 50,
        workerPos: { x: 11, y: 10 },
      },
      initialExtensionCount: 0,
    });
    let memory = {} as Memory;
    const outcomes = [runTick({ game: world.game(START_TICK), memory })];
    const config = memory.myrmex?.config as unknown as { candidate: unknown } | undefined;
    if (config === undefined) throw new Error("expected initialized config owner");
    // Keep this regression on the existing-site growth path; #476 owns layout-to-movement proof.
    config.candidate = {
      revision: 1,
      overrides: { features: { disabled: ["phase2.layout"] } },
    };
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    const executeTick = (await import("../src/runtime/tick")).runTick;

    for (let tick = START_TICK + 1; tick < START_TICK + 30 && world.siteCount() > 0; tick += 1) {
      outcomes.push(executeTick({ game: world.game(tick), memory }));
      expect(world.spawnEnergy()).toBe(300);
    }

    expect(world.buildCalls()).toEqual([
      expect.objectContaining({ energy: 5, targetId: "first-extension-site" }),
    ]);
    expect(world.siteCount()).toBe(0);
    expect(world.roomEnergyCapacity()).toBe(350);
    expect(world.spawnEnergy()).toBe(300);
    expect(
      outcomes
        .flatMap(({ colony }) => colony.reservations)
        .find(({ issuer }) => issuer === "growth/W1N1/rcl2-bootstrap/build/first-extension-site"),
    ).toMatchObject({
      category: "optional-growth",
      grant: { energy: 0 },
      reasonCode: "granted",
      status: "active",
    });
    expect(
      outcomes
        .flatMap(({ movement }) => movement.actionExecution)
        .some(
          ({ intent, status }) =>
            intent.kind === "build" &&
            intent.targetId === "first-extension-site" &&
            status === "executed",
        ),
    ).toBe(true);
    expect(outcomes.flatMap(({ kernel }) => kernel.faults)).toEqual([]);
  });

  it("keeps spawn-only RCL2 harvesting while its first static miner is unaffordable", () => {
    const world = establishedRcl2World({
      constructionSite: {
        controllerLevel: 2,
        id: "first-extension-site",
        initialProgress: 0,
        pos: { x: 10, y: 11 },
        progressTotal: 50,
        structureType: "extension",
        workerBody: ["work", "carry", "move"],
        workerEnergy: 0,
        workerPos: { x: 11, y: 10 },
      },
      initialExtensionCount: 0,
      reverseCollections: true,
    });
    world.killStaticMiner();
    const memory = {} as Memory;
    const outcomes = [] as ReturnType<typeof runTick>[];

    for (
      let tick = START_TICK;
      tick < START_TICK + 40 && (world.workerHarvestCalls() === 0 || world.siteProgress() === 0);
      tick += 1
    ) {
      outcomes.push(runTick({ game: world.game(tick), memory }));
      expect(world.spawnEnergy()).toBe(300);
    }

    const contracts = openedContractLedger(memory).view();
    expect(world.workerHarvestCalls()).toBeGreaterThan(0);
    expect(world.siteProgress()).toBeGreaterThan(0);
    expect(world.roomEnergyCapacity()).toBe(300);
    expect(contracts.active).toContainEqual(
      expect.objectContaining({
        issuer: "mining/W1N1/source-a",
        lease: null,
        state: "funded",
      }),
    );
    expect(
      outcomes.some(({ movement }) =>
        movement.actionExecution.some(
          ({ intent, status }) =>
            intent.kind === "harvest" && intent.targetId === "source-a" && status === "executed",
        ),
      ),
    ).toBe(true);
    expect(outcomes.flatMap(({ kernel }) => kernel.faults)).toEqual([]);
  });

  it("restores survival harvesting under constrained CPU after static-miner loss", async () => {
    const world = establishedRcl2World({
      constructionSite: {
        controllerLevel: 2,
        id: "road-site",
        initialProgress: 0,
        pos: { x: 10, y: 11 },
        progressTotal: 100,
        structureType: "road",
        workerBody: ["work", "carry", "move"],
        workerEnergy: 0,
        workerPos: { x: 11, y: 10 },
      },
    });
    let memory = {} as Memory;
    let nextTick = START_TICK;
    const takeover = [] as ReturnType<typeof runTick>[];
    const contractState = (prefix: string): string | undefined => {
      return openedContractLedger(memory)
        .view()
        .active.find(({ issuer }) => issuer.startsWith(prefix))?.state;
    };

    for (; nextTick < START_TICK + 30; nextTick += 1) {
      takeover.push(runTick({ game: world.game(nextTick), memory }));
      if (
        ["assigned", "active"].includes(contractState("mining/W1N1/source-a") ?? "") &&
        contractState("economy/W1N1/harvest/source-a") === "suspended"
      ) {
        nextTick += 1;
        break;
      }
    }

    expect(["assigned", "active"]).toContain(contractState("mining/W1N1/source-a"));
    expect(contractState("economy/W1N1/harvest/source-a")).toBe("suspended");
    expect(
      takeover.every(
        ({ movement }) =>
          movement.actionExecution.filter(
            ({ intent, status }) =>
              intent.kind === "harvest" && intent.targetId === "source-a" && status === "executed",
          ).length <= 1,
      ),
    ).toBe(true);
    world.killStaticMiner();
    world.clearDroppedEnergy();
    world.setCpuBucket(4_000);
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    const executeTick = (await import("../src/runtime/tick")).runTick;
    const harvestsBeforeLoss = world.workerHarvestCalls();
    const constrained = [] as ReturnType<typeof runTick>[];

    for (
      ;
      nextTick < START_TICK + 40 && world.workerHarvestCalls() === harvestsBeforeLoss;
      nextTick += 1
    )
      constrained.push(executeTick({ game: world.game(nextTick), memory }));

    expect(constrained).not.toHaveLength(0);
    expect(constrained.every(({ kernel }) => kernel.mode === "constrained")).toBe(true);
    expect(
      constrained.every(({ kernel }) =>
        kernel.systems.some(
          ({ status, systemId }) => systemId === "economy.contracts" && status === "completed",
        ),
      ),
    ).toBe(true);
    expect(world.workerHarvestCalls()).toBeGreaterThan(harvestsBeforeLoss);
    expect(["assigned", "active"]).toContain(contractState("economy/W1N1/harvest/source-a"));
    expect(
      constrained.every(
        ({ movement }) =>
          movement.actionExecution.filter(
            ({ intent, status }) =>
              intent.kind === "harvest" && intent.targetId === "source-a" && status === "executed",
          ).length <= 1,
      ),
    ).toBe(true);
  });

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

function openedContractLedger(memory: Memory): ContractLedger {
  const opened = ContractLedger.open(memory.myrmex?.contracts ?? {});
  expect(opened.status).toBe("ready");
  if (opened.status !== "ready") throw new Error("expected valid contracts owner");
  return opened.ledger;
}
