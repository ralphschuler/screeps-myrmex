import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick, type TickOutcome } from "../src/runtime/tick";
import { assertSingleTickAuthorities, survivalWorld } from "./support/survival-flow-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;
const LAST_TICK = START_TICK + 1_499;
const MAX_CPU_PER_DELIVERED_ENERGY = 1;

describe("survival-flow runtime recovery", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("recovers a zero-creep RCL1 room through bounded movement, batched harvest, and delivery", async () => {
    const world = survivalWorld();
    let memory = {} as Memory;
    let executeTick = runTick;
    let memoryResetAt: number | null = null;
    let sourcesReversed = false;
    const outcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];

    for (let tick = START_TICK; tick <= LAST_TICK; tick += 1) {
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      outcomes.push({ outcome, tick });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);

      if (memoryResetAt === null && world.workerEnergy >= 10 && world.firstHarvestAt !== null) {
        memory = JSON.parse(JSON.stringify(memory)) as Memory;
        vi.resetModules();
        executeTick = (await import("../src/runtime/tick")).runTick;
        world.reverseSources = true;
        sourcesReversed = true;
        memoryResetAt = tick;
      }

      if (world.controllerLevel >= 2) break;
    }

    expect(world.spawnCalls).toEqual([
      expect.objectContaining({
        body: ["work", "carry", "move"],
        cost: 200,
        tick: START_TICK,
      }),
    ]);
    expect(world.workerVisibleAt).not.toBeNull();
    expect(world.workerVisibleAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 10);
    expect(world.firstHarvestAt).not.toBeNull();
    expect(world.firstHarvestAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 30);
    expect(world.firstDeliveryAt).not.toBeNull();
    expect(world.firstDeliveryAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(START_TICK + 120);

    expect(world.firstHarvestTargetId).toBe("source-a");
    expect(world.cargoAtFirstDelivery).toBe(50);
    expect(world.sourceAEnergy).toBe(0);
    expect(world.sourceBHarvested).toBeGreaterThanOrEqual(50);
    expect(world.sourceBDelivered).toBeGreaterThanOrEqual(50);
    expect(world.spawnEnergy).toBeGreaterThanOrEqual(200);
    expect(world.spawnEnergy).toBe(300);
    expect(world.controllerLevel).toBe(2);
    expect(world.controllerUpgradeCalls).toBeGreaterThan(0);
    expect(world.fullSinkObservations).toBeGreaterThan(0);
    expect(world.fatiguedObservations).toBeGreaterThan(0);
    expect(world.sinkVanishedAt).not.toBeNull();
    expect(world.sinkResolverMisses).toBeGreaterThan(0);
    expect(world.moveCalls).toBeGreaterThan(0);
    expect(world.pathSearchCalls).toBeGreaterThan(0);
    expect(memoryResetAt).not.toBeNull();
    expect(sourcesReversed).toBe(true);
    const sourceAContractId = outcomes
      .flatMap(({ outcome }) => outcome.contractExecution.leases)
      .find(({ targetId }) => targetId === "source-a")?.contractId;
    expect(sourceAContractId).toBeDefined();
    expect(
      outcomes.some(({ outcome }) =>
        outcome.contracts?.transitions.some(
          (transition) =>
            transition.accepted &&
            transition.contractId === sourceAContractId &&
            transition.to === "cancelled",
        ),
      ),
    ).toBe(true);

    const postResetActions = outcomes
      .filter(({ tick }) => memoryResetAt !== null && tick > memoryResetAt)
      .flatMap(({ outcome }) => outcome.movement.actionExecution)
      .filter(({ status }) => status === "executed");
    expect(postResetActions.length).toBeGreaterThan(0);
    expect(
      postResetActions.some(
        ({ intent }) => intent.kind === "harvest" && intent.targetId === "source-b",
      ),
    ).toBe(true);

    const deliveredEnergy = outcomes.reduce(
      (total, { outcome }) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
      0,
    );
    const recoveryCpu = outcomes.reduce((total, { outcome }) => total + outcome.kernel.cpuUsed, 0);
    expect(deliveredEnergy).toBeGreaterThanOrEqual(100);
    expect(recoveryCpu).toBeGreaterThan(0);
    expect(recoveryCpu / deliveredEnergy).toBeLessThanOrEqual(MAX_CPU_PER_DELIVERED_ENERGY);

    const last = outcomes[outcomes.length - 1];
    const liveContractId = [...outcomes]
      .reverse()
      .flatMap(({ outcome }) => outcome.contractExecution.leases)
      .find(({ actorId }) => actorId === world.workerId)?.contractId;
    expect(last).toBeDefined();
    expect(liveContractId).toBeDefined();
    if (last === undefined || liveContractId === undefined)
      throw new Error("expected one live worker contract before death");

    const deliveredBeforeDeath = world.sourceBDelivered;
    world.killWorker();
    const afterDeath = executeTick({
      game: world.game(last.tick + 1),
      localPathSearch: world.pathSearch,
      memory,
    });
    expect(afterDeath.contracts?.transitions).toContainEqual(
      expect.objectContaining({ contractId: liveContractId, to: "cancelled" }),
    );
    expect(afterDeath.contracts?.allocation.assignments).toEqual([]);
    expect(world.spawnCalls).toHaveLength(2);
    expect(world.spawnCalls[1]).toMatchObject({
      body: ["work", "carry", "move"],
      cost: 200,
      tick: last.tick + 1,
    });
    expect(afterDeath.spawn.execution).toEqual([expect.objectContaining({ status: "scheduled" })]);
    world.assertEnergyConserved();

    const replacementOutcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];
    for (let tick = last.tick + 2; tick <= last.tick + 122; tick += 1) {
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      replacementOutcomes.push({ outcome, tick });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);
      if (world.sourceBDelivered > deliveredBeforeDeath) break;
    }
    expect(world.sourceBDelivered).toBeGreaterThan(deliveredBeforeDeath);
    expect(
      replacementOutcomes
        .flatMap(({ outcome }) => outcome.movement.actionExecution)
        .some(
          ({ intent, status }) =>
            status === "executed" && intent.kind === "harvest" && intent.targetId === "source-b",
        ),
    ).toBe(true);
    expect(
      replacementOutcomes
        .flatMap(({ outcome }) => outcome.movement.actionExecution)
        .some(({ intent, status }) => status === "executed" && intent.kind === "transfer"),
    ).toBe(true);
  }, 15_000);
});
