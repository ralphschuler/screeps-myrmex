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

  it("uses the current ColonyDirector reservation before assigning and commits once", () => {
    const memory = {} as Memory;
    const first = runTick({ game: fundedContractGame(70), memory });
    const reservation = first.colony.reservations[0];
    expect(reservation).toMatchObject({
      category: "emergency-spawn",
      colonyId: "W1N1",
      issuer: "colony/W1N1/restore-workforce",
      status: "active",
    });
    if (memory.myrmex === undefined || reservation === undefined) {
      throw new Error("expected initialized runtime funding fixture");
    }

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
    expect(prepared.transitions[0]).toMatchObject({ accepted: true, to: "funded" });
    (memory.myrmex as unknown as { contracts: unknown }).contracts = serializeContractLedgerState(
      opened.ledger.view(),
    );

    const assigned = runTick({ game: fundedContractGame(71), memory });
    expect(assigned.contracts?.funding).toEqual([
      expect.objectContaining({
        contractId: submitted.contractId,
        reason: "authorized",
        status: "authorized",
      }),
    ]);
    expect(assigned.contracts?.allocation.assignments).toEqual([
      expect.objectContaining({ actorId: "creep-budget", contractId: submitted.contractId }),
    ]);
    expect(assigned.stateCommit).toMatchObject({
      committed: true,
      owners: ["kernel", "contracts"],
      revision: 2,
    });
    const systemIds = assigned.kernel.systems.map(({ systemId }) => systemId);
    expect(systemIds.indexOf("colony.director")).toBeLessThan(
      systemIds.indexOf("contracts.reconcile"),
    );
    expect(systemIds.indexOf("contracts.reconcile")).toBeLessThan(
      systemIds.indexOf("state.reconcile"),
    );
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
      funding: fundingFromTick(initial),
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
    expect(outcome.telemetry).toMatchObject({ cacheEntries: 0, cacheNamespaces: 0 });
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

function fundedContractGame(time: number): RuntimeGame {
  const position = { roomName: "W1N1", x: 10, y: 10 };
  const store = {
    energy: 300,
    getCapacity: () => 300,
    getFreeCapacity: () => 0,
    getUsedCapacity: () => 300,
  };
  const creep = {
    body: [
      { hits: 100, type: "work" },
      { hits: 100, type: "move" },
    ],
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id: "creep-budget",
    my: true,
    name: "budget-worker",
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
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: (findType: number): unknown[] => {
      if (findType === FIND_CREEPS_VALUE) {
        return [creep];
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
    cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: { [creep.name]: creep },
    rooms: { W1N1: room },
    shard: { name: "shard3" },
    time,
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
