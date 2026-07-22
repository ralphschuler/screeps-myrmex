import { projectColonyRclPolicy, type ColonyView } from "../../../bot/src/colony";
import {
  CONSTRUCTION_SITE_LIMITS,
  LAYOUT_ALGORITHM_REVISION,
  LAYOUT_OWNER_SCHEMA_VERSION,
  STRUCTURE_REMOVAL_LIMITS,
  ConstructionSiteExecutor,
  StructureDestroyExecutor,
  arbitrateConstructionSites,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutRemovalReceipt,
  reconcileConstructionSiteExecution,
  reconcileStructureDestroyExecution,
  type LayoutCommitment,
  type LayoutPlacement,
  type LayoutsOwnerV22,
} from "../../../bot/src/layout";
import { ConstructionPlanner } from "../../../bot/src/maintenance";
import {
  canonicalHash,
  canonicalSerialize,
  defineReplayScenario,
  runScenario,
  type ReplayScenario,
  type ScenarioRunResult,
} from "../../src";
import { collectPhase2ProductionLayoutBuildEvidence } from "./phase2-production-layout-build";

const ROOM = "W1N1";
const FIRST_TICK = 50_000;
const TICKS = 70;
const CPU_PER_TICK = 0.25;
const EXTENSION_BUILD_ENERGY = 3_000;
const MAXIMUM_BUILD_ENERGY_PER_TICK = 100;
const OBSOLETE_ID = "extension-obsolete";
const POLICY_FINGERPRINT = "phase2-layout-rcl3-policy-v1";
const SCENARIO_ID = "phase2-layout-extension-migration-v1";
const SCENARIO_SEED = "phase2-layout-extension-migration-seed-v1";
const RESET_TICK = FIRST_TICK + 15;

const SPAWN = Object.freeze({ id: "spawn-1", name: "Spawn1", pos: pos(5, 25) });
const CONTROLLER = Object.freeze({ id: "controller-1", pos: pos(25, 25) });
const SOURCES = Object.freeze([
  Object.freeze({ id: "source-1", pos: pos(8, 10) }),
  Object.freeze({ id: "source-2", pos: pos(30, 10) }),
]);

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

interface ExtensionState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface SiteState {
  readonly id: string;
  readonly progress: number;
  readonly x: number;
  readonly y: number;
}

interface CommandRecord {
  readonly kind: "create-site" | "destroy-structure";
  readonly structureType: "extension";
  readonly tick: number;
  readonly x: number;
  readonly y: number;
}

interface Milestones {
  readonly destroyCommandAt: number | null;
  readonly destroyDisappearanceObservedAt: number | null;
  readonly firstBuildCompletedAt: number | null;
  readonly firstCompletedReplacementObservedAt: number | null;
  readonly firstSiteCommandAt: number | null;
  readonly firstSiteObservedAt: number | null;
  readonly secondBuildCompletedAt: number | null;
  readonly secondCompletedReplacementObservedAt: number | null;
  readonly secondSiteCommandAt: number | null;
  readonly secondSiteObservedAt: number | null;
}

interface LayoutWorld {
  readonly accessWitnessPreserved: boolean;
  readonly commands: readonly CommandRecord[];
  readonly extensions: readonly ExtensionState[];
  readonly lastRemovalProposals: number;
  readonly lastSiteProposals: number;
  readonly maximumActiveSites: number;
  readonly maximumEnergyPerTick: number;
  readonly milestones: Milestones;
  readonly minimumActiveExtensions: number;
  readonly owner: LayoutsOwnerV22;
  readonly sites: readonly SiteState[];
  readonly totalBuildEnergy: number;
}

interface LayoutInput {
  readonly reverseObservation: boolean;
}

interface LayoutOutcome {
  readonly accessWitnessPreserved: boolean;
  readonly activeExtensions: number;
  readonly activeSites: number;
  readonly buildEnergy: number;
  readonly commands: readonly CommandRecord[];
  readonly removalProposals: number;
  readonly siteProposals: number;
  readonly tick: number;
}

interface LayoutHeap {
  readonly constructionPlanner: ConstructionPlanner;
  readonly destroyExecutor: StructureDestroyExecutor;
  readonly siteExecutor: ConstructionSiteExecutor;
}

const POLICY = projectColonyRclPolicy({
  activeThreat: false,
  controllerLevel: 3,
  controllerRisk: false,
  cpuMode: "normal",
  energyAvailable: 800,
  energyCapacityAvailable: 800,
  protectedSpawnEnergy: 300,
  rcl8Health: null,
  state: "developing",
  visibility: "visible",
});

const COLONY = {
  activeThreat: false,
  controllerRisk: false,
  id: ROOM,
  legalWorkforce: true,
  rclPolicy: POLICY,
  roomName: ROOM,
  state: "developing",
  visibility: "visible",
} as ColonyView;

const PLACEMENTS: readonly LayoutPlacement[] = Object.freeze([
  {
    adoption: "planned",
    layer: "primary",
    minimumRcl: 1,
    pos: SPAWN.pos,
    structureType: "spawn",
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    adoption: "planned" as const,
    layer: "primary" as const,
    minimumRcl: 3,
    pos: pos(10 + index, 20),
    structureType: "extension",
  })),
]);

const COMMITMENT: LayoutCommitment = Object.freeze({
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: pos(10, 20),
  blockers: Object.freeze([]),
  committedAt: FIRST_TICK,
  fingerprint: "phase2-layout-extension-migration-layout-v1",
  transform: 0,
});

export async function collectPhase2LayoutMigrationEvidence() {
  const warm = runScenario(layoutMigrationScenario("warm"));
  const reset = runScenario(layoutMigrationScenario("reset"));
  const reordered = runScenario(layoutMigrationScenario("reordered"));
  const summaries = {
    warm: summarize(warm),
    reset: summarize(reset),
    reordered: summarize(reordered),
  };
  const semanticBytes = Object.values(summaries).map((value) => canonicalSerialize(value));
  const final = reset.finalWorld;
  const milestones = requiredMilestones(final.milestones);
  const productionBuild = await collectPhase2ProductionLayoutBuildEvidence();

  return Object.freeze({
    schemaVersion: 2,
    evidenceIssues: Object.freeze([365, 377]),
    issue: 365,
    status: "complete",
    scenario: {
      id: SCENARIO_ID,
      seed: SCENARIO_SEED,
      ticks: TICKS,
      variants: VARIANTS,
      facts: {
        roomName: ROOM,
        spawn: SPAWN,
        controller: CONTROLLER,
        sources: SOURCES,
      },
      commands: final.commands,
      milestones,
      deferredEffects: {
        firstSiteObservedNextTick:
          milestones.firstSiteObservedAt === milestones.firstSiteCommandAt + 1,
        firstReplacementObservedNextTick:
          milestones.firstCompletedReplacementObservedAt === milestones.firstBuildCompletedAt + 1,
        destroyDisappearanceObservedNextTick:
          milestones.destroyDisappearanceObservedAt === milestones.destroyCommandAt + 1,
        secondSiteObservedNextTick:
          milestones.secondSiteObservedAt === milestones.secondSiteCommandAt + 1,
        secondReplacementObservedNextTick:
          milestones.secondCompletedReplacementObservedAt === milestones.secondBuildCompletedAt + 1,
      },
      final: {
        activeSites: final.sites.length,
        exactExtensions: exactExtensionCount(final.extensions),
        removalProposals: final.lastRemovalProposals,
        siteProposals: final.lastSiteProposals,
      },
    },
    budgets: {
      constructionEnergy: final.totalBuildEnergy,
      maximumActiveSites: final.maximumActiveSites,
      maximumCpuPerTick: maximum(reset.transcript.ticks.map(({ cpu }) => cpu.used)),
      maximumEnergyPerTick: final.maximumEnergyPerTick,
      persistentSchemaVersion: LAYOUT_OWNER_SCHEMA_VERSION,
    },
    safety: {
      minimumActiveExtensions: final.minimumActiveExtensions,
      accessWitnessPreserved: final.accessWitnessPreserved,
      accessWitnessScope: "scenario-level",
      duplicateDestroyCommands: duplicateDestroyCommands(final.commands),
    },
    productionBuild,
    equivalence: {
      semanticBytesIdentical: new Set(semanticBytes).size === 1,
      outcomeHashes: {
        warm: warm.outcomeHash,
        reset: reset.outcomeHash,
        reordered: reordered.outcomeHash,
      },
      semanticHashes: {
        warm: canonicalHash(summaries.warm),
        reset: canonicalHash(summaries.reset),
        reordered: canonicalHash(summaries.reordered),
      },
    },
  });
}

function layoutMigrationScenario(
  variantName: VariantName,
): ReplayScenario<LayoutWorld, LayoutInput, LayoutOutcome, LayoutHeap> {
  const variant = VARIANTS[variantName];
  return defineReplayScenario({
    id: SCENARIO_ID,
    seed: SCENARIO_SEED,
    initialWorld: initialWorld(),
    ticks: Array.from({ length: TICKS }, (_, offset) => {
      const gameTime = FIRST_TICK + offset;
      return {
        gameTime,
        input: { reverseObservation: variant.reverseObservation },
        cpuBudget: CPU_PER_TICK,
        resetHeap: variant.resetTicks.includes(gameTime),
      };
    }),
    createHeap: createHeap,
    resetHeap: createHeap,
    assertCpu: ({ budget, remaining, used }) => {
      if (budget !== CPU_PER_TICK || used !== CPU_PER_TICK || remaining !== 0) {
        throw new Error("layout migration scenario CPU accounting drifted");
      }
    },
    step: ({ gameTime, heap, input, world }) => step(gameTime, heap, input, world),
    verify: (result) => {
      verifyScenario(result, variantName);
    },
  });
}

function step(
  gameTime: number,
  heap: LayoutHeap,
  input: LayoutInput,
  world: LayoutWorld,
): { readonly nextWorld: LayoutWorld; readonly outcome: LayoutOutcome; readonly cpuUsed: number } {
  const milestones = observeMilestones(world, gameTime);
  const room = roomSnapshot(world, gameTime, input.reverseObservation);
  const observationFingerprint = `phase2-layout-observation:${String(gameTime)}`;
  const structures = room.structures ?? [];
  const diff = diffOwnedRoomLayout({
    colonyId: ROOM,
    commitment: COMMITMENT,
    commitmentConflicted: false,
    constructionSites: room.constructionSites,
    observationFingerprint,
    placements: PLACEMENTS,
    policy: POLICY,
    policyEnabled: true,
    policyFingerprint: POLICY_FINGERPRINT,
    roomName: ROOM,
    roomStatus: "owned",
    structures,
  });
  const record = world.owner.records.find(({ roomName }) => roomName === ROOM);
  const siteArbitration = arbitrateConstructionSites({
    globalOwnedSiteCount: world.sites.length,
    limits: CONSTRUCTION_SITE_LIMITS,
    perRoomSiteCounts: [{ count: world.sites.length, roomName: ROOM }],
    priorReceipts: record?.siteReceipts ?? [],
    progressionAuthorizations: [{ authorized: true, colonyId: ROOM, roomName: ROOM }],
    proposals: diff.proposals,
    tick: gameTime,
  });
  const siteExecution = heap.siteExecutor.execute(siteArbitration.intents, {
    isCurrentCommitment: (_roomName, fingerprint) => fingerprint === COMMITMENT.fingerprint,
    resolveRoom: () =>
      ({
        controller: { my: true },
        createConstructionSite: () => 0,
      }) as unknown as Room,
  });
  let owner = reconcileConstructionSiteExecution(world.owner, siteExecution, gameTime).owner;

  const migration = heap.constructionPlanner.planMigration({
    colony: COLONY,
    commitment: COMMITMENT,
    globalOwnedSiteCount: world.sites.length,
    observationFingerprint,
    placements: PLACEMENTS,
    policyFingerprint: POLICY_FINGERPRINT,
    removalReceipt: record?.removalReceipt ?? null,
    room,
  });
  owner = persistLayoutRemovalReceipt(owner, ROOM, migration.removalReceipt);
  const removalArbitration = arbitrateStructureRemovals({
    authorizations: migration.authorization === null ? [] : [migration.authorization],
    limits: STRUCTURE_REMOVAL_LIMITS,
    proposals: migration.proposals,
  });
  const liveRoom = { controller: { my: true }, name: ROOM } as unknown as Room;
  const destroyExecution = heap.destroyExecutor.execute(removalArbitration.intents, {
    hasCurrentHostiles: () => false,
    isCurrentCommitment: (_roomName, fingerprint) => fingerprint === COMMITMENT.fingerprint,
    resolveRoom: () => liveRoom,
    resolveStructure: (id) => {
      const extension = world.extensions.find((candidate) => candidate.id === id);
      return extension === undefined ? null : liveExtension(extension, liveRoom);
    },
  });
  owner = reconcileStructureDestroyExecution(owner, destroyExecution, gameTime).owner;

  const commands: CommandRecord[] = [];
  let nextExtensions = [...world.extensions];
  let nextSites = [...world.sites];
  for (const execution of siteExecution) {
    if (!execution.called || execution.code !== "OK") continue;
    commands.push({
      kind: "create-site",
      structureType: "extension",
      tick: gameTime,
      x: execution.intent.x,
      y: execution.intent.y,
    });
    nextSites.push({
      id: siteId(execution.intent.x, execution.intent.y),
      progress: 0,
      x: execution.intent.x,
      y: execution.intent.y,
    });
  }
  for (const execution of destroyExecution) {
    if (!execution.called || execution.code !== "OK") continue;
    commands.push({
      kind: "destroy-structure",
      structureType: "extension",
      tick: gameTime,
      x: execution.intent.x,
      y: execution.intent.y,
    });
    nextExtensions = nextExtensions.filter(({ id }) => id !== execution.intent.targetId);
  }

  const activeSite = world.sites[0];
  const buildEnergy =
    activeSite === undefined
      ? 0
      : Math.min(MAXIMUM_BUILD_ENERGY_PER_TICK, EXTENSION_BUILD_ENERGY - activeSite.progress);
  if (activeSite !== undefined && buildEnergy > 0) {
    const nextProgress = activeSite.progress + buildEnergy;
    if (nextProgress === EXTENSION_BUILD_ENERGY) {
      nextSites = nextSites.filter(({ id }) => id !== activeSite.id);
      nextExtensions.push({
        id: extensionId(activeSite.x, activeSite.y),
        x: activeSite.x,
        y: activeSite.y,
      });
    } else {
      nextSites = nextSites.map((site) =>
        site.id === activeSite.id ? { ...site, progress: nextProgress } : site,
      );
    }
  }

  const nextCommands = [...world.commands, ...commands];
  const nextMilestones = buildCompletionMilestones(
    commandMilestones(milestones, commands),
    activeSite,
    buildEnergy,
    gameTime,
  );
  const nextWorld: LayoutWorld = {
    accessWitnessPreserved:
      world.accessWitnessPreserved &&
      accessWitness(world.extensions, world.sites) &&
      accessWitness(nextExtensions, nextSites),
    commands: nextCommands,
    extensions: sortExtensions(nextExtensions),
    lastRemovalProposals: migration.proposals.length,
    lastSiteProposals: diff.proposals.length,
    maximumActiveSites: Math.max(world.maximumActiveSites, nextSites.length),
    maximumEnergyPerTick: Math.max(world.maximumEnergyPerTick, buildEnergy),
    milestones: nextMilestones,
    minimumActiveExtensions: Math.min(world.minimumActiveExtensions, nextExtensions.length),
    owner,
    sites: sortSites(nextSites),
    totalBuildEnergy: world.totalBuildEnergy + buildEnergy,
  };
  return {
    nextWorld,
    outcome: {
      accessWitnessPreserved: nextWorld.accessWitnessPreserved,
      activeExtensions: world.extensions.length,
      activeSites: world.sites.length,
      buildEnergy,
      commands,
      removalProposals: migration.proposals.length,
      siteProposals: diff.proposals.length,
      tick: gameTime,
    },
    cpuUsed: CPU_PER_TICK,
  };
}

function initialWorld(): LayoutWorld {
  const extensions = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `extension-exact-${String(index)}`,
      x: 10 + index,
      y: 20,
    })),
    { id: OBSOLETE_ID, x: 30, y: 30 },
  ];
  return {
    accessWitnessPreserved: accessWitness(extensions, []),
    commands: [],
    extensions,
    lastRemovalProposals: 0,
    lastSiteProposals: 0,
    maximumActiveSites: 0,
    maximumEnergyPerTick: 0,
    milestones: {
      destroyCommandAt: null,
      destroyDisappearanceObservedAt: null,
      firstBuildCompletedAt: null,
      firstCompletedReplacementObservedAt: null,
      firstSiteCommandAt: null,
      firstSiteObservedAt: null,
      secondBuildCompletedAt: null,
      secondCompletedReplacementObservedAt: null,
      secondSiteCommandAt: null,
      secondSiteObservedAt: null,
    },
    minimumActiveExtensions: extensions.length,
    owner: persistLayoutCommitment(emptyLayoutsOwner(), ROOM, COMMITMENT, PLACEMENTS),
    sites: [],
    totalBuildEnergy: 0,
  };
}

function roomSnapshot(world: LayoutWorld, tick: number, reverse: boolean) {
  const extensions = reverse ? [...world.extensions].reverse() : world.extensions;
  const sites = reverse ? [...world.sites].reverse() : world.sites;
  const sources = reverse ? [...SOURCES].reverse() : SOURCES;
  const structures = [
    ...world.extensions.map((extension) => ({
      hits: 1_000,
      hitsMax: 1_000,
      id: extension.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: pos(extension.x, extension.y),
      structureType: "extension",
    })),
    {
      hits: 5_000,
      hitsMax: 5_000,
      id: SPAWN.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: SPAWN.pos,
      structureType: "spawn",
    },
  ];
  return {
    constructionSites: sites.map((site) => ({
      id: site.id,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: pos(site.x, site.y),
      progress: site.progress,
      progressTotal: EXTENSION_BUILD_ENERGY,
      structureType: "extension",
    })),
    controller: {
      id: CONTROLLER.id,
      level: 3,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: CONTROLLER.pos,
      progress: 0,
      progressTotal: 135_000,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 1,
      safeModeCooldown: null,
      ticksToDowngrade: 20_000,
      upgradeBlocked: null,
    },
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    hostileCreeps: [],
    name: ROOM,
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: extensions.map(extensionSnapshot),
    ownedSpawns: [
      {
        active: true,
        hits: 5_000,
        hitsMax: 5_000,
        id: SPAWN.id,
        name: SPAWN.name,
        pos: SPAWN.pos,
        spawning: null,
        store: {
          capacity: 300,
          freeCapacity: 0,
          resources: [{ amount: 300, resourceType: "energy" }],
          usedCapacity: 300,
        },
      },
    ],
    ownedTowers: [],
    roads: [],
    sources: sources.map((source) => ({
      energy: 3_000,
      energyCapacity: 3_000,
      id: source.id,
      pos: source.pos,
      ticksToRegeneration: null,
    })),
    storedStructures: [],
    structures: reverse ? structures.reverse() : structures,
  } as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
}

function extensionSnapshot(extension: ExtensionState) {
  return {
    active: true,
    hits: 1_000,
    hitsMax: 1_000,
    id: extension.id,
    pos: pos(extension.x, extension.y),
    store: {
      capacity: 50,
      freeCapacity: 50,
      resources: [],
      usedCapacity: 0,
    },
  };
}

function liveExtension(extension: ExtensionState, room: Room): Structure {
  return {
    destroy: () => 0,
    id: extension.id,
    isActive: () => true,
    my: true,
    pos: pos(extension.x, extension.y),
    room,
    store: { getUsedCapacity: () => 0 },
    structureType: "extension",
  } as unknown as Structure;
}

function observeMilestones(world: LayoutWorld, tick: number): Milestones {
  const hasSite = (x: number) => world.sites.some((site) => site.x === x && site.y === 20);
  const hasExtension = (x: number) =>
    world.extensions.some((extension) => extension.x === x && extension.y === 20);
  return {
    ...world.milestones,
    destroyDisappearanceObservedAt:
      world.milestones.destroyDisappearanceObservedAt ??
      (world.milestones.destroyCommandAt !== null &&
      !world.extensions.some(({ id }) => id === OBSOLETE_ID)
        ? tick
        : null),
    firstCompletedReplacementObservedAt:
      world.milestones.firstCompletedReplacementObservedAt ?? (hasExtension(18) ? tick : null),
    firstSiteObservedAt: world.milestones.firstSiteObservedAt ?? (hasSite(18) ? tick : null),
    secondCompletedReplacementObservedAt:
      world.milestones.secondCompletedReplacementObservedAt ?? (hasExtension(19) ? tick : null),
    secondSiteObservedAt: world.milestones.secondSiteObservedAt ?? (hasSite(19) ? tick : null),
  };
}

function commandMilestones(milestones: Milestones, commands: readonly CommandRecord[]): Milestones {
  const siteCommands = commands.filter(({ kind }) => kind === "create-site");
  const destroyCommand = commands.find(({ kind }) => kind === "destroy-structure");
  return {
    ...milestones,
    destroyCommandAt: milestones.destroyCommandAt ?? destroyCommand?.tick ?? null,
    firstSiteCommandAt: milestones.firstSiteCommandAt ?? siteCommands[0]?.tick ?? null,
    secondSiteCommandAt:
      milestones.secondSiteCommandAt ??
      (milestones.firstSiteCommandAt === null ? null : (siteCommands[0]?.tick ?? null)),
  };
}

function buildCompletionMilestones(
  milestones: Milestones,
  activeSite: SiteState | undefined,
  buildEnergy: number,
  tick: number,
): Milestones {
  if (
    activeSite === undefined ||
    buildEnergy === 0 ||
    activeSite.progress + buildEnergy !== EXTENSION_BUILD_ENERGY
  ) {
    return milestones;
  }
  if (activeSite.x === 18 && activeSite.y === 20) {
    return { ...milestones, firstBuildCompletedAt: milestones.firstBuildCompletedAt ?? tick };
  }
  if (activeSite.x === 19 && activeSite.y === 20) {
    return { ...milestones, secondBuildCompletedAt: milestones.secondBuildCompletedAt ?? tick };
  }
  return milestones;
}

function verifyScenario(
  result: ScenarioRunResult<LayoutWorld, LayoutInput, LayoutOutcome>,
  variantName: VariantName,
): void {
  const world = result.finalWorld;
  const kinds = world.commands.map(({ kind }) => kind).join(",");
  const variant = VARIANTS[variantName];
  const resetTicks = result.transcript.ticks
    .filter(({ heapReset }) => heapReset)
    .map(({ gameTime }) => gameTime);
  if (result.outcomes.length !== TICKS)
    throw new Error("scenario did not execute exactly 70 ticks");
  if (canonicalSerialize(resetTicks) !== canonicalSerialize(variant.resetTicks)) {
    throw new Error(`${variantName} variant reset dimensions drifted`);
  }
  if (
    result.transcript.ticks.some(
      ({ input }) => input.reverseObservation !== variant.reverseObservation,
    )
  ) {
    throw new Error(`${variantName} variant observation order drifted`);
  }
  if (kinds !== "create-site,destroy-structure,create-site") {
    throw new Error(`unexpected layout command order: ${kinds}`);
  }
  if (world.totalBuildEnergy !== 6_000 || world.maximumEnergyPerTick > 100) {
    throw new Error("construction energy bound failed");
  }
  if (world.maximumActiveSites > 1 || world.sites.length !== 0) {
    throw new Error("construction-site bound failed");
  }
  if (world.minimumActiveExtensions < 9 || exactExtensionCount(world.extensions) !== 10) {
    throw new Error("replacement-first extension safety failed");
  }
  if (world.lastSiteProposals !== 0 || world.lastRemovalProposals !== 0) {
    throw new Error("layout did not converge without proposals");
  }
  const milestones = requiredMilestones(world.milestones);
  if (variantName === "reset") {
    if (
      variant.resetTicks.length !== 1 ||
      RESET_TICK <= milestones.firstSiteObservedAt ||
      RESET_TICK > milestones.firstBuildCompletedAt
    ) {
      throw new Error("reset did not occur exactly once during the first build");
    }
  }
  if (milestones.destroyCommandAt < milestones.firstCompletedReplacementObservedAt) {
    throw new Error("obsolete extension was destroyed before completed replacement observation");
  }
  if (
    !world.accessWitnessPreserved ||
    result.outcomes.some(({ accessWitnessPreserved }) => !accessWitnessPreserved)
  ) {
    throw new Error("scenario access witness was blocked");
  }
}

function summarize(result: ScenarioRunResult<LayoutWorld, LayoutInput, LayoutOutcome>) {
  return {
    commands: result.finalWorld.commands,
    extensions: result.finalWorld.extensions,
    finalRemovalProposals: result.finalWorld.lastRemovalProposals,
    finalSiteProposals: result.finalWorld.lastSiteProposals,
    maximumActiveSites: result.finalWorld.maximumActiveSites,
    maximumEnergyPerTick: result.finalWorld.maximumEnergyPerTick,
    milestones: result.finalWorld.milestones,
    minimumActiveExtensions: result.finalWorld.minimumActiveExtensions,
    totalBuildEnergy: result.finalWorld.totalBuildEnergy,
  };
}

function accessWitness(
  extensions: readonly ExtensionState[],
  sites: readonly SiteState[],
): boolean {
  const blocked = new Set([
    positionKey(SPAWN.pos.x, SPAWN.pos.y),
    positionKey(CONTROLLER.pos.x, CONTROLLER.pos.y),
    ...SOURCES.map(({ pos: sourcePos }) => positionKey(sourcePos.x, sourcePos.y)),
    ...extensions.map(({ x, y }) => positionKey(x, y)),
    ...sites.map(({ x, y }) => positionKey(x, y)),
  ]);
  const reachable = new Set([positionKey(SPAWN.pos.x, SPAWN.pos.y)]);
  const frontier = [{ x: SPAWN.pos.x, y: SPAWN.pos.y }];
  const directions = [-1, 0, 1] as const;

  for (let index = 0; index < frontier.length; index += 1) {
    const current = frontier[index];
    if (current === undefined) continue;
    for (const dy of directions) {
      for (const dx of directions) {
        if (dx === 0 && dy === 0) continue;
        const x = current.x + dx;
        const y = current.y + dy;
        const key = positionKey(x, y);
        if (!isInteriorRoomPosition(x, y) || blocked.has(key) || reachable.has(key)) continue;
        reachable.add(key);
        frontier.push({ x, y });
      }
    }
  }

  return (
    hasReachableAdjacentWorkTile(CONTROLLER.pos, blocked, reachable) &&
    SOURCES.every(({ pos: sourcePos }) =>
      hasReachableAdjacentWorkTile(sourcePos, blocked, reachable),
    )
  );
}

function hasReachableAdjacentWorkTile(
  target: { readonly x: number; readonly y: number },
  blocked: ReadonlySet<string>,
  reachable: ReadonlySet<string>,
): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const x = target.x + dx;
      const y = target.y + dy;
      const key = positionKey(x, y);
      if (isInteriorRoomPosition(x, y) && !blocked.has(key) && reachable.has(key)) return true;
    }
  }
  return false;
}

function isInteriorRoomPosition(x: number, y: number): boolean {
  return x >= 1 && x <= 48 && y >= 1 && y <= 48;
}

function positionKey(x: number, y: number): string {
  return `${String(x)}:${String(y)}`;
}

function exactExtensionCount(extensions: readonly ExtensionState[]): number {
  return extensions.filter((extension) =>
    PLACEMENTS.some(
      ({ pos: placementPos }) => placementPos.x === extension.x && placementPos.y === extension.y,
    ),
  ).length;
}

function duplicateDestroyCommands(commands: readonly CommandRecord[]): number {
  const destroy = commands.filter(({ kind }) => kind === "destroy-structure");
  return destroy.length - new Set(destroy.map(({ x, y }) => `${String(x)}:${String(y)}`)).size;
}

function createHeap(): LayoutHeap {
  return {
    constructionPlanner: new ConstructionPlanner(),
    destroyExecutor: new StructureDestroyExecutor(),
    siteExecutor: new ConstructionSiteExecutor(),
  };
}

function requiredMilestones(milestones: Milestones) {
  return {
    destroyCommandAt: requiredMilestone(milestones.destroyCommandAt, "destroy command"),
    destroyDisappearanceObservedAt: requiredMilestone(
      milestones.destroyDisappearanceObservedAt,
      "destroy disappearance observation",
    ),
    firstBuildCompletedAt: requiredMilestone(
      milestones.firstBuildCompletedAt,
      "first build completion",
    ),
    firstCompletedReplacementObservedAt: requiredMilestone(
      milestones.firstCompletedReplacementObservedAt,
      "first completed replacement observation",
    ),
    firstSiteCommandAt: requiredMilestone(milestones.firstSiteCommandAt, "first site command"),
    firstSiteObservedAt: requiredMilestone(
      milestones.firstSiteObservedAt,
      "first site observation",
    ),
    secondBuildCompletedAt: requiredMilestone(
      milestones.secondBuildCompletedAt,
      "second build completion",
    ),
    secondCompletedReplacementObservedAt: requiredMilestone(
      milestones.secondCompletedReplacementObservedAt,
      "second completed replacement observation",
    ),
    secondSiteCommandAt: requiredMilestone(milestones.secondSiteCommandAt, "second site command"),
    secondSiteObservedAt: requiredMilestone(
      milestones.secondSiteObservedAt,
      "second site observation",
    ),
  };
}

function requiredMilestone(value: number | null, label: string): number {
  if (value === null) throw new Error(`missing ${label}`);
  return value;
}

function siteId(x: number, y: number): string {
  return `site-extension-${String(x)}-${String(y)}`;
}

function extensionId(x: number, y: number): string {
  return `extension-${String(x)}-${String(y)}`;
}

function sortExtensions(extensions: readonly ExtensionState[]): readonly ExtensionState[] {
  return [...extensions].sort(
    (left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id),
  );
}

function sortSites(sites: readonly SiteState[]): readonly SiteState[] {
  return [...sites].sort(
    (left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id),
  );
}

function maximum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.max(result, value), 0);
}

function pos(x: number, y: number) {
  return { roomName: ROOM, x, y };
}
