import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  layoutExtensionEvacuationBudgetIssuer,
  layoutExtensionEvacuationFlowId,
  layoutTowerEvacuationBudgetIssuer,
  layoutTowerEvacuationFlowId,
  parseLayoutsOwner,
  reconcileStaleLayoutRemovalReceipt,
  reconcileStaleLayoutSiteReceipt,
  type LayoutLabEvacuation,
  type LayoutsOwnerV25,
  type LayoutStorageEvacuation,
  type LayoutTerminalEvacuation,
} from "../src/layout";
import { reservationIdFor, type BudgetRequest } from "../src/colony";
import { contractIdFor, requestSignature, type WorkContractRequest } from "../src/contracts";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const ROOM_NAME = "W1N1";

interface StaleSiteEvidence {
  readonly ownership: "foreign" | "owned";
  readonly structureType: string;
  readonly x: number;
  readonly y: number;
}

type CompletedStaleEvacuationKind =
  "container" | "extension" | "lab" | "link" | "spawn" | "storage" | "terminal" | "tower";

interface GameOptions {
  readonly blockedTerrain?: boolean;
  readonly controllerLevel?: number;
  readonly controllerRisk?: boolean;
  readonly reverse?: boolean;
  readonly roomEnergyAvailable?: number;
  readonly roomEnergyCapacityAvailable?: number;
  readonly staleExtensionEvacuation?: {
    readonly replacementEnergy: number;
    readonly sourceEnergy: number;
  };
  readonly staleTowerEvacuation?: {
    readonly replacementEnergy: number;
    readonly sourceEnergy: number;
  };
  readonly staleRemovalTarget?: boolean;
  readonly staleRemovalTargetType?: CompletedStaleEvacuationKind;
  readonly staleSiteEvidence?: StaleSiteEvidence;
  readonly storageTerminalActive?: boolean;
  readonly storageTerminalCapacity?: number;
  readonly unavailableIndustryTerminalWork?: boolean;
  readonly storageTerminalResources?: readonly (readonly [string, number])[];
  readonly staticMiner?: boolean;
  readonly threat?: boolean;
  readonly visible?: boolean;
}

interface Commands {
  readonly createConstructionSite: ReturnType<typeof vi.fn<() => number>>;
  readonly destroyStructure: ReturnType<typeof vi.fn<() => number>>;
  readonly transferEnergy: ReturnType<typeof vi.fn<() => number>>;
  readonly withdrawEnergy: ReturnType<typeof vi.fn<() => number>>;
}

const LAB_EVACUATION_VARIANTS = [
  {
    evacuation: {
      amount: 100,
      expiresAt: 250,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 0,
      sourceId: "lab-obsolete",
      startedAt: 100,
    },
    name: "energy-only",
  },
  {
    evacuation: {
      amount: 100,
      destinationId: "storage-destination",
      destinationInitialAmount: 0,
      expiresAt: 250,
      replacementId: "lab-replacement",
      resourceType: "H",
      sourceId: "lab-obsolete",
      startedAt: 100,
    },
    name: "mineral-only storage",
  },
  {
    evacuation: {
      amount: 100,
      destinationId: "terminal-destination",
      destinationInitialAmount: 0,
      destinationStructureType: "terminal",
      expiresAt: 250,
      replacementId: "lab-replacement",
      resourceType: "H",
      sourceId: "lab-obsolete",
      startedAt: 100,
    },
    name: "mineral-only terminal",
  },
  {
    evacuation: {
      destinationId: "storage-destination",
      destinationInitialAmount: 0,
      energyAmount: 100,
      expiresAt: 250,
      mineralAmount: 100,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 0,
      resourceType: "H",
      sourceId: "lab-obsolete",
      startedAt: 100,
    },
    name: "mixed storage",
  },
  {
    evacuation: {
      destinationId: "terminal-destination",
      destinationInitialAmount: 0,
      destinationStructureType: "terminal",
      energyAmount: 100,
      expiresAt: 250,
      mineralAmount: 100,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 0,
      resourceType: "H",
      sourceId: "lab-obsolete",
      startedAt: 100,
    },
    name: "mixed terminal",
  },
] as const satisfies readonly {
  readonly evacuation: LayoutLabEvacuation;
  readonly name: string;
}[];

const STORAGE_EVACUATION_VARIANTS = [
  {
    evacuation: {
      amount: 100,
      expiresAt: 250,
      resourceType: "energy",
      sourceId: "storage-obsolete",
      startedAt: 100,
      terminalId: "storage-replacement",
      terminalInitialAmount: 50,
    },
    name: "single resource",
  },
  {
    evacuation: {
      expiresAt: 250,
      resourceManifest: [
        ["H", 100, 10],
        ["O", 100, 20],
        ["U", 100, 30],
        ["X", 100, 40],
        ["Z", 100, 50],
        ["energy", 100, 60],
        ["power", 100, 70],
        ["silicon", 100, 80],
      ],
      sourceId: "storage-obsolete",
      startedAt: 100,
      terminalId: "storage-replacement",
    },
    name: "eight-resource manifest",
  },
  {
    evacuation: {
      amount: 4_000,
      expiresAt: 400,
      resourceType: "energy",
      settledAmount: 3_000,
      sourceId: "storage-obsolete",
      startedAt: 100,
      terminalId: "storage-replacement",
      terminalInitialAmount: 50,
    },
    name: "two-batch single resource",
  },
  {
    evacuation: {
      expiresAt: 400,
      resourceManifest: [
        ["H", 2_000, 10],
        ["energy", 2_000, 20],
      ],
      settledAmount: 3_000,
      sourceId: "storage-obsolete",
      startedAt: 100,
      terminalId: "storage-replacement",
    },
    name: "two-batch manifest",
  },
] as const satisfies readonly {
  readonly evacuation: LayoutStorageEvacuation;
  readonly name: string;
}[];

const TERMINAL_EVACUATION_VARIANTS = [
  {
    evacuation: {
      amount: 100,
      expiresAt: 250,
      replacementId: "terminal-replacement",
      replacementInitialAmount: 0,
      resourceType: "energy",
      sourceId: "terminal-obsolete",
      startedAt: 100,
    },
    name: "single resource",
  },
  {
    evacuation: {
      expiresAt: 250,
      replacementId: "terminal-replacement",
      resourceManifest: [
        ["H", 100, 0],
        ["O", 100, 0],
        ["U", 100, 0],
        ["X", 100, 0],
        ["Z", 100, 0],
        ["energy", 100, 0],
        ["power", 100, 0],
        ["silicon", 100, 0],
      ],
      sourceId: "terminal-obsolete",
      startedAt: 100,
    },
    name: "eight-resource manifest",
  },
] as const satisfies readonly {
  readonly evacuation: LayoutTerminalEvacuation;
  readonly name: string;
}[];

type StaleActiveEvidence =
  | "completed-container-migration"
  | "completed-container-migration-with-site"
  | "completed-extension-evacuation"
  | "completed-extension-evacuation-with-site"
  | "completed-extension-evacuation-with-source-handoff"
  | "completed-lab-evacuation"
  | "completed-lab-evacuation-with-site"
  | "completed-link-evacuation"
  | "completed-link-evacuation-with-site"
  | "completed-spawn-evacuation"
  | "completed-spawn-evacuation-with-site"
  | "completed-storage-evacuation"
  | "completed-storage-evacuation-with-site"
  | "completed-terminal-evacuation"
  | "completed-terminal-evacuation-with-site"
  | "completed-tower-evacuation"
  | "completed-tower-evacuation-with-site"
  | "container-migration"
  | "evacuation"
  | "site-receipt"
  | "source-handoff"
  | "tower-evacuation"
  | null;

describe("stale layout revision runtime handoff (#385/#387/#389/#391/#393/#395/#397/#399/#401/#403/#405/#407/#409/#413/#415)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("persists one command-free handoff, then resumes ordinary convergence", () => {
    const forward = runHandoffVariant(false, false);
    const reset = runHandoffVariant(false, true);
    const reordered = runHandoffVariant(true, false);

    expect(forward.handoffCalls).toBe(0);
    expect(forward.followingCalls).toBe(1);
    expect(forward.followingAccepted).toBe(1);
    expect(forward.followingPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "complete" }),
    ]);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.owner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      schemaVersion: 25,
      staleRecords: [],
    });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("continues one stale extension evacuation through the existing funded logistics path", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleOwner(memory, "evacuation");
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const pending = runTick({
      game: game(202, commands, {
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 800,
        staleExtensionEvacuation: { replacementEnergy: 0, sourceEnergy: 50 },
      }),
      memory,
    });
    const record = layoutsOwner(memory).staleRecords[0];
    const evacuation = record?.extensionEvacuation;
    if (evacuation === undefined) throw new Error("expected stale extension evacuation");
    const budgetIssuer = layoutExtensionEvacuationBudgetIssuer(ROOM_NAME, evacuation);
    const flowId = layoutExtensionEvacuationFlowId(ROOM_NAME, evacuation);
    const contracts = memory.myrmex?.contracts as
      | {
          readonly active?: readonly {
            readonly execution?: { readonly flowId?: string };
            readonly state?: string;
          }[];
        }
      | undefined;

    expect(pending.kernel.faults).toEqual([]);
    expect(pending.colony.reservations).toContainEqual(
      expect.objectContaining({
        category: "optional-growth",
        colonyId: ROOM_NAME,
        issuer: budgetIssuer,
        status: "active",
      }),
    );
    expect(contracts?.active?.some(({ execution }) => execution?.flowId === flowId)).toBe(true);
    expect(pending.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(layoutsOwner(memory).records).toEqual([]);
    expect(layoutsOwner(memory).staleRecords[0]?.extensionEvacuation).toEqual(evacuation);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it("settles delivered stale extension stock command-free before a later revision handoff", async () => {
    const forward = await runCompletedStaleExtensionEvacuationVariant(false, false);
    const reset = await runCompletedStaleExtensionEvacuationVariant(false, true);
    const reordered = await runCompletedStaleExtensionEvacuationVariant(true, false);

    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.settlementOwner.records).toEqual([]);
    expect(forward.settlementOwner.staleRecords).toHaveLength(1);
    expect(forward.settlementOwner.staleRecords[0]?.extensionEvacuation).toBeUndefined();
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffOwner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      staleRecords: [],
    });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it.each([
    { name: "threat", options: { threat: true } },
    { name: "controller risk", options: { controllerRisk: true } },
  ] as const)("preserves delivered stale extension stock under $name", ({ options }) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleOwner(memory, "evacuation");
    const before = layoutsOwner(memory);
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const blocked = runTick({
      game: game(202, commands, {
        ...options,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 800,
        staleExtensionEvacuation: { replacementEnergy: 50, sourceEnergy: 0 },
      }),
      memory,
    });

    expect(layoutsOwner(memory)).toEqual(before);
    expect(blocked.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it.each([
    { name: "threat", options: { threat: true } },
    { name: "controller risk", options: { controllerRisk: true } },
  ] as const)("does not continue pending stale extension work under $name", ({ options }) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleOwner(memory, "evacuation");
    const evacuation = layoutsOwner(memory).staleRecords[0]?.extensionEvacuation;
    if (evacuation === undefined) throw new Error("expected stale extension evacuation");
    const budgetIssuer = layoutExtensionEvacuationBudgetIssuer(ROOM_NAME, evacuation);
    const flowId = layoutExtensionEvacuationFlowId(ROOM_NAME, evacuation);
    if (budgetIssuer === null) throw new Error("evacuation identity overflowed");

    const blocked = runTick({
      game: game(202, commands, {
        ...options,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 800,
        staleExtensionEvacuation: { replacementEnergy: 10, sourceEnergy: 40 },
      }),
      memory,
    });
    const contracts = memory.myrmex?.contracts as
      | {
          readonly active?: readonly {
            readonly execution?: { readonly counterpartId?: string; readonly flowId?: string };
            readonly targetId?: string;
          }[];
        }
      | undefined;

    expect(blocked.colony.reservations).not.toContainEqual(
      expect.objectContaining({ issuer: budgetIssuer, status: "active" }),
    );
    expect(contracts?.active?.some(({ execution }) => execution?.flowId === flowId)).not.toBe(true);
    expect(
      contracts?.active?.some(
        ({ execution, targetId }) =>
          targetId === evacuation.sourceId ||
          targetId === evacuation.replacementId ||
          execution?.counterpartId === evacuation.sourceId ||
          execution?.counterpartId === evacuation.replacementId,
      ),
    ).not.toBe(true);
    expect(layoutsOwner(memory).staleRecords[0]?.extensionEvacuation).toEqual(evacuation);
  });

  it("continues one stale tower evacuation through the existing funded logistics path", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands, { controllerLevel: 5 }), memory });
    runTick({ game: game(101, commands, { controllerLevel: 5 }), memory });
    seedStaleOwner(memory, "tower-evacuation");
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const pending = runTick({
      game: game(202, commands, {
        controllerLevel: 5,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 1_800,
        staleTowerEvacuation: { replacementEnergy: 10, sourceEnergy: 500 },
      }),
      memory,
    });
    const record = layoutsOwner(memory).staleRecords[0];
    const evacuation = record?.towerEvacuation;
    if (evacuation === undefined) throw new Error("expected stale tower evacuation");
    const budgetIssuer = layoutTowerEvacuationBudgetIssuer(ROOM_NAME, evacuation);
    const flowId = layoutTowerEvacuationFlowId(ROOM_NAME, evacuation);
    const contracts = memory.myrmex?.contracts as
      | {
          readonly active?: readonly {
            readonly execution?: { readonly flowId?: string };
          }[];
        }
      | undefined;

    expect(pending.kernel.faults).toEqual([]);
    expect(pending.colony.reservations).toContainEqual(
      expect.objectContaining({
        category: "optional-growth",
        colonyId: ROOM_NAME,
        issuer: budgetIssuer,
        status: "active",
      }),
    );
    expect(contracts?.active?.some(({ execution }) => execution?.flowId === flowId)).toBe(true);
    expect(layoutsOwner(memory).records).toEqual([]);
    expect(layoutsOwner(memory).staleRecords[0]?.towerEvacuation).toEqual(evacuation);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it("settles delivered stale tower stock command-free before a later revision handoff", async () => {
    const forward = await runCompletedStaleTowerEvacuationVariant(false, false);
    const reset = await runCompletedStaleTowerEvacuationVariant(false, true);
    const reordered = await runCompletedStaleTowerEvacuationVariant(true, false);

    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.settlementOwner.records).toEqual([]);
    expect(forward.settlementOwner.staleRecords).toHaveLength(1);
    expect(forward.settlementOwner.staleRecords[0]?.towerEvacuation).toBeUndefined();
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffOwner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      staleRecords: [],
    });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it.each([
    { name: "threat", options: { threat: true } },
    { name: "controller risk", options: { controllerRisk: true } },
  ] as const)("does not continue pending stale tower work under $name", ({ options }) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands, { controllerLevel: 5 }), memory });
    runTick({ game: game(101, commands, { controllerLevel: 5 }), memory });
    seedStaleOwner(memory, "tower-evacuation");
    const evacuation = layoutsOwner(memory).staleRecords[0]?.towerEvacuation;
    if (evacuation === undefined) throw new Error("expected stale tower evacuation");
    const budgetIssuer = layoutTowerEvacuationBudgetIssuer(ROOM_NAME, evacuation);
    const flowId = layoutTowerEvacuationFlowId(ROOM_NAME, evacuation);

    const blocked = runTick({
      game: game(202, commands, {
        ...options,
        controllerLevel: 5,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 1_800,
        staleTowerEvacuation: { replacementEnergy: 20, sourceEnergy: 490 },
      }),
      memory,
    });
    const contracts = memory.myrmex?.contracts as
      | {
          readonly active?: readonly {
            readonly execution?: { readonly counterpartId?: string; readonly flowId?: string };
            readonly targetId?: string;
          }[];
        }
      | undefined;

    expect(blocked.colony.reservations).not.toContainEqual(
      expect.objectContaining({ issuer: budgetIssuer, status: "active" }),
    );
    expect(contracts?.active?.some(({ execution }) => execution?.flowId === flowId)).not.toBe(true);
    expect(
      contracts?.active?.some(
        ({ execution, targetId }) =>
          targetId === evacuation.sourceId ||
          targetId === evacuation.replacementId ||
          execution?.counterpartId === evacuation.sourceId ||
          execution?.counterpartId === evacuation.replacementId,
      ),
    ).not.toBe(true);
    expect(layoutsOwner(memory).staleRecords[0]?.towerEvacuation).toEqual(evacuation);
  });

  it("blocks an existing stale tower lease when colony policy turns unsafe", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands, { controllerLevel: 5, staticMiner: true }), memory });
    runTick({ game: game(101, commands, { controllerLevel: 5, staticMiner: true }), memory });
    seedStaleOwner(memory, "tower-evacuation");
    const evacuation = layoutsOwner(memory).staleRecords[0]?.towerEvacuation;
    if (evacuation === undefined) throw new Error("expected stale tower evacuation");
    const flowId = layoutTowerEvacuationFlowId(ROOM_NAME, evacuation);
    const safeGame = (tick: number) =>
      game(tick, commands, {
        controllerLevel: 5,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 1_800,
        staleTowerEvacuation: { replacementEnergy: 10, sourceEnergy: 500 },
        staticMiner: true,
      });
    runTick({ game: safeGame(202), memory });
    runTick({ game: safeGame(203), memory });
    runTick({ game: safeGame(204), memory });
    runTick({ game: safeGame(205), memory });
    const contractsBefore = memory.myrmex?.contracts as
      | {
          readonly active?: readonly {
            readonly execution?: { readonly flowId?: string };
            readonly lease?: unknown;
            readonly state?: string;
          }[];
        }
      | undefined;
    expect(
      contractsBefore?.active?.some(
        ({ execution, lease, state }) =>
          execution?.flowId === flowId &&
          lease !== null &&
          (state === "assigned" || state === "active"),
      ),
    ).toBe(true);
    expect(commands.withdrawEnergy).toHaveBeenCalled();
    commands.transferEnergy.mockClear();
    commands.withdrawEnergy.mockClear();

    runTick({
      game: game(206, commands, {
        controllerLevel: 5,
        roomEnergyAvailable: 350,
        roomEnergyCapacityAvailable: 1_800,
        staleTowerEvacuation: { replacementEnergy: 10, sourceEnergy: 500 },
        staticMiner: true,
        threat: true,
      }),
      memory,
    });
    const contractsAfter = memory.myrmex?.contracts as typeof contractsBefore;

    expect(commands.withdrawEnergy).not.toHaveBeenCalled();
    expect(commands.transferEnergy).not.toHaveBeenCalled();
    expect(
      contractsAfter?.active?.some(
        ({ execution, lease, state }) =>
          execution?.flowId === flowId &&
          lease !== null &&
          (state === "assigned" || state === "active"),
      ),
    ).not.toBe(true);
  });

  it("reconciles one settled stale source-service issuance without interrupting mining", async () => {
    const forward = await runSettledStaleSourceServiceVariant(false, false);
    const reset = await runSettledStaleSourceServiceVariant(false, true);
    const reordered = await runSettledStaleSourceServiceVariant(true, false);

    expect(forward.kernelFaults).toEqual([]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.sourceServices).toHaveLength(1);
    expect(forward.sourceServices?.[0]).toMatchObject({
      pos: { roomName: ROOM_NAME },
      service: { issuerSequence: 2, kind: "source-container", sourceId: `source-${ROOM_NAME}` },
    });
    expect(forward.handoffMiningReservations).toHaveLength(1);
    expect(forward.handoffMiningReservations[0]).toMatchObject({
      category: "harvesting-filling",
      colonyId: ROOM_NAME,
      issuer: `mining/${ROOM_NAME}/source-${ROOM_NAME}`,
      request: { revision: 2 },
      status: "active",
    });
    expect(forward.handoffMiningTransitions).toEqual([
      { accepted: true, contractId: forward.contractId, from: "assigned", to: "active" },
    ]);
    expect(forward.activeMining).toHaveLength(1);
    expect(forward.activeMining[0]).toMatchObject({
      id: forward.contractId,
      issuerSequence: 2,
    });
    expect(["assigned", "active"]).toContain(forward.activeMining[0]?.state);
    expect(forward.activeMining[0]?.lease?.actorId).toBe(forward.expectedActorId);
    expect(forward.miningOutcomes).toEqual([]);
    expect(forward.handoffReplacements).toEqual([]);
    expect(forward.followingReplacements).toEqual([]);
    expect(forward.followingSubmissions).toEqual([
      expect.objectContaining({
        accepted: true,
        contractId: forward.contractId,
        outcome: "duplicate-active",
      }),
    ]);
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("admits exact stale mining through bounded RCL8 infrastructure recovery", async () => {
    const mature = await runSettledStaleSourceServiceVariant(false, false, 8);

    expect(mature.kernelFaults).toEqual([]);
    expect(mature.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(mature.handoffMiningReservations).toHaveLength(1);
    expect(mature.handoffMiningReservations[0]).toMatchObject({
      category: "harvesting-filling",
      colonyId: ROOM_NAME,
      request: { revision: 2 },
      status: "active",
    });
    expect(mature.activeMining).toHaveLength(1);
    expect(mature.miningOutcomes).toEqual([]);
  });

  it("does not renew exact stale mining when policy blocks the handoff", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands, { staticMiner: true }), memory });
    runTick({ game: game(101, commands, { staticMiner: true }), memory });
    runTick({ game: game(102, commands, { staticMiner: true }), memory });
    const { contractId } = seedSettledStaleSourceService(memory);
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const blocked = runTick({
      game: game(103, commands, { staticMiner: true, threat: true }),
      memory,
    });
    const contracts = memory.myrmex?.contracts as
      { active?: Array<{ id?: string; state?: string }> } | undefined;

    expect(blocked.layout.planning).toEqual([
      expect.objectContaining({ blocker: "revision-handoff-active", roomName: ROOM_NAME }),
    ]);
    expect(
      blocked.colony.reservations.filter(({ issuer }) => issuer.startsWith("mining/")),
    ).toEqual([expect.objectContaining({ status: "released" })]);
    expect(contracts?.active?.find(({ id }) => id === contractId)?.state).toBe("suspended");
    expect(layoutsOwner(memory).records).toEqual([]);
    expect(layoutsOwner(memory).staleRecords).toHaveLength(1);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it("rejects a handoff funded only by a later mining reservation revision", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands, { staticMiner: true }), memory });
    runTick({ game: game(101, commands, { staticMiner: true }), memory });
    runTick({ game: game(102, commands, { staticMiner: true }), memory });
    const { contractId } = seedSettledStaleSourceService(memory);
    advanceMiningReservation(memory, 3);
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const rejected = runTick({ game: game(103, commands, { staticMiner: true }), memory });

    expect(rejected.kernel.faults).toEqual([]);
    expect(rejected.layout.planning).toEqual([
      expect.objectContaining({ blocker: "revision-handoff-active", roomName: ROOM_NAME }),
    ]);
    const miningReservations = rejected.colony.reservations.filter(({ issuer }) =>
      issuer.startsWith("mining/"),
    );
    expect(miningReservations).toHaveLength(1);
    expect(miningReservations[0]).toMatchObject({
      category: "harvesting-filling",
      colonyId: ROOM_NAME,
      request: { revision: 3 },
      status: "active",
    });
    expect(
      rejected.contracts?.submissions.filter((submission) => submission.contractId === contractId),
    ).toEqual([]);
    const contracts = memory.myrmex?.contracts as
      { active?: Array<{ id?: string; state?: string }> } | undefined;
    expect(contracts?.active?.find(({ id }) => id === contractId)?.state).toBe("suspended");
    expect(layoutsOwner(memory).records).toEqual([]);
    expect(layoutsOwner(memory).staleRecords).toHaveLength(1);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it("suppresses every room's layout commands while admitting only one stale handoff", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(300, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(301, firstCommands, secondCommands), memory });
    seedStaleOwner(memory, null, "W1N1");
    firstCommands.createConstructionSite.mockClear();
    secondCommands.createConstructionSite.mockClear();

    const handoff = runTick({ game: twoRoomGame(302, firstCommands, secondCommands), memory });

    expect(handoff.layout.planning).toEqual([
      expect.objectContaining({ roomName: "W1N1", status: "handoff" }),
    ]);
    expect(handoff.layout.arbitration?.accepted).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();

    runTick({ game: twoRoomGame(303, firstCommands, secondCommands), memory });
    expect(
      firstCommands.createConstructionSite.mock.calls.length +
        secondCommands.createConstructionSite.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("suppresses every room's site/removal output while settling one stale receipt", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(300, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(301, firstCommands, secondCommands), memory });
    const target = seedStaleSiteReceipt(memory, {});
    firstCommands.createConstructionSite.mockClear();
    secondCommands.createConstructionSite.mockClear();

    const settlement = runTick({
      game: twoRoomGame(302, firstCommands, secondCommands, {
        staleSiteEvidence: {
          ownership: "owned",
          structureType: target.structureType,
          x: target.x,
          y: target.y,
        },
      }),
      memory,
    });

    expect(settlement.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(settlement.layout.arbitration?.intents).toEqual([]);
    expect(settlement.layout.execution).toEqual([]);
    expect(settlement.layout.migration.proposals).toEqual([]);
    expect(settlement.layout.migration.arbitration?.intents ?? []).toEqual([]);
    expect(settlement.layout.migration.execution).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
    expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
  });

  it.each(["container", "extension", "lab", "link", "spawn", "terminal", "tower"] as const)(
    "suppresses every room's layout commands while settling one stale %s pair",
    (kind) => {
      const firstCommands = commandSpies();
      const secondCommands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: twoRoomGame(100, firstCommands, secondCommands), memory });
      runTick({ game: twoRoomGame(101, firstCommands, secondCommands), memory });
      seedStaleRemovalReceipt(memory, {}, completedStaleEvidence(kind));
      runTick({
        game: twoRoomGame(102, firstCommands, secondCommands, {
          staleRemovalTarget: true,
          staleRemovalTargetType: kind,
        }),
        memory,
      });
      const priorOwner = layoutsOwner(memory);
      const priorOtherRoom = priorOwner.records.find(({ roomName }) => roomName === "W2N2");
      if (priorOtherRoom === undefined) throw new Error("expected unaffected second-room record");
      firstCommands.createConstructionSite.mockClear();
      firstCommands.destroyStructure.mockClear();
      secondCommands.createConstructionSite.mockClear();
      secondCommands.destroyStructure.mockClear();

      const settlement = runTick({ game: twoRoomGame(103, firstCommands, secondCommands), memory });

      const settledOwner = layoutsOwner(memory);
      const settledRecord = settledOwner.staleRecords[0];
      expect(settledOwner.revision).toBe(priorOwner.revision + 1);
      expect(staleEvacuation(settledRecord, kind)).toBeUndefined();
      expect(settledRecord?.removalReceipt).toBeUndefined();
      expect(settledOwner.records.find(({ roomName }) => roomName === "W2N2")).toEqual(
        priorOtherRoom,
      );
      expect(settlement.layout.planning).toEqual([
        expect.objectContaining({
          blocker: "revision-handoff-active",
          roomName: ROOM_NAME,
          status: "degraded",
        }),
      ]);
      expect(settlement.layout.arbitration?.accepted ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.deferred ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.intents ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.rejected ?? []).toEqual([]);
      expect(settlement.layout.execution).toEqual([]);
      expect(settlement.layout.migration.proposals).toEqual([]);
      expect(settlement.layout.migration.arbitration?.intents ?? []).toEqual([]);
      expect(settlement.layout.migration.execution).toEqual([]);
      expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
      expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
      expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
      expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
    },
  );

  it("suppresses every room's layout output while settling one stale storage pair", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    const storageOptions = {
      controllerLevel: 6,
      roomEnergyAvailable: 2_300,
      roomEnergyCapacityAvailable: 2_300,
      staleRemovalTargetType: "storage" as const,
      storageTerminalResources: [["energy", 150]] as const,
    };
    runTick({ game: twoRoomGame(100, firstCommands, secondCommands, storageOptions), memory });
    runTick({ game: twoRoomGame(101, firstCommands, secondCommands, storageOptions), memory });
    seedStaleRemovalReceipt(memory, {}, "completed-storage-evacuation");
    runTick({
      game: twoRoomGame(102, firstCommands, secondCommands, {
        ...storageOptions,
        staleRemovalTarget: true,
      }),
      memory,
    });
    firstCommands.createConstructionSite.mockClear();
    firstCommands.destroyStructure.mockClear();
    secondCommands.createConstructionSite.mockClear();
    secondCommands.destroyStructure.mockClear();

    const settlement = runTick({
      game: twoRoomGame(103, firstCommands, secondCommands, storageOptions),
      memory,
    });

    expect(layoutsOwner(memory).staleRecords[0]?.storageEvacuation).toBeUndefined();
    expect(settlement.layout.arbitration?.intents ?? []).toEqual([]);
    expect(settlement.layout.execution).toEqual([]);
    expect(settlement.layout.migration.proposals).toEqual([]);
    expect(settlement.layout.migration.execution).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
  });

  it("settles an exact owned construction-site observation without changing another receipt", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    const target = seedStaleSiteReceipt(memory, {});
    const owner = layoutsOwner(memory);
    const staleRecord = owner.staleRecords[0];
    const successfulReceipt = staleRecord?.siteReceipts?.[0];
    if (staleRecord === undefined || successfulReceipt === undefined)
      throw new Error("expected one stale successful site receipt");
    const ownerWithPending = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...staleRecord,
          siteReceipts: [
            successfulReceipt,
            { ...successfulReceipt, code: "ERR_FULL" },
            successfulReceipt,
          ],
        },
      ],
    });
    if (ownerWithPending === null) throw new Error("expected valid stale receipt owner");
    const serializedOwner: unknown = JSON.parse(JSON.stringify(ownerWithPending));
    const resetOwner = parseLayoutsOwner(serializedOwner);
    if (resetOwner === null) throw new Error("expected reset stale receipt owner");
    const constructionSites = [
      {
        id: "observed-site",
        ownerUsername: "Myrmex",
        ownership: "owned" as const,
        pos: { roomName: ROOM_NAME, x: target.x, y: target.y },
        progress: 0,
        progressTotal: 5_000,
        structureType: target.structureType,
      },
    ];
    const reconcile = (candidate: LayoutsOwnerV25) =>
      reconcileStaleLayoutSiteReceipt({
        constructionSites,
        observedAt: 102,
        owner: candidate,
        roomName: ROOM_NAME,
        structures: [],
      });

    const result = reconcile(ownerWithPending);
    const resetResult = reconcile(resetOwner);

    expect(result.settled).toMatchObject({ code: "OK" });
    expect(result.owner.staleRecords).toHaveLength(1);
    expect(result.owner.staleRecords[0]?.siteReceipts?.map(({ code }) => code)).toEqual([
      "ERR_FULL",
      "OK",
    ]);
    expect(resetResult).toEqual(result);
    const observedSite = constructionSites[0];
    if (observedSite === undefined) throw new Error("expected observed site fixture");

    const crossRoom = reconcileStaleLayoutSiteReceipt({
      constructionSites: [
        {
          ...observedSite,
          pos: { roomName: "W2N2", x: target.x, y: target.y },
        },
      ],
      observedAt: 102,
      owner: ownerWithPending,
      roomName: ROOM_NAME,
      structures: [],
    });
    expect(crossRoom.settled).toBeNull();
    expect(crossRoom.owner).toBe(ownerWithPending);
  });

  it("settles one freshly observed stale site before a later command-free handoff", () => {
    const forward = runStaleSiteSettlementVariant(false, false);
    const reset = runStaleSiteSettlementVariant(false, true);
    const reordered = runStaleSiteSettlementVariant(true, false);

    expect(forward.settlementCalls).toBe(0);
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.settledOwner.records).toEqual([]);
    expect(forward.settledOwner.staleRecords).toHaveLength(1);
    expect(forward.settledOwner.staleRecords[0]?.siteReceipts).toBeUndefined();
    expect(forward.handoffCalls).toBe(0);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffOwner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      staleRecords: [],
    });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("settles one successful stale removal from newer complete target absence", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, {});
    const owner = layoutsOwner(memory);
    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: null,
      observedAt: 102,
      owner,
      roomName: ROOM_NAME,
      structures: [],
    });

    expect(result.settled).toMatchObject({ code: "OK", targetId: "extension-obsolete" });
    expect(result.owner.staleRecords).toHaveLength(1);
    expect(result.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");
    const priorRecord = owner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected stale removal record");
    const { removalReceipt: _removalReceipt, ...retained } = priorRecord;
    void _removalReceipt;
    expect(result.owner.staleRecords[0]).toEqual(retained);

    const targetAbsentOwner = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...priorRecord,
          removalReceipt: { ...priorRecord.removalReceipt, code: "TARGET_ABSENT" },
        },
      ],
    });
    if (targetAbsentOwner === null) throw new Error("expected target-absent stale receipt owner");
    expect(
      reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: targetAbsentOwner,
        roomName: ROOM_NAME,
        structures: [],
      }).settled,
    ).toMatchObject({ code: "TARGET_ABSENT" });
  });

  it.each(["ERR_NOT_OWNER", "ERR_BUSY", "ERR_INVALID_TARGET", "UNEXPECTED"] as const)(
    "settles one failed stale %s receipt only from newer target presence",
    (code) => {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(memory, {
        attempt: 3,
        code,
        nextEligibleTick: Number.MAX_SAFE_INTEGER,
      });
      const owner = layoutsOwner(memory);
      const resetOwner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner)));
      if (resetOwner === null) throw new Error("expected reset stale failed receipt owner");
      const settle = (candidate: LayoutsOwnerV25) =>
        reconcileStaleLayoutRemovalReceipt({
          blocker: null,
          observedAt: 102,
          owner: candidate,
          roomName: ROOM_NAME,
          structures: [{ id: "extension-obsolete" }],
        });

      const result = settle(owner);
      const priorRecord = owner.staleRecords[0];
      if (priorRecord === undefined) throw new Error("expected stale failed receipt record");
      const { removalReceipt: _removalReceipt, ...retained } = priorRecord;
      void _removalReceipt;
      expect(result.settled).toMatchObject({ attempt: 3, code, targetId: "extension-obsolete" });
      expect(result.owner).toEqual({
        ...owner,
        revision: owner.revision + 1,
        staleRecords: [retained],
      });
      expect(settle(resetOwner)).toEqual(result);
      expect(
        reconcileStaleLayoutRemovalReceipt({
          blocker: null,
          observedAt: 102,
          owner,
          roomName: ROOM_NAME,
          structures: [],
        }),
      ).toEqual({ owner, settled: null });
    },
  );

  it.each(
    (
      ["container", "extension", "lab", "link", "spawn", "storage", "terminal", "tower"] as const
    ).flatMap((kind) =>
      (["ERR_NOT_OWNER", "ERR_BUSY", "ERR_INVALID_TARGET", "UNEXPECTED"] as const).map((code) => ({
        code,
        kind,
      })),
    ),
  )(
    "settles one failed stale $kind pair with $code from newer target presence",
    ({ code, kind }) => {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(
        memory,
        { attempt: 3, code, nextEligibleTick: Number.MAX_SAFE_INTEGER },
        completedStaleEvidence(kind),
      );
      const owner = layoutsOwner(memory);
      const priorRecord = owner.staleRecords[0];
      if (priorRecord === undefined) throw new Error(`expected stale failed ${kind} pair`);
      const resetOwner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner)));
      if (resetOwner === null) throw new Error(`expected reset stale failed ${kind} pair`);
      const settle = (candidate: LayoutsOwnerV25) =>
        reconcileStaleLayoutRemovalReceipt({
          blocker: null,
          observedAt: 102,
          owner: candidate,
          roomName: ROOM_NAME,
          structures: [{ id: `${kind}-obsolete` }],
        });

      const result = settle(owner);

      expect(result.settled).toMatchObject({ code, targetId: `${kind}-obsolete` });
      expect(result.owner.revision).toBe(owner.revision + 1);
      expect(result.owner.staleRecords[0]?.removalReceipt).toBeUndefined();
      expect(staleEvacuation(result.owner.staleRecords[0], kind)).toBeUndefined();
      expect(settle(resetOwner)).toEqual(result);
    },
  );

  it.each([
    "container",
    "extension",
    "lab",
    "link",
    "spawn",
    "storage",
    "terminal",
    "tower",
  ] as const)("settles one failed stale %s pair through runtime planner admission", (kind) => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(100, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(101, firstCommands, secondCommands), memory });
    seedStaleRemovalReceipt(
      memory,
      { attempt: 3, code: "ERR_BUSY", nextEligibleTick: Number.MAX_SAFE_INTEGER },
      completedStaleEvidence(kind),
    );
    const priorOtherRoom = layoutsOwner(memory).records.find(({ roomName }) => roomName === "W2N2");
    if (priorOtherRoom === undefined) throw new Error("expected unrelated current layout record");
    firstCommands.createConstructionSite.mockClear();
    firstCommands.destroyStructure.mockClear();
    secondCommands.createConstructionSite.mockClear();
    secondCommands.destroyStructure.mockClear();

    const outcome = runTick({
      game: twoRoomGame(102, firstCommands, secondCommands, {
        staleRemovalTarget: true,
        staleRemovalTargetType: kind,
      }),
      memory,
    });
    const owner = layoutsOwner(memory);

    expect(owner.staleRecords[0]?.removalReceipt).toBeUndefined();
    expect(staleEvacuation(owner.staleRecords[0], kind)).toBeUndefined();
    expect(owner.records.find(({ roomName }) => roomName === "W2N2")).toEqual(priorOtherRoom);
    expect(outcome.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "target absent",
      observedAt: 102,
      receipt: {},
      structures: [],
    },
    {
      name: "same tick",
      observedAt: 101,
      receipt: {},
      structures: ["extension-obsolete"],
    },
    {
      name: "incomplete structure projection",
      observedAt: 102,
      receipt: {},
      structures: undefined,
    },
    {
      blocker: "policy-unavailable" as const,
      name: "unsafe policy",
      observedAt: 102,
      receipt: {},
      structures: ["extension-obsolete"],
    },
    {
      name: "wrong target",
      observedAt: 102,
      receipt: { targetId: "different-extension" },
      structures: ["different-extension"],
    },
    {
      name: "wrong replacement",
      observedAt: 102,
      receipt: { replacementId: "different-extension" },
      structures: ["extension-obsolete"],
    },
    {
      name: "wrong type",
      observedAt: 102,
      receipt: { targetStructureType: "tower" },
      structures: ["extension-obsolete"],
    },
    {
      name: "receipt before evacuation",
      observedAt: 102,
      receipt: { observedAt: 99 },
      structures: ["extension-obsolete"],
    },
    {
      name: "receipt at evacuation expiry",
      observedAt: 251,
      receipt: { observedAt: 250 },
      structures: ["extension-obsolete"],
    },
  ] as const)("preserves a failed stale evacuation pair with $name", (testCase) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(
      memory,
      {
        attempt: 3,
        code: "ERR_BUSY",
        nextEligibleTick: Number.MAX_SAFE_INTEGER,
        ...testCase.receipt,
      },
      "completed-extension-evacuation",
    );
    const owner = layoutsOwner(memory);

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: "blocker" in testCase ? testCase.blocker : null,
      observedAt: testCase.observedAt,
      owner,
      roomName: ROOM_NAME,
      structures: testCase.structures?.map((id) => ({ id })),
    });

    expect(result).toEqual({ owner, settled: null });
  });

  it("preserves a failed stale receipt paired with multiple evacuations", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(
      memory,
      { attempt: 3, code: "ERR_BUSY", nextEligibleTick: Number.MAX_SAFE_INTEGER },
      "completed-extension-evacuation",
    );
    const owner = layoutsOwner(memory);
    const record = owner.staleRecords[0];
    if (record === undefined) throw new Error("expected stale failed evacuation pair");
    const multiple = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...record,
          towerEvacuation: {
            amount: 500,
            expiresAt: 250,
            replacementId: "tower-replacement",
            replacementInitialEnergy: 10,
            sourceId: "tower-obsolete",
            startedAt: 100,
          },
        },
      ],
    });
    if (multiple === null) throw new Error("expected valid multiple-evacuation stale owner");

    expect(
      reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: multiple,
        roomName: ROOM_NAME,
        structures: [{ id: "extension-obsolete" }],
      }),
    ).toEqual({ owner: multiple, settled: null });
  });

  it("settles a failed stale storage pair without success-only conservation evidence", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    const options = {
      controllerLevel: 6,
      roomEnergyAvailable: 2_300,
      roomEnergyCapacityAvailable: 2_300,
      staleRemovalTargetType: "storage" as const,
      storageTerminalResources: [] as const,
    };
    runTick({ game: game(100, commands, options), memory });
    runTick({ game: game(101, commands, options), memory });
    seedStaleRemovalReceipt(
      memory,
      { attempt: 3, code: "ERR_BUSY", nextEligibleTick: Number.MAX_SAFE_INTEGER },
      "completed-storage-evacuation",
    );

    runTick({ game: game(102, commands, { ...options, staleRemovalTarget: true }), memory });

    expect(layoutsOwner(memory).staleRecords[0]?.removalReceipt).toBeUndefined();
    expect(layoutsOwner(memory).staleRecords[0]?.storageEvacuation).toBeUndefined();
  });

  it("settles a failed stale removal command-free before a later revision handoff", async () => {
    const forward = await runFailedStaleRemovalSettlementVariant(false, false);
    const reset = await runFailedStaleRemovalSettlementVariant(false, true);
    const reordered = await runFailedStaleRemovalSettlementVariant(true, false);

    const priorRecord = forward.pendingOwner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected pending stale failed receipt");
    const { removalReceipt: _removalReceipt, ...retained } = priorRecord;
    void _removalReceipt;
    expect(forward.settlementOwner).toEqual({
      ...forward.pendingOwner,
      revision: forward.pendingOwner.revision + 1,
      staleRecords: [retained],
    });
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffOwner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
        forward.unrelatedRecord,
      ],
      staleRecords: [],
    });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("settles one exact failed stale evacuation pair command-free before handoff", async () => {
    const active = "completed-extension-evacuation" as const;
    const forward = await runFailedStaleRemovalSettlementVariant(false, false, active);
    const reset = await runFailedStaleRemovalSettlementVariant(false, true, active);
    const reordered = await runFailedStaleRemovalSettlementVariant(true, false, active);

    const priorRecord = forward.pendingOwner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected pending stale failed evacuation pair");
    const {
      extensionEvacuation: _extensionEvacuation,
      removalReceipt: _removalReceipt,
      ...retained
    } = priorRecord;
    void [_extensionEvacuation, _removalReceipt];
    expect(forward.settlementOwner).toEqual({
      ...forward.pendingOwner,
      revision: forward.pendingOwner.revision + 1,
      staleRecords: [retained],
    });
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffOwner.staleRecords).toEqual([]);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("atomically settles one completed stale storage pair only with exact inventory proof", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleOwner(memory, null);
    const owner = layoutsOwner(memory);
    const staleRecord = owner.staleRecords[0];
    if (staleRecord === undefined) throw new Error("expected stale layout record");
    const pairedOwner = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...staleRecord,
          removalReceipt: {
            attempt: 1,
            code: "OK",
            nextEligibleTick: Number.MAX_SAFE_INTEGER,
            observedAt: 101,
            replacementId: "storage-terminal",
            targetId: "storage-obsolete",
            targetStructureType: "storage",
          },
          storageEvacuation: {
            amount: 100,
            expiresAt: 250,
            resourceType: "energy",
            sourceId: "storage-obsolete",
            startedAt: 100,
            terminalId: "storage-terminal",
            terminalInitialAmount: 50,
          },
        },
      ],
    });
    if (pairedOwner === null) throw new Error("expected valid stale storage pair");

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: null,
      observedAt: 102,
      owner: pairedOwner,
      roomName: ROOM_NAME,
      storageRemovalCompleted: true,
      structures: [],
    });

    expect(result.settled).toMatchObject({ targetStructureType: "storage" });
    expect(result.owner.revision).toBe(pairedOwner.revision + 1);
    expect(result.owner.staleRecords[0]?.storageEvacuation).toBeUndefined();
    expect(result.owner.staleRecords[0]?.removalReceipt).toBeUndefined();
    expect(
      reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: pairedOwner,
        roomName: ROOM_NAME,
        structures: [],
      }),
    ).toEqual({ owner: pairedOwner, settled: null });

    const pairedRecord = pairedOwner.staleRecords[0];
    if (pairedRecord?.removalReceipt === undefined)
      throw new Error("expected paired storage receipt");
    for (const testCase of [
      { name: "target", receipt: { targetId: "different-storage" } },
      { name: "replacement", receipt: { replacementId: "different-terminal" } },
      { name: "type", receipt: { targetStructureType: "terminal" as const } },
      { name: "lower interval", receipt: { observedAt: 99 } },
      { name: "upper interval", receipt: { observedAt: 250 } },
      { name: "failure", receipt: { code: "ERR_BUSY" as const } },
    ]) {
      const mismatchedOwner = parseLayoutsOwner({
        ...pairedOwner,
        staleRecords: [
          {
            ...pairedRecord,
            removalReceipt: { ...pairedRecord.removalReceipt, ...testCase.receipt },
          },
        ],
      });
      if (mismatchedOwner === null) throw new Error(`expected valid ${testCase.name} mismatch`);
      const mismatched = reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 251,
        owner: mismatchedOwner,
        roomName: ROOM_NAME,
        storageRemovalCompleted: true,
        structures: [],
      });
      expect(mismatched.settled, testCase.name).toBeNull();
      expect(mismatched.owner, testCase.name).toBe(mismatchedOwner);
    }
  });

  it.each(["container", "extension", "lab", "link", "spawn", "terminal", "tower"] as const)(
    "atomically settles one completed stale %s migration pair",
    (kind) => {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(memory, {}, completedStaleEvidence(kind));
      const owner = layoutsOwner(memory);
      const priorRecord = owner.staleRecords[0];
      const evacuation = staleEvacuation(priorRecord, kind);
      if (
        priorRecord === undefined ||
        evacuation === undefined ||
        priorRecord.removalReceipt === undefined
      )
        throw new Error(`expected completed stale ${kind} migration`);

      const result = reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner,
        roomName: ROOM_NAME,
        structures: [],
      });

      expect(result.settled).toMatchObject({
        code: "OK",
        replacementId:
          "terminalId" in evacuation ? evacuation.terminalId : evacuation.replacementId,
        targetId: "targetId" in evacuation ? evacuation.targetId : evacuation.sourceId,
        targetStructureType: kind,
      });
      expect(result.owner.revision).toBe(owner.revision + 1);
      expect(result.owner.staleRecords).toHaveLength(1);
      expect(staleEvacuation(result.owner.staleRecords[0], kind)).toBeUndefined();
      expect(result.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");
      expect(result.owner.staleRecords[0]).toEqual(withoutCompletedEvacuation(priorRecord, kind));

      const targetAbsentOwner = parseLayoutsOwner({
        ...owner,
        staleRecords: [
          {
            ...priorRecord,
            removalReceipt: { ...priorRecord.removalReceipt, code: "TARGET_ABSENT" },
          },
        ],
      });
      if (targetAbsentOwner === null) throw new Error("expected paired target-absent owner");
      const targetAbsentResult = reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: targetAbsentOwner,
        roomName: ROOM_NAME,
        structures: [],
      });
      expect(targetAbsentResult.settled).toMatchObject({ code: "TARGET_ABSENT" });
      expect(staleEvacuation(targetAbsentResult.owner.staleRecords[0], kind)).toBeUndefined();
      expect(targetAbsentResult.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");

      const lowerBoundOwner = parseLayoutsOwner({
        ...owner,
        staleRecords: [
          {
            ...priorRecord,
            removalReceipt: {
              ...priorRecord.removalReceipt,
              observedAt: evacuation.startedAt,
            },
          },
        ],
      });
      if (lowerBoundOwner === null) throw new Error("expected lower-bound completed owner");
      expect(
        reconcileStaleLayoutRemovalReceipt({
          blocker: null,
          observedAt: evacuation.startedAt + 1,
          owner: lowerBoundOwner,
          roomName: ROOM_NAME,
          structures: [],
        }).settled,
      ).toMatchObject({ observedAt: evacuation.startedAt });
    },
  );

  it.each(LAB_EVACUATION_VARIANTS)(
    "settles completed stale lab $name records across command, reset, and reorder variants",
    async ({ evacuation }) => {
      for (const code of ["OK", "TARGET_ABSENT"] as const) {
        const forward = await runStaleRemovalSettlementVariant(
          false,
          false,
          "lab",
          code,
          evacuation,
        );
        const reset = await runStaleRemovalSettlementVariant(false, true, "lab", code, evacuation);
        const reordered = await runStaleRemovalSettlementVariant(
          true,
          false,
          "lab",
          code,
          evacuation,
        );

        expect(forward.pendingOwner.staleRecords[0]?.labEvacuation).toEqual(evacuation);
        expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({ code });
        expect(forward.settlementOwner.staleRecords[0]?.labEvacuation).toBeUndefined();
        expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
        expect(forward.settlementOwner.records).toEqual([]);
        expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.settlementPlanning).toEqual([
          expect.objectContaining({
            blocker: "revision-handoff-active",
            roomName: ROOM_NAME,
            status: "degraded",
          }),
        ]);
        expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.handoffPlanning).toEqual([
          expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
        ]);
        expect(reset).toEqual(forward);
        expect(reordered).toEqual(forward);
      }
    },
  );

  it.each(STORAGE_EVACUATION_VARIANTS)(
    "settles completed stale storage $name records across command, reset, and reorder variants",
    async ({ evacuation }) => {
      for (const code of ["OK", "TARGET_ABSENT"] as const) {
        const forward = await runStaleRemovalSettlementVariant(
          false,
          false,
          "storage",
          code,
          evacuation,
        );
        const reset = await runStaleRemovalSettlementVariant(
          false,
          true,
          "storage",
          code,
          evacuation,
        );
        const reordered = await runStaleRemovalSettlementVariant(
          true,
          false,
          "storage",
          code,
          evacuation,
        );

        expect(forward.pendingOwner.staleRecords[0]?.storageEvacuation).toEqual(evacuation);
        expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({ code });
        expect(forward.settlementOwner.staleRecords[0]?.storageEvacuation).toBeUndefined();
        expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
        expect(forward.settlementOwner.records).toEqual([]);
        expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.settlementPlanning).toEqual([
          expect.objectContaining({
            blocker: "revision-handoff-active",
            roomName: ROOM_NAME,
            status: "degraded",
          }),
        ]);
        expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.handoffPlanning).toEqual([
          expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
        ]);
        expect(reset).toEqual(forward);
        expect(reordered).toEqual(forward);
      }
    },
  );

  it("preserves completed stale storage evidence when critical inventory proof drifts", async () => {
    const evacuation = STORAGE_EVACUATION_VARIANTS[0].evacuation;
    for (const testCase of [
      {
        name: "destination stock",
        options: { storageTerminalResources: [["energy", 149]] as const },
      },
      { name: "terminal capacity", options: { storageTerminalCapacity: 299_999 } },
      { name: "terminal activity", options: { storageTerminalActive: false } },
      { name: "Industry terminal work", options: { unavailableIndustryTerminalWork: true } },
      { name: "colony safety", options: { threat: true } },
    ] as const) {
      const outcome = await runStaleRemovalSettlementVariant(
        false,
        false,
        "storage",
        "OK",
        evacuation,
        testCase.options,
      );

      expect(outcome.settlementOwner.staleRecords[0]?.storageEvacuation, testCase.name).toEqual(
        evacuation,
      );
      expect(outcome.settlementOwner.staleRecords[0]?.removalReceipt, testCase.name).toMatchObject({
        code: "OK",
      });
      expect(outcome.settlementCommands, testCase.name).toEqual({ create: 0, destroy: 0 });
    }
  });

  it.each(TERMINAL_EVACUATION_VARIANTS)(
    "settles completed stale terminal $name records across command, reset, and reorder variants",
    async ({ evacuation }) => {
      for (const code of ["OK", "TARGET_ABSENT"] as const) {
        const forward = await runStaleRemovalSettlementVariant(
          false,
          false,
          "terminal",
          code,
          evacuation,
        );
        const reset = await runStaleRemovalSettlementVariant(
          false,
          true,
          "terminal",
          code,
          evacuation,
        );
        const reordered = await runStaleRemovalSettlementVariant(
          true,
          false,
          "terminal",
          code,
          evacuation,
        );

        expect(forward.pendingOwner.staleRecords[0]?.terminalEvacuation).toEqual(evacuation);
        expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({ code });
        expect(forward.settlementOwner.staleRecords[0]?.terminalEvacuation).toBeUndefined();
        expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
        expect(forward.settlementOwner.records).toEqual([]);
        expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.settlementPlanning).toEqual([
          expect.objectContaining({
            blocker: "revision-handoff-active",
            roomName: ROOM_NAME,
            status: "degraded",
          }),
        ]);
        expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
        expect(forward.handoffPlanning).toEqual([
          expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
        ]);
        expect(reset).toEqual(forward);
        expect(reordered).toEqual(forward);
      }
    },
  );

  it("preserves a completed stale spawn pair when another evacuation remains active", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, {}, "completed-spawn-evacuation");
    const owner = layoutsOwner(memory);
    const priorRecord = owner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected completed stale spawn record");
    const mixedOwner = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...priorRecord,
          towerEvacuation: {
            amount: 500,
            expiresAt: 250,
            replacementId: "tower-replacement",
            replacementInitialEnergy: 10,
            sourceId: "tower-obsolete",
            startedAt: 100,
          },
        },
      ],
    });
    if (mixedOwner === null) throw new Error("expected mixed stale evacuation owner");

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: null,
      observedAt: 102,
      owner: mixedOwner,
      roomName: ROOM_NAME,
      structures: [],
    });

    expect(result.settled).toBeNull();
    expect(result.owner).toBe(mixedOwner);
  });

  it("settles stale removal command-free before a later revision handoff", async () => {
    const forward = await runStaleRemovalSettlementVariant(false, false);
    const reset = await runStaleRemovalSettlementVariant(false, true);
    const reordered = await runStaleRemovalSettlementVariant(true, false);

    expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({ code: "OK" });
    expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
    expect(forward.settlementOwner.records).toEqual([]);
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffOwner).toMatchObject({ records: [expect.anything()], staleRecords: [] });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it.each(["container", "link", "spawn"] as const)(
    "settles target-absent %s evidence across runtime variants",
    async (kind) => {
      const forward = await runStaleRemovalSettlementVariant(false, false, kind, "TARGET_ABSENT");
      const reset = await runStaleRemovalSettlementVariant(false, true, kind, "TARGET_ABSENT");
      const reordered = await runStaleRemovalSettlementVariant(true, false, kind, "TARGET_ABSENT");

      expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({
        code: "TARGET_ABSENT",
      });
      expect(staleEvacuation(forward.settlementOwner.staleRecords[0], kind)).toBeUndefined();
      expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
      expect(reset).toEqual(forward);
      expect(reordered).toEqual(forward);
    },
  );

  it.each(["container", "extension", "link", "spawn", "tower"] as const)(
    "settles a completed stale %s migration before a later revision handoff",
    async (kind) => {
      const forward = await runStaleRemovalSettlementVariant(false, false, kind);
      const reset = await runStaleRemovalSettlementVariant(false, true, kind);
      const reordered = await runStaleRemovalSettlementVariant(true, false, kind);
      const pendingRecord = forward.pendingOwner.staleRecords[0];
      const settlementRecord = forward.settlementOwner.staleRecords[0];

      expect(staleEvacuation(pendingRecord, kind)).toBeDefined();
      expect(pendingRecord?.removalReceipt).toMatchObject({ code: "OK" });
      expect(staleEvacuation(settlementRecord, kind)).toBeUndefined();
      expect(settlementRecord?.removalReceipt).toBeUndefined();
      expect(forward.settlementOwner.records).toEqual([]);
      expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
      expect(forward.settlementPlanning).toEqual([
        expect.objectContaining({
          blocker: "revision-handoff-active",
          roomName: ROOM_NAME,
          status: "degraded",
        }),
      ]);
      expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
      expect(forward.handoffPlanning).toEqual([
        expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
      ]);
      expect(forward.handoffOwner).toMatchObject({
        records: [expect.anything()],
        staleRecords: [],
      });
      expect(reset).toEqual(forward);
      expect(reordered).toEqual(forward);
    },
  );

  // This bounded legacy matrix boots every stale-evidence shape under one explicit suite ceiling.
  it("preserves stale removal receipts without exact terminal-success absence evidence", () => {
    for (const testCase of [
      { name: "target present", observedAt: 102, receipt: {}, structures: ["extension-obsolete"] },
      { name: "same tick", observedAt: 101, receipt: {}, structures: [] },
      {
        name: "storage",
        observedAt: 102,
        receipt: { targetStructureType: "storage" },
        structures: [],
      },
      { name: "failed", observedAt: 102, receipt: { code: "ERR_BUSY" }, structures: [] },
      {
        name: "failed same tick",
        observedAt: 101,
        receipt: { code: "ERR_BUSY" },
        structures: ["extension-obsolete"],
      },
      {
        name: "failed incomplete structure projection",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: undefined,
      },
      {
        name: "failed wrong target",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: ["different-extension"],
      },
      {
        name: "failed unsafe policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: ["extension-obsolete"],
      },
      {
        name: "failed active evacuation",
        blocker: "revision-handoff-active",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: ["extension-obsolete"],
        withEvacuation: true,
      },
      {
        name: "incomplete structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
      },
      {
        name: "active evacuation",
        blocker: "revision-handoff-active",
        observedAt: 102,
        receipt: {},
        structures: [],
        withEvacuation: true,
      },
      {
        name: "container target present",
        observedAt: 102,
        receipt: {},
        structures: ["container-obsolete"],
        completedEvacuation: "container",
      },
      {
        name: "container same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "container failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "incomplete container structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "container",
      },
      {
        name: "unsafe container policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "wrong container target",
        observedAt: 102,
        receipt: { targetId: "different-container" },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "wrong container replacement",
        observedAt: 102,
        receipt: { replacementId: "different-container" },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "wrong container type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "container receipt predates migration",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "container receipt at migration expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "container",
      },
      {
        name: "wrong paired target",
        observedAt: 102,
        receipt: { targetId: "different-extension" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "wrong paired replacement",
        observedAt: 102,
        receipt: { replacementId: "different-extension" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "wrong paired type",
        observedAt: 102,
        receipt: { targetStructureType: "container" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "spawn target present",
        observedAt: 102,
        receipt: {},
        structures: ["spawn-obsolete"],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "incomplete spawn structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "spawn",
      },
      {
        name: "unsafe spawn policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn target",
        observedAt: 102,
        receipt: { targetId: "different-spawn" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn replacement",
        observedAt: 102,
        receipt: { replacementId: "different-spawn" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "link target present",
        observedAt: 102,
        receipt: {},
        structures: ["link-obsolete"],
        completedEvacuation: "link",
      },
      {
        name: "link same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "incomplete link structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "link",
      },
      {
        name: "unsafe link policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link target",
        observedAt: 102,
        receipt: { targetId: "different-link" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link replacement",
        observedAt: 102,
        receipt: { replacementId: "different-link" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "tower target present",
        observedAt: 102,
        receipt: {},
        structures: ["tower-obsolete"],
        completedEvacuation: "tower",
      },
      {
        name: "tower same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "incomplete tower structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "tower",
      },
      {
        name: "unsafe tower policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower target",
        observedAt: 102,
        receipt: { targetId: "different-tower" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower replacement",
        observedAt: 102,
        receipt: { replacementId: "different-tower" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "unsafe policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
      },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      const completedEvacuation =
        "completedEvacuation" in testCase ? testCase.completedEvacuation : null;
      seedStaleRemovalReceipt(
        memory,
        testCase.receipt,
        completedEvacuation === null
          ? testCase.withEvacuation === true
            ? "evacuation"
            : null
          : completedStaleEvidence(completedEvacuation),
      );
      const owner = layoutsOwner(memory);
      const result = reconcileStaleLayoutRemovalReceipt({
        blocker: testCase.blocker ?? null,
        observedAt: testCase.observedAt,
        owner,
        roomName: ROOM_NAME,
        structures: testCase.structures?.map((id) => ({ id })),
      });

      expect(result.settled, testCase.name).toBeNull();
      expect(result.owner, testCase.name).toBe(owner);
    }
  }, 10_000);

  it.each([
    { name: "target present", observedAt: 102, receipt: {}, structures: ["lab-obsolete"] },
    { name: "same tick", observedAt: 101, receipt: {}, structures: [] },
    { name: "failed", observedAt: 102, receipt: { code: "ERR_BUSY" }, structures: [] },
    {
      name: "incomplete structure projection",
      observedAt: 102,
      receipt: {},
      structures: undefined,
    },
    {
      name: "unsafe policy",
      blocker: "policy-unavailable",
      observedAt: 102,
      receipt: {},
      structures: [],
    },
    {
      name: "wrong target",
      observedAt: 102,
      receipt: { targetId: "different-lab" },
      structures: [],
    },
    {
      name: "wrong replacement",
      observedAt: 102,
      receipt: { replacementId: "different-lab" },
      structures: [],
    },
    {
      name: "wrong type",
      observedAt: 102,
      receipt: { targetStructureType: "extension" },
      structures: [],
    },
    {
      name: "receipt predates evacuation",
      observedAt: 102,
      receipt: { observedAt: 99 },
      structures: [],
    },
    {
      name: "receipt at evacuation expiry",
      observedAt: 251,
      receipt: { observedAt: 250 },
      structures: [],
    },
  ] as const)("preserves a stale lab pair when $name", (testCase) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, testCase.receipt, "completed-lab-evacuation");
    const owner = layoutsOwner(memory);

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: "blocker" in testCase ? testCase.blocker : null,
      observedAt: testCase.observedAt,
      owner,
      roomName: ROOM_NAME,
      structures: testCase.structures?.map((id) => ({ id })),
    });

    expect(result.settled).toBeNull();
    expect(result.owner).toBe(owner);
  });

  it.each([
    { name: "target present", observedAt: 102, receipt: {}, structures: ["terminal-obsolete"] },
    { name: "same tick", observedAt: 101, receipt: {}, structures: [] },
    { name: "failed", observedAt: 102, receipt: { code: "ERR_BUSY" }, structures: [] },
    {
      name: "incomplete structure projection",
      observedAt: 102,
      receipt: {},
      structures: undefined,
    },
    {
      name: "unsafe policy",
      blocker: "policy-unavailable",
      observedAt: 102,
      receipt: {},
      structures: [],
    },
    {
      name: "wrong target",
      observedAt: 102,
      receipt: { targetId: "different-terminal" },
      structures: [],
    },
    {
      name: "wrong replacement",
      observedAt: 102,
      receipt: { replacementId: "different-storage" },
      structures: [],
    },
    {
      name: "wrong type",
      observedAt: 102,
      receipt: { targetStructureType: "extension" },
      structures: [],
    },
    {
      name: "receipt predates evacuation",
      observedAt: 102,
      receipt: { observedAt: 99 },
      structures: [],
    },
    {
      name: "receipt at evacuation expiry",
      observedAt: 251,
      receipt: { observedAt: 250 },
      structures: [],
    },
  ] as const)("preserves a stale terminal pair when $name", (testCase) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, testCase.receipt, "completed-terminal-evacuation");
    const owner = layoutsOwner(memory);

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: "blocker" in testCase ? testCase.blocker : null,
      observedAt: testCase.observedAt,
      owner,
      roomName: ROOM_NAME,
      structures: testCase.structures?.map((id) => ({ id })),
    });

    expect(result.settled).toBeNull();
    expect(result.owner).toBe(owner);
  });

  it.each([
    {
      active: "completed-extension-evacuation-with-site" as const,
      name: "exact evacuation plus site receipt",
      options: {},
    },
    {
      active: "completed-extension-evacuation-with-source-handoff" as const,
      name: "exact evacuation plus source-service issuance",
      options: {},
    },
    {
      active: "completed-extension-evacuation" as const,
      name: "exact evacuation plus unsafe policy",
      options: { threat: true },
    },
  ])("preserves a failed stale receipt with $name", ({ active, options }) => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(
      memory,
      { attempt: 3, code: "ERR_BUSY", nextEligibleTick: Number.MAX_SAFE_INTEGER },
      active,
    );
    const before = layoutsOwner(memory);
    commands.createConstructionSite.mockClear();
    commands.destroyStructure.mockClear();

    const outcome = runTick({
      game: game(102, commands, { ...options, staleRemovalTarget: true }),
      memory,
    });

    expect(layoutsOwner(memory)).toEqual(before);
    expect(outcome.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(commands.createConstructionSite).not.toHaveBeenCalled();
    expect(commands.destroyStructure).not.toHaveBeenCalled();
  });

  it("keeps stale removal receipts blocked by active or unsafe runtime evidence", () => {
    for (const testCase of [
      { active: "evacuation", name: "active evacuation", options: {} },
      {
        active: "completed-container-migration-with-site",
        name: "completed container migration with another active term",
        options: {},
      },
      {
        active: "completed-extension-evacuation-with-site",
        name: "completed extension evacuation with another active term",
        options: {},
      },
      {
        active: "completed-lab-evacuation-with-site",
        name: "completed lab evacuation with another active term",
        options: {},
      },
      {
        active: "completed-link-evacuation-with-site",
        name: "completed link evacuation with another active term",
        options: {},
      },
      {
        active: "completed-spawn-evacuation-with-site",
        name: "completed spawn evacuation with another active term",
        options: {},
      },
      {
        active: "completed-storage-evacuation-with-site",
        name: "completed storage evacuation with another active term",
        options: {
          controllerLevel: 6,
          roomEnergyAvailable: 2_300,
          roomEnergyCapacityAvailable: 2_300,
          staleRemovalTargetType: "storage",
          storageTerminalResources: [["energy", 150]],
        },
      },
      {
        active: "completed-terminal-evacuation-with-site",
        name: "completed terminal evacuation with another active term",
        options: {},
      },
      {
        active: "completed-tower-evacuation-with-site",
        name: "completed tower evacuation with another active term",
        options: {},
      },
      { active: "container-migration", name: "active migration", options: {} },
      { active: "site-receipt", name: "active site receipt", options: {} },
      { active: "source-handoff", name: "active source handoff", options: {} },
      { active: null, name: "unsafe threat", options: { threat: true } },
      { active: null, name: "unknown vision", options: { visible: false } },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(memory, {}, testCase.active);
      commands.createConstructionSite.mockClear();
      commands.destroyStructure.mockClear();

      const outcome = runTick({ game: game(102, commands, testCase.options), memory });
      const owner = layoutsOwner(memory);

      expect(owner.staleRecords[0]?.removalReceipt, testCase.name).toMatchObject({ code: "OK" });
      expect(owner.records, testCase.name).toEqual([]);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(commands.destroyStructure, testCase.name).not.toHaveBeenCalled();
      if (testCase.options.visible === false) expect(outcome.layout.planning).toEqual([]);
      else
        expect(outcome.layout.planning[0], testCase.name).toMatchObject({
          blocker: "revision-handoff-active",
          status: "degraded",
        });
    }
  });

  it("preserves stale site receipts without fresh exact successful owned evidence", () => {
    for (const testCase of [
      { name: "absent", evidence: null, receipt: {} },
      { name: "foreign structure", evidence: { ownership: "foreign" }, receipt: {} },
      {
        name: "wrong position",
        evidence: { ownership: "owned", xOffset: 1 },
        receipt: {},
      },
      {
        name: "wrong structure type",
        evidence: { ownership: "owned", structureType: "road" },
        receipt: {},
      },
      {
        name: "malformed proposal identity",
        evidence: { ownership: "owned" },
        receipt: { proposalId: "not-a-layout-site" },
      },
      {
        name: "noncanonical identity prefix",
        evidence: { ownership: "owned" },
        receipt: { proposalId: "noncanonical-prefix" },
      },
      {
        name: "different layout fingerprint",
        evidence: { ownership: "owned" },
        receipt: { layoutFingerprint: "layout-v2:different" },
      },
      {
        name: "non-success result",
        evidence: { ownership: "owned" },
        receipt: { code: "ERR_FULL" },
      },
      {
        name: "same-tick result",
        evidence: { ownership: "owned" },
        receipt: { observedAt: 202 },
      },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(200, commands), memory });
      runTick({ game: game(201, commands), memory });
      const target = seedStaleSiteReceipt(memory, testCase.receipt);
      commands.createConstructionSite.mockClear();
      const evidence =
        testCase.evidence === null
          ? undefined
          : {
              ownership: testCase.evidence.ownership,
              structureType: testCase.evidence.structureType ?? target.structureType,
              x: target.x + (testCase.evidence.xOffset ?? 0),
              y: target.y,
            };

      const outcome = runTick({
        game: game(202, commands, evidence === undefined ? {} : { staleSiteEvidence: evidence }),
        memory,
      });
      const owner = layoutsOwner(memory);

      expect(outcome.kernel.faults, testCase.name).toEqual([]);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(owner.records, testCase.name).toEqual([]);
      expect(owner.staleRecords[0]?.siteReceipts, testCase.name).toHaveLength(1);
      expect(outcome.layout.planning[0], testCase.name).toMatchObject({
        blocker: "revision-handoff-active",
        status: "degraded",
      });
    }
  });

  it("preserves active or unsafe stale evidence and authorizes no command", () => {
    for (const testCase of [
      { name: "active evacuation", active: "evacuation", options: {} },
      { name: "active source handoff", active: "source-handoff", options: {} },
      { name: "threat", active: null, options: { threat: true } },
      { name: "controller risk", active: null, options: { controllerRisk: true } },
      { name: "RCL outside policy", active: null, options: { controllerLevel: 1 } },
      { name: "blocked source access", active: null, options: { blockedTerrain: true } },
      { name: "unknown vision", active: null, options: { visible: false } },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(200, commands), memory });
      runTick({ game: game(201, commands), memory });
      seedStaleOwner(memory, testCase.active);
      commands.createConstructionSite.mockClear();

      const outcome = runTick({ game: game(202, commands, testCase.options), memory });
      const owner = parseLayoutsOwner(memory.myrmex?.layouts);
      if (owner === null) throw new Error("expected parsed layouts owner");

      expect(outcome.kernel.faults, testCase.name).toEqual([]);
      expect(outcome.stateCommit?.committed, testCase.name).toBe(true);
      expect(
        (memory.myrmex?.layouts as { readonly schemaVersion?: unknown } | undefined)?.schemaVersion,
        testCase.name,
      ).toBe(25);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(owner.records, testCase.name).toEqual([]);
      expect(owner.staleRecords, testCase.name).toHaveLength(1);
      if (testCase.options.visible === false) expect(outcome.layout.planning).toEqual([]);
      else expect(outcome.layout.planning[0], testCase.name).toMatchObject({ status: "degraded" });
      if (testCase.active !== null)
        expect(outcome.layout.planning[0]).toMatchObject({ blocker: "revision-handoff-active" });
    }
  });
});

async function runSettledStaleSourceServiceVariant(
  reverse: boolean,
  reset: boolean,
  controllerLevel = 3,
) {
  const commands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  const roomOptions = {
    controllerLevel,
    reverse,
    roomEnergyAvailable: controllerLevel === 8 ? 12_900 : 800,
    roomEnergyCapacityAvailable: controllerLevel === 8 ? 12_900 : 800,
    staticMiner: true,
  } as const;
  executeTick({ game: game(100, commands, roomOptions), memory });
  executeTick({ game: game(101, commands, roomOptions), memory });
  executeTick({ game: game(102, commands, roomOptions), memory });
  const { contractId, expectedActorId } = seedSettledStaleSourceService(memory);
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  const handoff = executeTick({
    game: game(103, commands, roomOptions),
    memory,
  });
  const handoffCommands = {
    create: commands.createConstructionSite.mock.calls.length,
    destroy: commands.destroyStructure.mock.calls.length,
  };
  const sourceServices = layoutsOwner(memory).records.find(
    ({ roomName }) => roomName === ROOM_NAME,
  )?.sourceServices;
  const contractOwner = memory.myrmex?.contracts as
    | {
        active?: Array<{
          id?: string;
          issuer?: string;
          issuerSequence?: number;
          lease?: { actorId?: string };
          state?: string;
        }>;
        outcomes?: Array<{ id?: string; issuer?: string }>;
      }
    | undefined;
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();
  const following = executeTick({
    game: game(104, commands, roomOptions),
    memory,
  });
  const issuer = `mining/${ROOM_NAME}/source-${ROOM_NAME}`;

  return {
    activeMining: (contractOwner?.active ?? []).filter((contract) => contract.issuer === issuer),
    contractId,
    expectedActorId,
    followingReplacements: following.contracts?.replacements ?? [],
    followingSubmissions: (following.contracts?.submissions ?? []).filter(
      (submission) => submission.contractId === contractId,
    ),
    handoffCommands,
    handoffMiningReservations: handoff.colony.reservations.filter(({ issuer }) =>
      issuer.startsWith("mining/"),
    ),
    handoffPlanning: handoff.layout.planning,
    handoffReplacements: handoff.contracts?.replacements ?? [],
    handoffMiningTransitions: (handoff.contracts?.transitions ?? []).filter(
      (transition) => transition.contractId === contractId,
    ),
    kernelFaults: handoff.kernel.faults,
    miningOutcomes: (contractOwner?.outcomes ?? []).filter((outcome) => outcome.issuer === issuer),
    sourceServices,
  };
}

function runStaleSiteSettlementVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  runTick({ game: game(100, commands, { reverse }), memory });
  runTick({ game: game(101, commands, { reverse }), memory });
  const target = seedStaleSiteReceipt(memory, {});
  if (reset) memory = JSON.parse(JSON.stringify(memory)) as Memory;
  commands.createConstructionSite.mockClear();
  const staleSiteEvidence: StaleSiteEvidence = {
    ownership: "owned",
    structureType: target.structureType,
    x: target.x,
    y: target.y,
  };

  const settlement = runTick({
    game: game(102, commands, { reverse, staleSiteEvidence }),
    memory,
  });
  const settledOwner = layoutsOwner(memory);
  const settlementCalls = commands.createConstructionSite.mock.calls.length;
  commands.createConstructionSite.mockClear();
  const handoff = runTick({
    game: game(103, commands, { reverse, staleSiteEvidence }),
    memory,
  });

  return {
    handoffCalls: commands.createConstructionSite.mock.calls.length,
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    settledOwner,
    settlementCalls,
    settlementPlanning: settlement.layout.planning,
  };
}

async function runFailedStaleRemovalSettlementVariant(
  reverse: boolean,
  reset: boolean,
  active: StaleActiveEvidence = null,
) {
  const firstCommands = commandSpies();
  const secondCommands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  executeTick({ game: twoRoomGame(100, firstCommands, secondCommands, { reverse }), memory });
  executeTick({ game: twoRoomGame(101, firstCommands, secondCommands, { reverse }), memory });
  seedStaleRemovalReceipt(
    memory,
    {
      attempt: 3,
      code: "ERR_BUSY",
      nextEligibleTick: Number.MAX_SAFE_INTEGER,
    },
    active,
  );
  const pendingOwner = layoutsOwner(memory);
  const unrelatedRecord = pendingOwner.records.find(({ roomName }) => roomName === "W2N2");
  if (unrelatedRecord === undefined) throw new Error("expected unrelated layout record");
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  firstCommands.createConstructionSite.mockClear();
  firstCommands.destroyStructure.mockClear();
  secondCommands.createConstructionSite.mockClear();
  secondCommands.destroyStructure.mockClear();

  const settlement = executeTick({
    game: twoRoomGame(102, firstCommands, secondCommands, {
      reverse,
      staleRemovalTarget: true,
    }),
    memory,
  });
  const settlementOwner = layoutsOwner(memory);
  const settlementCommands = {
    create:
      firstCommands.createConstructionSite.mock.calls.length +
      secondCommands.createConstructionSite.mock.calls.length,
    destroy:
      firstCommands.destroyStructure.mock.calls.length +
      secondCommands.destroyStructure.mock.calls.length,
  };
  firstCommands.createConstructionSite.mockClear();
  firstCommands.destroyStructure.mockClear();
  secondCommands.createConstructionSite.mockClear();
  secondCommands.destroyStructure.mockClear();
  const handoff = executeTick({
    game: twoRoomGame(103, firstCommands, secondCommands, {
      reverse,
      staleRemovalTarget: true,
    }),
    memory,
  });

  return {
    handoffCommands: {
      create:
        firstCommands.createConstructionSite.mock.calls.length +
        secondCommands.createConstructionSite.mock.calls.length,
      destroy:
        firstCommands.destroyStructure.mock.calls.length +
        secondCommands.destroyStructure.mock.calls.length,
    },
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    pendingOwner,
    settlementCommands,
    settlementOwner,
    settlementPlanning: settlement.layout.planning,
    unrelatedRecord,
  };
}

async function runStaleRemovalSettlementVariant(
  reverse: boolean,
  reset: boolean,
  completedEvacuation: CompletedStaleEvacuationKind | null = null,
  receiptCode: "OK" | "TARGET_ABSENT" = "OK",
  evacuationOverride?: LayoutLabEvacuation | LayoutStorageEvacuation | LayoutTerminalEvacuation,
  storageSettlementOptions: GameOptions = {},
) {
  const commands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  const storageOptions =
    completedEvacuation === "storage"
      ? {
          controllerLevel: 6,
          roomEnergyAvailable: 2_300,
          roomEnergyCapacityAvailable: 2_300,
          staleRemovalTargetType: "storage" as const,
          storageTerminalResources: storageTerminalResources(evacuationOverride),
        }
      : {};
  executeTick({ game: game(100, commands, { reverse, ...storageOptions }), memory });
  executeTick({ game: game(101, commands, { reverse, ...storageOptions }), memory });
  seedStaleRemovalReceipt(
    memory,
    { code: receiptCode },
    completedEvacuation === null ? null : completedStaleEvidence(completedEvacuation),
    evacuationOverride,
  );
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  executeTick({
    game: game(102, commands, {
      reverse,
      ...storageOptions,
      staleRemovalTarget: true,
      ...(completedEvacuation === null ? {} : { staleRemovalTargetType: completedEvacuation }),
    }),
    memory,
  });
  const pendingOwner = layoutsOwner(memory);
  if (storageSettlementOptions.unavailableIndustryTerminalWork === true) {
    memory.myrmex = {
      ...memory.myrmex,
      industry: {
        schemaVersion: 5,
        revision: 0,
        policySourceVersion: "industry-policy-v2",
        commands: [
          {
            attempt: 1,
            identity: "unmatched-terminal-send",
            lastCode: "ERR_TIRED",
            nextEligibleTick: 200,
            status: "backoff",
          },
        ],
        labAttempts: [],
        labCommitments: [],
        matureAttempts: [],
        matureCommitments: [],
        observerAttempts: [],
      },
    } as NonNullable<Memory["myrmex"]>;
  }
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();
  const settlement = executeTick({
    game: game(103, commands, { reverse, ...storageOptions, ...storageSettlementOptions }),
    memory,
  });
  const settlementOwner = layoutsOwner(memory);
  const settlementCommands = {
    create: commands.createConstructionSite.mock.calls.length,
    destroy: commands.destroyStructure.mock.calls.length,
  };
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();
  const handoff = executeTick({
    game: game(104, commands, { reverse, ...storageOptions }),
    memory,
  });

  return {
    handoffCommands: {
      create: commands.createConstructionSite.mock.calls.length,
      destroy: commands.destroyStructure.mock.calls.length,
    },
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    pendingOwner,
    settlementCommands,
    settlementOwner,
    settlementPlanning: settlement.layout.planning,
  };
}

function runHandoffVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  runTick({ game: game(100, commands, { reverse }), memory });
  runTick({ game: game(101, commands, { reverse }), memory });
  seedStaleOwner(memory, null);
  if (reset) memory = JSON.parse(JSON.stringify(memory)) as Memory;
  commands.createConstructionSite.mockClear();

  const handoff = runTick({ game: game(102, commands, { reverse }), memory });
  const owner = JSON.parse(JSON.stringify(layoutsOwner(memory))) as unknown;
  const handoffCalls = commands.createConstructionSite.mock.calls.length;
  commands.createConstructionSite.mockClear();
  const following = runTick({ game: game(103, commands, { reverse }), memory });

  return {
    followingAccepted: following.layout.arbitration?.accepted.length ?? 0,
    followingCalls: commands.createConstructionSite.mock.calls.length,
    followingPlanning: following.layout.planning,
    handoffCalls,
    handoffPlanning: handoff.layout.planning,
    owner,
  };
}

function completedStaleEvidence(kind: CompletedStaleEvacuationKind): StaleActiveEvidence {
  return kind === "container" ? "completed-container-migration" : `completed-${kind}-evacuation`;
}

function storageTerminalResources(
  evacuation: LayoutLabEvacuation | LayoutStorageEvacuation | LayoutTerminalEvacuation | undefined,
): readonly (readonly [string, number])[] {
  if (evacuation === undefined || !("terminalId" in evacuation)) return [];
  if ("resourceManifest" in evacuation)
    return evacuation.resourceManifest.map(([resourceType, amount, initialAmount]) => [
      resourceType,
      amount + initialAmount,
    ]);
  return [[evacuation.resourceType, evacuation.amount + evacuation.terminalInitialAmount]];
}

function seedStaleRemovalReceipt(
  memory: Memory,
  overrides: Partial<NonNullable<LayoutsOwnerV25["records"][number]["removalReceipt"]>>,
  active: StaleActiveEvidence = null,
  evacuationOverride?: LayoutLabEvacuation | LayoutStorageEvacuation | LayoutTerminalEvacuation,
): void {
  seedStaleOwner(memory, active);
  const owner = layoutsOwner(memory);
  const staleRecord = owner.staleRecords.find((record) => record.roomName === ROOM_NAME);
  if (staleRecord === undefined) throw new Error("expected stale layout record");
  const structureType = active?.startsWith("completed-container-migration")
    ? ("container" as const)
    : active?.startsWith("completed-lab-evacuation")
      ? ("lab" as const)
      : active?.startsWith("completed-link-evacuation")
        ? ("link" as const)
        : active?.startsWith("completed-spawn-evacuation")
          ? ("spawn" as const)
          : active?.startsWith("completed-storage-evacuation")
            ? ("storage" as const)
            : active?.startsWith("completed-terminal-evacuation")
              ? ("terminal" as const)
              : active?.startsWith("completed-tower-evacuation")
                ? ("tower" as const)
                : ("extension" as const);
  const removalReceipt = {
    attempt: 1,
    code: "OK" as const,
    nextEligibleTick: Number.MAX_SAFE_INTEGER,
    observedAt: 101,
    replacementId: `${structureType}-replacement`,
    targetId: `${structureType}-obsolete`,
    targetStructureType: structureType,
    ...overrides,
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      ...owner,
      staleRecords: [
        {
          ...staleRecord,
          ...(evacuationOverride === undefined || structureType !== "lab"
            ? {}
            : { labEvacuation: evacuationOverride }),
          ...(evacuationOverride === undefined || structureType !== "storage"
            ? {}
            : { storageEvacuation: evacuationOverride }),
          ...(evacuationOverride === undefined || structureType !== "terminal"
            ? {}
            : { terminalEvacuation: evacuationOverride }),
          removalReceipt,
        },
      ],
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
}

function seedStaleSiteReceipt(
  memory: Memory,
  overrides: Partial<NonNullable<LayoutsOwnerV25["records"][number]["siteReceipts"]>[number]>,
): { readonly structureType: string; readonly x: number; readonly y: number } {
  const owner = layoutsOwner(memory);
  const current = owner.records.find((record) => record.roomName === ROOM_NAME);
  const receipt = current?.siteReceipts?.find(({ code }) => code === "OK");
  if (current === undefined || receipt === undefined)
    throw new Error("expected initialized layout site receipt");
  const proposalId = `site-v1:colony:${ROOM_NAME}:${current.fingerprint}:0:extension:40:40`;
  const normalizedOverrides =
    overrides.proposalId === "noncanonical-prefix"
      ? {
          ...overrides,
          proposalId: `site-v1:extra:${proposalId.slice("site-v1:".length)}`,
        }
      : overrides;
  const canonicalReceipt = { ...receipt, proposalId, ...normalizedOverrides };
  const identity = parseSiteIdentity(proposalId);
  const staleRecord = {
    ...current,
    algorithmRevision: "owned-room-layout-v1",
    siteReceipts: [canonicalReceipt],
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      records: owner.records.map((record) =>
        record.roomName === ROOM_NAME ? staleRecord : record,
      ),
      revision: owner.revision,
      schemaVersion: 24,
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
  return identity;
}

function parseSiteIdentity(proposalId: string): {
  readonly structureType: string;
  readonly x: number;
  readonly y: number;
} {
  const fields = proposalId.split(":");
  const x = Number(fields[fields.length - 1]);
  const y = Number(fields[fields.length - 2]);
  const structureType = fields[fields.length - 3];
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || structureType === undefined)
    throw new Error("expected canonical layout site identity");
  return { structureType, x, y };
}

function seedStaleOwner(memory: Memory, active: StaleActiveEvidence, roomName = ROOM_NAME): void {
  const owner = layoutsOwner(memory);
  const current = owner.records.find((record) => record.roomName === roomName);
  if (current === undefined) throw new Error("expected initialized layout record");
  const {
    containerMigration: _containerMigration,
    extensionEvacuation: _extensionEvacuation,
    labEvacuation: _labEvacuation,
    linkEvacuation: _linkEvacuation,
    removalReceipt: _removalReceipt,
    siteReceipts: _siteReceipts,
    spawnEvacuation: _spawnEvacuation,
    storageEvacuation: _storageEvacuation,
    terminalEvacuation: _terminalEvacuation,
    towerEvacuation: _towerEvacuation,
    ...stable
  } = current;
  void [
    _containerMigration,
    _extensionEvacuation,
    _labEvacuation,
    _linkEvacuation,
    _removalReceipt,
    _siteReceipts,
    _spawnEvacuation,
    _storageEvacuation,
    _terminalEvacuation,
    _towerEvacuation,
  ];
  const completedContainerMigration =
    active !== null && active.startsWith("completed-container-migration");
  const completedExtensionEvacuation =
    active !== null && active.startsWith("completed-extension-evacuation");
  const completedLabEvacuation = active !== null && active.startsWith("completed-lab-evacuation");
  const completedLinkEvacuation = active !== null && active.startsWith("completed-link-evacuation");
  const completedSpawnEvacuation =
    active !== null && active.startsWith("completed-spawn-evacuation");
  const completedStorageEvacuation =
    active !== null && active.startsWith("completed-storage-evacuation");
  const completedTerminalEvacuation =
    active !== null && active.startsWith("completed-terminal-evacuation");
  const completedTowerEvacuation =
    active !== null && active.startsWith("completed-tower-evacuation");
  const staleRecord = {
    ...stable,
    algorithmRevision: "owned-room-layout-v1",
    ...(active === "container-migration" || completedContainerMigration
      ? {
          containerMigration: {
            expiresAt: completedContainerMigration ? 250 : 350,
            replacementId: "container-replacement",
            startedAt: completedContainerMigration ? 100 : 200,
            targetId: "container-obsolete",
          },
        }
      : {}),
    ...(active === "evacuation" || completedExtensionEvacuation
      ? {
          extensionEvacuation: {
            amount: 50,
            expiresAt: completedExtensionEvacuation ? 250 : 350,
            replacementId: "extension-replacement",
            replacementInitialEnergy: 0,
            sourceId: "extension-obsolete",
            startedAt: completedExtensionEvacuation ? 100 : 200,
          },
        }
      : {}),
    ...(completedLabEvacuation
      ? {
          labEvacuation: {
            amount: 100,
            expiresAt: 250,
            replacementId: "lab-replacement",
            replacementInitialEnergy: 0,
            sourceId: "lab-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(completedLinkEvacuation
      ? {
          linkEvacuation: {
            amount: 800,
            expiresAt: 250,
            replacementId: "link-replacement",
            replacementInitialEnergy: 0,
            sourceId: "link-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(completedSpawnEvacuation
      ? {
          spawnEvacuation: {
            amount: 300,
            expiresAt: 250,
            replacementId: "spawn-replacement",
            replacementInitialEnergy: 0,
            sourceId: "spawn-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(completedStorageEvacuation
      ? {
          storageEvacuation: {
            amount: 100,
            expiresAt: 250,
            resourceType: "energy",
            sourceId: "storage-obsolete",
            startedAt: 100,
            terminalId: "storage-replacement",
            terminalInitialAmount: 50,
          },
        }
      : {}),
    ...(completedTerminalEvacuation
      ? {
          terminalEvacuation: {
            amount: 100,
            expiresAt: 250,
            replacementId: "terminal-replacement",
            replacementInitialAmount: 0,
            resourceType: "energy",
            sourceId: "terminal-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(active === "tower-evacuation" || completedTowerEvacuation
      ? {
          towerEvacuation: {
            amount: 500,
            expiresAt: completedTowerEvacuation ? 250 : 350,
            replacementId: "tower-replacement",
            replacementInitialEnergy: 10,
            sourceId: "tower-obsolete",
            startedAt: completedTowerEvacuation ? 100 : 200,
          },
        }
      : {}),
    ...((active === "site-receipt" ||
      active === "completed-container-migration-with-site" ||
      active === "completed-extension-evacuation-with-site" ||
      active === "completed-lab-evacuation-with-site" ||
      active === "completed-link-evacuation-with-site" ||
      active === "completed-spawn-evacuation-with-site" ||
      active === "completed-storage-evacuation-with-site" ||
      active === "completed-terminal-evacuation-with-site" ||
      active === "completed-tower-evacuation-with-site") &&
    _siteReceipts?.[0] !== undefined
      ? { siteReceipts: [_siteReceipts[0]] }
      : {}),
    ...((active === "source-handoff" ||
      active === "completed-extension-evacuation-with-source-handoff") &&
    stable.sourceServices !== undefined
      ? {
          sourceServices: stable.sourceServices.map((placement) => ({
            ...placement,
            ...(placement.service === undefined
              ? {}
              : { service: { ...placement.service, issuerSequence: 2 } }),
          })),
        }
      : {}),
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      records: owner.records.map((record) => (record.roomName === roomName ? staleRecord : record)),
      revision: owner.revision,
      schemaVersion: 24,
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
}

function seedSettledStaleSourceService(memory: Memory): {
  readonly contractId: string;
  readonly expectedActorId: string;
} {
  seedStaleOwner(memory, "source-handoff");
  const issuer = `mining/${ROOM_NAME}/source-${ROOM_NAME}`;
  const contracts = memory.myrmex?.contracts as
    | {
        active?: Array<{
          history: Array<{ from: string | null; reason: string; tick: number; to: string }>;
          id: string;
          issuer: string;
          issuerSequence: number;
          lease: null | { actorId: string };
          requestSignature: string;
          revision: number;
          state: string;
        }>;
        issuerFrontiers?: Array<{ issuer: string; retiredThrough: number }>;
      }
    | undefined;
  const predecessor = contracts?.active?.find((contract) => contract.issuer === issuer);
  if (
    predecessor === undefined ||
    contracts?.active === undefined ||
    predecessor.state !== "funded"
  )
    throw new Error("expected funded static-mining predecessor");
  const successorRequest = {
    ...(JSON.parse(predecessor.requestSignature) as WorkContractRequest),
    issuerSequence: 2,
  };
  const successorId = contractIdFor(issuer, `source-${ROOM_NAME}`, 2);
  const expectedActorId = `static-miner-${ROOM_NAME}`;
  const active = contracts.active.map((contract) =>
    contract === predecessor
      ? {
          ...contract,
          history: [
            ...contract.history,
            {
              from: "funded",
              reason: "test-exact-static-mining-assignment",
              tick: 102,
              to: "assigned",
            },
          ],
          id: successorId,
          issuerSequence: 2,
          lease: {
            actorId: expectedActorId,
            actorName: expectedActorId,
            assignedAt: 102,
            assignmentCost: 0,
            expiresAt: 112,
            travelTicks: 0,
          },
          requestSignature: requestSignature(successorRequest),
          revision: contract.revision + 1,
          state: "assigned",
        }
      : contract.lease?.actorId === expectedActorId &&
          (contract.state === "assigned" || contract.state === "active")
        ? {
            ...contract,
            history: [
              ...contract.history,
              {
                from: contract.state,
                reason: "test-release-static-mining-actor",
                tick: 102,
                to: "suspended",
              },
            ],
            lease: null,
            revision: contract.revision + 1,
            state: "suspended",
          }
        : contract,
  );
  const issuerFrontiers = [
    ...(contracts.issuerFrontiers ?? []).filter((frontier) => frontier.issuer !== issuer),
    { issuer, retiredThrough: 1 },
  ].sort((left, right) => left.issuer.localeCompare(right.issuer));
  memory.myrmex = {
    ...memory.myrmex,
    contracts: { ...(memory.myrmex?.contracts as object), active, issuerFrontiers },
  } as NonNullable<Memory["myrmex"]>;
  return { contractId: successorId, expectedActorId };
}

function advanceMiningReservation(memory: Memory, revision: number): void {
  const colonies = memory.myrmex?.colonies as
    | {
        ledger?: Array<{
          issuer: string;
          request: BudgetRequest;
          reservationId: string;
          revision: number;
        }>;
      }
    | undefined;
  const issuer = `mining/${ROOM_NAME}/source-${ROOM_NAME}`;
  const reservation = colonies?.ledger?.find((entry) => entry.issuer === issuer);
  if (reservation === undefined) throw new Error("expected static-mining reservation");
  const request = { ...reservation.request, revision };
  reservation.request = request;
  reservation.reservationId = reservationIdFor(request);
  reservation.revision = revision;
}

function staleEvacuation(
  record: LayoutsOwnerV25["staleRecords"][number] | undefined,
  kind: CompletedStaleEvacuationKind,
) {
  return kind === "container"
    ? record?.containerMigration
    : kind === "extension"
      ? record?.extensionEvacuation
      : kind === "lab"
        ? record?.labEvacuation
        : kind === "link"
          ? record?.linkEvacuation
          : kind === "spawn"
            ? record?.spawnEvacuation
            : kind === "storage"
              ? record?.storageEvacuation
              : kind === "terminal"
                ? record?.terminalEvacuation
                : record?.towerEvacuation;
}

function withoutCompletedEvacuation(
  record: LayoutsOwnerV25["staleRecords"][number],
  kind: CompletedStaleEvacuationKind,
): LayoutsOwnerV25["staleRecords"][number] {
  const { removalReceipt: _removalReceipt, ...withoutReceipt } = record;
  void _removalReceipt;
  if (kind === "container") {
    const { containerMigration: _containerMigration, ...retained } = withoutReceipt;
    void _containerMigration;
    return retained;
  }
  if (kind === "extension") {
    const { extensionEvacuation: _extensionEvacuation, ...retained } = withoutReceipt;
    void _extensionEvacuation;
    return retained;
  }
  if (kind === "lab") {
    const { labEvacuation: _labEvacuation, ...retained } = withoutReceipt;
    void _labEvacuation;
    return retained;
  }
  if (kind === "link") {
    const { linkEvacuation: _linkEvacuation, ...retained } = withoutReceipt;
    void _linkEvacuation;
    return retained;
  }
  if (kind === "spawn") {
    const { spawnEvacuation: _spawnEvacuation, ...retained } = withoutReceipt;
    void _spawnEvacuation;
    return retained;
  }
  if (kind === "storage") {
    const { storageEvacuation: _storageEvacuation, ...retained } = withoutReceipt;
    void _storageEvacuation;
    return retained;
  }
  if (kind === "terminal") {
    const { terminalEvacuation: _terminalEvacuation, ...retained } = withoutReceipt;
    void _terminalEvacuation;
    return retained;
  }
  const { towerEvacuation: _towerEvacuation, ...retained } = withoutReceipt;
  void _towerEvacuation;
  return retained;
}

function layoutsOwner(memory: Memory): LayoutsOwnerV25 {
  const owner = parseLayoutsOwner(memory.myrmex?.layouts);
  if (owner === null) throw new Error("expected layouts owner");
  return owner;
}

function commandSpies(): Commands {
  return {
    createConstructionSite: vi.fn(() => 0),
    destroyStructure: vi.fn(() => 0),
    transferEnergy: vi.fn(() => 0),
    withdrawEnergy: vi.fn(() => 0),
  };
}

function twoRoomGame(
  time: number,
  firstCommands: Commands,
  secondCommands: Commands,
  firstOptions: GameOptions = {},
): RuntimeGame {
  const first = game(time, firstCommands, firstOptions, "W1N1");
  const second = game(time, secondCommands, {}, "W2N2");
  return {
    ...first,
    creeps: { ...first.creeps, ...second.creeps },
    getObjectById: (id) => first.getObjectById?.(id) ?? second.getObjectById?.(id) ?? null,
    rooms: { ...first.rooms, ...second.rooms },
  };
}

async function runCompletedStaleExtensionEvacuationVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  executeTick({ game: game(100, commands, { reverse }), memory });
  executeTick({ game: game(101, commands, { reverse }), memory });
  seedStaleOwner(memory, "evacuation");
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  const settlement = executeTick({
    game: game(202, commands, {
      reverse,
      roomEnergyAvailable: 350,
      roomEnergyCapacityAvailable: 800,
      staleExtensionEvacuation: { replacementEnergy: 50, sourceEnergy: 0 },
    }),
    memory,
  });
  const settlementOwner = layoutsOwner(memory);
  const settlementCommands = {
    create: commands.createConstructionSite.mock.calls.length,
    destroy: commands.destroyStructure.mock.calls.length,
  };
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  const handoff = executeTick({
    game: game(203, commands, {
      reverse,
      roomEnergyAvailable: 350,
      roomEnergyCapacityAvailable: 800,
      staleExtensionEvacuation: { replacementEnergy: 50, sourceEnergy: 0 },
    }),
    memory,
  });
  return {
    handoffCommands: {
      create: commands.createConstructionSite.mock.calls.length,
      destroy: commands.destroyStructure.mock.calls.length,
    },
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    settlementCommands,
    settlementOwner,
    settlementPlanning: settlement.layout.planning,
  };
}

async function runCompletedStaleTowerEvacuationVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  executeTick({ game: game(100, commands, { controllerLevel: 5, reverse }), memory });
  executeTick({ game: game(101, commands, { controllerLevel: 5, reverse }), memory });
  seedStaleOwner(memory, "tower-evacuation");
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  const settlementGame = game(202, commands, {
    controllerLevel: 5,
    reverse,
    roomEnergyAvailable: 350,
    roomEnergyCapacityAvailable: 1_800,
    staleTowerEvacuation: { replacementEnergy: 510, sourceEnergy: 0 },
  });
  const settlement = executeTick({
    game: settlementGame,
    memory,
  });
  const settlementOwner = layoutsOwner(memory);
  const settlementCommands = {
    create: commands.createConstructionSite.mock.calls.length,
    destroy: commands.destroyStructure.mock.calls.length,
  };
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  const handoff = executeTick({
    game: game(203, commands, {
      controllerLevel: 5,
      reverse,
      roomEnergyAvailable: 350,
      roomEnergyCapacityAvailable: 1_800,
      staleTowerEvacuation: { replacementEnergy: 510, sourceEnergy: 0 },
    }),
    memory,
  });
  return {
    handoffCommands: {
      create: commands.createConstructionSite.mock.calls.length,
      destroy: commands.destroyStructure.mock.calls.length,
    },
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    settlementCommands,
    settlementOwner,
    settlementPlanning: settlement.layout.planning,
  };
}

function game(
  time: number,
  commands: Commands,
  options: GameOptions = {},
  roomName = ROOM_NAME,
): RuntimeGame {
  if (options.visible === false)
    return {
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    };
  const pos = (x: number, y: number) => ({ roomName, x, y });
  const source = {
    energy: 3_000,
    energyCapacity: 3_000,
    id: `source-${roomName}`,
    pos: pos(10, 10),
    ticksToRegeneration: 300,
  } as unknown as Source;
  const worker = {
    body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: `worker-${roomName}`,
    my: true,
    name: `worker-${roomName}`,
    owner: { username: "Myrmex" },
    pos: options.staleTowerEvacuation === undefined ? pos(25, 25) : pos(39, 39),
    room: { name: roomName },
    spawning: false,
    store: { getCapacity: () => 50, getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
    transfer: commands.transferEnergy,
    withdraw: commands.withdrawEnergy,
    ticksToLive: 1_000,
  } as unknown as Creep;
  const staticMiner = options.staticMiner
    ? ({
        body: [
          ...Array.from({ length: 5 }, () => ({ hits: 100, type: "work" })),
          ...Array.from({ length: 3 }, () => ({ hits: 100, type: "move" })),
          { hits: 100, type: "carry" },
        ],
        fatigue: 0,
        harvest: () => 0,
        hits: 900,
        hitsMax: 900,
        id: `static-miner-${roomName}`,
        my: true,
        name: `static-miner-${roomName}`,
        owner: { username: "Myrmex" },
        pos: pos(11, 11),
        room: { name: roomName },
        spawning: false,
        store: { getCapacity: () => 50, getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
        ticksToLive: 1_000,
      } as unknown as Creep)
    : null;
  const supportWorker = options.staticMiner
    ? ({
        body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
        fatigue: 0,
        hits: 300,
        hitsMax: 300,
        id: `support-worker-${roomName}`,
        my: true,
        name: `support-worker-${roomName}`,
        owner: { username: "Myrmex" },
        pos: pos(25, 24),
        room: { name: roomName },
        spawning: false,
        store: { getCapacity: () => 50, getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
        ticksToLive: 1_000,
      } as unknown as Creep)
    : null;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: `spawn-${roomName}`,
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24, 25),
    room: { name: roomName },
    spawnCreep: () => 0,
    spawning: null,
    store: { getCapacity: () => 300, getFreeCapacity: () => 0, getUsedCapacity: () => 300 },
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const hostile = {
    body: [{ hits: 100, type: "attack" }],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: `hostile-${roomName}`,
    my: false,
    name: `hostile-${roomName}`,
    owner: { username: "Enemy" },
    pos: pos(20, 20),
    spawning: false,
    store: { getCapacity: () => 0, getFreeCapacity: () => 0, getUsedCapacity: () => 0 },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const controller = {
    id: `controller-${roomName}`,
    level: options.controllerLevel ?? 3,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(25, 20),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: options.controllerRisk ? 100 : 10_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const completedStructure =
    options.staleSiteEvidence === undefined
      ? null
      : ({
          destroy: commands.destroyStructure,
          hits: 1_000,
          hitsMax: 1_000,
          id: `completed-${roomName}`,
          isActive: () => true,
          my: options.staleSiteEvidence.ownership === "owned",
          owner: {
            username: options.staleSiteEvidence.ownership === "owned" ? "Myrmex" : "OtherPlayer",
          },
          pos: pos(options.staleSiteEvidence.x, options.staleSiteEvidence.y),
          room: { name: roomName },
          store: {
            getCapacity: () => 50,
            getFreeCapacity: () => 50,
            getUsedCapacity: () => 0,
          },
          structureType: options.staleSiteEvidence.structureType,
        } as unknown as AnyStructure);
  const staleRemovalTargetType = options.staleRemovalTargetType ?? "extension";
  const staleRemovalHits =
    staleRemovalTargetType === "spawn"
      ? 5_000
      : staleRemovalTargetType === "storage"
        ? 10_000
        : staleRemovalTargetType === "tower" || staleRemovalTargetType === "terminal"
          ? 3_000
          : staleRemovalTargetType === "lab"
            ? 500
            : 1_000;
  const staleRemovalCapacity =
    staleRemovalTargetType === "container"
      ? 2_000
      : staleRemovalTargetType === "spawn"
        ? 300
        : staleRemovalTargetType === "storage"
          ? 1_000_000
          : staleRemovalTargetType === "tower"
            ? 1_000
            : staleRemovalTargetType === "link"
              ? 800
              : staleRemovalTargetType === "lab"
                ? 2_000
                : staleRemovalTargetType === "terminal"
                  ? 300_000
                  : 50;
  const storageTerminalResources = options.storageTerminalResources ?? [];
  const storageTerminalCapacity = options.storageTerminalCapacity ?? 300_000;
  const storageTerminalUsed = storageTerminalResources.reduce(
    (total, [, amount]) => total + amount,
    0,
  );
  const storageTerminal =
    staleRemovalTargetType === "storage"
      ? ({
          cooldown: 0,
          hits: 3_000,
          hitsMax: 3_000,
          id: "storage-replacement",
          isActive: () => options.storageTerminalActive !== false,
          my: true,
          owner: { username: "Myrmex" },
          pos: pos(39, 40),
          room: { name: roomName },
          send: () => 0,
          store: {
            ...Object.fromEntries(storageTerminalResources),
            getCapacity: () => storageTerminalCapacity,
            getFreeCapacity: () => storageTerminalCapacity - storageTerminalUsed,
            getUsedCapacity: (resourceType?: string) =>
              resourceType === undefined
                ? storageTerminalUsed
                : (storageTerminalResources.find(([type]) => type === resourceType)?.[1] ?? 0),
          },
          structureType: "terminal",
        } as unknown as StructureTerminal)
      : null;
  const staleExtensionEvacuation = options.staleExtensionEvacuation;
  const evacuationExtension = (id: string, x: number, energy: number) =>
    ({
      destroy: commands.destroyStructure,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: pos(x, 40),
      room: { name: roomName },
      store: {
        energy,
        getCapacity: () => 50,
        getFreeCapacity: () => 50 - energy,
        getUsedCapacity: () => energy,
      },
      structureType: "extension",
    }) as unknown as StructureExtension;
  const staleEvacuationSource =
    staleExtensionEvacuation === undefined
      ? null
      : evacuationExtension("extension-obsolete", 40, staleExtensionEvacuation.sourceEnergy);
  const staleEvacuationReplacement =
    staleExtensionEvacuation === undefined
      ? null
      : evacuationExtension(
          "extension-replacement",
          41,
          staleExtensionEvacuation.replacementEnergy,
        );
  const staleTowerEvacuation = options.staleTowerEvacuation;
  const evacuationTower = (id: string, x: number, energy: number) =>
    ({
      attack: () => 0,
      destroy: commands.destroyStructure,
      heal: () => 0,
      hits: 3_000,
      hitsMax: 3_000,
      id,
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: pos(x, 39),
      repair: () => 0,
      room: { name: roomName },
      store: {
        energy,
        getCapacity: () => 1_000,
        getFreeCapacity: () => 1_000 - energy,
        getUsedCapacity: () => energy,
      },
      structureType: "tower",
    }) as unknown as StructureTower;
  const staleTowerSource =
    staleTowerEvacuation === undefined
      ? null
      : evacuationTower("tower-obsolete", 40, staleTowerEvacuation.sourceEnergy);
  const staleTowerReplacement =
    staleTowerEvacuation === undefined
      ? null
      : evacuationTower("tower-replacement", 41, staleTowerEvacuation.replacementEnergy);
  const staleRemovalTarget = options.staleRemovalTarget
    ? ({
        destroy: commands.destroyStructure,
        hits: staleRemovalHits,
        hitsMax: staleRemovalHits,
        id: `${staleRemovalTargetType}-obsolete`,
        isActive: () => true,
        my: true,
        ...(staleRemovalTargetType === "container"
          ? { ticksToDecay: 5_000 }
          : staleRemovalTargetType === "spawn"
            ? { name: "ObsoleteSpawn", spawnCreep: () => 0, spawning: null }
            : staleRemovalTargetType === "link"
              ? { cooldown: 0, transferEnergy: () => 0 }
              : staleRemovalTargetType === "lab"
                ? { cooldown: 0, mineralType: null }
                : staleRemovalTargetType === "terminal"
                  ? { cooldown: 0, send: () => 0 }
                  : {}),
        owner: { username: "Myrmex" },
        pos: pos(40, 40),
        room: { name: roomName },
        store: {
          ...(staleRemovalTargetType === "lab" ? { energy: 0 } : {}),
          getCapacity: (resourceType?: string) =>
            staleRemovalTargetType === "lab" && resourceType !== "energy"
              ? 3_000
              : staleRemovalCapacity,
          getFreeCapacity: (resourceType?: string) =>
            staleRemovalTargetType === "lab" && resourceType !== "energy"
              ? 3_000
              : staleRemovalCapacity,
          getUsedCapacity: () => 0,
        },
        structureType: staleRemovalTargetType,
      } as unknown as AnyStructure)
    : null;
  const structures = options.reverse
    ? [
        spawn,
        ...(completedStructure === null ? [] : [completedStructure]),
        ...(storageTerminal === null ? [] : [storageTerminal]),
        ...(staleEvacuationSource === null ? [] : [staleEvacuationSource]),
        ...(staleEvacuationReplacement === null ? [] : [staleEvacuationReplacement]),
        ...(staleTowerSource === null ? [] : [staleTowerSource]),
        ...(staleTowerReplacement === null ? [] : [staleTowerReplacement]),
        ...(staleRemovalTarget === null ? [] : [staleRemovalTarget]),
      ].reverse()
    : [
        spawn,
        ...(completedStructure === null ? [] : [completedStructure]),
        ...(storageTerminal === null ? [] : [storageTerminal]),
        ...(staleEvacuationSource === null ? [] : [staleEvacuationSource]),
        ...(staleEvacuationReplacement === null ? [] : [staleEvacuationReplacement]),
        ...(staleTowerSource === null ? [] : [staleTowerSource]),
        ...(staleTowerReplacement === null ? [] : [staleTowerReplacement]),
        ...(staleRemovalTarget === null ? [] : [staleRemovalTarget]),
      ];
  const ownedCreeps =
    staticMiner === null || supportWorker === null
      ? [worker]
      : [worker, supportWorker, staticMiner];
  const creeps = options.threat ? [...ownedCreeps, hostile] : ownedCreeps;
  const room = {
    controller,
    createConstructionSite: commands.createConstructionSite,
    energyAvailable: options.roomEnergyAvailable ?? 800,
    energyCapacityAvailable: options.roomEnergyCapacityAvailable ?? 800,
    find: (kind: number): unknown[] =>
      kind === FIND_CREEPS_VALUE
        ? options.reverse
          ? [...creeps].reverse()
          : creeps
        : kind === FIND_STRUCTURES_VALUE
          ? structures
          : kind === FIND_SOURCES_VALUE
            ? [source]
            : kind === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    getTerrain: () => (options.blockedTerrain ? { get: () => 1 } : PLAIN_ROOM_TERRAIN),
    name: roomName,
  } as unknown as Room;
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: Object.fromEntries(ownedCreeps.map((creep) => [creep.name, creep])),
    getObjectById: (id) =>
      id === worker.id
        ? worker
        : id === supportWorker?.id
          ? supportWorker
          : id === staticMiner?.id
            ? staticMiner
            : id === spawn.id
              ? spawn
              : id === source.id
                ? source
                : id === staleEvacuationSource?.id
                  ? staleEvacuationSource
                  : id === staleEvacuationReplacement?.id
                    ? staleEvacuationReplacement
                    : id === staleTowerSource?.id
                      ? staleTowerSource
                      : id === staleTowerReplacement?.id
                        ? staleTowerReplacement
                        : null,
    rooms: { [roomName]: room },
    shard: { name: "shard3" },
    time,
  };
}
