import { vi } from "vitest";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import { COLONY_RCL_POLICY_TABLE } from "../../../bot/src/colony";
import {
  layoutExtensionEvacuationBudgetIssuer,
  layoutExtensionEvacuationFlowId,
  parseLayoutsOwner,
  reconstructCommittedLayout,
  type LayoutPlacement,
  type LayoutRecord,
  type LayoutsOwnerV25,
} from "../../../bot/src/layout";
import type { RuntimeGame } from "../../../bot/src/runtime/context";
import type { TickOutcome } from "../../../bot/src/runtime/tick";
import { canonicalHash, canonicalSerialize } from "../../src";

const ROOM = "W1N1";
const FIRST_TICK = 80_000;
const MAXIMUM_TICKS = 100;
const SOURCE_ID = "extension-obsolete";
const REPLACEMENT_ID = "extension-replacement";
const HAULER_ID = "migration-hauler";
const EVACUATION_ENERGY = 50;
const MODELED_BUILD_ENERGY_PER_TICK = 100;
const EXTENSION_BUILD_ENERGY = 3_000;

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

type Variant = "reordered" | "reset" | "warm";
type CommandKind = "build-modeled" | "create-site" | "destroy" | "transfer" | "withdraw";

interface CommandRecord {
  readonly amount: number;
  readonly kind: CommandKind;
  readonly targetId: string;
  readonly tick: number;
}

interface Milestones {
  readonly destroyAt: number;
  readonly evacuationSettledAt: number;
  readonly flowFundedAt: number;
  readonly flowRetiredAt: number;
  readonly handoffAt: number;
  readonly replacementObservedAt: number;
  readonly siteAt: number;
  readonly siteObservedAt: number;
  readonly stableAt: number;
  readonly transferAt: number;
  readonly withdrawAt: number;
}

interface VariantSummary {
  readonly commands: readonly CommandRecord[];
  readonly exactExtensions: number;
  readonly finalOwnerHash: string;
  readonly finalRemovalProposals: number;
  readonly finalSiteCount: number;
  readonly finalSiteProposals: number;
  readonly maximumActiveSites: number;
  readonly maximumPersistentBytes: number;
  readonly milestones: Milestones;
  readonly modeledConstructionEnergy: number;
  readonly replacementEnergy: number;
  readonly resetAfterAcquire: boolean;
  readonly sourceEnergy: number;
  readonly staleRecords: number;
  readonly totalExtensions: number;
}

interface ExtensionState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  energy: number;
}

interface SiteState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  progress: number;
}

export async function collectPhase2ActiveStaleExtensionConvergenceEvidence() {
  const warm = await runVariant("warm");
  const reset = await runVariant("reset");
  const reordered = await runVariant("reordered");
  const semantic = {
    warm: semanticSummary(warm),
    reset: semanticSummary(reset),
    reordered: semanticSummary(reordered),
  };
  const semanticBytes = Object.values(semantic).map((value) => canonicalSerialize(value));
  if (new Set(semanticBytes).size !== 1) {
    throw new Error(`active stale extension convergence drifted: ${canonicalSerialize(semantic)}`);
  }

  return Object.freeze({
    scenario: Object.freeze({
      id: "phase2-active-stale-extension-convergence-v1",
      variants: Object.freeze({
        warm: Object.freeze({ resetAfterAcquire: false, reverseObservation: false }),
        reset: Object.freeze({ resetAfterAcquire: true, reverseObservation: false }),
        reordered: Object.freeze({ resetAfterAcquire: false, reverseObservation: true }),
      }),
    }),
    authority: Object.freeze({
      budgetAndFlowFunded: warm.milestones.flowFundedAt < warm.milestones.withdrawAt,
      exactDeliveryObserved:
        warm.sourceEnergy === 0 && warm.replacementEnergy === EVACUATION_ENERGY,
      flowRetiredBeforeSettlement:
        warm.milestones.flowRetiredAt <= warm.milestones.evacuationSettledAt,
      settlementCommandFree: commandsAt(warm, warm.milestones.evacuationSettledAt).length === 0,
      handoffCommandFree: commandsAt(warm, warm.milestones.handoffAt).length === 0,
      handoffAfterSettlement: warm.milestones.handoffAt > warm.milestones.evacuationSettledAt,
    }),
    budgets: Object.freeze({
      evacuationEnergy: EVACUATION_ENERGY,
      maximumActiveSites: Math.max(
        warm.maximumActiveSites,
        reset.maximumActiveSites,
        reordered.maximumActiveSites,
      ),
      maximumPersistentBytes: Math.max(
        warm.maximumPersistentBytes,
        reset.maximumPersistentBytes,
        reordered.maximumPersistentBytes,
      ),
      modeledConstructionEnergy: warm.modeledConstructionEnergy,
      modeledConstructionEnergyPerTick: MODELED_BUILD_ENERGY_PER_TICK,
    }),
    equivalence: Object.freeze({
      semanticBytesIdentical: new Set(semanticBytes).size === 1,
      semanticHashes: Object.freeze({
        warm: canonicalHash(semantic.warm),
        reset: canonicalHash(semantic.reset),
        reordered: canonicalHash(semantic.reordered),
      }),
    }),
    final: Object.freeze({
      exactExtensions: warm.exactExtensions,
      removalProposals: warm.finalRemovalProposals,
      siteCount: warm.finalSiteCount,
      siteProposals: warm.finalSiteProposals,
      staleRecords: warm.staleRecords,
      totalExtensions: warm.totalExtensions,
    }),
    milestones: warm.milestones,
    safety: Object.freeze({
      duplicateDestroyCommands: duplicateCommands(warm.commands, "destroy"),
      duplicateSiteCommands: duplicateCommands(warm.commands, "create-site"),
      exactEnergyConserved: warm.sourceEnergy + warm.replacementEnergy === EVACUATION_ENERGY,
      resetAfterAcquire: reset.resetAfterAcquire,
    }),
  });
}

async function runVariant(variant: Variant): Promise<VariantSummary> {
  vi.resetModules();
  const reverseObservation = variant === "reordered";
  const world = mutableWorld(reverseObservation);
  let memory = {} as Memory;
  let executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
  let maximumPersistentBytes = 0;
  let resetAfterAcquire = false;
  let flowFundedAt: number | null = null;
  let flowRetiredAt: number | null = null;
  let evacuationSettledAt: number | null = null;
  let handoffAt: number | null = null;

  executeTick({ game: world.game(FIRST_TICK), memory });
  executeTick({ game: world.game(FIRST_TICK + 1), memory });
  const { budgetIssuer, flowId } = seedActiveStaleEvacuation(memory, world);
  let priorOwner = owner(memory);
  world.activate();

  for (let tick = FIRST_TICK + 2; tick < FIRST_TICK + MAXIMUM_TICKS; tick += 1) {
    const outcome = executeTick({ game: world.game(tick), memory });
    maximumPersistentBytes = Math.max(
      maximumPersistentBytes,
      utf8ByteLength(canonicalSerialize(memory)),
    );
    const currentOwner = owner(memory);
    const flowActive = activeFlow(memory, flowId);
    if (
      flowFundedAt === null &&
      outcome.colony.reservations.some(
        ({ category, issuer, status }) =>
          category === "optional-growth" && issuer === budgetIssuer && status === "active",
      ) &&
      flowActive
    ) {
      flowFundedAt = tick;
    }
    if (flowFundedAt !== null && flowRetiredAt === null && !flowActive) flowRetiredAt = tick;

    const priorStale = priorOwner.staleRecords[0];
    const currentStale = currentOwner.staleRecords[0];
    if (
      evacuationSettledAt === null &&
      priorStale?.extensionEvacuation !== undefined &&
      currentStale !== undefined &&
      currentStale.extensionEvacuation === undefined
    ) {
      evacuationSettledAt = tick;
    }
    if (
      handoffAt === null &&
      priorOwner.staleRecords.length === 1 &&
      currentOwner.staleRecords.length === 0 &&
      currentOwner.records.length === 1
    ) {
      handoffAt = tick;
    }
    priorOwner = currentOwner;

    if (variant === "reset" && !resetAfterAcquire && world.firstWithdrawAt() !== null) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
      resetAfterAcquire = true;
    }

    if (
      flowFundedAt !== null &&
      flowRetiredAt !== null &&
      evacuationSettledAt !== null &&
      handoffAt !== null &&
      world.isStable() &&
      currentOwner.staleRecords.length === 0 &&
      outcome.layout.migration.proposals.length === 0 &&
      (outcome.layout.arbitration?.accepted.length ?? 0) === 0
    ) {
      return validatedSummary(
        variant,
        world,
        currentOwner,
        outcome,
        maximumPersistentBytes,
        resetAfterAcquire,
        { evacuationSettledAt, flowFundedAt, flowRetiredAt, handoffAt },
      );
    }
  }
  const finalOwner = owner(memory);
  throw new Error(
    `${variant} active stale extension convergence timed out: ${canonicalSerialize({
      commands: world.commands(),
      evacuationSettledAt,
      exactExtensions: world.exactExtensionCount(),
      flowFundedAt,
      flowRetiredAt,
      handoffAt,
      records: finalOwner.records.length,
      sites: world.siteCount(),
      staleRecords: finalOwner.staleRecords.length,
    })}`,
  );
}

function validatedSummary(
  variant: Variant,
  world: ReturnType<typeof mutableWorld>,
  currentOwner: LayoutsOwnerV25,
  outcome: TickOutcome,
  maximumPersistentBytes: number,
  resetAfterAcquire: boolean,
  ownerMilestones: Pick<
    Milestones,
    "evacuationSettledAt" | "flowFundedAt" | "flowRetiredAt" | "handoffAt"
  >,
): VariantSummary {
  const withdrawAt = required(world.firstWithdrawAt(), "withdraw");
  const transferAt = required(world.firstTransferAt(), "transfer");
  const destroyAt = required(world.firstDestroyAt(), "destroy");
  const siteAt = required(world.firstSiteAt(), "site command");
  const siteObservedAt = required(world.siteObservedAt(), "site observation");
  const replacementObservedAt = required(world.replacementObservedAt(), "replacement observation");
  const stableAt = required(world.stableAt(), "stable geometry");
  const milestones: Milestones = Object.freeze({
    destroyAt,
    evacuationSettledAt: ownerMilestones.evacuationSettledAt,
    flowFundedAt: ownerMilestones.flowFundedAt,
    flowRetiredAt: ownerMilestones.flowRetiredAt,
    handoffAt: ownerMilestones.handoffAt,
    replacementObservedAt,
    siteAt,
    siteObservedAt,
    stableAt,
    transferAt,
    withdrawAt,
  });
  const commands = world.commands();
  const sourceEnergy = world.extensionEnergy(SOURCE_ID);
  const replacementEnergy = world.extensionEnergy(REPLACEMENT_ID);
  const exactExtensions = world.exactExtensionCount();
  const summary: VariantSummary = Object.freeze({
    commands,
    exactExtensions,
    finalOwnerHash: canonicalHash(currentOwner),
    finalRemovalProposals: outcome.layout.migration.proposals.length,
    finalSiteCount: world.siteCount(),
    finalSiteProposals: outcome.layout.arbitration?.accepted.length ?? 0,
    maximumActiveSites: world.maximumActiveSites(),
    maximumPersistentBytes,
    milestones,
    modeledConstructionEnergy: world.modeledConstructionEnergy(),
    replacementEnergy,
    resetAfterAcquire,
    sourceEnergy,
    staleRecords: currentOwner.staleRecords.length,
    totalExtensions: world.extensionCount(),
  });

  if (sourceEnergy !== 0 || replacementEnergy !== EVACUATION_ENERGY) {
    throw new Error(`${variant} did not conserve exact evacuation stock`);
  }
  if (
    milestones.withdrawAt >= milestones.transferAt ||
    milestones.flowRetiredAt > milestones.evacuationSettledAt ||
    milestones.evacuationSettledAt >= milestones.handoffAt ||
    milestones.handoffAt >= milestones.destroyAt ||
    milestones.destroyAt >= milestones.siteAt ||
    milestones.siteAt >= milestones.siteObservedAt ||
    milestones.siteObservedAt >= milestones.replacementObservedAt ||
    milestones.replacementObservedAt > milestones.stableAt
  ) {
    throw new Error(`${variant} milestone order drifted: ${canonicalSerialize(milestones)}`);
  }
  if (
    commandsAt(summary, milestones.evacuationSettledAt).length !== 0 ||
    commandsAt(summary, milestones.handoffAt).length !== 0
  ) {
    throw new Error(`${variant} settlement or handoff reached a command boundary`);
  }
  if (
    exactExtensions !== 10 ||
    world.extensionCount() !== 10 ||
    world.siteCount() !== 0 ||
    currentOwner.staleRecords.length !== 0 ||
    outcome.layout.migration.proposals.length !== 0 ||
    (outcome.layout.arbitration?.accepted.length ?? 0) !== 0
  ) {
    throw new Error(`${variant} did not reach stable current extension geometry`);
  }
  if (
    world.maximumActiveSites() > 1 ||
    world.modeledConstructionEnergy() !== EXTENSION_BUILD_ENERGY ||
    duplicateCommands(commands, "destroy") !== 0 ||
    duplicateCommands(commands, "create-site") !== 0 ||
    (variant === "reset") !== resetAfterAcquire
  ) {
    throw new Error(`${variant} exceeded reset, site, energy, or duplicate-command bounds`);
  }
  return summary;
}

function mutableWorld(reverseObservation: boolean) {
  let tick = FIRST_TICK - 1;
  let active = false;
  let exactExtensionPositions: readonly { readonly x: number; readonly y: number }[] = [];
  let extensions: ExtensionState[] = [];
  let plannedStructures: AnyStructure[] = [];
  let site: SiteState | null = null;
  let pendingSite: Omit<SiteState, "progress"> | null = null;
  let pendingDestroy = false;
  let haulerEnergy = 0;
  let modeledEnergy = 0;
  let maximumSites = 0;
  let observedSiteAt: number | null = null;
  let observedReplacementAt: number | null = null;
  let stableTick: number | null = null;
  const commandRecords: CommandRecord[] = [];
  const sourcePos = { x: 10, y: 10 };
  let minerPos = { x: 11, y: 10 };

  const pos = (x: number, y: number) => ({ roomName: ROOM, x, y });
  const extensionStore = (extension: ExtensionState) => ({
    get energy() {
      return extension.energy;
    },
    getCapacity: () => 50,
    getFreeCapacity: () => 50 - extension.energy,
    getUsedCapacity: (resourceType?: string) =>
      resourceType === undefined || resourceType === "energy" ? extension.energy : 0,
  });
  const extensionObject = (extension: ExtensionState): StructureExtension =>
    ({
      destroy: () => {
        if (!active || extension.id !== SOURCE_ID || pendingDestroy) return -7;
        pendingDestroy = true;
        commandRecords.push({ amount: 0, kind: "destroy", targetId: extension.id, tick });
        return 0;
      },
      hits: 1_000,
      hitsMax: 1_000,
      id: extension.id,
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: pos(extension.x, extension.y),
      room: { name: ROOM },
      store: extensionStore(extension),
      structureType: "extension",
    }) as unknown as StructureExtension;
  const plannedStructureObject = (placement: LayoutPlacement, index: number): AnyStructure => {
    const structureType = placement.structureType;
    const base = {
      hits: 5_000,
      hitsMax: 5_000,
      id: `planned-${structureType}-${String(index)}`,
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: pos(placement.pos.x, placement.pos.y),
      room: { name: ROOM },
      structureType,
    };
    if (structureType === "tower") {
      return {
        ...base,
        store: {
          energy: 1_000,
          getCapacity: () => 1_000,
          getFreeCapacity: () => 0,
          getUsedCapacity: () => 1_000,
        },
      } as unknown as StructureTower;
    }
    if (structureType === "rampart") {
      return { ...base, isPublic: false, ticksToDecay: 100_000 } as unknown as StructureRampart;
    }
    if (structureType === "road") {
      return { ...base, ticksToDecay: 20_000 } as unknown as StructureRoad;
    }
    if (structureType === "container") {
      return { ...base, ticksToDecay: 100_000 } as unknown as StructureContainer;
    }
    return base as unknown as AnyStructure;
  };
  const spawnEnergy = 300;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-main",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24, 25),
    room: { name: ROOM },
    spawnCreep: () => -4,
    spawning: null,
    store: {
      energy: spawnEnergy,
      getCapacity: () => 300,
      getFreeCapacity: () => 0,
      getUsedCapacity: (resourceType?: string) =>
        resourceType === undefined || resourceType === "energy" ? spawnEnergy : 0,
    },
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const source = {
    energy: 3_000,
    energyCapacity: 3_000,
    id: "source-main",
    pos: pos(sourcePos.x, sourcePos.y),
    ticksToRegeneration: 300,
  } as unknown as Source;
  let haulerPos = { x: 40, y: 39 };
  const hauler = {
    body: ["carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id: HAULER_ID,
    my: true,
    name: HAULER_ID,
    owner: { username: "Myrmex" },
    get pos() {
      return pos(haulerPos.x, haulerPos.y);
    },
    room: { name: ROOM },
    spawning: false,
    store: {
      get energy() {
        return haulerEnergy;
      },
      getCapacity: () => 50,
      getFreeCapacity: () => 50 - haulerEnergy,
      getUsedCapacity: (resourceType?: string) =>
        resourceType === undefined || resourceType === "energy" ? haulerEnergy : 0,
    },
    ticksToLive: 1_000,
    move: () => -7,
    transfer: (target: AnyStoreStructure, resourceType: ResourceConstant, amount?: number) => {
      const replacement = extensions.find(({ id }) => id === target.id);
      if (replacement === undefined || resourceType !== "energy" || target.id !== REPLACEMENT_ID) {
        return -7;
      }
      const transferred = Math.min(amount ?? haulerEnergy, haulerEnergy, 50 - replacement.energy);
      if (transferred <= 0) return -8;
      haulerEnergy -= transferred;
      replacement.energy += transferred;
      commandRecords.push({
        amount: transferred,
        kind: "transfer",
        targetId: String(target.id),
        tick,
      });
      return 0;
    },
    withdraw: (target: AnyStoreStructure, resourceType: ResourceConstant, amount?: number) => {
      const obsolete = extensions.find(({ id }) => id === target.id);
      if (obsolete === undefined || resourceType !== "energy" || target.id !== SOURCE_ID) return -7;
      const withdrawn = Math.min(amount ?? obsolete.energy, obsolete.energy, 50 - haulerEnergy);
      if (withdrawn <= 0) return -6;
      obsolete.energy -= withdrawn;
      haulerEnergy += withdrawn;
      commandRecords.push({
        amount: withdrawn,
        kind: "withdraw",
        targetId: String(target.id),
        tick,
      });
      return 0;
    },
  } as unknown as Creep;
  const miner = {
    body: ["work", "work", "work", "work", "work", "carry", "move"].map((type) => ({
      hits: 100,
      type,
    })),
    fatigue: 0,
    hits: 700,
    hitsMax: 700,
    id: "static-miner",
    my: true,
    name: "static-miner",
    owner: { username: "Myrmex" },
    get pos() {
      return pos(minerPos.x, minerPos.y);
    },
    room: { name: ROOM },
    spawning: false,
    store: {
      getCapacity: () => 50,
      getFreeCapacity: () => 50,
      getUsedCapacity: () => 0,
    },
    ticksToLive: 1_000,
    harvest: () => 0,
    move: () => -7,
    transfer: () => -7,
    withdraw: () => -7,
  } as unknown as Creep;
  const support = {
    body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "support-worker",
    my: true,
    name: "support-worker",
    owner: { username: "Myrmex" },
    pos: pos(25, 24),
    room: { name: ROOM },
    spawning: false,
    store: {
      getCapacity: () => 50,
      getFreeCapacity: () => 50,
      getUsedCapacity: () => 0,
    },
    ticksToLive: 1_000,
    harvest: () => -7,
    move: () => -7,
    transfer: () => -7,
    withdraw: () => -7,
  } as unknown as Creep;
  const controller = {
    id: "controller-main",
    level: 3,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(25, 20),
    progress: 0,
    progressTotal: 135_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: 20_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;

  const applyDeferredEffects = () => {
    if (!active) return;
    if (pendingDestroy) {
      extensions = extensions.filter(({ id }) => id !== SOURCE_ID);
      pendingDestroy = false;
    }
    if (pendingSite !== null && site === null) {
      site = { ...pendingSite, progress: 0 };
      pendingSite = null;
      observedSiteAt ??= tick;
    }
    if (site !== null) {
      const amount = Math.min(
        MODELED_BUILD_ENERGY_PER_TICK,
        EXTENSION_BUILD_ENERGY - site.progress,
      );
      site.progress += amount;
      modeledEnergy += amount;
      commandRecords.push({ amount, kind: "build-modeled", targetId: site.id, tick });
      if (site.progress === EXTENSION_BUILD_ENERGY) {
        extensions.push({
          id: `extension-built-${String(site.x)}-${String(site.y)}`,
          x: site.x,
          y: site.y,
          energy: 0,
        });
        site = null;
        observedReplacementAt ??= tick;
      }
    }
    maximumSites = Math.max(maximumSites, site === null ? 0 : 1);
    if (isStable()) stableTick ??= tick;
  };

  const structures = () => [spawn, ...plannedStructures, ...extensions.map(extensionObject)];
  const room = {
    controller,
    createConstructionSite: (x: number, y: number, structureType: BuildableStructureConstant) => {
      if (!active || structureType !== "extension" || pendingSite !== null || site !== null)
        return -8;
      pendingSite = { id: `site-extension-${String(x)}-${String(y)}`, x, y };
      commandRecords.push({ amount: 0, kind: "create-site", targetId: pendingSite.id, tick });
      return 0;
    },
    get energyAvailable() {
      return spawnEnergy + extensions.reduce((total, extension) => total + extension.energy, 0);
    },
    get energyCapacityAvailable() {
      return 300 + extensions.length * 50;
    },
    find: (findType: number): unknown[] => {
      const creeps = [hauler, miner, support];
      if (findType === FIND_CREEPS_VALUE)
        return reverseObservation ? [...creeps].reverse() : creeps;
      if (findType === FIND_DROPPED_RESOURCES_VALUE) return [];
      if (findType === FIND_STRUCTURES_VALUE) {
        const values = structures();
        return reverseObservation ? [...values].reverse() : values;
      }
      if (findType === FIND_CONSTRUCTION_SITES_VALUE) return site === null ? [] : [siteObject()];
      if (findType === FIND_SOURCES_VALUE) return [source];
      return [];
    },
    getTerrain: () => ({ get: () => 0 }),
    name: ROOM,
  } as unknown as Room;
  const siteObject = (): ConstructionSite => {
    if (site === null) throw new Error("site unavailable");
    return {
      id: site.id,
      my: true,
      owner: { username: "Myrmex" },
      pos: pos(site.x, site.y),
      progress: site.progress,
      progressTotal: EXTENSION_BUILD_ENERGY,
      structureType: "extension",
    } as unknown as ConstructionSite;
  };

  function isStable(): boolean {
    return (
      active &&
      site === null &&
      pendingSite === null &&
      extensions.length === 10 &&
      exactExtensionCount() === 10
    );
  }
  function exactExtensionCount(): number {
    const exact = new Set(exactExtensionPositions.map(({ x, y }) => `${String(x)}:${String(y)}`));
    return extensions.filter(({ x, y }) => exact.has(`${String(x)}:${String(y)}`)).length;
  }

  return {
    activate: () => {
      active = true;
    },
    commands: () => Object.freeze([...commandRecords]),
    exactExtensionCount,
    extensionCount: () => extensions.length,
    extensionEnergy: (id: string) =>
      extensions.find((extension) => extension.id === id)?.energy ?? 0,
    firstDestroyAt: () => commandRecords.find(({ kind }) => kind === "destroy")?.tick ?? null,
    firstSiteAt: () => commandRecords.find(({ kind }) => kind === "create-site")?.tick ?? null,
    firstTransferAt: () => commandRecords.find(({ kind }) => kind === "transfer")?.tick ?? null,
    firstWithdrawAt: () => commandRecords.find(({ kind }) => kind === "withdraw")?.tick ?? null,
    game: (nextTick: number): RuntimeGame => {
      if (nextTick <= tick) throw new Error("active stale extension ticks must increase");
      tick = nextTick;
      applyDeferredEffects();
      const creepEntries = [hauler, miner, support];
      let cpuUsed = 0;
      return {
        cpu: {
          bucket: 9_000,
          limit: 20,
          tickLimit: 500,
          getUsed: () => {
            const value = cpuUsed;
            cpuUsed += 0.001;
            return value;
          },
        },
        creeps: Object.fromEntries(creepEntries.map((creep) => [creep.name, creep])),
        getObjectById: (id: string) =>
          id === hauler.id
            ? hauler
            : id === miner.id
              ? miner
              : id === support.id
                ? support
                : id === source.id
                  ? source
                  : id === spawn.id
                    ? spawn
                    : id === site?.id
                      ? siteObject()
                      : (structures().find((structure) => structure.id === id) ?? null),
        rooms: { [ROOM]: room },
        shard: { name: "shard3" },
        time: nextTick,
      };
    },
    isStable,
    maximumActiveSites: () => maximumSites,
    modeledConstructionEnergy: () => modeledEnergy,
    replacementObservedAt: () => observedReplacementAt,
    seedGeometry: (
      commitment: LayoutRecord,
      positions: readonly { readonly x: number; readonly y: number }[],
      placements: readonly LayoutPlacement[],
    ) => {
      exactExtensionPositions = positions;
      if (positions.length !== 10) throw new Error("expected ten RCL3 extension positions");
      const replacement = positions[0];
      if (replacement === undefined) throw new Error("expected exact extension replacement");
      const occupied = new Set(
        placements.map(
          ({ pos: placementPos }) => `${String(placementPos.x)}:${String(placementPos.y)}`,
        ),
      );
      const external = adjacentCandidates(replacement).find(
        ({ x, y }) =>
          !occupied.has(`${String(x)}:${String(y)}`) && !(x === sourcePos.x && y === sourcePos.y),
      );
      if (external === undefined) throw new Error("expected adjacent external extension position");
      const hauler = adjacentCandidates(external).find(
        ({ x, y }) =>
          Math.max(Math.abs(x - replacement.x), Math.abs(y - replacement.y)) <= 1 &&
          !occupied.has(`${String(x)}:${String(y)}`) &&
          !(x === external.x && y === external.y),
      );
      if (hauler === undefined) throw new Error("expected shared adjacent hauler position");
      haulerPos = hauler;
      extensions = positions.slice(0, 9).map(({ x, y }, index) => ({
        energy: index === 0 ? 0 : 50,
        id: index === 0 ? REPLACEMENT_ID : `extension-exact-${String(index)}`,
        x,
        y,
      }));
      extensions.push({ energy: EVACUATION_ENERGY, id: SOURCE_ID, x: external.x, y: external.y });
      plannedStructures = placements
        .filter(
          ({ minimumRcl, structureType }) =>
            minimumRcl <= 3 && structureType !== "extension" && structureType !== "spawn",
        )
        .map(plannedStructureObject);
      const service = commitment.sourceServices?.[0]?.pos;
      if (service !== undefined) minerPos = { x: service.x, y: service.y };
      commandRecords.length = 0;
    },
    siteCount: () => (site === null ? 0 : 1),
    siteObservedAt: () => observedSiteAt,
    stableAt: () => stableTick,
  };
}

function seedActiveStaleEvacuation(
  memory: Memory,
  world: ReturnType<typeof mutableWorld>,
): { readonly budgetIssuer: string; readonly flowId: string } {
  const currentOwner = owner(memory);
  const current = currentOwner.records.find(({ roomName }) => roomName === ROOM);
  const unlocks = COLONY_RCL_POLICY_TABLE.find(({ level }) => level === 3)?.unlocks;
  if (current === undefined || unlocks === undefined)
    throw new Error("current RCL3 layout unavailable");
  const placements = reconstructCommittedLayout({
    commitment: current,
    roomName: ROOM,
    sourceCount: 1,
    unlocks,
  });
  if (placements === null) throw new Error("current RCL3 layout could not be reconstructed");
  const extensionPositions = placements
    .filter(
      ({ layer, minimumRcl, structureType }) =>
        layer === "primary" && minimumRcl <= 3 && structureType === "extension",
    )
    .map(({ pos }) => ({ x: pos.x, y: pos.y }));
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
  const evacuation = {
    amount: EVACUATION_ENERGY,
    expiresAt: FIRST_TICK + 151,
    replacementId: REPLACEMENT_ID,
    replacementInitialEnergy: 0,
    sourceId: SOURCE_ID,
    startedAt: FIRST_TICK + 1,
  } as const;
  const staleRecord = {
    ...stable,
    algorithmRevision: "owned-room-layout-v1",
    extensionEvacuation: evacuation,
  };
  const root = memory.myrmex;
  if (root === undefined) throw new Error("runtime root unavailable");
  (root as unknown as { layouts: unknown }).layouts = {
    records: [staleRecord],
    revision: currentOwner.revision + 1,
    schemaVersion: 24,
  };
  world.seedGeometry(current, extensionPositions, placements);
  const flowId = layoutExtensionEvacuationFlowId(ROOM, evacuation);
  const budgetIssuer = layoutExtensionEvacuationBudgetIssuer(ROOM, evacuation);
  if (budgetIssuer === null) throw new Error("stale extension budget identity overflowed");
  return { budgetIssuer, flowId };
}

function owner(memory: Memory): LayoutsOwnerV25 {
  const parsed = parseLayoutsOwner(memory.myrmex?.layouts);
  if (parsed === null)
    throw new Error(`layouts owner unavailable: ${canonicalSerialize(memory.myrmex?.layouts)}`);
  return parsed;
}

function flowContracts(memory: Memory, flowId: string) {
  const contracts = memory.myrmex?.contracts as
    | {
        readonly active?: readonly {
          readonly execution?: { readonly flowId?: string };
          readonly lease?: unknown;
          readonly state?: string;
        }[];
        readonly outcomes?: readonly {
          readonly requestSignature?: string;
          readonly state?: string;
        }[];
      }
    | undefined;
  return {
    active: contracts?.active?.filter(({ execution }) => execution?.flowId === flowId) ?? [],
    outcomes:
      contracts?.outcomes?.filter(({ requestSignature }) => requestSignature?.includes(flowId)) ??
      [],
  };
}

function activeFlow(memory: Memory, flowId: string): boolean {
  return flowContracts(memory, flowId).active.length > 0;
}

function semanticSummary(summary: VariantSummary) {
  return {
    ...summary,
    maximumPersistentBytes: 0,
    resetAfterAcquire: false,
  };
}

function commandsAt(summary: Pick<VariantSummary, "commands">, tick: number) {
  return summary.commands.filter(
    (command) => command.tick === tick && command.kind !== "build-modeled",
  );
}

function duplicateCommands(commands: readonly CommandRecord[], kind: CommandKind): number {
  const matches = commands.filter((command) => command.kind === kind);
  return matches.length - new Set(matches.map(({ targetId }) => targetId)).size;
}

function adjacentCandidates(position: { readonly x: number; readonly y: number }) {
  const result: { readonly x: number; readonly y: number }[] = [];
  for (let y = position.y - 1; y <= position.y + 1; y += 1) {
    for (let x = position.x - 1; x <= position.x + 1; x += 1) {
      if ((x !== position.x || y !== position.y) && x > 0 && x < 49 && y > 0 && y < 49) {
        result.push({ x, y });
      }
    }
  }
  return result;
}

function required(value: number | null, label: string): number {
  if (value === null) throw new Error(`missing ${label} milestone`);
  return value;
}
