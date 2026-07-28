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
  }, 60_000);

  it("regenerates a terminal transfer after endpoint recovery and delivers after reset", async () => {
    const world = survivalWorld({
      initialSpawnEnergy: 100,
      initialWorkerEnergy: 50,
      simulateTransientSinkFailure: false,
    });
    const issuer = "economy/W1N1/transfer/spawn-1";
    let memory = {} as Memory;
    let executeTick = runTick;

    const first = executeTick({
      game: world.game(START_TICK),
      localPathSearch: world.pathSearch,
      memory,
    });
    world.assertEnergyConserved();
    const firstRecord = contractOwner(memory).active.find((contract) => contract.issuer === issuer);
    expect(firstRecord).toMatchObject({ issuerSequence: 1, state: "proposed" });
    expect(first.contracts?.submissions).toContainEqual(
      expect.objectContaining({ accepted: true, outcome: "created" }),
    );

    world.setSpawnVisible(false);
    const retired = executeTick({
      game: world.game(START_TICK + 1),
      localPathSearch: world.pathSearch,
      memory,
    });
    world.assertEnergyConserved();
    expect(retired.contracts?.transitions).toContainEqual(
      expect.objectContaining({
        accepted: true,
        contractId: firstRecord?.id,
        to: "cancelled",
      }),
    );
    expect(contractOwner(memory)).toMatchObject({
      active: [],
      issuerFrontiers: [{ issuer, retiredThrough: 1 }],
    });
    expect(world.firstDeliveryAt).toBeNull();
    expect(world.workerEnergy).toBe(50);

    world.setSpawnVisible(true);
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;

    const recovery: TickOutcome[] = [];
    let sawSuccessor = false;
    let maximumActiveTransfers = 0;
    for (let tick = START_TICK + 2; tick <= START_TICK + 30; tick += 1) {
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      recovery.push(outcome);
      world.assertEnergyConserved();
      const activeTransfers = contractOwner(memory).active.filter(
        (contract) => contract.issuer === issuer,
      );
      maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers.length);
      sawSuccessor ||= activeTransfers.some(({ issuerSequence }) => issuerSequence === 2);
      if (world.firstDeliveryAt !== null) break;
    }

    expect(sawSuccessor).toBe(true);
    expect(maximumActiveTransfers).toBe(1);
    expect(
      recovery
        .flatMap(({ contracts }) => contracts?.submissions ?? [])
        .some((submission) => submission.accepted && submission.outcome === "duplicate-terminal"),
    ).toBe(false);
    expect(
      recovery
        .flatMap(({ contracts }) => contracts?.submissions ?? [])
        .some((submission) => submission.accepted && submission.outcome === "created"),
    ).toBe(true);
    expect(world.firstDeliveryAt).not.toBeNull();
    expect(world.cargoAtFirstDelivery).toBe(50);
    expect(world.workerEnergy).toBe(0);
    expect(world.spawnEnergy).toBe(150);
  }, 60_000);

  it("funds carried-energy RCL1 controller risk at the protected spawn floor", async () => {
    const world = survivalWorld({
      controllerInitialProgress: 196,
      controllerPosition: { roomName: "W1N1", x: 17, y: 10 },
      controllerTicksToDowngrade: 3_000,
      initialWorkerEnergy: 4,
    });
    let memory = {} as Memory;
    vi.resetModules();
    let executeTick = (await import("../src/runtime/tick")).runTick;
    let resetAt: number | null = null;
    let maximumControllerContracts = 0;
    let maximumControllerLeases = 0;
    let sawCargoDeferral = false;
    let sawTravelUnknown = false;
    const outcomes: TickOutcome[] = [];

    world.setCpuBucket(4_000);
    world.setPathUnavailable(true);
    for (let tick = START_TICK; tick <= START_TICK + 99; tick += 1) {
      if (tick === START_TICK + 3) world.setCpuBucket(10_000);
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      outcomes.push(outcome);
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);

      const activeContracts = (
        memory.myrmex?.contracts as
          { readonly active?: readonly { readonly issuer?: string }[] } | undefined
      )?.active;
      maximumControllerContracts = Math.max(
        maximumControllerContracts,
        (activeContracts ?? []).filter(
          ({ issuer }) => issuer === "growth/W1N1/upgrade-controller/controller-1",
        ).length,
      );
      maximumControllerLeases = Math.max(
        maximumControllerLeases,
        outcome.contractExecution.leases.filter(({ targetId }) => targetId === "controller-1")
          .length,
      );

      const deferredReasons =
        outcome.contracts?.allocation.deferred.map(({ reason }) => reason) ?? [];
      if (!sawTravelUnknown && deferredReasons.includes("travel-unknown")) {
        sawTravelUnknown = true;
        world.setPathUnavailable(false);
        world.setWorkerEnergy(0);
      } else if (
        sawTravelUnknown &&
        (deferredReasons.includes("no-viable-actor") || deferredReasons.includes("no-actor"))
      ) {
        sawCargoDeferral = true;
        world.setWorkerEnergy(4);
      }

      if (
        resetAt === null &&
        outcome.contractExecution.leases.some(({ targetId }) => targetId === "controller-1")
      ) {
        resetAt = tick;
        memory = JSON.parse(JSON.stringify(memory)) as Memory;
        vi.resetModules();
        executeTick = (await import("../src/runtime/tick")).runTick;
        world.reverseSources = true;
      }
      if (world.controllerLevel >= 2) break;
    }

    const controllerReservations = outcomes
      .flatMap(({ colony }) => colony.reservations)
      .filter(({ issuer }) => issuer === "growth/W1N1/upgrade-controller/controller-1");
    expect(
      controllerReservations.some(
        ({ category, grant, request, status }) =>
          category === "controller-risk" &&
          grant.energy === 0 &&
          request.energy === null &&
          status === "active",
      ),
    ).toBe(true);
    expect(controllerReservations).toContainEqual(
      expect.objectContaining({ category: "bootstrap-controller", status: "active" }),
    );
    expect(
      outcomes.every(({ colony }) => {
        const activeCategories = new Set(
          colony.reservations
            .filter(
              ({ issuer, status }) =>
                issuer === "growth/W1N1/upgrade-controller/controller-1" && status === "active",
            )
            .map(({ category }) => category),
        );
        return activeCategories.size <= 1;
      }),
    ).toBe(true);
    const replacements = outcomes.flatMap(({ contracts }) => contracts?.replacements ?? []);
    expect(replacements).toContainEqual(expect.objectContaining({ accepted: true }));
    expect(replacements.every(({ accepted }) => accepted)).toBe(true);
    expect(maximumControllerContracts).toBe(1);
    expect(maximumControllerLeases).toBe(1);
    expect(world.constrainedCpuObservations).toBeGreaterThanOrEqual(3);
    expect(world.pathUnavailableObservations).toBeGreaterThan(0);
    expect(sawTravelUnknown).toBe(true);
    expect(sawCargoDeferral).toBe(true);
    expect(resetAt).not.toBeNull();
    expect(world.moveCalls).toBeGreaterThan(0);
    expect(world.controllerUpgradeCalls).toBe(4);
    expect(world.controllerLevel).toBe(2);
    expect(world.spawnEnergy).toBe(300);
    expect(world.spawnCalls).toEqual([]);
  }, 60_000);

  it("spends a full RCL1 worker cargo at the controller before harvesting again", () => {
    const world = survivalWorld({
      controllerInitialProgress: 150,
      controllerPosition: { roomName: "W1N1", x: 13, y: 10 },
      initialWorkerEnergy: 50,
    });
    const memory = {} as Memory;
    const outcomes: TickOutcome[] = [];
    const controllerContractIds = new Set<string>();
    let firstUpgradeOutcome = -1;

    for (let tick = START_TICK; tick <= START_TICK + 199; tick += 1) {
      const outcome = runTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      outcomes.push(outcome);
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);
      for (const lease of outcome.contractExecution.leases) {
        if (lease.targetId === "controller-1") controllerContractIds.add(lease.contractId);
      }
      if (
        firstUpgradeOutcome < 0 &&
        outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && intent.kind === "upgrade-controller",
        )
      )
        firstUpgradeOutcome = outcomes.length - 1;
      if (world.controllerLevel >= 2) break;
    }

    expect(firstUpgradeOutcome).toBeGreaterThanOrEqual(0);
    expect(world.controllerLevel).toBe(2);
    expect(world.controllerUpgradeCalls).toBe(50);
    expect(world.workerEnergy).toBe(0);
    expect(world.sourceAEnergy).toBe(50);
    expect(world.sourceBHarvested).toBe(0);
    expect(
      outcomes
        .slice(firstUpgradeOutcome)
        .flatMap(({ movement }) => movement.actionExecution)
        .some(
          ({ intent, status }) =>
            status === "executed" && (intent.kind === "harvest" || intent.kind === "pickup"),
        ),
    ).toBe(false);
    expect(
      outcomes
        .slice(firstUpgradeOutcome)
        .flatMap(({ contracts }) => contracts?.releases ?? [])
        .some(
          ({ contractId, reason }) =>
            controllerContractIds.has(contractId) && reason === "allocator-unassigned",
        ),
    ).toBe(false);
  }, 60_000);

  it("finishes RCL1 acquisition before controller risk and then consumes the full cargo", () => {
    const world = survivalWorld({
      controllerInitialProgress: 150,
      controllerPosition: { roomName: "W1N1", x: 17, y: 10 },
      controllerTicksToDowngrade: 3_000,
      initialWorkerEnergy: 1,
      simulateTransientSinkFailure: false,
    });
    world.setWorkerEnergy(0);
    const memory = {} as Memory;
    let firstUpgradeEnergy: number | null = null;
    let harvestedAfterUpgrade = false;
    let maximumEnergyBeforeUpgrade = 0;

    for (let tick = START_TICK; tick <= START_TICK + 249; tick += 1) {
      const energyBefore = world.workerEnergy;
      const outcome = runTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);
      maximumEnergyBeforeUpgrade = Math.max(maximumEnergyBeforeUpgrade, world.workerEnergy);

      const executedActions = outcome.movement.actionExecution
        .filter(({ status }) => status === "executed")
        .map(({ intent }) => intent.kind);
      if (executedActions.includes("upgrade-controller")) {
        firstUpgradeEnergy ??= energyBefore;
      } else if (
        firstUpgradeEnergy !== null &&
        (executedActions.includes("harvest") || executedActions.includes("pickup"))
      ) {
        harvestedAfterUpgrade = true;
      }

      if (firstUpgradeEnergy !== null && world.workerEnergy === 0) break;
    }

    expect(world.firstHarvestAt).not.toBeNull();
    expect(maximumEnergyBeforeUpgrade).toBe(50);
    expect(firstUpgradeEnergy).toBe(50);
    expect(harvestedAfterUpgrade).toBe(false);
    expect(world.controllerUpgradeCalls).toBe(50);
    expect(world.workerEnergy).toBe(0);
    expect(world.controllerLevel).toBe(2);
  }, 60_000);

  it("leases distant RCL1 controller work after CPU and route recovery without deadline churn", async () => {
    const world = survivalWorld({
      controllerInitialProgress: 196,
      controllerPosition: { roomName: "W1N1", x: 47, y: 47 },
      initialWorkerEnergy: 50,
    });
    let memory = {} as Memory;
    let executeTick = runTick;
    let resetAt: number | null = null;
    let maximumBootstrapContracts = 0;
    let sawDeadlineInfeasible = false;
    let sawTravelUnknown = false;
    const assignments: NonNullable<
      TickOutcome["contracts"]
    >["allocation"]["assignments"][number][] = [];
    const releases: NonNullable<TickOutcome["contracts"]>["releases"][number][] = [];
    const controllerContractIds = new Set<string>();

    world.setCpuBucket(4_000);
    world.setPathUnavailable(true);
    for (let tick = START_TICK; tick <= START_TICK + 249; tick += 1) {
      if (tick === START_TICK + 3) world.setCpuBucket(10_000);
      const outcome = executeTick({
        game: world.game(tick),
        localPathSearch: world.pathSearch,
        memory,
      });
      world.assertEnergyConserved();
      assertSingleTickAuthorities(outcome, world.workerId);
      assignments.push(...(outcome.contracts?.allocation.assignments ?? []));
      releases.push(...(outcome.contracts?.releases ?? []));
      for (const lease of outcome.contractExecution.leases) {
        if (lease.targetId === "controller-1") controllerContractIds.add(lease.contractId);
      }
      const contractsOwner = memory.myrmex?.contracts as
        { readonly active?: readonly { readonly issuer?: string }[] } | undefined;
      maximumBootstrapContracts = Math.max(
        maximumBootstrapContracts,
        (contractsOwner?.active ?? []).filter(
          ({ issuer }) => issuer === "growth/W1N1/upgrade-controller/controller-1",
        ).length,
      );
      sawDeadlineInfeasible ||=
        outcome.contracts?.allocation.deferred.some(
          ({ reason }) => reason === "deadline-infeasible",
        ) ?? false;
      const travelUnknown =
        outcome.contracts?.allocation.deferred.some(({ reason }) => reason === "travel-unknown") ??
        false;
      if (travelUnknown) {
        sawTravelUnknown = true;
        world.setPathUnavailable(false);
      }

      const distantAssignment = outcome.contracts?.allocation.assignments.find(
        ({ travelTicks }) => travelTicks >= 40,
      );
      if (distantAssignment !== undefined && resetAt === null) {
        resetAt = tick;
        memory = JSON.parse(JSON.stringify(memory)) as Memory;
        vi.resetModules();
        executeTick = (await import("../src/runtime/tick")).runTick;
        world.reverseSources = true;
      }
      if (world.controllerLevel >= 2) break;
    }

    expect(world.constrainedCpuObservations).toBeGreaterThanOrEqual(3);
    expect(world.pathUnavailableObservations).toBeGreaterThan(0);
    expect(sawTravelUnknown).toBe(true);
    expect(sawDeadlineInfeasible).toBe(false);
    expect(maximumBootstrapContracts).toBe(1);
    expect(
      assignments.some(
        ({ contractId, travelTicks }) => controllerContractIds.has(contractId) && travelTicks >= 40,
      ),
    ).toBe(true);
    expect(releases.some(({ reason }) => reason === "deadline-infeasible")).toBe(false);
    expect(resetAt).not.toBeNull();
    expect(world.moveCalls).toBeGreaterThan(0);
    expect(world.controllerUpgradeCalls).toBe(4);
    expect(world.controllerLevel).toBe(2);
    expect(world.spawnEnergy).toBe(300);
    expect(world.spawnCalls).toEqual([]);
  }, 60_000);
});

function contractOwner(memory: Memory): {
  readonly active: readonly {
    readonly id: string;
    readonly issuer: string;
    readonly issuerSequence: number;
    readonly state: string;
  }[];
  readonly issuerFrontiers: readonly {
    readonly issuer: string;
    readonly retiredThrough: number;
  }[];
} {
  const owner = memory.myrmex?.contracts as
    | {
        readonly active?: readonly {
          readonly id?: string;
          readonly issuer?: string;
          readonly issuerSequence?: number;
          readonly state?: string;
        }[];
        readonly issuerFrontiers?: readonly {
          readonly issuer?: string;
          readonly retiredThrough?: number;
        }[];
      }
    | undefined;
  return {
    active: (owner?.active ?? []).flatMap((contract) =>
      typeof contract.id === "string" &&
      typeof contract.issuer === "string" &&
      typeof contract.issuerSequence === "number" &&
      typeof contract.state === "string"
        ? [
            {
              id: contract.id,
              issuer: contract.issuer,
              issuerSequence: contract.issuerSequence,
              state: contract.state,
            },
          ]
        : [],
    ),
    issuerFrontiers: (owner?.issuerFrontiers ?? []).flatMap((frontier) =>
      typeof frontier.issuer === "string" && typeof frontier.retiredThrough === "number"
        ? [{ issuer: frontier.issuer, retiredThrough: frontier.retiredThrough }]
        : [],
    ),
  };
}
