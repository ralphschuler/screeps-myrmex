import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../src/cache";
import {
  ContractLedger,
  serializeContractLedgerState,
  workforceActorFromCreep,
  type ContractFundingView,
  type WorkContractRequest,
} from "../src/contracts";
import { FEATURE_GATE_IDS } from "../src/config";
import { planSurvivalFlow } from "../src/economy";
import { runTick } from "../src/runtime/tick";
import type { RuntimeGame } from "../src/runtime/context";
import { TICK_PHASES, type TickPhase } from "../src/runtime/phases";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("tick lifecycle", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });
  it("initializes the contracts owner through the single reconciliation commit", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });

    const initialized = runTick({ game: gameAt(40), memory });

    expect(initialized.contracts).toMatchObject({
      allocation: { assignments: [], deferred: [], safeIdle: [] },
      releases: [],
      submissions: [],
      transitions: [],
    });
    expect(initialized.contractExecution).toEqual({ leases: [], status: "ready" });
    expect(initialized.movement).toEqual({
      actionDecisions: [],
      actionExecution: [],
      actionSubmitted: 0,
      movementDecisions: [],
      movementExecution: [],
      movementSubmitted: 0,
      status: "executed",
    });
    expect(
      initialized.localPathPlanning.plan({
        availableCpu: 1,
        goal: { roomName: "W1N1", x: 10, y: 10 },
        origin: { roomName: "W1N1", x: 9, y: 10 },
        range: 1,
        snapshot: initialized.snapshot,
        tick: 40,
      }),
    ).toEqual({ reason: "unavailable", status: "no-path" });
    expect(initialized.kernel.systems).toContainEqual(
      expect.objectContaining({ systemId: "movement.arbitrate-execute", status: "completed" }),
    );
    expect(initialized.stateCommit).toEqual({
      committed: true,
      owners: ["config", "kernel", "colonies", "contracts"],
      revision: 1,
    });
    expect(memory.myrmex?.meta.schemaVersion).toBe(3);
    expect(memory.myrmex?.contracts).toEqual({
      active: [],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    });

    const stable = runTick({ game: gameAt(41), memory });
    expect(stable.stateCommit).toEqual({ committed: true, owners: ["kernel"], revision: 2 });
    expect(memory.myrmex?.contracts).toEqual({
      active: [],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    });
  });

  it.each([
    {
      label: "malformed",
      owner: { active: "not-an-array", issuerFrontiers: [], outcomes: [], schemaVersion: 1 },
    },
    {
      label: "future",
      owner: { opaque: { preserve: true }, schemaVersion: 2 },
    },
  ])("faults safely on $label contracts-owner data without overwriting it", ({ owner }) => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
    runTick({ game: gameAt(50), memory });
    if (memory.myrmex === undefined) {
      throw new Error("current memory was not initialized");
    }
    (memory.myrmex as unknown as { contracts: unknown }).contracts = owner;
    const before = JSON.stringify(memory.myrmex.contracts);

    const outcome = runTick({ game: gameAt(51), memory });

    expect(outcome.contracts).toBeNull();
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ stage: "run", systemId: "contracts.reconcile" }),
    ]);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", systemId: "contracts.reconcile" }),
        expect.objectContaining({ status: "completed", systemId: "state.reconcile" }),
        expect.objectContaining({ status: "completed", systemId: "telemetry.minimum" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({ committed: true, owners: ["kernel"] });
    expect(JSON.stringify(memory.myrmex.contracts)).toBe(before);
  });

  it("preserves the contracts owner when the gate is disabled or prerequisite-blocked", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
    runTick({ game: gameAt(60), memory });
    if (memory.myrmex === undefined) {
      throw new Error("current memory was not initialized");
    }
    const malformedOwner = { active: "preserve", outcomes: [], schemaVersion: 1 };
    const malformedBytes = JSON.stringify(malformedOwner);
    (memory.myrmex as unknown as { contracts: unknown }).contracts = malformedOwner;
    const configOwner = memory.myrmex.config as unknown as { candidate: unknown };
    configOwner.candidate = {
      revision: 1,
      overrides: { features: { disabled: ["phase1.contracts"] } },
    };

    const disabled = runTick({ game: gameAt(61), memory });
    expect(disabled.config.features.gates["phase1.contracts"]).toMatchObject({
      enabled: false,
      reason: "operator-disabled",
    });
    expect(disabled.contracts).toBeNull();
    expect(disabled.kernel.faults).toEqual([]);
    expect(JSON.stringify(memory.myrmex.contracts)).toBe(malformedBytes);

    const currentConfigOwner = memory.myrmex.config as unknown as { candidate: unknown };
    currentConfigOwner.candidate = {
      revision: 2,
      overrides: { features: { disabled: ["phase1.colony"] } },
    };
    const blocked = runTick({ game: gameAt(62), memory });
    expect(blocked.config.features.gates["phase1.contracts"]).toEqual({
      blockedBy: "phase1.colony",
      enabled: false,
      reason: "prerequisite-blocked",
    });
    expect(blocked.contracts).toBeNull();
    expect(blocked.kernel.faults).toEqual([]);
    expect(JSON.stringify(memory.myrmex.contracts)).toBe(malformedBytes);
  });

  it("settles the recovery spawn before contract funding and commits once", () => {
    const memory = {} as Memory;
    const spawnCreep = vi.fn(() => 0);
    const first = runTick({
      game: fundedContractGame(70, { includeCreep: false, spawnCreep }),
      memory,
    });
    const reservation = first.colony.reservations[0];
    expect(reservation).toMatchObject({
      category: "emergency-spawn",
      colonyId: "W1N1",
      consumed: { cpu: 100, energy: 200, spawn: true },
      grant: { cpu: 100, energy: 300 },
      issuer: "colony/W1N1/restore-workforce",
      reasonCode: "released",
      status: "released",
    });
    expect(first.spawn).toMatchObject({
      status: "planned",
      execution: [
        {
          status: "scheduled",
          reason: "scheduled",
          returnCode: 0,
          command: {
            body: ["work", "carry", "move"],
            colonyId: "W1N1",
            energyCost: 200,
            scheduledTick: 70,
            spawnId: "spawn-budget",
            spawnName: "Spawn1",
            spawnTicks: 9,
          },
        },
      ],
    });
    expect(first.stateCommit).toEqual({
      committed: true,
      owners: ["config", "kernel", "colonies", "contracts"],
      revision: 1,
    });
    const scheduledName = first.spawn.execution[0]?.command.name;
    expect(spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawnCreep).toHaveBeenCalledWith(["work", "carry", "move"], scheduledName);
    if (
      memory.myrmex === undefined ||
      reservation === undefined ||
      typeof scheduledName !== "string"
    ) {
      throw new Error("expected initialized runtime funding fixture");
    }

    const persistedAfterSchedule = JSON.stringify(memory);
    const presentMemory = JSON.parse(persistedAfterSchedule) as Memory;
    const presentSpawnCreep = vi.fn(() => 0);
    const observed = runTick({
      game: fundedContractGame(120, {
        creepName: scheduledName,
        includeCreep: true,
        legalCreep: true,
        spawnCreep: presentSpawnCreep,
      }),
      memory: presentMemory,
    });
    expect(presentSpawnCreep).not.toHaveBeenCalled();
    expect(observed.colony.objectives).toEqual([]);
    expect(observed.spawn.execution).toEqual([]);

    const damagedMemory = JSON.parse(persistedAfterSchedule) as Memory;
    const damagedSpawnCreep = vi.fn(() => 0);
    const damaged = runTick({
      game: fundedContractGame(80, {
        creepName: scheduledName,
        includeCreep: true,
        legalCreep: false,
        spawnCreep: damagedSpawnCreep,
      }),
      memory: damagedMemory,
    });
    expect(damagedSpawnCreep).not.toHaveBeenCalled();
    expect(damaged.spawn.execution).toEqual([]);
    expect(damaged.spawn.broker?.decisions).toEqual([
      expect.objectContaining({
        demandId: "colony/W1N1/restore-workforce",
        reason: "name-collision-exhausted",
        status: "deferred",
      }),
    ]);
    expect(damaged.colony.objectives).toEqual([
      expect.objectContaining({
        id: "colony/W1N1/restore-workforce",
        status: "blocked",
      }),
    ]);

    const absentMemory = JSON.parse(persistedAfterSchedule) as Memory;
    const absentSpawnCreep = vi.fn(() => 0);
    const retried = runTick({
      game: fundedContractGame(120, {
        includeCreep: false,
        spawnCreep: absentSpawnCreep,
      }),
      memory: absentMemory,
    });
    expect(absentSpawnCreep).toHaveBeenCalledTimes(1);
    expect(absentSpawnCreep).toHaveBeenCalledWith(["work", "carry", "move"], scheduledName);
    expect(retried.spawn.execution).toEqual([
      expect.objectContaining({ reason: "scheduled", status: "scheduled" }),
    ]);

    const opened = ContractLedger.open({});
    if (opened.status !== "ready") {
      throw new Error("expected an empty contract ledger");
    }
    const request = runtimeFundedRequest();
    const submitted = opened.ledger.submit(request, 70);
    if (!submitted.accepted) {
      throw new Error(`contract submission failed: ${submitted.reason}`);
    }
    const funding = fundingFromTick(first);
    const prepared = opened.ledger.reconcile({
      actors: [],
      funding,
      requests: [],
      tick: 70,
      transitions: [
        {
          contractId: submitted.contractId,
          reason: "budget-authorized",
          tick: 70,
          to: "funded",
        },
      ],
      travel: { estimate: () => 0 },
    });
    expect(prepared.transitions[0]).toMatchObject({
      accepted: false,
      reason: "funding-reservation-inactive",
    });
    expect(opened.ledger.view().active[0]?.state).toBe("proposed");
    (memory.myrmex as unknown as { contracts: unknown }).contracts = serializeContractLedgerState(
      opened.ledger.view(),
    );

    const next = runTick({
      game: fundedContractGame(71, { includeCreep: false }),
      memory,
    });
    expect(next.spawn.execution).toEqual([]);
    expect(next.spawn.broker?.decisions).toEqual([
      expect.objectContaining({
        demandId: "colony/W1N1/restore-workforce",
        reason: "expectation-pending",
        status: "deferred",
      }),
    ]);
    expect(next.contracts?.funding).toEqual([
      expect.objectContaining({
        contractId: submitted.contractId,
        reason: "reservation-inactive",
        status: "denied",
      }),
    ]);
    expect(next.contracts?.allocation.assignments).toEqual([]);
    expect(next.stateCommit).toMatchObject({ committed: true, revision: 2 });
    const systemIds = next.kernel.systems.map(({ systemId }) => systemId);
    expect(systemIds.indexOf("colony.director")).toBeLessThan(systemIds.indexOf("spawn.execute"));
    expect(systemIds.indexOf("spawn.execute")).toBeLessThan(systemIds.indexOf("spawn.settle"));
    expect(systemIds.indexOf("spawn.settle")).toBeLessThan(
      systemIds.indexOf("contracts.reconcile"),
    );
    expect(systemIds.indexOf("contracts.reconcile")).toBeLessThan(
      systemIds.indexOf("state.reconcile"),
    );
  });

  it("replays zero-creep recovery through harvest and positive spawn delivery", () => {
    const memory = {} as Memory;
    const world = economyGame();
    const cold = runTick({ game: world.game(200), memory });
    expect(cold.spawn.execution).toHaveLength(1);
    world.spawnEnergy = 100;

    world.workerPresent = true;
    runTick({ game: world.game(210), memory });
    const planned = runTick({ game: world.game(211), memory });
    expect(planned.config.features.gates["phase1.economy"].enabled).toBe(true);
    expect(planned.snapshot.rooms[0]?.sources).toHaveLength(1);
    expect(planned.snapshot.rooms[0]?.ownedCreeps).toHaveLength(1);
    expect(planSurvivalFlow(planned.snapshot)).toHaveLength(1);
    expect(planned.colony.reservations).toContainEqual(
      expect.objectContaining({ category: "harvesting-filling", status: "active" }),
    );
    const harvested = runTick({ game: world.game(212), memory });
    expect(harvested.kernel.systems).toContainEqual(
      expect.objectContaining({ systemId: "economy.contracts", status: "completed" }),
    );
    expect(world.workerEnergy).toBeGreaterThan(0);
    expect(harvested.telemetry?.energyFlow).toMatchObject({ harvested: 1 });

    // Simulate a heap reset: only serialized authorities may carry this flow forward.
    const resumedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    let delivered: ReturnType<typeof runTick> | undefined;
    for (const tick of [213, 214, 215, 216, 217, 218, 219, 220]) {
      const outcome = runTick({ game: world.game(tick), memory: resumedMemory });
      if (outcome.movement.actionExecution.some(({ intent }) => intent.kind === "transfer")) {
        delivered = outcome;
        break;
      }
    }
    expect(delivered).toBeDefined();
    if (delivered === undefined) throw new Error("expected one transfer action");
    expect(world.spawnEnergy).toBeGreaterThan(100);
    expect(world.workerEnergy).toBeLessThan(50);
    expect(delivered.telemetry?.energyFlow).toMatchObject({ delivered: 1 });
  });

  it("preserves the one-short recovery denial without staging an exact spawn grant", () => {
    const memory = {} as Memory;
    const spawnCreep = vi.fn(() => 0);

    const outcome = runTick({
      game: fundedContractGame(72, {
        energy: 199,
        energyCapacity: 300,
        includeCreep: false,
        spawnCreep,
      }),
      memory,
    });

    expect(spawnCreep).not.toHaveBeenCalled();
    expect(outcome.spawn.execution).toEqual([]);
    expect(outcome.spawn.broker?.decisions).toEqual([]);
    expect(outcome.colony.objectives).toEqual([
      expect.objectContaining({
        budgetReasonCode: "insufficient-energy",
        id: "colony/W1N1/restore-workforce",
        reservationId: null,
        status: "blocked",
      }),
    ]);
    expect(outcome.colony.reservations).toEqual([
      expect.objectContaining({
        grant: { cpu: 0, energy: 0, spawn: null },
        status: "pending",
      }),
    ]);
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["config", "kernel", "colonies", "contracts"],
    });
  });

  it("settles a scheduled spawn even when command execution overruns its CPU budget", () => {
    const memory = {} as Memory;
    let used = 0;
    const spawnCreep = vi.fn(() => {
      used = 499;
      return 0;
    });

    const outcome = runTick({
      game: fundedContractGame(73, {
        cpuGetUsed: () => used,
        includeCreep: false,
        spawnCreep,
      }),
      memory,
    });

    expect(spawnCreep).toHaveBeenCalledTimes(1);
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ stage: "budget", systemId: "spawn.execute" }),
    ]);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", systemId: "spawn.execute" }),
        expect.objectContaining({ status: "completed", systemId: "spawn.settle" }),
        expect.objectContaining({ status: "completed", systemId: "state.reconcile" }),
      ]),
    );
    expect(outcome.colony.reservations).toEqual([
      expect.objectContaining({
        consumed: { cpu: 100, energy: 200, spawn: true },
        status: "released",
      }),
    ]);
    expect(outcome.spawn.execution).toEqual([
      expect.objectContaining({ reason: "scheduled", status: "scheduled" }),
    ]);
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["config", "kernel", "colonies"],
    });
  });

  it("preserves contracts when emergency admission skips operational work", () => {
    const memory = {} as Memory;
    const gameAt = (time: number, bucket: number): RuntimeGame => ({
      cpu: { bucket, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
    runTick({ game: gameAt(80, 9_000), memory });
    if (memory.myrmex === undefined) {
      throw new Error("current memory was not initialized");
    }

    const opened = ContractLedger.open({});
    if (opened.status !== "ready") {
      throw new Error("expected an empty contract ledger");
    }
    const submitted = opened.ledger.submit(runtimeFundedRequest(), 80);
    if (!submitted.accepted) {
      throw new Error(`contract submission failed: ${submitted.reason}`);
    }
    (memory.myrmex as unknown as { contracts: unknown }).contracts = serializeContractLedgerState(
      opened.ledger.view(),
    );
    const ownerBytes = JSON.stringify(memory.myrmex.contracts);

    const outcome = runTick({ game: gameAt(81, 0), memory });

    expect(outcome.kernel.mode).toBe("emergency");
    expect(outcome.contracts).toBeNull();
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemId: "contracts.reconcile",
          status: "skipped",
          skipReason: "cpu-mode",
        }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({ committed: true, owners: ["kernel"] });
    expect(JSON.stringify(memory.myrmex.contracts)).toBe(ownerBytes);
  });

  it("runs all phases through the kernel and records bounded tick-local telemetry", () => {
    const observed: TickPhase[] = [];
    const getUsed = vi.fn(() => 1.25);
    const memory = {} as Memory;

    const outcome = runTick({
      game: {
        cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 42,
      },
      memory,
      onPhase: (phase) => observed.push(phase),
    });

    expect(observed).toEqual(TICK_PHASES);
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(memory.myrmex?.meta.lastTick).toBe(42);
    expect(memory.myrmex?.meta.revision).toBe(1);
    expect(memory.myrmex).toMatchObject({
      config: {
        schemaVersion: 1,
        candidate: null,
        lastValid: null,
      },
      kernel: {
        runtime: {
          schemaVersion: 1,
          cpuMode: "normal",
        },
      },
    });
    expect(outcome.configResolution).toEqual({
      status: "source-defaults",
      reasonCode: "owner-initialized",
      candidateRevision: null,
      acceptedCandidateRevision: null,
    });
    expect(Object.isFrozen(outcome.config)).toBe(true);
    expect(Object.isFrozen(outcome.config.policy.recovery)).toBe(true);
    expect(outcome.telemetry).toMatchObject({
      configSourceRevision: outcome.config.sourceRevision,
      configRevision: outcome.config.revision,
      policyRevision: outcome.config.policyRevision,
      configStatus: "source-defaults",
      configReasonCode: "owner-initialized",
    });
    expect(outcome.telemetry?.featureGates.map(({ id }) => id)).toEqual(FEATURE_GATE_IDS);
    expect(outcome.telemetry?.featureGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "phase1.colony", enabled: true, reason: "enabled" }),
      ]),
    );
    expect(outcome.colony).toMatchObject({ status: "planned", colonies: [], objectives: [] });
    expect(outcome.telemetry?.colony).toMatchObject({
      status: "planned",
      activeReservations: 0,
      objectives: 0,
    });
    expect(outcome.telemetry?.energyFlow).toEqual({
      carried: 0,
      delivered: 0,
      dropped: 0,
      harvested: 0,
      requested: 0,
      unmet: 0,
    });
  });

  it("contains a colony planning fault and still executes the mandatory tail", () => {
    const observed: TickPhase[] = [];
    const memory = {} as Memory;

    const outcome = runTick({
      game: {
        cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 43,
      },
      memory,
      onPhase: (phase) => {
        observed.push(phase);
        if (phase === "plan") {
          throw new Error("injected planner fault");
        }
      },
    });

    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "colony.director", stage: "run" }),
    ]);
    expect(observed).toEqual(TICK_PHASES);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "execution.arbitrate", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({ committed: true });
    expect(outcome.kernel.faults).toHaveLength(1);
    expect(outcome.telemetry).toMatchObject({ memoryStatus: "ready", ownedRooms: 0 });
  });

  it("preserves a non-empty assigned commitment when the funding view is unavailable", () => {
    const memory = {} as Memory;
    const game = fundedContractGame(43);
    const initial = runTick({ game, memory });
    const actor = initial.snapshot.rooms[0]?.ownedCreeps[0];
    if (memory.myrmex === undefined || actor === undefined) {
      throw new Error("expected initialized assigned-contract fixture");
    }
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") {
      throw new Error("expected an empty contract ledger");
    }
    const request = runtimeFundedRequest();
    const submitted = opened.ledger.submit(request, 43);
    if (!submitted.accepted) {
      throw new Error(`contract submission failed: ${submitted.reason}`);
    }
    opened.ledger.reconcile({
      actors: [workforceActorFromCreep(actor)],
      funding: activeFundingFromTick(initial),
      requests: [],
      tick: 43,
      transitions: [
        {
          contractId: submitted.contractId,
          reason: "budget-authorized",
          tick: 43,
          to: "funded",
        },
      ],
      travel: { estimate: () => 0 },
    });
    expect(opened.ledger.view().active[0]?.state).toBe("assigned");
    (memory.myrmex as unknown as { contracts: unknown }).contracts = serializeContractLedgerState(
      opened.ledger.view(),
    );
    (memory.myrmex as unknown as { colonies: unknown }).colonies = { schemaVersion: 1 };
    const ownerBytes = JSON.stringify(memory.myrmex.contracts);

    const outcome = runTick({ game: fundedContractGame(44), memory });

    expect(outcome.contracts).toBeNull();
    expect(outcome.colony.status).toBe("owner-malformed");
    expect(outcome.kernel.faults).toEqual([]);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "contracts.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({ committed: true, owners: ["kernel"] });
    expect(JSON.stringify(memory.myrmex.contracts)).toBe(ownerBytes);
  });

  it("clears a published contract result when its staged owner is discarded", () => {
    let used = 0;
    const stageDescriptor = Object.getOwnPropertyDescriptor(ContractLedger.prototype, "stage");
    if (typeof stageDescriptor?.value !== "function") {
      throw new TypeError("ContractLedger.stage descriptor is unavailable");
    }
    const originalStage = stageDescriptor.value as ContractLedger["stage"];
    const stageSpy = vi.spyOn(ContractLedger.prototype, "stage").mockImplementation(function (
      this: ContractLedger,
      manager,
    ) {
      const result = originalStage.call(this, manager);
      used = 496;
      return result;
    });
    const memory = {} as Memory;
    const outcome = (() => {
      try {
        return runTick({
          game: {
            cpu: {
              bucket: 9_000,
              limit: 20,
              tickLimit: 500,
              getUsed: () => used,
            },
            creeps: {},
            rooms: {},
            shard: { name: "shard3" },
            time: 44,
          },
          memory,
        });
      } finally {
        stageSpy.mockRestore();
      }
    })();

    expect(outcome.contracts).toBeNull();
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "contracts.reconcile", stage: "budget" }),
    ]);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "contracts.reconcile", status: "failed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["config", "kernel", "colonies"],
    });
    expect(memory.myrmex?.contracts).toEqual({});
  });

  it("clears a published contract result when the atomic root commit is rejected", () => {
    const memory = {} as Memory;
    const stageDescriptor = Object.getOwnPropertyDescriptor(ContractLedger.prototype, "stage");
    if (typeof stageDescriptor?.value !== "function") {
      throw new TypeError("ContractLedger.stage descriptor is unavailable");
    }
    const originalStage = stageDescriptor.value as ContractLedger["stage"];
    const stageSpy = vi.spyOn(ContractLedger.prototype, "stage").mockImplementation(function (
      this: ContractLedger,
      manager,
    ) {
      const result = originalStage.call(this, manager);
      if (memory.myrmex === undefined) {
        throw new Error("expected initialized Memory root");
      }
      memory.myrmex = JSON.parse(JSON.stringify(memory.myrmex)) as NonNullable<Memory["myrmex"]>;
      return result;
    });
    const outcome = (() => {
      try {
        return runTick({
          game: {
            cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
            creeps: {},
            rooms: {},
            shard: { name: "shard3" },
            time: 45,
          },
          memory,
        });
      } finally {
        stageSpy.mockRestore();
      }
    })();

    expect(outcome.contracts).toBeNull();
    expect(outcome.stateCommit).toEqual({
      committed: false,
      faults: [expect.objectContaining({ code: "stale-root" })],
    });
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "state.reconcile", stage: "commit" }),
    ]);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "contracts.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "failed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(memory.myrmex?.contracts).toEqual({});
  });

  it("activates one valid candidate and retains it after an atomic rejection", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });

    runTick({ game: gameAt(60), memory });
    const owner = memory.myrmex?.config as unknown as {
      candidate: unknown;
      lastValid: { candidateRevision: number } | null;
    };
    owner.candidate = {
      revision: 91_001,
      overrides: {
        policy: { recovery: { protectedSpawnEnergy: 450 } },
        relations: { self: ["Myrmex"], allies: ["Friendly"], naps: ["Pact"] },
      },
    };

    const accepted = runTick({ game: gameAt(61), memory });

    expect(accepted.configResolution).toEqual({
      status: "candidate-accepted",
      reasonCode: "candidate-valid",
      candidateRevision: 91_001,
      acceptedCandidateRevision: 91_001,
    });
    expect(accepted.config.policy.recovery.protectedSpawnEnergy).toBe(450);
    expect(accepted.config.relations).toEqual({
      self: ["Myrmex"],
      allies: ["Friendly"],
      naps: ["Pact"],
    });
    const acceptedOwner = memory.myrmex?.config as unknown as {
      candidate: unknown;
      lastValid: { candidateRevision: number } | null;
    };
    expect(acceptedOwner.lastValid?.candidateRevision).toBe(91_001);
    expect(accepted.stateCommit).toMatchObject({ committed: true, owners: ["config", "kernel"] });

    acceptedOwner.candidate = {
      revision: 91_002,
      overrides: {
        policy: { recovery: { protectedSpawnEnergy: 500 } },
        unknownPolicy: true,
      },
    };
    const rejected = runTick({ game: gameAt(62), memory });

    expect(rejected.configResolution).toEqual({
      status: "last-valid-retained",
      reasonCode: "candidate-invalid",
      candidateRevision: 91_002,
      acceptedCandidateRevision: 91_001,
    });
    expect(rejected.config).toEqual(accepted.config);
    expect(rejected.telemetry).toMatchObject({
      configStatus: "last-valid-retained",
      configReasonCode: "candidate-invalid",
      configRevision: accepted.config.revision,
      policyRevision: accepted.config.policyRevision,
    });
    expect(rejected.stateCommit).toMatchObject({ committed: true, owners: ["kernel"] });
    expect(memory.myrmex?.config?.candidate).toMatchObject({ revision: 91_002 });
  });

  it("accounts Memory preflight as overhead and cache telemetry inside its system", () => {
    let used = 0;
    let firstReading = true;
    const getUsed = vi.fn(() => {
      const reading = used;
      if (firstReading) {
        firstReading = false;
        used = 2;
      }
      return reading;
    });
    const metricsDescriptor = Object.getOwnPropertyDescriptor(CacheManager.prototype, "metrics");
    if (typeof metricsDescriptor?.value !== "function") {
      throw new TypeError("CacheManager.metrics descriptor is unavailable");
    }
    const originalMetrics = metricsDescriptor.value as (
      this: CacheManager,
    ) => ReturnType<CacheManager["metrics"]>;
    let metricsCalls = 0;
    const metricsSpy = vi.spyOn(CacheManager.prototype, "metrics").mockImplementation(function (
      this: CacheManager,
    ) {
      metricsCalls += 1;
      used += 0.75;
      return originalMetrics.call(this);
    });
    const outcome = (() => {
      try {
        return runTick({
          game: {
            cpu: {
              bucket: 8_000,
              limit: 20,
              tickLimit: 500,
              getUsed,
            },
            creeps: {},
            rooms: {},
            shard: { name: "shard3" },
            time: 45,
          },
          memory: {} as Memory,
        });
      } finally {
        metricsSpy.mockRestore();
      }
    })();

    const telemetrySystem = outcome.kernel.systems.find(
      ({ systemId }) => systemId === "telemetry.minimum",
    );
    const phaseCpu = outcome.kernel.phases.reduce((total, phase) => total + phase.cpuUsed, 0);
    expect(metricsCalls).toBe(1);
    expect(outcome.kernel.cpu.usedAtStart).toBe(0);
    expect(telemetrySystem).toMatchObject({ status: "completed", cpuUsed: 0.75 });
    expect(outcome.kernel.cpuUsed).toBe(2.75);
    expect(outcome.kernel.overheadCpu).toBe(2);
    expect(phaseCpu + outcome.kernel.overheadCpu).toBe(outcome.kernel.cpuUsed);
    expect(outcome.telemetry).toMatchObject({ cacheEntries: 0, cacheNamespaces: 2 });
  });

  it("returns the kernel report when the mandatory telemetry system itself faults", () => {
    const outcome = runTick({
      game: {
        cpu: {
          bucket: 8_000,
          limit: 20,
          tickLimit: 500,
          getUsed: () => 0,
        },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 46,
      },
      memory: {} as Memory,
      onPhase: (phase) => {
        if (phase === "telemetry") {
          throw new Error("injected telemetry fault");
        }
      },
    });

    expect(outcome.telemetry).toBeNull();
    expect(outcome.stateCommit).toMatchObject({ committed: true });
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "failed" }),
      ]),
    );
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "telemetry.minimum", stage: "run" }),
    ]);
  });

  it("continues boot with retired, duplicate, or malformed persisted kernel health", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });

    runTick({ game: gameAt(50), memory });
    (memory.myrmex as unknown as { kernel: { runtime: unknown } }).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "retired.system",
          consecutiveFailures: 1,
          lastSuccessfulTick: 40,
          nextProbeTick: null,
        },
        {
          systemId: "cache.sweep",
          consecutiveFailures: 2,
          lastSuccessfulTick: 40,
          nextProbeTick: 100,
        },
        {
          systemId: "cache.sweep",
          consecutiveFailures: 3,
          lastSuccessfulTick: 41,
          nextProbeTick: 200,
        },
      ],
    };

    const restored = runTick({ game: gameAt(51), memory });

    expect(restored.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemId: "cache.sweep",
          status: "skipped",
          skipReason: "quarantined",
          nextEligibleTick: 100,
        }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(restored.stateCommit).toMatchObject({ committed: true });

    (memory.myrmex as unknown as { kernel: { runtime: unknown } }).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "cache.sweep",
          consecutiveFailures: -1,
          lastSuccessfulTick: 40,
          nextProbeTick: null,
        },
      ],
    };

    const recovered = runTick({ game: gameAt(52), memory });

    expect(recovered.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "cache.sweep", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(recovered.stateCommit).toMatchObject({ committed: true });
  });

  it("uses recovery admission while an interrupted migration advances", () => {
    const memory = {
      myrmex: {
        schema: 1,
        boot: { firstTick: 1, lastTick: 40, shard: "shard3" },
        world: { stale: true },
      },
    } as unknown as Memory;

    const outcome = runTick({
      game: {
        cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 44,
      },
      memory,
    });

    expect(outcome.memoryStatus).toBe("recovery");
    expect(outcome.kernel.mode).toBe("recovery");
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "colony.director", status: "completed" }),
        expect.objectContaining({ systemId: "execution.arbitrate", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toBeNull();
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(outcome.configResolution).toMatchObject({
      status: "owner-unavailable",
      reasonCode: "owner-unavailable",
    });
    expect(outcome.telemetry).toMatchObject({
      configStatus: "owner-unavailable",
      configReasonCode: "owner-unavailable",
      configRevision: outcome.config.revision,
      policyRevision: outcome.config.policyRevision,
      colony: { status: "owner-unavailable" },
    });
  });
});

interface FundedContractGameOptions {
  readonly cpuGetUsed?: () => number;
  readonly creepName?: string;
  readonly energy?: number;
  readonly energyCapacity?: number;
  readonly includeCreep?: boolean;
  readonly legalCreep?: boolean;
  readonly spawnCreep?: (...arguments_: unknown[]) => number;
}

function economyGame(): {
  game(time: number): RuntimeGame;
  spawnEnergy: number;
  workerEnergy: number;
  workerPresent: boolean;
} {
  const world = { spawnEnergy: 300, workerEnergy: 0, workerPresent: false };
  const source = {
    id: "source-economy",
    energy: 3_000,
    energyCapacity: 3_000,
    pos: { roomName: "W1N1", x: 10, y: 10 },
    ticksToRegeneration: 0,
  };
  const worker = {
    body: [
      { hits: 100, type: "work" },
      { hits: 100, type: "carry" },
      { hits: 100, type: "move" },
    ],
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "creep-economy",
    my: true,
    name: "economy-worker",
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 10, y: 10 },
    spawning: false,
    store: {
      get energy() {
        return world.workerEnergy;
      },
      getCapacity: () => 50,
      getFreeCapacity: () => 50 - world.workerEnergy,
      getUsedCapacity: () => world.workerEnergy,
    },
    ticksToLive: 100,
    harvest: () => {
      if (world.workerEnergy >= 50 || source.energy <= 0) return -8;
      world.workerEnergy = 50;
      source.energy -= 50;
      return 0;
    },
    transfer: () => {
      if (world.workerEnergy <= 0 || world.spawnEnergy >= 300) return -8;
      world.workerEnergy -= 1;
      world.spawnEnergy += 1;
      return 0;
    },
    move: () => 0,
  } as unknown as Creep;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-economy",
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 11, y: 10 },
    room: { name: "W1N1" },
    isActive: () => true,
    spawnCreep: () => 0,
    spawning: null,
    structureType: "spawn",
    store: {
      get energy() {
        return world.spawnEnergy;
      },
      getCapacity: () => 300,
      getFreeCapacity: () => 300 - world.spawnEnergy,
      getUsedCapacity: () => world.spawnEnergy,
    },
  } as unknown as StructureSpawn;
  const room = {
    controller: {
      id: "controller-economy",
      level: 1,
      my: true,
      owner: { username: "Myrmex" },
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: 0,
      progressTotal: 200,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: undefined,
      ticksToDowngrade: 10_000,
      upgradeBlocked: undefined,
    },
    get energyAvailable() {
      return world.spawnEnergy;
    },
    energyCapacityAvailable: 300,
    name: "W1N1",
    find: (findType: number): unknown[] =>
      findType === FIND_CREEPS_VALUE
        ? world.workerPresent
          ? [worker]
          : []
        : findType === FIND_STRUCTURES_VALUE
          ? [spawn]
          : findType === FIND_SOURCES_VALUE
            ? [source]
            : findType === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
  } as unknown as Room;
  return Object.assign(world, {
    game: (time: number): RuntimeGame => ({
      cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: world.workerPresent ? { "economy-worker": worker } : {},
      rooms: { W1N1: room },
      shard: { name: "shard3" },
      time,
      getObjectById: (id: string) =>
        id === source.id ? source : id === spawn.id ? spawn : id === worker.id ? worker : null,
    }),
  });
}

function fundedContractGame(time: number, options: FundedContractGameOptions = {}): RuntimeGame {
  const energy = options.energy ?? 300;
  const energyCapacity = options.energyCapacity ?? 300;
  const includeCreep = options.includeCreep ?? true;
  const legalCreep = options.legalCreep ?? false;
  const spawnCreep = options.spawnCreep ?? (() => 0);
  const creepName = options.creepName ?? "budget-worker";
  const position = { roomName: "W1N1", x: 10, y: 10 };
  const store = {
    energy,
    getCapacity: () => energyCapacity,
    getFreeCapacity: () => Math.max(0, energyCapacity - energy),
    getUsedCapacity: () => energy,
  };
  const creep = {
    body: [
      { hits: 100, type: "work" },
      ...(legalCreep ? [{ hits: 100, type: "carry" }] : []),
      { hits: 100, type: "move" },
    ],
    fatigue: 0,
    hits: legalCreep ? 300 : 200,
    hitsMax: legalCreep ? 300 : 200,
    id: "creep-budget",
    my: true,
    name: creepName,
    owner: { username: "Myrmex" },
    pos: position,
    spawning: false,
    store: {
      getCapacity: () => 0,
      getFreeCapacity: () => 0,
      getUsedCapacity: () => 0,
    },
    ticksToLive: 100,
  } as unknown as Creep;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-budget",
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 11, y: 10 },
    room: { name: "W1N1" },
    isActive: () => true,
    spawnCreep,
    spawning: null,
    store,
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const room = {
    controller: {
      id: "controller-budget",
      level: 1,
      my: true,
      owner: { username: "Myrmex" },
      pos: { roomName: "W1N1", x: 12, y: 10 },
      progress: 0,
      progressTotal: 200,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: undefined,
      ticksToDowngrade: 10_000,
      upgradeBlocked: undefined,
    },
    energyAvailable: energy,
    energyCapacityAvailable: energyCapacity,
    find: (findType: number): unknown[] => {
      if (findType === FIND_CREEPS_VALUE) {
        return includeCreep ? [creep] : [];
      }
      if (findType === FIND_STRUCTURES_VALUE) {
        return [spawn];
      }
      if (findType === FIND_SOURCES_VALUE || findType === FIND_CONSTRUCTION_SITES_VALUE) {
        return [];
      }
      throw new Error(`unexpected find type ${String(findType)}`);
    },
    name: "W1N1",
  } as unknown as Room;
  return {
    cpu: {
      bucket: 10_000,
      limit: 20,
      tickLimit: 500,
      getUsed: options.cpuGetUsed ?? (() => 0),
    },
    creeps: includeCreep ? { [creep.name]: creep } : {},
    rooms: { W1N1: room },
    shard: { name: "shard3" },
    time,
    getObjectById: (id: string) => (id === spawn.id ? spawn : null),
  };
}

function runtimeFundedRequest(): WorkContractRequest {
  return {
    budgetBinding: {
      category: "emergency-spawn",
      issuer: "colony/W1N1/restore-workforce",
    },
    conditions: { cancellation: null, failure: "failed", success: "completed" },
    deadline: 100,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    expiresAt: 101,
    issuer: "test:runtime",
    issuerKey: "budget-funded",
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 5,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: [],
    priority: { class: "survival", value: 100 },
    quantity: 1,
    range: 0,
    requiredCapability: {
      attack: 0,
      carry: 0,
      claim: 0,
      heal: 0,
      move: 1,
      rangedAttack: 0,
      tough: 0,
      work: 1,
    },
    target: { roomName: "W1N1", x: 10, y: 10 },
    targetId: null,
  };
}

function fundingFromTick(outcome: ReturnType<typeof runTick>): ContractFundingView {
  return {
    authorizations: outcome.colony.reservations.map((entry) => ({
      category: entry.category,
      colonyId: entry.colonyId,
      expiresAt: entry.request.expiresAt,
      issuer: entry.issuer,
      reservationId: entry.reservationId,
      revision: entry.revision,
      status: entry.status,
    })),
    owners: outcome.colony.colonies.map(({ id, visibility }) => ({ id, visibility })),
    status: "ready",
  };
}

function activeFundingFromTick(outcome: ReturnType<typeof runTick>): ContractFundingView {
  const funding = fundingFromTick(outcome);
  if (funding.status !== "ready") {
    throw new Error("expected a ready runtime funding view");
  }
  return {
    ...funding,
    authorizations: funding.authorizations.map((authorization) => ({
      ...authorization,
      status: "active" as const,
    })),
  };
}
