import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../src/cache";
import {
  ContractLedger,
  serializeContractLedgerState,
  workforceActorFromCreep,
  type ContractExecutionView,
  type ContractFundingView,
  type ContractPlanningView,
  type WorkContractRequest,
} from "../src/contracts";
import { COLONY_RCL_POLICY_TABLE } from "../src/colony";
import { FEATURE_GATE_IDS } from "../src/config";
import { planSurvivalFlow, type SurvivalFlowCandidate } from "../src/economy";
import {
  LAYOUT_ALGORITHM_REVISION,
  emptyLayoutsOwner,
  persistLayoutCommitment,
} from "../src/layout";
import {
  projectActiveLeaseTargetIds,
  projectActiveSpawnClaimIds,
  orphanedSpawnEvacuationTransition,
  projectCommittedLabLayouts,
  projectPinnedLabHandoffLayout,
  runTick,
  withoutSuppressedLeaseTargets,
  withoutSuppressedSurvivalTransfers,
} from "../src/runtime/tick";
import type { RuntimeGame } from "../src/runtime/context";
import { TICK_PHASES, type TickPhase } from "../src/runtime/phases";
import {
  MAX_CREEP_NAME_CODE_UNITS,
  generatedSpawnCreepName,
  generatedSpawnCreepNameCandidates,
} from "../src/spawn";
import { TelemetryService } from "../src/telemetry/service";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

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

  it("projects every assigned or active contract endpoint before irreversible migration", () => {
    const contracts = [
      {
        execution: {
          action: "transfer",
          completion: "continuous",
          counterpartId: "spawn-obsolete",
          resourceType: "energy",
          version: 1,
        },
        state: "active",
        targetId: "source-a",
      },
      {
        execution: {
          action: "transfer",
          completion: "target-full",
          counterpartId: "spawn-other",
          flowId: "flow-a",
          recommendedCarry: 1,
          recommendedMove: 1,
          reservedAmount: 50,
          resourceType: "energy",
          stage: "deliver",
          version: 3,
        },
        state: "assigned",
        targetId: "storage-a",
      },
      {
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: "spawn-v2",
          resourceType: null,
          version: 2,
          workPosition: { roomName: "W1N1", x: 10, y: 10 },
        },
        state: "assigned",
        targetId: "source-v2",
      },
      {
        execution: {
          action: "repair",
          completion: "work-complete",
          counterpartId: null,
          resourceType: "energy",
          version: 1,
        },
        state: "funded",
        targetId: "spawn-unleased",
      },
    ] as unknown as ContractPlanningView["contracts"];

    expect([...projectActiveLeaseTargetIds(contracts)].sort()).toEqual([
      "source-a",
      "source-v2",
      "spawn-obsolete",
      "spawn-other",
      "spawn-v2",
      "storage-a",
    ]);
  });

  it("suppresses every migration-spawn lease endpoint and retires orphaned flow states", () => {
    const execution = {
      status: "ready",
      leases: [
        {
          actorId: "worker-a",
          execution: {
            action: "transfer",
            completion: "target-full",
            counterpartId: "spawn-obsolete",
            resourceType: "energy",
            version: 1,
          },
          targetId: "source-a",
        },
        {
          actorId: "worker-b",
          execution: {
            action: "withdraw",
            completion: "flow-complete",
            counterpartId: "spawn-replacement",
            flowId: "layout-spawn-evacuation:W1N1:spawn-obsolete:spawn-replacement",
            recommendedCarry: 1,
            recommendedMove: 1,
            reservedAmount: 300,
            resourceType: "energy",
            stage: "acquire",
            version: 3,
          },
          targetId: "spawn-obsolete",
        },
        {
          actorId: "worker-c",
          execution: {
            action: "harvest",
            completion: "continuous",
            counterpartId: null,
            resourceType: null,
            version: 1,
          },
          targetId: "source-safe",
        },
      ],
    } as unknown as ContractExecutionView;

    const filtered = withoutSuppressedLeaseTargets(
      execution,
      new Set(["spawn-obsolete", "spawn-replacement"]),
    );
    expect(filtered.leases.map(({ actorId }) => actorId)).toEqual(["worker-c"]);
    const survival = withoutSuppressedSurvivalTransfers(
      [
        { action: "transfer", targetId: "spawn-obsolete" },
        { action: "transfer", targetId: "spawn-safe" },
        { action: "harvest", targetId: "source-safe" },
      ] as unknown as readonly SurvivalFlowCandidate[],
      new Set(["spawn-obsolete"]),
    );
    expect(survival.map(({ targetId }) => targetId)).toEqual(["spawn-safe", "source-safe"]);
    expect(orphanedSpawnEvacuationTransition("proposed")).toBe("cancelled");
    expect(orphanedSpawnEvacuationTransition("funded")).toBe("suspended");
    expect(orphanedSpawnEvacuationTransition("assigned")).toBe("failed");
    expect(orphanedSpawnEvacuationTransition("active")).toBe("failed");
    expect(orphanedSpawnEvacuationTransition("suspended")).toBe("failed");
  });

  it("allows only the authorized tower evacuation flow through suppressed stale endpoints", () => {
    const exactFlowId = "layout-tower-evacuation:W1N1:tower-obsolete:tower-replacement";
    const execution = {
      status: "ready",
      leases: [
        {
          actorId: "exact-hauler",
          execution: {
            action: "transfer",
            completion: "flow-complete",
            counterpartId: "tower-obsolete",
            flowId: exactFlowId,
            recommendedCarry: 1,
            recommendedMove: 1,
            reservedAmount: 500,
            resourceType: "energy",
            stage: "deliver",
            version: 3,
          },
          targetId: "tower-replacement",
        },
        {
          actorId: "conflicting-refill",
          execution: {
            action: "transfer",
            completion: "flow-complete",
            counterpartId: "storage",
            flowId: "ordinary-tower-refill",
            recommendedCarry: 1,
            recommendedMove: 1,
            reservedAmount: 100,
            resourceType: "energy",
            stage: "deliver",
            version: 3,
          },
          targetId: "tower-replacement",
        },
        {
          actorId: "safe-worker",
          execution: {
            action: "harvest",
            completion: "continuous",
            counterpartId: null,
            resourceType: null,
            version: 1,
          },
          targetId: "source-safe",
        },
      ],
    } as unknown as ContractExecutionView;

    const filtered = withoutSuppressedLeaseTargets(
      execution,
      new Set(["tower-obsolete", "tower-replacement"]),
      new Set([exactFlowId]),
    );

    expect(filtered.leases.map(({ actorId }) => actorId)).toEqual(["exact-hauler", "safe-worker"]);
  });

  it("fails spawn-removal claim evidence closed unless the broker completed planning", () => {
    const planned = {
      status: "planned",
      selections: [{ spawnId: "spawn-selected" }],
    } as unknown as NonNullable<ReturnType<typeof runTick>["spawn"]["broker"]>;
    const invalid = {
      status: "invalid",
      selections: [],
    } as unknown as NonNullable<ReturnType<typeof runTick>["spawn"]["broker"]>;

    expect(projectActiveSpawnClaimIds(planned)).toEqual(new Set(["spawn-selected"]));
    expect(projectActiveSpawnClaimIds(invalid)).toBeNull();
    expect(projectActiveSpawnClaimIds(null)).toBeNull();
  });

  it("publishes industry terminal work, spawn selections, layout, and links before migration", () => {
    const outcome = runTick({
      game: {
        cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 99,
      },
      memory: {} as Memory,
    });
    const planOrder = outcome.kernel.systems
      .map(({ systemId }) => systemId)
      .filter((systemId) =>
        [
          "agents.plan",
          "colony.director",
          "industry.publish",
          "layout.plan",
          "links.plan",
          "migration.layout",
        ].includes(systemId),
      );

    expect(planOrder).toEqual([
      "colony.director",
      "agents.plan",
      "industry.publish",
      "layout.plan",
      "links.plan",
      "migration.layout",
    ]);
  });

  it("reconstructs and pins exact committed RCL8 lab handoff geometry", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", {
      algorithmRevision: LAYOUT_ALGORITHM_REVISION,
      anchor: { roomName: "W1N1", x: 25, y: 25 },
      blockers: [],
      committedAt: 90,
      fingerprint: "layout-commitment",
      transform: 0,
    });
    const snapshot = {
      rooms: [
        {
          controller: {
            level: 8,
            ownership: "owned",
            pos: { roomName: "W1N1", x: 20, y: 20 },
          },
          name: "W1N1",
          sources: [
            { id: "source-a", pos: { roomName: "W1N1", x: 10, y: 10 } },
            { id: "source-b", pos: { roomName: "W1N1", x: 40, y: 40 } },
          ],
        },
      ],
    } as unknown as Parameters<typeof projectCommittedLabLayouts>[0];

    const first = projectCommittedLabLayouts(snapshot, owner);
    const reset = projectCommittedLabLayouts(roundTrip(snapshot), roundTrip(owner));

    expect(first).toHaveLength(1);
    expect(first[0]?.roomName).toBe("W1N1");
    expect(first[0]?.layoutFingerprint).toBe("layout-commitment");
    expect(first[0]?.labPositions).toHaveLength(10);
    expect(first[0]?.labPositions.every(({ roomName }) => roomName === "W1N1")).toBe(true);
    expect(reset).toEqual(first);
    expect(projectCommittedLabLayouts(snapshot, null)).toEqual([]);

    const unlocks = COLONY_RCL_POLICY_TABLE.find(({ level }) => level === 8)?.unlocks ?? null;
    const record = owner.records[0];
    const pinned = projectPinnedLabHandoffLayout({
      handoffLayoutFingerprint: "layout-commitment",
      record,
      roomName: "W1N1",
      sourceCount: 2,
      unlocks,
    });
    expect(pinned?.commitment.fingerprint).toBe("layout-commitment");
    expect(pinned?.placements.filter(({ structureType }) => structureType === "lab")).toHaveLength(
      10,
    );
    expect(
      projectPinnedLabHandoffLayout({
        handoffLayoutFingerprint: "replacement-layout",
        record,
        roomName: "W1N1",
        sourceCount: 2,
        unlocks,
      }),
    ).toBeNull();
  });

  it("executes one fail-closed tower command from the mandatory safety phase", () => {
    const attack = vi.fn(() => 0);
    const activateSafeMode = vi.fn(() => 0);
    const hostile = {
      body: [{ hits: 100, type: "attack" }],
      fatigue: 0,
      hits: 100,
      hitsMax: 100,
      id: "hostile-1",
      my: false,
      name: "hostile-1",
      owner: { username: "Enemy" },
      pos: { roomName: "W1N1", x: 20, y: 20 },
      spawning: false,
      store: { getCapacity: () => 0, getFreeCapacity: () => 0, getUsedCapacity: () => 0 },
      ticksToLive: 1_000,
    } as unknown as Creep;
    const tower = {
      hits: 3_000,
      hitsMax: 3_000,
      id: "tower-1",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: { roomName: "W1N1", x: 25, y: 25 },
      structureType: "tower",
      store: {
        energy: 800,
        getCapacity: () => 1_000,
        getFreeCapacity: () => 200,
        getUsedCapacity: () => 800,
      },
      attack,
      heal: () => 0,
      repair: () => 0,
    } as unknown as StructureTower;
    const spawn = {
      hits: 50,
      hitsMax: 5_000,
      id: "spawn-1",
      my: true,
      name: "Spawn1",
      owner: { username: "Myrmex" },
      pos: { roomName: "W1N1", x: 24, y: 25 },
      room: { name: "W1N1" },
      isActive: () => true,
      spawning: null,
      spawnCreep: () => 0,
      structureType: "spawn",
      store: { getCapacity: () => 300, getFreeCapacity: () => 0, getUsedCapacity: () => 300 },
    } as unknown as StructureSpawn;
    const controller = {
      id: "controller-1",
      level: 3,
      my: true,
      owner: { username: "Myrmex" },
      pos: { roomName: "W1N1", x: 25, y: 24 },
      progress: 0,
      progressTotal: 1,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: undefined,
      ticksToDowngrade: 10_000,
      upgradeBlocked: undefined,
      activateSafeMode,
    } as unknown as StructureController;
    const room = {
      name: "W1N1",
      controller,
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      getTerrain: () => PLAIN_ROOM_TERRAIN,
      find: (kind: number): unknown[] =>
        kind === FIND_CREEPS_VALUE
          ? [hostile]
          : kind === FIND_STRUCTURES_VALUE
            ? [spawn, tower]
            : kind === FIND_SOURCES_VALUE || kind === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    } as unknown as Room;
    const game: RuntimeGame = {
      cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: { W1N1: room },
      shard: { name: "shard3" },
      time: 100,
      getObjectById: (id) =>
        id === tower.id
          ? tower
          : id === hostile.id
            ? hostile
            : id === controller.id
              ? controller
              : id === spawn.id
                ? spawn
                : null,
    };
    const outcome = runTick({ game, memory: {} as Memory });
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "defense.plan", status: "completed" }),
      ]),
    );
    expect(outcome.snapshot.rooms[0]?.hostileCreeps).toHaveLength(1);
    expect(outcome.snapshot.rooms[0]?.ownedTowers).toHaveLength(1);
    expect(outcome.config.features.gates["phase1.safety"].enabled).toBe(true);
    expect(outcome.execution?.accepted).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "tower.attack" })]),
    );
    expect(attack).toHaveBeenCalledWith(hostile);
    expect(activateSafeMode).toHaveBeenCalledTimes(1);
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
      owners: ["config", "kernel", "colonies", "contracts", "telemetry"],
      revision: 1,
    });
    expect(memory.myrmex?.meta.schemaVersion).toBe(4);
    expect(initialized.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", systemId: "layout.execute" }),
        expect.objectContaining({ status: "completed", systemId: "layout.reconcile" }),
      ]),
    );
    expect(memory.myrmex?.contracts).toEqual({
      active: [],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    });

    const stable = runTick({ game: gameAt(41), memory });
    expect(stable.stateCommit).toEqual({
      committed: true,
      owners: ["kernel", "telemetry"],
      revision: 2,
    });
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
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["kernel", "telemetry"],
    });
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
      owners: ["config", "kernel", "colonies", "contracts", "telemetry"],
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
    const damagedReplacement = damaged.spawn.broker?.selections[0];
    expect(damagedReplacement?.name).not.toBe(scheduledName);
    expect(damagedSpawnCreep).toHaveBeenCalledTimes(1);
    expect(damagedSpawnCreep).toHaveBeenCalledWith(
      ["work", "carry", "move"],
      damagedReplacement?.name,
    );
    expect(damaged.spawn.execution).toEqual([
      expect.objectContaining({ reason: "scheduled", status: "scheduled" }),
    ]);
    expect(damaged.colony.objectives).toEqual([
      expect.objectContaining({
        id: "colony/W1N1/restore-workforce",
        status: "funded",
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
    expect(absentSpawnCreep).toHaveBeenCalledWith(
      ["work", "carry", "move"],
      retried.spawn.broker?.selections[0]?.name,
    );
    expect(retried.spawn.broker?.selections[0]?.name).not.toBe(scheduledName);
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

  it("settles post-admission insufficient-energy rejection before retrying", () => {
    const memory = {} as Memory;
    const rejectedSpawnCreep = vi.fn(() => -6);
    const rejected = runTick({
      game: fundedContractGame(70, {
        includeCreep: false,
        spawnCreep: rejectedSpawnCreep,
      }),
      memory,
    });

    expect(rejectedSpawnCreep).toHaveBeenCalledTimes(1);
    expect(rejected.spawn.execution).toEqual([
      expect.objectContaining({
        reason: "insufficient-energy",
        returnCode: -6,
        status: "rejected",
      }),
    ]);
    expect(rejected.colony.reservations).toContainEqual(
      expect.objectContaining({ status: "released" }),
    );

    const recoveredSpawnCreep = vi.fn(() => 0);
    const recovered = runTick({
      game: fundedContractGame(80, {
        includeCreep: false,
        spawnCreep: recoveredSpawnCreep,
      }),
      memory,
    });

    expect(recoveredSpawnCreep).toHaveBeenCalledTimes(1);
    expect(recovered.spawn.execution).toEqual([
      expect.objectContaining({ reason: "scheduled", status: "scheduled", returnCode: 0 }),
    ]);
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
    expect(planned.config.features.gates["phase1.recovery"].enabled).toBe(true);
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
    expect(harvested.telemetry?.energyFlow).toMatchObject({ harvested: 2 });

    // Simulate a heap reset: only serialized authorities may carry this flow forward.
    const resumedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    let delivered: ReturnType<typeof runTick> | undefined;
    for (const tick of Array.from({ length: 120 }, (_, index) => 213 + index)) {
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
    expect(delivered.telemetry?.energyFlow).toMatchObject({ delivered: 50 });
  });

  it("schedules one distinct successor at the proactive boundary and deduplicates it after reset", () => {
    const memory = {} as Memory;
    const spawnCreep = vi.fn(() => 0);

    const bootstrapped = runTick({
      game: fundedContractGame(70, { includeCreep: false, spawnCreep }),
      memory,
    });
    const incumbentName = bootstrapped.spawn.broker?.selections[0]?.name;
    expect(incumbentName).toBeDefined();
    expect(bootstrapped.spawn.execution).toEqual([
      expect.objectContaining({ status: "scheduled", reason: "scheduled" }),
    ]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);
    if (incumbentName === undefined) {
      throw new Error("zero-worker recovery did not publish its generated incumbent identity");
    }

    const beforeBoundary = runTick({
      game: fundedContractGame(80, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 60,
      }),
      memory,
    });
    expect(beforeBoundary.spawn.execution).toEqual([]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);

    const scheduled = runTick({
      game: fundedContractGame(81, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 59,
      }),
      memory,
    });
    const successor = scheduled.spawn.broker?.selections[0];
    expect(successor).toMatchObject({
      demandId: "colony/W1N1/restore-workforce",
      replacementCreepName: incumbentName,
    });
    if (successor === undefined) {
      throw new Error("proactive handoff did not select a successor");
    }
    expect(successor.name).not.toBe(incumbentName);
    expect(successor.name).toBe(
      generatedSpawnCreepName({
        id: successor.demandId,
        issuer: successor.issuer,
        colonyId: successor.colonyId,
        revision: successor.revision,
        category: "emergency-recovery",
      }),
    );
    expect(successor.name.length).toBeLessThanOrEqual(MAX_CREEP_NAME_CODE_UNITS);
    expect(scheduled.spawn.execution).toEqual([
      expect.objectContaining({ status: "scheduled", reason: "scheduled" }),
    ]);
    expect(spawnCreep).toHaveBeenCalledTimes(2);

    const resumedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const reset = runTick({
      game: fundedContractGame(82, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        spawning: { creepName: successor.name, remainingTime: 8 },
        ticksToLive: 58,
      }),
      memory: resumedMemory,
    });
    expect(reset.spawn.broker?.decisions).toEqual([
      expect.objectContaining({
        demandId: "colony/W1N1/restore-workforce",
        status: "deferred",
        reason: "observed-spawning",
      }),
    ]);
    expect(reset.spawn.execution).toEqual([]);
    expect(spawnCreep).toHaveBeenCalledTimes(2);
  });

  it("reconstructs one bounded successor name after failed scheduling and retry backoff", () => {
    const memory = {} as Memory;
    const spawnCreep = vi.fn().mockReturnValueOnce(-4).mockReturnValue(0);
    const incumbentName = "retry-incumbent";
    runTick({
      game: fundedContractGame(99, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 60,
      }),
      memory,
    });

    const failed = runTick({
      game: fundedContractGame(100, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 59,
      }),
      memory,
    });
    const failedSelection = failed.spawn.broker?.selections[0];
    expect(failedSelection).toBeDefined();
    expect(failed.spawn.execution).toEqual([
      expect.objectContaining({ status: "rejected", reason: "busy" }),
    ]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);

    const resumedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const backingOff = runTick({
      game: fundedContractGame(101, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 58,
      }),
      memory: resumedMemory,
    });
    expect(backingOff.spawn.broker?.decisions).toEqual([
      expect.objectContaining({ status: "deferred", reason: "not-before", retryAt: 102 }),
    ]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);

    const retried = runTick({
      game: fundedContractGame(102, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        ticksToLive: 57,
      }),
      memory: resumedMemory,
    });
    const retriedSelection = retried.spawn.broker?.selections[0];
    expect(retriedSelection).toMatchObject({ replacementCreepName: incumbentName });
    if (failedSelection === undefined || retriedSelection === undefined) {
      throw new Error("retry handoff did not expose both bounded successor identities");
    }
    expect(retriedSelection.revision).toBeGreaterThan(failedSelection.revision);
    expect(retriedSelection.name).not.toBe(failedSelection.name);
    expect(retriedSelection.name).toBe(
      generatedSpawnCreepName({
        id: retriedSelection.demandId,
        issuer: retriedSelection.issuer,
        colonyId: retriedSelection.colonyId,
        revision: retriedSelection.revision,
        category: "emergency-recovery",
      }),
    );
    expect(retriedSelection.name.length).toBeLessThanOrEqual(MAX_CREEP_NAME_CODE_UNITS);
    expect(retried.spawn.execution).toEqual([
      expect.objectContaining({ status: "scheduled", reason: "scheduled" }),
    ]);
    expect(retried.colony.reservations).toEqual([
      expect.objectContaining({
        reservationId: retriedSelection.budgetId,
        revision: retriedSelection.revision,
        consumed: { cpu: 100, energy: 200, spawn: true },
        status: "released",
      }),
    ]);
    expect(spawnCreep).toHaveBeenLastCalledWith(["work", "carry", "move"], retriedSelection.name);
    expect(spawnCreep).toHaveBeenCalledTimes(2);

    const observedMemory = JSON.parse(JSON.stringify(resumedMemory)) as Memory;
    const observed = runTick({
      game: fundedContractGame(103, {
        creepName: incumbentName,
        legalCreep: true,
        spawnCreep,
        spawning: { creepName: retriedSelection.name, remainingTime: 8 },
        ticksToLive: 56,
      }),
      memory: observedMemory,
    });
    expect(observed.spawn.broker?.decisions).toEqual([
      expect.objectContaining({ status: "deferred", reason: "observed-spawning" }),
    ]);
    expect(observed.spawn.execution).toEqual([]);
    expect(spawnCreep).toHaveBeenCalledTimes(2);
  });

  it("binds a blocked recovery reservation to the exact funded spawn revision after reset", () => {
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
        revision: 1,
        status: "pending",
      }),
    ]);
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["config", "kernel", "colonies", "contracts", "telemetry"],
    });

    const fundedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const funded = runTick({
      game: fundedContractGame(73, {
        energy: 300,
        energyCapacity: 300,
        includeCreep: false,
        spawnCreep,
      }),
      memory: fundedMemory,
    });
    const selection = funded.spawn.broker?.selections[0];
    const reservation = funded.colony.reservations[0];
    expect(selection).toMatchObject({ revision: 2 });
    expect(reservation).toMatchObject({
      reservationId: selection?.budgetId,
      revision: selection?.revision,
      consumed: { cpu: 100, energy: 200, spawn: true },
      status: "released",
    });
    if (selection === undefined || reservation === undefined) {
      throw new Error("blocked recovery did not bind its funded exact revision");
    }
    expect(selection.name).toBe(
      generatedSpawnCreepName({
        id: selection.demandId,
        issuer: selection.issuer,
        colonyId: selection.colonyId,
        revision: reservation.revision,
        category: "emergency-recovery",
      }),
    );
    expect(spawnCreep).toHaveBeenCalledWith(["work", "carry", "move"], selection.name);

    const observedMemory = JSON.parse(JSON.stringify(fundedMemory)) as Memory;
    const observed = runTick({
      game: fundedContractGame(74, {
        energy: 300,
        energyCapacity: 300,
        includeCreep: false,
        spawnCreep,
        spawning: { creepName: selection.name, remainingTime: 8 },
      }),
      memory: observedMemory,
    });
    expect(observed.spawn.broker?.decisions).toEqual([
      expect.objectContaining({ status: "deferred", reason: "observed-spawning" }),
    ]);
    expect(observed.spawn.execution).toEqual([]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);
  });

  it("adopts one observed pre-revision recovery name without duplicating on an idle spawn", () => {
    const memory = {} as Memory;
    const spawnCreep = vi.fn(() => 0);
    const scheduled = runTick({
      game: fundedContractGame(70, { includeCreep: false, spawnCreep }),
      memory,
    });
    const selection = scheduled.spawn.broker?.selections[0];
    if (selection === undefined) {
      throw new Error("rollout fixture did not schedule its durable recovery attempt");
    }
    const candidates = generatedSpawnCreepNameCandidates({
      id: selection.demandId,
      issuer: selection.issuer,
      colonyId: selection.colonyId,
      revision: selection.revision,
      category: "emergency-recovery",
    });
    const legacyName = candidates[1];
    if (legacyName === undefined) {
      throw new Error("recovery identity did not expose its bounded rollout predecessor");
    }

    const resumedMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const observed = runTick({
      game: fundedContractGame(120, {
        controllerLevel: 7,
        energy: 300,
        energyCapacity: 600,
        includeCreep: false,
        includeSecondSpawn: true,
        spawnCreep,
        spawning: { creepName: legacyName, remainingTime: 0 },
      }),
      memory: resumedMemory,
    });

    expect(observed.snapshot.rooms[0]?.ownedSpawns).toHaveLength(2);
    expect(observed.spawn.broker?.decisions).toEqual([
      expect.objectContaining({ status: "deferred", reason: "observed-spawning", retryAt: 121 }),
    ]);
    expect(observed.spawn.broker?.selections).toEqual([]);
    expect(observed.spawn.execution).toEqual([]);
    expect(spawnCreep).toHaveBeenCalledTimes(1);
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
      owners: ["config", "kernel", "colonies", "telemetry"],
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
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["kernel", "telemetry"],
    });
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
        schemaVersion: 2,
        candidate: null,
        lastValid: null,
      },
      kernel: {
        runtime: {
          schemaVersion: 1,
          cpuMode: "normal",
        },
      },
      telemetry: {
        schemaVersion: 5,
        last: { tick: 42 },
        history: [{ tick: 42 }],
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
      harvestedIsLowerBound: false,
      requested: 0,
      unmet: 0,
    });
    expect(outcome.telemetry).toMatchObject({
      activity: { hostileRooms: 0, movementBlocked: 0, spawnScheduled: 0 },
      status: { droppedDetails: 0 },
    });
  });

  it("reports a repeated planner fault once, reminds, resolves once, and keeps the mandatory tail", () => {
    const observed: TickPhase[] = [];
    const memory = {} as Memory;
    const firstLines: string[] = [];

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
      consoleSink: { log: (line) => firstLines.push(line) },
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
    expect(outcome.telemetry?.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(outcome.reporterStatus.transitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(firstLines).toEqual([expect.stringContaining("reporter signal kind=first")]);

    const runLater = (time: number, fail: boolean, lines: string[]) =>
      runTick({
        game: {
          cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
          creeps: {},
          rooms: {},
          shard: { name: "shard3" },
          time,
        },
        memory,
        onPhase: (phase) => {
          if (fail && phase === "plan") throw new Error("injected planner fault");
        },
        consoleSink: { log: (line) => lines.push(line) },
      });
    const reminderLines: string[] = [];
    const resolvedLines: string[] = [];
    const quietLines: string[] = [];
    const reminder = runLater(53, true, reminderLines);
    const resolved = runLater(54, false, resolvedLines);
    const quiet = runLater(55, false, quietLines);

    expect(reminder.telemetry?.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "reminder", count: 2 }),
    ]);
    expect(reminder.reporterStatus.transitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "reminder", count: 2 }),
    ]);
    expect(resolved.telemetry?.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "resolved", count: 2 }),
    ]);
    expect(resolved.reporterStatus.transitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "resolved", count: 2 }),
    ]);
    expect(quiet.telemetry?.reporterTransitions).toEqual([]);
    expect(quiet.reporterStatus.transitions).toEqual([]);
    expect(reminderLines).toEqual([expect.stringContaining("reporter signal kind=reminder")]);
    expect(resolvedLines).toEqual([expect.stringContaining("reporter signal kind=resolved")]);
    expect(quietLines).toEqual([]);
    expect(
      [outcome, reminder, resolved, quiet].every(({ stateCommit }) => stateCommit?.committed),
    ).toBe(true);
    expect(
      [outcome, reminder, resolved, quiet]
        .flatMap(({ reporterStatus }) => reporterStatus.transitions)
        .filter((transition) => transition.category === "signal" && transition.kind === "resolved"),
    ).toHaveLength(1);
    expect(memory.myrmex).not.toHaveProperty("telemetry.reporter.events");
    expect(JSON.stringify(memory.myrmex)).not.toContain("injected planner fault");
  });

  it("keeps gameplay receipts and commands identical when the console sink throws", () => {
    const baselineSpawn = vi.fn(() => 0);
    const isolatedSpawn = vi.fn(() => 0);
    const baseline = runTick({
      game: fundedContractGame(100, { includeCreep: false, spawnCreep: baselineSpawn }),
      memory: {} as Memory,
    });
    const sink = vi.fn(() => {
      throw new Error("console unavailable");
    });
    const isolated = runTick({
      game: fundedContractGame(100, { includeCreep: false, spawnCreep: isolatedSpawn }),
      memory: {} as Memory,
      consoleSink: { log: sink },
    });

    expect(sink).toHaveBeenCalled();
    expect(isolatedSpawn.mock.calls).toEqual(baselineSpawn.mock.calls);
    expect(isolated.colony).toEqual(baseline.colony);
    expect(isolated.contracts).toEqual(baseline.contracts);
    expect(isolated.execution).toEqual(baseline.execution);
    expect(isolated.movement).toEqual(baseline.movement);
    expect(isolated.spawn).toEqual(baseline.spawn);
    expect(isolated.stateCommit).toEqual(baseline.stateCommit);
  });

  it("isolates a throwing telemetry service from gameplay persistence and mandatory completion", () => {
    const baselineMemory = {} as Memory;
    const isolatedMemory = {} as Memory;
    const baselineSpawn = vi.fn(() => 0);
    const isolatedSpawn = vi.fn(() => 0);
    const baseline = runTick({
      game: fundedContractGame(100, { includeCreep: false, spawnCreep: baselineSpawn }),
      memory: baselineMemory,
    });
    const recordSpy = vi.spyOn(TelemetryService.prototype, "record").mockImplementation(() => {
      throw new Error("injected reporter service failure");
    });
    const isolated = (() => {
      try {
        return runTick({
          game: fundedContractGame(100, { includeCreep: false, spawnCreep: isolatedSpawn }),
          memory: isolatedMemory,
        });
      } finally {
        recordSpy.mockRestore();
      }
    })();

    expect(isolatedSpawn.mock.calls).toEqual(baselineSpawn.mock.calls);
    expect(isolated.colony).toEqual(baseline.colony);
    expect(isolated.contracts).toEqual(baseline.contracts);
    expect(isolated.execution).toEqual(baseline.execution);
    expect(isolated.movement).toEqual(baseline.movement);
    expect(isolated.spawn).toEqual(baseline.spawn);
    expect(isolated.stateCommit).toMatchObject({ committed: true });
    expect(isolated.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(isolated.telemetry).toBeNull();
    expect(isolated.reporterStatus).toMatchObject({
      projectionStatus: "ready",
      observer: { status: "unavailable" },
      transitions: [],
    });
    if (baselineMemory.myrmex === undefined || isolatedMemory.myrmex === undefined) {
      throw new Error("expected both roots to commit");
    }
    const { telemetry: _baselineTelemetry, ...baselineGameplayOwners } = baselineMemory.myrmex;
    const { telemetry: _isolatedTelemetry, ...isolatedGameplayOwners } = isolatedMemory.myrmex;
    void _baselineTelemetry;
    void _isolatedTelemetry;
    expect(isolatedGameplayOwners).toEqual(baselineGameplayOwners);
  });

  it("rebuilds oversized reporter metadata without changing gameplay or mandatory completion", () => {
    const seeded = {} as Memory;
    runTick({
      game: {
        cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: {},
        rooms: {},
        shard: { name: "shard3" },
        time: 90,
      },
      memory: seeded,
    });
    const baselineMemory = JSON.parse(JSON.stringify(seeded)) as Memory;
    const hostileMemory = JSON.parse(JSON.stringify(seeded)) as Memory;
    const hostileTelemetry = hostileMemory.myrmex?.telemetry as Record<string, unknown> | undefined;
    if (hostileTelemetry === undefined) throw new Error("expected initialized telemetry owner");
    hostileTelemetry.reporter = {
      schemaVersion: 2,
      entries: {
        schemaVersion: 1,
        entries: Array.from({ length: 128 }, (_, index) => ({
          fingerprint: `fault:${index.toString(16).padStart(8, "0")}`,
          count: Number.MAX_SAFE_INTEGER,
          lastTick: 89,
          nextReminderTick: 90,
          reasonCode: "unexpected-exception",
        })),
      },
      recovery: {
        signature: "recovering",
        lastProgressTick: 89,
        reminderAtTick: 90,
        reminderCount: Number.MAX_SAFE_INTEGER,
        stuckReportedAtTick: 89,
        blockerRef: "recovery-blocker:deadbeef",
        blockerReasonCode: "none",
      },
    };
    const baselineSpawn = vi.fn(() => 0);
    const hostileSpawn = vi.fn(() => 0);

    const baseline = runTick({
      game: fundedContractGame(100, { includeCreep: false, spawnCreep: baselineSpawn }),
      memory: baselineMemory,
    });
    const hostile = runTick({
      game: fundedContractGame(100, { includeCreep: false, spawnCreep: hostileSpawn }),
      memory: hostileMemory,
    });

    expect(hostileSpawn.mock.calls).toEqual(baselineSpawn.mock.calls);
    expect(hostile.colony).toEqual(baseline.colony);
    expect(hostile.contracts).toEqual(baseline.contracts);
    expect(hostile.execution).toEqual(baseline.execution);
    expect(hostile.movement).toEqual(baseline.movement);
    expect(hostile.spawn).toEqual(baseline.spawn);
    expect(hostile.stateCommit).toEqual(baseline.stateCommit);
    expect(hostile.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(hostile.telemetry).not.toBeNull();
    expect(JSON.stringify(hostile.telemetry)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(JSON.stringify(hostileMemory.myrmex)).not.toContain(String(Number.MAX_SAFE_INTEGER));
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
    expect(outcome.stateCommit).toMatchObject({
      committed: true,
      owners: ["kernel", "telemetry"],
    });
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
      owners: ["config", "kernel", "colonies", "telemetry"],
    });
    expect(memory.myrmex?.contracts).toEqual({});
  });

  it("clears a published contract result when the atomic root commit is rejected", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
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
          game: gameAt(45),
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
    expect(outcome.telemetry?.reporterTransitions).toEqual([]);
    expect(outcome.reporterStatus.transitions).toEqual([]);
    expect(memory.myrmex?.contracts).toEqual({});
  });

  it("publishes reporter evidence only after its candidate owner commits", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
    runTick({ game: gameAt(44), memory });
    if (memory.myrmex?.kernel === undefined) throw new Error("expected initialized kernel owner");
    memory.myrmex.kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "cache.sweep",
          consecutiveFailures: 1,
          lastSuccessfulTick: 44,
          nextProbeTick: 100,
        },
      ],
    };
    const recordDescriptor = Object.getOwnPropertyDescriptor(TelemetryService.prototype, "record");
    if (typeof recordDescriptor?.value !== "function") {
      throw new TypeError("TelemetryService.record descriptor is unavailable");
    }
    const originalRecord = recordDescriptor.value as TelemetryService["record"];
    let rootReplaced = false;
    const recordSpy = vi.spyOn(TelemetryService.prototype, "record").mockImplementation(function (
      this: TelemetryService,
      owner,
      input,
    ) {
      const result = originalRecord.call(this, owner, input);
      if (!rootReplaced) {
        if (memory.myrmex === undefined) throw new Error("expected initialized Memory root");
        memory.myrmex = JSON.parse(JSON.stringify(memory.myrmex)) as NonNullable<Memory["myrmex"]>;
        rootReplaced = true;
      }
      return result;
    });
    const rejected = (() => {
      try {
        return runTick({ game: gameAt(45), memory });
      } finally {
        recordSpy.mockRestore();
      }
    })();

    expect(rejected.stateCommit).toEqual({
      committed: false,
      faults: [expect.objectContaining({ code: "stale-root" })],
    });
    expect(rejected.telemetry?.reporterTransitions).toEqual([]);
    expect(rejected.reporterStatus.transitions).toEqual([]);

    const recovered = runTick({ game: gameAt(46), memory });
    const quiet = runTick({ game: gameAt(47), memory });
    expect(recovered.telemetry?.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(recovered.reporterStatus.transitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(quiet.telemetry?.reporterTransitions).toEqual([]);
    expect(quiet.reporterStatus.transitions).toEqual([]);
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
    expect(accepted.stateCommit).toMatchObject({
      committed: true,
      owners: ["config", "kernel", "telemetry"],
    });

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
    expect(rejected.stateCommit).toMatchObject({
      committed: true,
      owners: ["kernel", "telemetry"],
    });
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
    expect(telemetrySystem).toMatchObject({ status: "completed", cpuUsed: 0 });
    expect(outcome.kernel.cpuUsed).toBe(2.75);
    expect(outcome.kernel.overheadCpu).toBe(2);
    expect(phaseCpu + outcome.kernel.overheadCpu).toBe(outcome.kernel.cpuUsed);
    expect(outcome.telemetry).toMatchObject({ cacheEntries: 2, cacheNamespaces: 3 });
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
    expect(outcome.reporterStatus.transitions).toEqual([]);
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

  it("keeps unpersistable mandatory-tail health out of durable reporter transitions", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    });
    runTick({ game: gameAt(80), memory });
    if (memory.myrmex?.kernel === undefined) throw new Error("expected initialized kernel owner");
    memory.myrmex.kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "state.reconcile",
          consecutiveFailures: 1,
          lastSuccessfulTick: 79,
          nextProbeTick: null,
        },
        {
          systemId: "telemetry.minimum",
          consecutiveFailures: 1,
          lastSuccessfulTick: 79,
          nextProbeTick: null,
        },
      ],
    };

    const outcome = runTick({ game: gameAt(81), memory });

    expect(outcome.kernel.faults).toEqual([]);
    expect(outcome.telemetry?.reporterTransitions).toEqual([]);
    expect(outcome.reporterStatus.transitions).toEqual([]);
    expect(outcome.stateCommit).toMatchObject({ committed: true });
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
  readonly controllerLevel?: number;
  readonly cpuGetUsed?: () => number;
  readonly creepName?: string;
  readonly energy?: number;
  readonly energyCapacity?: number;
  readonly includeCreep?: boolean;
  readonly includeSecondSpawn?: boolean;
  readonly legalCreep?: boolean;
  readonly spawning?: { readonly creepName: string; readonly remainingTime: number };
  readonly spawnCreep?: (...arguments_: unknown[]) => number;
  readonly ticksToLive?: number;
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
      const harvested = Math.min(2, 50 - world.workerEnergy, source.energy);
      world.workerEnergy += harvested;
      source.energy -= harvested;
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
    getTerrain: () => PLAIN_ROOM_TERRAIN,
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
    ticksToLive: options.ticksToLive ?? 100,
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
    spawning:
      options.spawning === undefined
        ? null
        : {
            name: options.spawning.creepName,
            needTime: 9,
            remainingTime: options.spawning.remainingTime,
          },
    store,
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const secondSpawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-budget-2",
    my: true,
    name: "Spawn2",
    owner: { username: "Myrmex" },
    pos: { roomName: "W1N1", x: 12, y: 11 },
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
      level: options.controllerLevel ?? 1,
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
    getTerrain: () => PLAIN_ROOM_TERRAIN,
    find: (findType: number): unknown[] => {
      if (findType === FIND_CREEPS_VALUE) {
        return includeCreep ? [creep] : [];
      }
      if (findType === FIND_STRUCTURES_VALUE) {
        return options.includeSecondSpawn ? [spawn, secondSpawn] : [spawn];
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
    getObjectById: (id: string) =>
      id === spawn.id ? spawn : id === secondSpawn.id ? secondSpawn : null,
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

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
