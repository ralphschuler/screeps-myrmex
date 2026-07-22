import { projectColonyRclPolicy, type ColonyView } from "../../../bot/src/colony";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import { emptyContractExecutionView, emptyContractPlanningView } from "../../../bot/src/contracts";
import {
  CONSTRUCTION_SITE_LIMITS,
  LAYOUT_ALGORITHM_REVISION,
  ConstructionSiteExecutor,
  arbitrateConstructionSites,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutRemovalReceipt,
  persistLayoutStorageEvacuation,
  reconcileConstructionSiteExecution,
  type LayoutCommitment,
  type LayoutPlacement,
  type LayoutsOwnerV24,
} from "../../../bot/src/layout";
import { observeLogisticsGraph, planLogisticsRuntime } from "../../../bot/src/logistics/runtime";
import { projectLayoutStorageEvacuations } from "../../../bot/src/logistics/storage-evacuation";
import { ConstructionPlanner } from "../../../bot/src/maintenance";
import type { RoomSnapshot, WorldSnapshot } from "../../../bot/src/world/snapshot";
import {
  canonicalHash,
  canonicalSerialize,
  defineReplayScenario,
  runScenario,
  type ReplayScenario,
  type ScenarioRunResult,
} from "../../src";

const ROOM = "W1N1";
const FIRST_TICK = 70_000;
const TICKS = 304;
const RESET_TICK = FIRST_TICK + 150;
const CPU_PER_TICK = 0.1;
const BUILD_ENERGY_PER_TICK = 100;
const STORAGE_BUILD_ENERGY = 30_000;
const STORAGE_ID = "storage-obsolete";
const TERMINAL_ID = "terminal-active";
const SITE_ID = "site-storage-20-20";
const POLICY_FINGERPRINT = "phase2-storage-rebuild-policy-v1";
const SCENARIO_ID = "phase2-storage-rebuild-continuity-v1";
const SCENARIO_SEED = "phase2-storage-rebuild-continuity-seed-v1";

const STORAGE_POS = pos(20, 20);
const TERMINAL_POS = pos(21, 20);
const COMMITMENT: LayoutCommitment = Object.freeze({
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: pos(25, 25),
  blockers: Object.freeze([]),
  committedAt: FIRST_TICK - 100,
  fingerprint: "phase2-storage-rebuild-layout-v1",
  transform: 0,
});
const PLACEMENTS: readonly LayoutPlacement[] = Object.freeze([
  {
    adoption: "planned",
    layer: "primary",
    minimumRcl: 4,
    pos: STORAGE_POS,
    structureType: "storage",
  },
  {
    adoption: "exact",
    layer: "primary",
    minimumRcl: 6,
    pos: TERMINAL_POS,
    structureType: "terminal",
  },
]);
const POLICY = projectColonyRclPolicy({
  activeThreat: false,
  controllerLevel: 8,
  controllerRisk: false,
  cpuMode: "normal",
  energyAvailable: 12_900,
  energyCapacityAvailable: 12_900,
  protectedSpawnEnergy: 300,
  rcl8Health: null,
  state: "mature",
  visibility: "visible",
});
const COLONY = {
  activeThreat: false,
  controllerRisk: false,
  id: ROOM,
  legalWorkforce: true,
  rclPolicy: {
    ...POLICY,
    progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
  },
  roomName: ROOM,
  state: "mature",
  visibility: "visible",
} as ColonyView;

const VARIANTS = Object.freeze({
  warm: Object.freeze({ resetTicks: Object.freeze([] as number[]), reverseObservation: false }),
  reset: Object.freeze({
    resetTicks: Object.freeze([RESET_TICK]),
    reverseObservation: false,
  }),
  reordered: Object.freeze({
    resetTicks: Object.freeze([] as number[]),
    reverseObservation: true,
  }),
});
type VariantName = keyof typeof VARIANTS;

interface StorageWorld {
  readonly commands: readonly {
    readonly kind: "create-site" | "destroy-structure";
    readonly tick: number;
  }[];
  readonly maximumActiveSites: number;
  readonly maximumEnergyPerTick: number;
  readonly maximumPersistentBytes: number;
  readonly milestones: {
    readonly activeStorageObservedAt: number | null;
    readonly receiptClearedAt: number | null;
    readonly siteCommandAt: number | null;
    readonly siteObservedAt: number | null;
  };
  readonly owner: LayoutsOwnerV24;
  readonly siteProgress: number | null;
  readonly storageActive: boolean;
  readonly terminalAdmittedFlowTicks: number;
  readonly terminalServiceTicks: number;
  readonly totalBuildEnergy: number;
}

interface StorageInput {
  readonly reverseObservation: boolean;
}

interface StorageOutcome {
  readonly activeSites: number;
  readonly buildEnergy: number;
  readonly storageActive: boolean;
  readonly terminalServiceAvailable: boolean;
  readonly tick: number;
}

interface StorageHeap {
  readonly constructionPlanner: ConstructionPlanner;
  readonly siteExecutor: ConstructionSiteExecutor;
}

export function collectPhase2StorageRebuildContinuityEvidence() {
  const warm = runScenario(storageScenario("warm"));
  const reset = runScenario(storageScenario("reset"));
  const reordered = runScenario(storageScenario("reordered"));
  const summaries = {
    reordered: summarize(reordered),
    reset: summarize(reset),
    warm: summarize(warm),
  };
  const semanticBytes = Object.values(summaries).map((summary) => canonicalSerialize(summary));
  const final = warm.finalWorld;
  const milestones = requiredMilestones(final.milestones);
  return Object.freeze({
    scenario: Object.freeze({
      id: SCENARIO_ID,
      seed: SCENARIO_SEED,
      ticks: TICKS,
      variants: VARIANTS,
    }),
    budgets: Object.freeze({
      constructionEnergy: final.totalBuildEnergy,
      maximumActiveSites: final.maximumActiveSites,
      maximumCpuPerTick: Math.max(...warm.transcript.ticks.map(({ cpu }) => cpu.used)),
      maximumEnergyPerTick: final.maximumEnergyPerTick,
      maximumPersistentBytes: final.maximumPersistentBytes,
    }),
    continuity: Object.freeze({
      duplicateDestroyCommands: final.commands.filter(({ kind }) => kind === "destroy-structure")
        .length,
      terminalAdmittedFlowTicks: final.terminalAdmittedFlowTicks,
      terminalServiceTicks: final.terminalServiceTicks,
      uninterruptedUntilStorageObserved:
        final.terminalServiceTicks === milestones.activeStorageObservedAt - FIRST_TICK,
    }),
    equivalence: Object.freeze({
      semanticBytesIdentical: new Set(semanticBytes).size === 1,
      outcomeHashes: Object.freeze({
        reordered: reordered.outcomeHash,
        reset: reset.outcomeHash,
        warm: warm.outcomeHash,
      }),
      semanticHashes: Object.freeze({
        reordered: canonicalHash(summaries.reordered),
        reset: canonicalHash(summaries.reset),
        warm: canonicalHash(summaries.warm),
      }),
    }),
    final: Object.freeze({
      activeSites: final.siteProgress === null ? 0 : 1,
      activeStorage: final.storageActive,
      removalReceipt: final.owner.records[0]?.removalReceipt ?? null,
      storageEvacuation: final.owner.records[0]?.storageEvacuation ?? null,
    }),
    milestones,
  });
}

function storageScenario(
  variantName: VariantName,
): ReplayScenario<StorageWorld, StorageInput, StorageOutcome, StorageHeap> {
  const variant = VARIANTS[variantName];
  return defineReplayScenario({
    id: SCENARIO_ID,
    seed: SCENARIO_SEED,
    initialWorld: initialWorld(),
    ticks: Array.from({ length: TICKS }, (_, offset) => {
      const gameTime = FIRST_TICK + offset;
      return {
        cpuBudget: CPU_PER_TICK,
        gameTime,
        input: { reverseObservation: variant.reverseObservation },
        resetHeap: variant.resetTicks.includes(gameTime),
      };
    }),
    createHeap,
    resetHeap: createHeap,
    assertCpu: ({ budget, remaining, used }) => {
      if (budget !== CPU_PER_TICK || used !== CPU_PER_TICK || remaining !== 0)
        throw new Error("storage rebuild CPU accounting drifted");
    },
    step: ({ gameTime, heap, input, world }) => step(gameTime, heap, input, world),
    verify: (result) => {
      verify(result, variantName);
    },
  });
}

function step(
  tick: number,
  heap: StorageHeap,
  input: StorageInput,
  world: StorageWorld,
): {
  readonly cpuUsed: number;
  readonly nextWorld: StorageWorld;
  readonly outcome: StorageOutcome;
} {
  const snapshot = snapshotOf(world, tick, input.reverseObservation);
  const room = snapshot.rooms[0];
  if (room === undefined) throw new Error("storage rebuild room unavailable");
  const record = world.owner.records[0];
  if (record === undefined) throw new Error("storage rebuild layout record unavailable");
  const evacuation = projectLayoutStorageEvacuations({
    existingBudgets: [],
    quiescentTerminalRoomNames: new Set([ROOM]),
    records: [record],
    snapshot,
    tick,
  });
  const graph = observeLogisticsGraph(snapshot, true);
  const logistics = planLogisticsRuntime({
    execution: emptyContractExecutionView("ready"),
    includeOptional: true,
    planning: emptyContractPlanningView("ready"),
    resourceDemands: evacuation.demands,
    snapshot,
    tick,
  });
  const terminalFlowAdmitted =
    logistics.plan.projections.some(
      ({ admittedAmount, blocker, sourceNodeId }) =>
        admittedAmount === 50 &&
        blocker === null &&
        sourceNodeId === `store:${TERMINAL_ID}:source:energy`,
    ) &&
    logistics.contracts.commitments.some(
      ({ flowId, reservedAmount }) =>
        flowId.startsWith(`flow:store:${TERMINAL_ID}:source:energy->`) && reservedAmount === 50,
    ) &&
    logistics.budgets.some(({ category }) => category === "harvesting-filling");
  const terminalServiceAvailable =
    evacuation.demands.suppressedSinkTargetIds?.length === 0 &&
    evacuation.demands.suppressedSourceTargetIds?.length === 0 &&
    graph.nodes.some(({ id }) => id === `store:${TERMINAL_ID}:source:energy`) &&
    graph.nodes.some(({ id }) => id === `store:${TERMINAL_ID}:sink:energy`) &&
    terminalFlowAdmitted;

  const migration = heap.constructionPlanner.planMigration({
    activeLeasedWorkTargetIds: new Set(),
    activeLogisticsEndpoints: [],
    activeLogisticsFlowIds: new Set(),
    activeLogisticsTargetIds: new Set(),
    activeTerminalLogisticsTargetIds: new Set(),
    colony: COLONY,
    commitment: COMMITMENT,
    globalOwnedSiteCount: world.siteProgress === null ? 0 : 1,
    industryTerminalWork: { roomName: ROOM, status: "quiescent" },
    labEvacuation: null,
    logisticsEvidenceReady: true,
    observationFingerprint: `storage-rebuild:${String(tick)}`,
    placements: PLACEMENTS,
    policyFingerprint: POLICY_FINGERPRINT,
    removalReceipt: record.removalReceipt ?? null,
    room,
    storageEvacuation: record.storageEvacuation ?? null,
    storageRemovalCompleted:
      record.removalReceipt?.targetStructureType === "storage" &&
      evacuation.demands.suppressedSinkTargetIds?.length === 0 &&
      evacuation.demands.suppressedSourceTargetIds?.length === 0,
    terminalEvacuation: null,
  });
  let owner = persistLayoutRemovalReceipt(world.owner, ROOM, migration.removalReceipt);
  owner = persistLayoutStorageEvacuation(owner, ROOM, migration.storageEvacuation);

  const diff = diffOwnedRoomLayout({
    colonyId: ROOM,
    commitment: COMMITMENT,
    commitmentConflicted: false,
    constructionSites: room.constructionSites,
    observationFingerprint: `storage-rebuild:${String(tick)}`,
    placements: PLACEMENTS,
    policy: POLICY,
    policyEnabled: true,
    policyFingerprint: POLICY_FINGERPRINT,
    roomName: ROOM,
    roomStatus: "owned",
    structures: room.structures ?? [],
  });
  const siteArbitration = arbitrateConstructionSites({
    globalOwnedSiteCount: world.siteProgress === null ? 0 : 1,
    limits: CONSTRUCTION_SITE_LIMITS,
    perRoomSiteCounts: [{ count: world.siteProgress === null ? 0 : 1, roomName: ROOM }],
    priorReceipts: record.siteReceipts ?? [],
    progressionAuthorizations: [{ authorized: true, colonyId: ROOM, roomName: ROOM }],
    proposals: diff.proposals,
    tick,
  });
  const execution = heap.siteExecutor.execute(siteArbitration.intents, {
    isCurrentCommitment: (_roomName, fingerprint) => fingerprint === COMMITMENT.fingerprint,
    resolveRoom: () =>
      ({ controller: { my: true }, createConstructionSite: () => 0 }) as unknown as Room,
  });
  owner = reconcileConstructionSiteExecution(owner, execution, tick).owner;

  const created = execution.some(({ called, code }) => called && code === "OK");
  const currentProgress = world.siteProgress;
  const buildEnergy =
    currentProgress === null
      ? 0
      : Math.min(BUILD_ENERGY_PER_TICK, STORAGE_BUILD_ENERGY - currentProgress);
  const completed =
    currentProgress !== null && currentProgress + buildEnergy === STORAGE_BUILD_ENERGY;
  const nextSiteProgress = created ? 0 : completed ? null : currentProgress;
  const nextStorageActive = world.storageActive || completed;
  const nextMilestones = {
    activeStorageObservedAt:
      world.milestones.activeStorageObservedAt ?? (world.storageActive ? tick : null),
    receiptClearedAt:
      world.milestones.receiptClearedAt ??
      (migration.removalReceipt === null && migration.storageEvacuation === null ? tick : null),
    siteCommandAt: world.milestones.siteCommandAt ?? (created ? tick : null),
    siteObservedAt: world.milestones.siteObservedAt ?? (world.siteProgress !== null ? tick : null),
  };
  const nextWorld: StorageWorld = {
    commands: created
      ? [...world.commands, { kind: "create-site", tick } as const]
      : world.commands,
    maximumActiveSites: Math.max(world.maximumActiveSites, nextSiteProgress === null ? 0 : 1),
    maximumEnergyPerTick: Math.max(world.maximumEnergyPerTick, buildEnergy),
    maximumPersistentBytes: Math.max(
      world.maximumPersistentBytes,
      utf8ByteLength(canonicalSerialize(owner)),
    ),
    milestones: nextMilestones,
    owner,
    siteProgress:
      nextSiteProgress === null || created ? nextSiteProgress : nextSiteProgress + buildEnergy,
    storageActive: nextStorageActive,
    terminalAdmittedFlowTicks:
      world.terminalAdmittedFlowTicks + (!world.storageActive && terminalFlowAdmitted ? 1 : 0),
    terminalServiceTicks:
      world.terminalServiceTicks + (!world.storageActive && terminalServiceAvailable ? 1 : 0),
    totalBuildEnergy: world.totalBuildEnergy + buildEnergy,
  };
  return {
    cpuUsed: CPU_PER_TICK,
    nextWorld,
    outcome: {
      activeSites: world.siteProgress === null ? 0 : 1,
      buildEnergy,
      storageActive: world.storageActive,
      terminalServiceAvailable,
      tick,
    },
  };
}

function initialWorld(): StorageWorld {
  let owner = persistLayoutCommitment(emptyLayoutsOwner(), ROOM, COMMITMENT, PLACEMENTS);
  owner = persistLayoutStorageEvacuation(owner, ROOM, {
    amount: 3_000,
    expiresAt: FIRST_TICK + 140,
    resourceType: "energy",
    sourceId: STORAGE_ID,
    startedAt: FIRST_TICK - 10,
    terminalId: TERMINAL_ID,
    terminalInitialAmount: 25_000,
  });
  owner = persistLayoutRemovalReceipt(owner, ROOM, {
    attempt: 1,
    code: "OK",
    nextEligibleTick: Number.MAX_SAFE_INTEGER,
    observedAt: FIRST_TICK - 1,
    replacementId: TERMINAL_ID,
    targetId: STORAGE_ID,
    targetStructureType: "storage",
  });
  return {
    commands: [],
    maximumActiveSites: 0,
    maximumEnergyPerTick: 0,
    maximumPersistentBytes: utf8ByteLength(canonicalSerialize(owner)),
    milestones: {
      activeStorageObservedAt: null,
      receiptClearedAt: null,
      siteCommandAt: null,
      siteObservedAt: null,
    },
    owner,
    siteProgress: null,
    storageActive: false,
    terminalAdmittedFlowTicks: 0,
    terminalServiceTicks: 0,
    totalBuildEnergy: 0,
  };
}

function snapshotOf(world: StorageWorld, tick: number, reverse: boolean): WorldSnapshot {
  const terminal = {
    active: true,
    cooldown: 0,
    hits: 3_000,
    hitsMax: 3_000,
    id: TERMINAL_ID,
    pos: TERMINAL_POS,
    store: inventory(300_000, [["energy", 28_000]]),
  };
  const storage = {
    active: true,
    hits: 10_000,
    hitsMax: 10_000,
    id: `built-${SITE_ID}`,
    pos: STORAGE_POS,
    store: inventory(1_000_000, []),
  };
  const extension = {
    active: true,
    hits: 1_000,
    hitsMax: 1_000,
    id: "extension-refill",
    pos: pos(22, 20),
    store: inventory(50, []),
  };
  const structures = [
    {
      hits: terminal.hits,
      hitsMax: terminal.hitsMax,
      id: terminal.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: terminal.pos,
      structureType: "terminal",
    },
    {
      hits: extension.hits,
      hitsMax: extension.hitsMax,
      id: extension.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: extension.pos,
      structureType: "extension",
    },
    ...(world.storageActive
      ? [
          {
            hits: storage.hits,
            hitsMax: storage.hitsMax,
            id: storage.id,
            ownerUsername: "Myrmex",
            ownership: "owned" as const,
            pos: storage.pos,
            structureType: "storage",
          } as const,
        ]
      : []),
  ];
  const storedStructures = [
    {
      hits: terminal.hits,
      hitsMax: terminal.hitsMax,
      id: terminal.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: terminal.pos,
      store: terminal.store,
      structureType: "terminal" as const,
    },
    ...(world.storageActive
      ? [
          {
            hits: storage.hits,
            hitsMax: storage.hitsMax,
            id: storage.id,
            ownerUsername: "Myrmex",
            ownership: "owned" as const,
            pos: storage.pos,
            store: storage.store,
            structureType: "storage" as const,
          },
        ]
      : []),
  ];
  const room = {
    constructionSites:
      world.siteProgress === null
        ? []
        : [
            {
              id: SITE_ID,
              ownerUsername: "Myrmex",
              ownership: "owned" as const,
              pos: STORAGE_POS,
              progress: world.siteProgress,
              progressTotal: STORAGE_BUILD_ENERGY,
              structureType: "storage" as const,
            },
          ],
    controller: { level: 8, ownership: "owned" as const },
    energyAvailable: 12_900,
    energyCapacityAvailable: 12_900,
    hostileCreeps: [],
    name: ROOM,
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [extension],
    ownedSpawns: [],
    ownedStorages: world.storageActive ? [storage] : [],
    ownedTerminals: [terminal],
    ownedTowers: [],
    sources: [],
    storedStructures: reverse ? storedStructures.reverse() : storedStructures,
    structures: reverse ? structures.reverse() : structures,
  } as unknown as RoomSnapshot;
  return {
    observation: { age: 0, shard: "shard3", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: room.constructionSites.length,
    ownedRooms: [room],
    rooms: [room],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: room.constructionSites.length,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: storedStructures.length,
        tombstones: 0,
        total: 2 + storedStructures.length + room.constructionSites.length,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  } as unknown as WorldSnapshot;
}

function summarize(result: ScenarioRunResult<StorageWorld, StorageInput, StorageOutcome>) {
  return {
    commands: result.finalWorld.commands,
    maximumActiveSites: result.finalWorld.maximumActiveSites,
    maximumEnergyPerTick: result.finalWorld.maximumEnergyPerTick,
    maximumPersistentBytes: result.finalWorld.maximumPersistentBytes,
    milestones: result.finalWorld.milestones,
    owner: result.finalWorld.owner,
    siteProgress: result.finalWorld.siteProgress,
    storageActive: result.finalWorld.storageActive,
    terminalAdmittedFlowTicks: result.finalWorld.terminalAdmittedFlowTicks,
    terminalServiceTicks: result.finalWorld.terminalServiceTicks,
    totalBuildEnergy: result.finalWorld.totalBuildEnergy,
  };
}

function verify(
  result: ScenarioRunResult<StorageWorld, StorageInput, StorageOutcome>,
  variantName: VariantName,
): void {
  const world = result.finalWorld;
  const variant = VARIANTS[variantName];
  const resetTicks = result.transcript.ticks
    .filter(({ heapReset }) => heapReset)
    .map(({ gameTime }) => gameTime);
  if (canonicalSerialize(resetTicks) !== canonicalSerialize(variant.resetTicks))
    throw new Error(`${variantName} storage rebuild reset dimensions drifted`);
  if (world.commands.length !== 1 || world.commands[0]?.kind !== "create-site")
    throw new Error(`${variantName} storage rebuild repeated or missed site creation`);
  if (!world.storageActive || world.siteProgress !== null)
    throw new Error(`${variantName} storage rebuild did not reach active committed storage`);
  if (world.totalBuildEnergy !== STORAGE_BUILD_ENERGY)
    throw new Error(`${variantName} storage rebuild energy drifted`);
  if (
    world.maximumActiveSites !== 1 ||
    world.maximumEnergyPerTick > BUILD_ENERGY_PER_TICK ||
    world.maximumPersistentBytes > 4_096
  )
    throw new Error(`${variantName} storage rebuild exceeded site/energy/Memory bounds`);
  const milestones = requiredMilestones(world.milestones);
  if (
    milestones.siteObservedAt !== milestones.siteCommandAt + 1 ||
    milestones.activeStorageObservedAt !== milestones.siteObservedAt + 300
  )
    throw new Error(`${variantName} storage rebuild deferred effects drifted`);
  if (
    world.terminalAdmittedFlowTicks !== milestones.activeStorageObservedAt - FIRST_TICK ||
    result.outcomes
      .filter(({ tick }) => tick < milestones.activeStorageObservedAt)
      .some(({ terminalServiceAvailable }) => !terminalServiceAvailable)
  )
    throw new Error(`${variantName} terminal logistics was interrupted during storage rebuild`);
  if (world.owner.records[0]?.removalReceipt !== undefined)
    throw new Error(`${variantName} storage removal receipt did not clear`);
  if (world.owner.records[0]?.storageEvacuation !== undefined)
    throw new Error(`${variantName} storage evacuation did not clear`);
}

function requiredMilestones(milestones: StorageWorld["milestones"]) {
  const required = <Value>(value: Value | null, label: string): Value => {
    if (value === null) throw new Error(`missing storage rebuild ${label}`);
    return value;
  };
  return {
    activeStorageObservedAt: required(milestones.activeStorageObservedAt, "storage observation"),
    receiptClearedAt: required(milestones.receiptClearedAt, "receipt clearance"),
    siteCommandAt: required(milestones.siteCommandAt, "site command"),
    siteObservedAt: required(milestones.siteObservedAt, "site observation"),
  };
}

function createHeap(): StorageHeap {
  return {
    constructionPlanner: new ConstructionPlanner(),
    siteExecutor: new ConstructionSiteExecutor(),
  };
}

function inventory(capacity: number, resources: readonly (readonly [string, number])[]) {
  const usedCapacity = resources.reduce((total, [, amount]) => total + amount, 0);
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: resources.map(([resourceType, amount]) => ({ amount, resourceType })),
    usedCapacity,
  };
}

function pos(x: number, y: number) {
  return { roomName: ROOM, x, y };
}
