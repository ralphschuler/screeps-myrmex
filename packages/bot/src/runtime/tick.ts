import {
  createIntentChannel,
  type ArbitrationBatch,
  type CommandExecutionResult,
  type IntentChannel,
} from "../execution";
import { executeDefenseIntents, planDefense, planRoutineTowerMaintenance } from "../defense";
import {
  authorizedSurvivalFlow,
  emptyStaticMiningPlan,
  planStaticMining,
  planSurvivalFlow,
  renewSurvivalFlowBudgets,
  type StaticMiningPlan,
  type SurvivalFlowCandidate,
} from "../economy";
import {
  ConstructionPlanner,
  assignMaintenanceExecution,
  authorizeMaintenanceWork,
  authorizedCriticalMaintenance,
  projectMaintenanceBudgets,
  maintenanceWorkOutcomes,
  measureMaintenanceTraffic,
  planCriticalMaintenance,
  renewCriticalMaintenanceBudgets,
  type CriticalMaintenanceCandidate,
  type AuthorizedMaintenanceProjection,
  type MaintenanceBudgetProjection,
  type MaintenanceTelemetryInput,
} from "../maintenance";
import {
  authorizedSurvivalGrowth,
  planSurvivalGrowth,
  renewGrowthBudgets,
  type GrowthCandidate,
} from "../growth";
import {
  dispositionTransitions,
  planLeaseAgents,
  repairRetryTransitions,
  reconcileLeaseAgentActions,
  type LeaseAgentPlan,
} from "../agents";
import { getRuntimeCacheManager, type CacheManager } from "../cache";
import {
  MovementRuntime,
  SnapshotLocalPathPlanningService,
  emptyMovementRuntimeResult,
  getMovementPathCache,
  type LocalPathPlanningService,
  type LocalPathSearch,
  type MovementRuntimeResult,
} from "../movement";
import { createScreepsLocalPathSearch } from "./local-path-adapter";
import {
  BUDGET_CATEGORIES,
  COLONY_RCL_POLICY_TABLE,
  ColonyDirector,
  emptyColonyPlanningResult,
  isInfrastructureRecoveryAuthorized,
  populationSpawnDemandBinding,
  recoverySpawnDemandBinding,
  resolveColoniesOwner,
  type BudgetRequest,
  type ColonyDirectorSession,
  type ColonyDomainHealthDomain,
  type ColonyPlanningResult,
  type ColonyRclUnlockAllowances,
  type ColonySpawnCommandSettlement,
} from "../colony";
import {
  isFeatureEnabled,
  type RuntimeConfig,
  type RuntimeConfigResolutionMetadata,
} from "../config";
import { RuntimeConfigAuthority, type RuntimeConfigResolution } from "../config/authority";
import {
  ContractLedger,
  contractIdFor,
  createContractRequestChannel,
  emptyContractExecutionView,
  emptyContractPlanningView,
  workforceActorFromCreep,
  type ContractFundingView,
  type ContractExecutionView,
  type ContractPlanningView,
  type ContractReconciliationResult,
  type ContractRequestChannel,
  type ContractPopulationView,
} from "../contracts";
import {
  openMyrmexMemory,
  type MemoryCommitResult,
  type MemoryManager,
  type OpenMemoryResult,
} from "../state/memory";
import {
  CREEP_SPAWN_TICKS_PER_PART,
  SpawnBroker,
  SpawnExecutor,
  generatedSpawnCreepName,
  generatedSpawnCreepNameCandidates,
  spawnRuntimeResult,
  type SpawnBrokerResult,
  type SpawnCommandIntent,
  type SpawnDemand,
  type SpawnExecutionResult,
  type SpawnExpectation,
  type SpawnRuntimeResult,
  type SpawnSelection,
} from "../spawn";
import type { JsonObject, StateView } from "../state/schema";
import { recordTickTelemetry, type TickTelemetry } from "../telemetry/metrics";
import { measureSurvivalEnergyFlow } from "../telemetry/energy-flow";
import type { LogisticsFlowObservation } from "../telemetry/logistics";
import type { StaticMiningSourceObservation } from "../telemetry/static-mining";
import { TelemetryService } from "../telemetry/service";
import { ConsoleReporter, type ConsoleSink } from "../telemetry/console-reporter";
import { projectReporterStatus, type ReporterStatus } from "../telemetry/reporter-status";
import { observeWorld } from "../world/observe";
import { emptyWorldSnapshot, type WorldSnapshot } from "../world/snapshot";
import type { RuntimeGame, TickContext } from "./context";
import {
  CONSTRUCTION_SITE_LIMITS,
  STRUCTURE_REMOVAL_LIMITS,
  ConstructionSiteExecutor,
  StructureDestroyExecutor,
  arbitrateConstructionSites,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  freshSourceServicePlacements,
  layoutCacheDependencies,
  isLayoutSpawnEvacuationFlowId,
  layoutLabEvacuationFlowIds,
  layoutLinkEvacuationFlowId,
  layoutSpawnEvacuationFlowId,
  layoutTerminalEvacuationFlowIds,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutContainerMigration,
  persistLayoutExtensionEvacuation,
  persistLayoutLabEvacuation,
  persistLayoutLinkEvacuation,
  persistLayoutRemovalReceipt,
  persistLayoutSpawnEvacuation,
  persistLayoutTerminalEvacuation,
  persistLayoutTowerEvacuation,
  planOwnedRoomLayout,
  projectLayoutConvergencePlacements,
  reconcileConstructionSiteExecution,
  reconcileStructureDestroyExecution,
  reconstructCommittedLayout,
  registerLayoutCompiledCache,
  selectLayoutPlanningWindow,
  type ConstructionSiteArbitrationResult,
  type ConstructionSiteExecutionResult,
  type LayoutCommitment,
  type LayoutMigrationAuthorization,
  type LayoutMigrationBlockerRecord,
  type LayoutMigrationProposal,
  type LayoutPlacement,
  type LayoutRecord,
  type LayoutRuntimePlanRecord,
  type LayoutRuntimeResult,
  type LayoutsOwnerV19,
  type StructureDestroyExecutionResult,
  type StructureRemovalArbitrationResult,
} from "../layout";
import {
  CPU_MODES,
  RuntimeKernel,
  type CpuBudget,
  type CpuMode,
  type KernelTickReport,
  type StagedSystemResult,
  type SystemHealthRecord,
  type TickSystem,
} from "./kernel";
import type { TickPhase } from "./phases";
import { deriveRuntimeColonyDomainHealth } from "./colony-domain-health";
import { createLocalPathTravelEstimateView, localPathSearchAllowance } from "./local-path-travel";
import {
  currentlyExecutableLogisticsFlowIds,
  emptyLogisticsRuntimeProjection,
  executableLogisticsView,
  planLogisticsRuntime,
  renewLogisticsBudgets,
  type LogisticsRuntimeProjection,
} from "../logistics/runtime";
import { projectLayoutContainerMigrations } from "../logistics/container-migration";
import { projectLayoutExtensionEvacuations } from "../logistics/extension-evacuation";
import {
  completeExecutableLayoutLabEvacuationFlowIds,
  projectLayoutLabEvacuations,
} from "../logistics/lab-evacuation";
import { projectLayoutLinkEvacuations } from "../logistics/link-evacuation";
import {
  authorizedLayoutSpawnEvacuationBudgets,
  projectLayoutSpawnEvacuations,
} from "../logistics/spawn-evacuation";
import {
  completeExecutableLayoutTerminalEvacuationFlowIds,
  projectLayoutTerminalEvacuations,
} from "../logistics/terminal-evacuation";
import { projectLayoutTowerEvacuations } from "../logistics/tower-evacuation";
import type { LogisticsResourceDemandProjection } from "../logistics/resource-demands";
import {
  LinkExecutor,
  emptyLinkRuntimeResult,
  planLinkRuntime,
  projectLinkDomainHealth,
  validateReserveLinkEvacuationContinuity,
  type LinkRoomLayoutEvidence,
  type LinkRuntimeResult,
} from "../links";
import {
  IndustryDirector,
  composeLabRuntime,
  composeMatureInfrastructure,
  emptyLabCompositionProjection,
  emptyMatureInfrastructureProjection,
  executeLabIntents,
  executeMatureIntents,
  fingerprintLiveLabCreep,
  settleLabComposition,
  authorizeIndustryWork,
  eligibleIndustrySendIds,
  emptyIndustryOwner,
  executeTerminalSendIntents,
  observeIndustryRooms,
  migrateIndustryOwner,
  normalizeMatureMechanics,
  parseIndustryOwner,
  persistIndustryOwner,
  projectIndustryBudgets,
  projectIndustryTelemetry,
  projectIndustryTerminalWork,
  projectLabTelemetry,
  projectMatureCommandTelemetry,
  projectTerminalSendIntents,
  reconcileIndustryCommands,
  settleMatureInfrastructure,
  type IndustryCommandState,
  type IndustryOwnerV5,
  type IndustryPlan,
  type IndustryRoomState,
  type IndustryTelemetry,
  type IndustryTerminalWorkProjection,
  type LabCommand,
  type LabCompositionProjection,
  type CommittedLabLayout,
  type InternalSendRequest,
  type MatureCommand,
  type MatureInfrastructureProjection,
  type MatureMechanicsInput,
  type TerminalSendCommand,
} from "../industry";
import {
  composeObserverRuntime,
  emptyObserverRuntimeProjection,
  executeObserverIntents,
  projectObserverTelemetry,
  settleObserverRuntime,
  type ObserverCommand,
  type ObserverRuntimeProjection,
} from "../observer";

const KERNEL_STATE_SCHEMA_VERSION = 1 as const;
const MAX_RESTORED_SYSTEM_HEALTH = 128;
const runtimeConfigAuthority = new RuntimeConfigAuthority();
const colonyDirector = new ColonyDirector();
const spawnBroker = new SpawnBroker();
const spawnExecutor = new SpawnExecutor();
const telemetryService = new TelemetryService();
const constructionSiteExecutor = new ConstructionSiteExecutor();
const structureDestroyExecutor = new StructureDestroyExecutor();
const linkExecutor = new LinkExecutor();
const constructionPlanner = new ConstructionPlanner();
const industryDirector = new IndustryDirector();
const layoutCaches = new WeakMap<CacheManager, ReturnType<typeof registerLayoutCompiledCache>>();

export interface TickInput {
  readonly game: RuntimeGame;
  readonly memory: Memory;
  /** Test-only replacement for the runtime-owned Screeps PathFinder adapter. */
  readonly localPathSearch?: LocalPathSearch;
  /** Test/diagnostic observer. A throwing callback is isolated like its owning system. */
  readonly onPhase?: (phase: TickPhase) => void;
  /** Optional host adapter for the sole redacted console reporter. */
  readonly consoleSink?: ConsoleSink;
}

export interface TickOutcome {
  readonly memoryStatus: OpenMemoryResult["status"];
  readonly migrationStepsApplied: number;
  readonly config: RuntimeConfig;
  readonly configResolution: RuntimeConfigResolutionMetadata;
  readonly snapshot: WorldSnapshot;
  readonly colony: ColonyPlanningResult;
  /** Sanitized start-of-tick lease authorization for plan systems and diagnostics. */
  readonly contractExecution: ContractExecutionView;
  readonly contracts: ContractReconciliationResult | null;
  readonly execution: ArbitrationBatch | null;
  readonly movement: MovementRuntimeResult;
  /** Runtime-owned data-only local path capability. */
  readonly localPathPlanning: LocalPathPlanningService;
  readonly layout: LayoutRuntimeResult;
  readonly links: LinkRuntimeResult;
  readonly spawn: SpawnRuntimeResult;
  readonly stateCommit: MemoryCommitResult | null;
  /** Null only when the mandatory telemetry system itself faults; the kernel report still survives. */
  readonly telemetry: TickTelemetry | null;
  /** Pure, redacted observer view for the later ConsoleReporter adapter. */
  readonly reporterStatus: ReporterStatus;
  readonly kernel: KernelTickReport;
}

interface TickRuntimeControl {
  readonly context: TickContext;
  publishSnapshot(snapshot: WorldSnapshot): void;
  publishColony(colony: ColonyPlanningResult): void;
  clearColony(): void;
  publishContracts(result: ContractReconciliationResult): void;
  clearContracts(): void;
  publishExecution(batch: ArbitrationBatch): void;
  publishMovement(result: MovementRuntimeResult): void;
  clearMovement(): void;
  publishLayout(result: LayoutRuntimeResult): void;
  publishLinks(result: LinkRuntimeResult): void;
  publishSpawn(result: SpawnRuntimeResult): void;
  clearSpawn(): void;
  publishStateCommit(result: MemoryCommitResult): void;
  publishTelemetry(telemetry: TickTelemetry): void;
}

interface RestoredKernelState {
  readonly cpuMode: CpuMode | null;
  readonly health: readonly SystemHealthRecord[];
}

/**
 * Runs one complete Screeps tick through the sole phase orchestrator. Memory opening is the bounded
 * preflight needed to select recovery admission; every scheduled unit then runs under RuntimeKernel.
 */
export function runTick(input: TickInput): TickOutcome {
  const tickStartedAtCpu = input.game.cpu.getUsed();
  const opened = openMyrmexMemory(input.memory, input.game.time, input.game.shard.name);
  const cacheManager = getRuntimeCacheManager();
  getMovementPathCache(cacheManager);
  const manager = opened.status === "ready" ? opened.manager : null;
  const state = manager?.view() ?? null;
  const contractExecution = readContractExecution(manager);
  const contractPlanning = readContractPlanning(manager);
  const contractPopulation = readContractPopulation(manager);
  const configResolution = runtimeConfigAuthority.resolve(
    manager?.ownerView("config") ?? null,
    input.game.time,
  );
  const localPathPlanning = new SnapshotLocalPathPlanningService(
    getMovementPathCache(cacheManager),
    isFeatureEnabled(configResolution.config, "phase1.movement")
      ? (input.localPathSearch ?? createScreepsLocalPathSearch())
      : null,
    configResolution.config.policy.movement,
  );
  const restored = restoreKernelState(state);
  const movementRuntime = new MovementRuntime();
  const runtime = createTickRuntime(
    input.game,
    opened.status,
    state,
    configResolution.config,
    configResolution.metadata,
    contractExecution,
    contractPlanning,
    localPathPlanning,
    movementRuntime.channels,
  );
  const intentChannel = createIntentChannel({
    maximumSubmitted: 512,
    maximumAccepted: 128,
    maximumBudget: 1_000_000,
    overloadPolicy: "defer",
  });
  const contractChannel = createContractRequestChannel();

  const systems = composeRuntimeSystems({
    game: input.game,
    manager,
    cacheManager,
    runtime,
    intentChannel,
    movementRuntime,
    configReplacement: configResolution.replacementOwner,
    contractChannel,
    contractPopulation,
    onPhase: input.onPhase,
    getKernel: () => kernel,
  });
  const kernel = new RuntimeKernel(systems, {
    initialHealth: restored.health,
    initialCpuMode: restored.cpuMode,
  });

  const report = kernel.run({
    tick: input.game.time,
    context: runtime.context,
    cpu: input.game.cpu,
    tickStartedAtCpu,
    signals: { recoveryRequired: opened.status !== "ready" },
    inputRevision: runtimeInputRevision(runtime.context.snapshot, runtime.context.config),
  });
  const reporterStatus = projectReporterStatus(
    runtime.context.telemetry,
    report,
    runtime.context.config.policy.reporter,
  );
  if (input.consoleSink !== undefined) {
    new ConsoleReporter().report(
      reporterStatus,
      runtime.context.config.policy.reporter,
      input.consoleSink,
    );
  }
  return Object.freeze({
    memoryStatus: opened.status,
    migrationStepsApplied: opened.migrationStepsApplied,
    config: runtime.context.config,
    configResolution: runtime.context.configResolution,
    snapshot: runtime.context.snapshot,
    colony: runtime.context.colony,
    contractExecution: runtime.context.contractExecution,
    contracts: runtime.context.contracts,
    execution: runtime.context.execution,
    movement: runtime.context.movement,
    localPathPlanning: runtime.context.localPathPlanning,
    layout: runtime.context.layout,
    links: runtime.context.links,
    spawn: runtime.context.spawn,
    stateCommit: runtime.context.stateCommit,
    telemetry: runtime.context.telemetry,
    reporterStatus,
    kernel: report,
  });
}

interface CompositionInput {
  readonly game: RuntimeGame;
  readonly manager: MemoryManager | null;
  readonly cacheManager: CacheManager;
  readonly runtime: TickRuntimeControl;
  readonly intentChannel: IntentChannel;
  readonly movementRuntime: MovementRuntime;
  readonly configReplacement: RuntimeConfigResolution["replacementOwner"];
  readonly contractChannel: ContractRequestChannel;
  readonly contractPopulation: ContractPopulationView;
  readonly onPhase: ((phase: TickPhase) => void) | undefined;
  readonly getKernel: () => RuntimeKernel<TickContext>;
}

interface SpawnTickDraft {
  session: ColonyDirectorSession | null;
  broker: SpawnBrokerResult | null;
  intents: readonly SpawnCommandIntent[];
  execution: readonly SpawnExecutionResult[] | null;
  settled: ReturnType<ColonyDirectorSession["settle"]> | null;
  settlementStaged: boolean;
  status: SpawnRuntimeResult["status"];
}
interface LayoutTickDraft {
  arbitration: ConstructionSiteArbitrationResult | null;
  changed: boolean;
  execution: readonly ConstructionSiteExecutionResult[];
  migrationArbitration: StructureRemovalArbitrationResult | null;
  migrationBlockers: readonly LayoutMigrationBlockerRecord[];
  migrationExecution: readonly StructureDestroyExecutionResult[];
  migrationInputs: readonly Parameters<ConstructionPlanner["planMigration"]>[0][];
  migrationProposals: readonly LayoutMigrationProposal[];
  migrationScannedCandidates: number;
  migrationTruncatedCandidates: number;
  owner: LayoutsOwnerV19 | null;
  planning: readonly LayoutRuntimePlanRecord[];
  receiptsWritten: number;
  reconciledEarly: boolean;
  sourceServiceHandoffChanged: boolean;
  status: LayoutRuntimeResult["status"];
  linkEvidence: readonly LinkRoomLayoutEvidence[];
  maintenanceLayouts: readonly {
    readonly placements: readonly LayoutPlacement[];
    readonly roomName: string;
  }[];
}
interface IndustryTickDraft {
  eligiblePlan: IndustryPlan;
  execution: readonly CommandExecutionResult<TerminalSendCommand>[];
  labExecution: readonly CommandExecutionResult<LabCommand>[];
  labs: LabCompositionProjection;
  mature: MatureInfrastructureProjection;
  matureExecution: readonly CommandExecutionResult<MatureCommand>[];
  observer: ObserverRuntimeProjection;
  observerExecution: readonly CommandExecutionResult<ObserverCommand>[];
  owner: IndustryOwnerV5;
  ownerNeedsPersistence: boolean;
  plan: IndustryPlan;
  rooms: readonly IndustryRoomState[];
  states: readonly IndustryCommandState[];
  telemetry: IndustryTelemetry;
  terminalWork: IndustryTerminalWorkProjection;
}

/** Static, explicit composition. Roadmap systems replace foundation markers in dependency order. */
function composeRuntimeSystems(input: CompositionInput): readonly TickSystem<TickContext>[] {
  const spawnDraft: SpawnTickDraft = {
    session: null,
    broker: null,
    intents: [],
    execution: null,
    settled: null,
    settlementStaged: false,
    status: "not-run",
  };
  const layoutDraft: LayoutTickDraft = {
    arbitration: null,
    changed: false,
    execution: Object.freeze([]),
    migrationArbitration: null,
    migrationBlockers: Object.freeze([]),
    migrationExecution: Object.freeze([]),
    migrationInputs: Object.freeze([]),
    migrationProposals: Object.freeze([]),
    migrationScannedCandidates: 0,
    migrationTruncatedCandidates: 0,
    owner: null,
    planning: Object.freeze([]),
    receiptsWritten: 0,
    reconciledEarly: false,
    sourceServiceHandoffChanged: false,
    status: "not-run",
    linkEvidence: Object.freeze([]),
    maintenanceLayouts: Object.freeze([]),
  };
  const industryOwnerResult = industryOwnerForPolicy(
    input.manager?.ownerView("industry") ?? null,
    input.runtime.context.config.policy.industry.sourceVersion,
  );
  const industryOwner = industryOwnerResult.owner;
  const industryDraft: IndustryTickDraft = {
    eligiblePlan: emptyIndustryPlan(),
    execution: Object.freeze([]),
    labExecution: Object.freeze([]),
    labs: emptyLabCompositionProjection(),
    mature: emptyMatureInfrastructureProjection(),
    matureExecution: Object.freeze([]),
    observer: emptyObserverRuntimeProjection(),
    observerExecution: Object.freeze([]),
    owner: industryOwner,
    ownerNeedsPersistence: industryOwnerResult.needsPersistence,
    plan: emptyIndustryPlan(),
    rooms: Object.freeze([]),
    states: industryOwner.commands,
    telemetry: projectIndustryTelemetry({
      plan: emptyIndustryPlan(),
      results: [],
      states: industryOwner.commands,
    }),
    terminalWork: Object.freeze({ rooms: Object.freeze([]), status: "unavailable" }),
  };
  let leaseAgentPlan: LeaseAgentPlan = Object.freeze({
    actions: Object.freeze([]),
    dispositions: Object.freeze([]),
    movement: Object.freeze([]),
  });
  let survivalCandidates: readonly SurvivalFlowCandidate[] = Object.freeze([]);
  let maintenanceCandidates: readonly CriticalMaintenanceCandidate[] = Object.freeze([]);
  let growthCandidates: readonly GrowthCandidate[] = Object.freeze([]);
  let staticMiningPlan: StaticMiningPlan = emptyStaticMiningPlan();
  let logisticsRuntime = emptyLogisticsRuntimeProjection();
  let activeLabEvacuationFlowIds: ReadonlySet<string> = persistedLayoutLabEvacuationFlowIds(
    input.manager,
  );
  let authorizedLabEvacuationFlowIds: ReadonlySet<string> = new Set();
  let activeLinkEvacuationFlowIds: ReadonlySet<string> = persistedLayoutLinkEvacuationFlowIds(
    input.manager,
  );
  let authorizedLinkEvacuationFlowIds: ReadonlySet<string> = new Set();
  let activeSpawnEvacuationFlowIds: ReadonlySet<string> = persistedLayoutSpawnEvacuationFlowIds(
    input.manager,
  );
  let candidateSpawnEvacuationFlowIds: ReadonlySet<string> = new Set();
  let suppressedSpawnEvacuationTargetIds: ReadonlySet<string> = new Set();
  let activeTerminalEvacuationFlowIds: ReadonlySet<string> =
    persistedLayoutTerminalEvacuationFlowIds(input.manager);
  let authorizedTerminalEvacuationFlowIds: ReadonlySet<string> = new Set();
  let suppressedTerminalEvacuationTargetIds: ReadonlySet<string> =
    persistedLayoutTerminalEvacuationTargetIds(input.manager, input.runtime.context.tick);
  let linkDraft = emptyLinkRuntimeResult();
  let maintenanceBudget: MaintenanceBudgetProjection = Object.freeze({
    budgets: Object.freeze([]),
    planning: Object.freeze({
      deferred: Object.freeze([]),
      deferredCount: 0,
      health: Object.freeze([]),
      proposals: Object.freeze([]),
      scannedStructures: 0,
      truncatedStructures: 0,
    }),
  });
  let authorizedMaintenance: AuthorizedMaintenanceProjection = Object.freeze({
    creepRequests: Object.freeze([]),
    fundedProposals: Object.freeze([]),
    retirements: Object.freeze([]),
    towerCandidates: Object.freeze([]),
  });
  let staticMiningCpuUsed = 0;
  let logisticsCpuUsed = 0;
  let collectedTelemetry: TickTelemetry | null = null;
  let maintenanceTowerCommands: MaintenanceTelemetryInput["towerCommands"] = Object.freeze([]);
  let maintenanceTowerRejections: MaintenanceTelemetryInput["towerRejections"] = Object.freeze([]);
  let maintenanceDuplicateTargetsSuppressed = 0;
  return Object.freeze([
    configBootSystem(input),
    {
      descriptor: {
        id: "agents.reconcile",
        phase: "reconcile",
        criticality: "operational",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase1.agents")) return staged(() => undefined);
        const scope = input.contractChannel.openProducer("agents.reconcile");
        const transitions = [
          ...dispositionTransitions(leaseAgentPlan.dispositions, context.tick),
          ...reconcileLeaseAgentActions(
            context.contractExecution.leases,
            context.movement,
            context.tick,
          ),
          ...repairRetryTransitions(
            context.contractPlanning,
            context.config.policy.retries,
            context.tick,
          ),
        ].sort((left, right) => left.contractId.localeCompare(right.contractId));
        const seen = new Set<string>();
        for (const transition of transitions) {
          if (seen.has(transition.contractId)) continue;
          seen.add(transition.contractId);
          scope.producer.transition(transition);
        }
        const stagedRequests = scope.stage();
        return staged(
          () => {
            stagedRequests.commit();
          },
          () => {
            stagedRequests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "contracts.reconcile",
        phase: "reconcile",
        criticality: "operational",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: true,
        mandatoryTail: false,
      },
      run: ({ context, budget }) => {
        if (!isFeatureEnabled(context.config, "phase1.contracts")) {
          input.contractChannel.seal();
          return staged(() => undefined);
        }
        if (input.manager === null || context.state === null) {
          input.contractChannel.seal();
          return staged(() => undefined);
        }
        if (!spawnDraft.settlementStaged) {
          input.contractChannel.seal();
          return staged(() => undefined);
        }
        const manager = input.manager;
        const funding = contractFundingView(context.colony);
        if (funding.status === "unavailable") {
          input.contractChannel.seal();
          return staged(() => undefined);
        }
        const opened = ContractLedger.open(manager.ownerView("contracts"));
        if (opened.status === "invalid") {
          throw new Error(
            `contracts-owner-invalid:${opened.error.code}:${opened.error.path}`.slice(0, 256),
          );
        }
        if (opened.status === "unsupported") {
          throw new Error(
            `contracts-owner-unsupported:${String(opened.foundSchemaVersion)}`.slice(0, 256),
          );
        }

        const batch = input.contractChannel.seal();
        const actors = context.snapshot.rooms
          .flatMap((room) => room.ownedCreeps)
          .map(workforceActorFromCreep);
        const reconciliation = opened.ledger.reconcile({
          actors,
          funding,
          replacements: batch.replacements,
          requests: batch.requests,
          tick: context.tick,
          transitions: batch.transitions,
          travel: createLocalPathTravelEstimateView({
            availableCpu: localPathSearchAllowance(budget),
            paths: context.localPathPlanning,
            snapshot: context.snapshot,
            tick: context.tick,
          }),
        });

        return staged(
          () => {
            if (opened.ledger.changed) {
              const stagedContracts = opened.ledger.stage(manager);
              if (!stagedContracts.staged) {
                throw new Error(stagedContracts.fault?.message ?? "contracts state staging failed");
              }
            }
            input.runtime.publishContracts(reconciliation);
          },
          () => {
            manager.discard("contracts");
            input.runtime.clearContracts();
          },
        );
      },
    },
    {
      descriptor: {
        id: "world.observe",
        phase: "observe",
        criticality: "mandatory",
        cadence: 1,
        estimate: 1,
        admitInRecovery: true,
        mandatoryTail: false,
      },
      run: () => {
        input.onPhase?.("observe");
        const snapshot = observeWorld(input.game);
        return staged(
          () => {
            input.runtime.publishSnapshot(snapshot);
          },
          () => undefined,
        );
      },
    },
    defenseSafetySystem(input),
    colonyDirectorSystem(
      input,
      spawnDraft,
      industryDraft,
      (
        economy,
        maintenance,
        growth,
        mining,
        miningCpuUsed,
        logistics,
        logisticsCpu,
        matureMaintenance,
        activeLabEvacuations,
        authorizedLabEvacuations,
        activeLinkEvacuations,
        authorizedLinkEvacuations,
        activeSpawnEvacuations,
        authorizedSpawnEvacuations,
        suppressedSpawnEvacuationTargets,
        activeTerminalEvacuations,
        authorizedTerminalEvacuations,
        suppressedTerminalEvacuationTargets,
      ) => {
        survivalCandidates = economy;
        maintenanceCandidates = maintenance;
        growthCandidates = growth;
        staticMiningPlan = mining;
        staticMiningCpuUsed = miningCpuUsed;
        logisticsRuntime = logistics;
        logisticsCpuUsed = logisticsCpu;
        maintenanceBudget = matureMaintenance;
        activeLabEvacuationFlowIds = activeLabEvacuations;
        authorizedLabEvacuationFlowIds = authorizedLabEvacuations;
        activeLinkEvacuationFlowIds = activeLinkEvacuations;
        authorizedLinkEvacuationFlowIds = authorizedLinkEvacuations;
        activeSpawnEvacuationFlowIds = activeSpawnEvacuations;
        candidateSpawnEvacuationFlowIds = authorizedSpawnEvacuations;
        suppressedSpawnEvacuationTargetIds = suppressedSpawnEvacuationTargets;
        activeTerminalEvacuationFlowIds = activeTerminalEvacuations;
        authorizedTerminalEvacuationFlowIds = authorizedTerminalEvacuations;
        suppressedTerminalEvacuationTargetIds = suppressedTerminalEvacuationTargets;
      },
    ),
    industryPublicationSystem(input, industryDraft),
    layoutPlanningSystem(
      input,
      layoutDraft,
      () => logisticsRuntime,
      () => industryDraft.labs,
      () => industryDraft.terminalWork,
    ),
    {
      descriptor: {
        id: "maintenance.routine-contracts",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase2.maintenance")) return staged(() => undefined);
        const planning = constructionPlanner.plan({
          layouts: new Map(
            layoutDraft.maintenanceLayouts.map(({ placements, roomName }) => [
              roomName,
              placements,
            ]),
          ),
          reserves: context.snapshot.rooms.map((room) => ({
            roomName: room.name,
            state:
              context.colony.colonies.find(({ roomName }) => roomName === room.name)?.rclPolicy
                .protectedSpawnReserve.state === "restored"
                ? "surplus"
                : "protected",
          })),
          snapshot: context.snapshot,
          traffic: measureMaintenanceTraffic(context.snapshot),
        });
        maintenanceBudget = Object.freeze({ ...maintenanceBudget, planning });
        authorizedMaintenance = authorizeMaintenanceWork({
          budgets: maintenanceBudget.budgets,
          contracts: context.contractPlanning,
          planning,
          reservations: context.colony.reservations,
          tick: context.tick,
        });
        const towerIntents = planRoutineTowerMaintenance(
          context.snapshot,
          context.config,
          authorizedMaintenance.towerCandidates,
        );
        const assignment = assignMaintenanceExecution(authorizedMaintenance, towerIntents);
        maintenanceDuplicateTargetsSuppressed = assignment.duplicateTargetsSuppressed;
        const contracts = input.contractChannel.openProducer("maintenance.routine-contracts");
        for (const request of assignment.creepRequests) contracts.producer.submit(request);
        for (const transition of authorizedMaintenance.retirements)
          contracts.producer.transition(transition);
        const stagedContracts = contracts.stage();
        const intents = input.intentChannel.openProducer("maintenance.towers");
        for (const intent of towerIntents) intents.producer.submit(intent);
        const stagedIntents = intents.stage();
        return staged(
          () => {
            stagedContracts.commit();
            stagedIntents.commit();
          },
          () => {
            stagedContracts.discard();
            stagedIntents.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "links.plan",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        linkDraft = isFeatureEnabled(context.config, "phase2.links")
          ? planLinkRuntime({
              excludedLinkIds: activeLayoutLinkEvacuationIds(input.manager),
              growth: growthCandidates,
              layouts: layoutDraft.linkEvidence,
              logistics: logisticsRuntime,
              mining: staticMiningPlan,
              reservations: context.colony.reservations,
              rooms: context.snapshot.rooms,
              tick: context.tick,
            })
          : emptyLinkRuntimeResult("disabled");
        return staged(
          () => {
            input.runtime.publishLinks(linkDraft);
          },
          () => {
            linkDraft = emptyLinkRuntimeResult();
            input.runtime.publishLinks(linkDraft);
          },
        );
      },
    },
    layoutMigrationPlanningSystem(
      input,
      layoutDraft,
      () => linkDraft,
      () => candidateSpawnEvacuationFlowIds,
      () => logisticsRuntime,
      () => leaseAgentPlan,
      (planned) => {
        leaseAgentPlan = planned;
      },
    ),
    {
      descriptor: {
        id: "mining.contracts",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase2.mining")) {
          return staged(() => undefined);
        }
        const funded = new Set(
          context.colony.reservations
            .filter(
              ({ category, status }) => category === "harvesting-filling" && status === "active",
            )
            .map(({ colonyId, issuer }) => `${colonyId}\u0000${issuer}`),
        );
        const scope = input.contractChannel.openProducer("mining.contracts");
        for (const request of staticMiningPlan.requests) {
          if (funded.has(`${request.owner.id}\u0000${request.budgetBinding.issuer}`)) {
            scope.producer.submit(request);
          }
        }
        for (const replacement of staticMiningPlan.replacements) {
          const successor = replacement.successor;
          if (!funded.has(`${successor.owner.id}\u0000${successor.budgetBinding.issuer}`)) continue;
          scope.producer.replace(replacement);
          scope.producer.transition({
            contractId: contractIdFor(
              successor.issuer,
              successor.issuerKey,
              successor.issuerSequence,
            ),
            reason: "static-mining-successor-funded",
            tick: context.tick,
            to: "funded",
          });
        }
        for (const contract of context.contractPlanning.contracts) {
          if (
            contract.issuer.startsWith("mining/") &&
            (contract.state === "proposed" || contract.state === "suspended") &&
            funded.has(`${contract.owner.id}\u0000${contract.budgetBinding.issuer}`)
          ) {
            scope.producer.transition({
              contractId: contract.contractId,
              reason: "static-mining-funded",
              tick: context.tick,
              to: "funded",
            });
          }
        }
        for (const transition of staticMiningPlan.transitions) {
          scope.producer.transition(transition);
        }
        const stagedRequests = scope.stage();
        return staged(
          () => {
            stagedRequests.commit();
          },
          () => {
            stagedRequests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "logistics.contracts",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase2.mining")) return staged(() => undefined);
        const funded = new Set(
          context.colony.reservations
            .filter(({ status }) => status === "active")
            .map(({ category, colonyId, issuer }) => `${colonyId}\u0000${category}\u0000${issuer}`),
        );
        const scope = input.contractChannel.openProducer("logistics.contracts");
        for (const commitment of logisticsRuntime.contracts.commitments) {
          const request = commitment.request;
          if (
            request !== null &&
            (request.execution?.version !== 3 ||
              !isLayoutSpawnEvacuationFlowId(request.execution.flowId)) &&
            (request.execution?.version !== 3 ||
              isAuthorizedLayoutTerminalEvacuationFlowId(
                request.execution.flowId,
                activeTerminalEvacuationFlowIds,
                authorizedTerminalEvacuationFlowIds,
              )) &&
            funded.has(
              `${request.owner.id}\u0000${request.budgetBinding.category}\u0000${request.budgetBinding.issuer}`,
            )
          )
            scope.producer.submit(request);
        }
        for (const transition of logisticsRuntime.contracts.retirements)
          scope.producer.transition(transition);
        for (const contract of context.contractPlanning.contracts) {
          if (
            contract.execution.version === 3 &&
            isLayoutSpawnEvacuationFlowId(contract.execution.flowId)
          ) {
            if (!activeSpawnEvacuationFlowIds.has(contract.execution.flowId)) {
              scope.producer.transition({
                contractId: contract.contractId,
                reason: "layout-spawn-evacuation-orphaned",
                tick: context.tick,
                to: orphanedSpawnEvacuationTransition(contract.state),
              });
            }
            continue;
          }
          if (
            contract.execution.version === 3 &&
            contract.issuer.startsWith("logistics/") &&
            isAuthorizedLayoutTerminalEvacuationFlowId(
              contract.execution.flowId,
              activeTerminalEvacuationFlowIds,
              authorizedTerminalEvacuationFlowIds,
            ) &&
            (contract.state === "proposed" || contract.state === "suspended") &&
            funded.has(
              `${contract.owner.id}\u0000${contract.budgetBinding.category}\u0000${contract.budgetBinding.issuer}`,
            )
          )
            scope.producer.transition({
              contractId: contract.contractId,
              reason: "logistics-funded",
              tick: context.tick,
              to: "funded",
            });
        }
        const requests = scope.stage();
        return staged(
          () => {
            requests.commit();
          },
          () => {
            requests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "economy.contracts",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase1.economy")) return staged(() => undefined);
        const scope = input.contractChannel.openProducer("economy.contracts");
        const flow = authorizedSurvivalFlow(
          survivalCandidates,
          context.colony.reservations,
          context.contractPlanning,
          context.tick,
          context.snapshot,
        );
        for (const request of flow.requests) scope.producer.submit(request);
        for (const transition of flow.transitions) scope.producer.transition(transition);
        const stagedRequests = scope.stage();
        return staged(
          () => {
            stagedRequests.commit();
          },
          () => {
            stagedRequests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "maintenance.contracts",
        phase: "plan",
        criticality: "operational",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: true,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase1.critical-maintenance")) {
          return staged(() => undefined);
        }
        const scope = input.contractChannel.openProducer("maintenance.contracts");
        const maintenance = authorizedCriticalMaintenance(
          maintenanceCandidates,
          context.colony.reservations,
          context.contractPlanning,
          context.tick,
        );
        for (const request of maintenance.requests) scope.producer.submit(request);
        for (const transition of maintenance.transitions) scope.producer.transition(transition);
        const stagedRequests = scope.stage();
        return staged(
          () => {
            stagedRequests.commit();
          },
          () => {
            stagedRequests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "growth.contracts",
        phase: "plan",
        criticality: "economic",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!isFeatureEnabled(context.config, "phase1.growth")) return staged(() => undefined);
        const scope = input.contractChannel.openProducer("growth.contracts");
        const growth = authorizedSurvivalGrowth(
          growthCandidates,
          context.colony.reservations,
          context.contractPlanning,
          context.tick,
          context.snapshot,
        );
        for (const request of growth.requests) scope.producer.submit(request);
        for (const transition of growth.transitions) scope.producer.transition(transition);
        const stagedRequests = scope.stage();
        return staged(
          () => {
            stagedRequests.commit();
          },
          () => {
            stagedRequests.discard();
          },
        );
      },
    },
    {
      descriptor: {
        id: "agents.plan",
        phase: "plan",
        criticality: "operational",
        cadence: 1,
        estimate: 1,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context, budget }) => {
        if (!isFeatureEnabled(context.config, "phase1.agents")) {
          return staged(() => {
            leaseAgentPlan = Object.freeze({
              actions: Object.freeze([]),
              dispositions: Object.freeze([]),
              movement: Object.freeze([]),
            });
          });
        }
        const blockedSpawnEvacuationFlowIds = context.contractExecution.leases.flatMap(
          ({ execution }) =>
            execution.version === 3 && isLayoutSpawnEvacuationFlowId(execution.flowId)
              ? [execution.flowId]
              : [],
        );
        const planned = planLeaseAgents({
          availablePathCpu: localPathSearchAllowance(budget),
          execution: withoutSuppressedLeaseTargets(
            executableLogisticsView(
              context.contractExecution,
              new Set([
                ...[...activeLabEvacuationFlowIds].filter(
                  (flowId) => !authorizedLabEvacuationFlowIds.has(flowId),
                ),
                ...[...activeLinkEvacuationFlowIds].filter(
                  (flowId) => !authorizedLinkEvacuationFlowIds.has(flowId),
                ),
                ...[...activeTerminalEvacuationFlowIds].filter(
                  (flowId) => !authorizedTerminalEvacuationFlowIds.has(flowId),
                ),
                ...blockedSpawnEvacuationFlowIds,
              ]),
            ),
            new Set([
              ...suppressedSpawnEvacuationTargetIds,
              ...suppressedTerminalEvacuationTargetIds,
            ]),
            authorizedTerminalEvacuationFlowIds,
          ),
          paths: context.localPathPlanning,
          snapshot: context.snapshot,
          tick: context.tick,
        });
        return staged(
          () => {
            for (const intent of planned.actions)
              input.movementRuntime.actionProducer.submit(intent);
            for (const intent of planned.movement)
              input.movementRuntime.movementProducer.submit(intent);
            leaseAgentPlan = planned;
          },
          () => {
            leaseAgentPlan = Object.freeze({
              actions: Object.freeze([]),
              dispositions: Object.freeze([]),
              movement: Object.freeze([]),
            });
          },
        );
      },
    },
    {
      descriptor: {
        id: "cache.sweep",
        phase: "plan",
        criticality: "maintenance",
        cadence: 25,
        estimate: 0.25,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        input.cacheManager.sweep(context.tick, 32);
        return staged(() => undefined);
      },
    },
    {
      descriptor: {
        id: "execution.arbitrate",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ context }) => {
        input.onPhase?.("execute");
        const batch = input.intentChannel.arbiter.arbitrate({
          tick: context.tick,
          snapshotRevision: snapshotRevision(context.snapshot),
        });
        maintenanceTowerRejections = Object.freeze(
          batch.decisions.flatMap((decision) =>
            decision.intent.kind === "tower.repair" && decision.status !== "accepted"
              ? [{ targetId: decision.intent.target, reason: decision.reason }]
              : [],
          ),
        );
        return staged(
          () => {
            input.runtime.publishExecution(batch);
          },
          () => undefined,
        );
      },
    },
    {
      descriptor: {
        id: "execution.defense",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ context }) => {
        if (context.execution !== null)
          maintenanceTowerCommands = executeDefenseIntents(
            context.execution,
            context.tick,
            (id) => resolveLiveObject(input.game, id),
            input.game.cpu,
          );
        return staged(() => undefined);
      },
    },
    {
      descriptor: {
        id: "industry.execute",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: false,
        mandatoryTail: true,
      },
      run: ({ context }) => {
        const enabled = isFeatureEnabled(context.config, "phase2.industry");
        industryDraft.execution =
          enabled && context.execution !== null
            ? executeTerminalSendIntents(
                context.execution,
                context.tick,
                (id) => resolveLiveObject(input.game, id) as StructureTerminal | null,
                input.game.cpu,
              )
            : Object.freeze([]);
        industryDraft.labExecution =
          enabled && isFeatureEnabled(context.config, "phase2.labs") && context.execution !== null
            ? executeLabIntents(
                context.execution,
                context.tick,
                {
                  creepFingerprint: fingerprintLiveLabCreep,
                  resolveCreep: (id) => resolveLiveObject(input.game, id) as Creep | null,
                  resolveLab: (id) => resolveLiveObject(input.game, id) as StructureLab | null,
                },
                input.game.cpu,
              )
            : Object.freeze([]);
        const matureEnabled =
          enabled &&
          isFeatureEnabled(context.config, "phase2.mature") &&
          context.execution !== null;
        const currentCatalog = matureEnabled ? matureCatalogFromGlobals(context.config) : null;
        industryDraft.matureExecution = matureEnabled
          ? executeMatureIntents(
              context.execution,
              context.tick,
              {
                currentCapabilityFingerprint: (kind, id) =>
                  industryDraft.mature.capabilities.find(
                    (capability) => capability.kind === kind && capability.id === id,
                  )?.fingerprint ?? null,
                currentMechanicsFingerprint: () => currentCatalog?.fingerprint ?? null,
                resolveFactory: (id) =>
                  resolveLiveObject(input.game, id) as StructureFactory | null,
                resolvePowerSpawn: (id) =>
                  resolveLiveObject(input.game, id) as StructurePowerSpawn | null,
              },
              input.game.cpu,
            )
          : Object.freeze([]);
        industryDraft.observerExecution = matureEnabled
          ? executeObserverIntents(
              context.execution,
              context.tick,
              {
                currentCapabilityFingerprint: (id) =>
                  industryDraft.mature.capabilities.find(
                    (capability) => capability.kind === "observer" && capability.id === id,
                  )?.fingerprint ?? null,
                currentMechanicsFingerprint: () => currentCatalog?.fingerprint ?? null,
                resolveObserver: (id) =>
                  resolveLiveObject(input.game, id) as StructureObserver | null,
              },
              input.game.cpu,
            )
          : Object.freeze([]);
        return staged(() => undefined);
      },
    },
    {
      descriptor: {
        id: "spawn.execute",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.75,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: () => {
        const results = spawnExecutor.execute(
          spawnDraft.intents,
          (spawnId) => resolveLiveSpawn(input.game, spawnId),
          input.game.cpu,
        );
        spawnDraft.execution = results;
        return staged(
          () => {
            input.runtime.publishSpawn(
              spawnRuntimeResult(spawnDraft.status, spawnDraft.broker, results),
            );
          },
          () => {
            input.runtime.clearColony();
            input.runtime.clearSpawn();
          },
        );
      },
    },
    {
      descriptor: {
        id: "layout.execute",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: true,
      },
      run: () => {
        const owner = layoutDraft.owner;
        const isCurrentCommitment = (roomName: string, fingerprint: string) =>
          owner?.records.some(
            (record) => record.roomName === roomName && record.fingerprint === fingerprint,
          ) === true;
        const execution = constructionSiteExecutor.execute(layoutDraft.arbitration?.intents ?? [], {
          isCurrentCommitment,
          resolveRoom: (roomName) => input.game.rooms[roomName] ?? null,
        });
        const migrationExecution = structureDestroyExecutor.execute(
          layoutDraft.migrationArbitration?.intents ?? [],
          {
            hasCurrentHostiles: (roomName) =>
              (input.game.rooms[roomName]?.find(FIND_HOSTILE_CREEPS) ?? []).length > 0,
            isCurrentCommitment,
            resolveRoom: (roomName) => input.game.rooms[roomName] ?? null,
            resolveStructure: (structureId) =>
              resolveLiveObject(input.game, structureId) as Structure | null,
          },
        );
        layoutDraft.execution = execution;
        layoutDraft.migrationExecution = migrationExecution;
        return staged(() => {
          input.runtime.publishLayout(layoutRuntimeResult(layoutDraft, 0));
        });
      },
    },
    {
      descriptor: {
        id: "links.execute",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: false,
        mandatoryTail: true,
      },
      run: () => {
        const decisions = linkDraft.rooms.flatMap(({ arbitration }) => arbitration.accepted);
        const current = new Set(linkDraft.rooms.map(({ layoutRevision }) => layoutRevision));
        const execution = linkExecutor.execute(
          decisions,
          {
            isCurrentLayoutRevision: (revision) => current.has(revision),
            resolveLink: (id) => resolveLiveObject(input.game, id) as StructureLink | null,
          },
          input.game.time,
        );
        linkDraft = Object.freeze({ ...linkDraft, execution: Object.freeze(execution) });
        return staged(() => {
          input.runtime.publishLinks(linkDraft);
        });
      },
    },
    {
      descriptor: {
        id: "movement.arbitrate-execute",
        phase: "execute",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: true,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        const result = isFeatureEnabled(context.config, "phase1.movement")
          ? input.movementRuntime.execute(context.snapshot, context.tick, {
              resolveActor: (actorId) => resolveLiveObject(input.game, actorId),
              resolveTarget: (targetId) => resolveLiveObject(input.game, targetId),
            })
          : input.movementRuntime.disabled();
        return staged(
          () => {
            input.runtime.publishMovement(result);
          },
          () => {
            input.runtime.clearMovement();
          },
        );
      },
    },
    spawnSettleSystem(input, spawnDraft),
    {
      descriptor: {
        id: "industry.reconcile",
        phase: "reconcile",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: false,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        const previousOwner = industryDraft.owner;
        const states = reconcileIndustryCommands({
          plan: industryDraft.plan,
          previous: industryDraft.owner.commands,
          results: industryDraft.execution,
          tick: context.tick,
        });
        const labState = settleLabComposition({
          execution: industryDraft.labExecution,
          previousAttempts: industryDraft.owner.labAttempts,
          projection: industryDraft.labs,
        });
        const matureState =
          industryDraft.mature.catalog === null
            ? {
                attempts: industryDraft.owner.matureAttempts,
                commitments: industryDraft.owner.matureCommitments,
              }
            : settleMatureInfrastructure({
                execution: industryDraft.matureExecution,
                previousAttempts: industryDraft.owner.matureAttempts,
                projection: industryDraft.mature,
              });
        const observerAttempts =
          industryDraft.mature.catalog === null
            ? industryDraft.owner.observerAttempts
            : settleObserverRuntime({
                execution: industryDraft.observerExecution,
                previousAttempts: industryDraft.owner.observerAttempts,
                projection: industryDraft.observer,
              });
        const owner = persistIndustryOwner(
          industryDraft.owner,
          context.config.policy.industry.sourceVersion,
          states,
          labState.commitments,
          labState.attempts,
          matureState.attempts,
          matureState.commitments,
          observerAttempts,
        );
        const telemetry = projectIndustryTelemetry({
          labs: projectLabTelemetry(industryDraft.labs, industryDraft.labExecution),
          ...(industryDraft.mature.catalog === null
            ? {}
            : {
                mature: projectMatureCommandTelemetry({
                  execution: industryDraft.matureExecution,
                  intents: industryDraft.mature.intents,
                  settlements: industryDraft.mature.settlements,
                }),
                observer: projectObserverTelemetry({
                  dispositions: industryDraft.observer.arbitration.dispositions,
                  execution: industryDraft.observerExecution,
                  intents: industryDraft.observer.arbitration.intents,
                  settlements: industryDraft.observer.settlements,
                }),
              }),
          plan: industryDraft.plan,
          results: industryDraft.execution,
          states,
        });
        return staged(
          () => {
            industryDraft.owner = owner;
            const needsPersistence = industryDraft.ownerNeedsPersistence;
            industryDraft.ownerNeedsPersistence = false;
            industryDraft.states = states;
            industryDraft.telemetry = telemetry;
            if (input.manager !== null && (owner !== previousOwner || needsPersistence)) {
              const transaction = input.manager.transaction("industry");
              transaction.replace(owner);
              const stagedResult = transaction.stage();
              if (!stagedResult.staged)
                throw new Error(stagedResult.fault?.message ?? "industry state staging failed");
            }
          },
          () => input.manager?.discard("industry"),
        );
      },
    },
    {
      descriptor: {
        id: "layout.handoff-reconcile",
        phase: "reconcile",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.1,
        admitInRecovery: true,
        mandatoryTail: false,
      },
      run: ({ context }) => {
        if (!layoutDraft.sourceServiceHandoffChanged || layoutDraft.reconciledEarly)
          return staged(() => undefined);
        const reconciled = reconcileLayoutDraft(layoutDraft, context.tick);
        return staged(
          () => {
            if (input.manager !== null && reconciled.owner !== null) {
              const changed =
                layoutDraft.changed || reconciled.owner.revision !== layoutDraft.owner?.revision;
              if (changed) {
                const transaction = input.manager.transaction("layouts");
                transaction.replace(reconciled.owner);
                const stagedResult = transaction.stage();
                if (!stagedResult.staged)
                  throw new Error(stagedResult.fault?.message ?? "layout state staging failed");
              }
            }
            layoutDraft.owner = reconciled.owner;
            layoutDraft.changed = false;
            layoutDraft.receiptsWritten = reconciled.receiptsWritten;
            layoutDraft.reconciledEarly = true;
            input.runtime.publishLayout(
              layoutRuntimeResult(layoutDraft, layoutDraft.receiptsWritten),
            );
          },
          () => input.manager?.discard("layouts"),
        );
      },
    },
    {
      descriptor: {
        id: "layout.reconcile",
        phase: "reconcile",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.25,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ context }) => {
        if (layoutDraft.reconciledEarly)
          return staged(() => {
            input.runtime.publishLayout(
              layoutRuntimeResult(layoutDraft, layoutDraft.receiptsWritten),
            );
          });
        const reconciled = reconcileLayoutDraft(layoutDraft, context.tick);
        return staged(
          () => {
            if (input.manager !== null && reconciled.owner !== null) {
              const changed =
                layoutDraft.changed || reconciled.owner.revision !== layoutDraft.owner?.revision;
              layoutDraft.owner = reconciled.owner;
              layoutDraft.changed = changed;
              if (changed) {
                const transaction = input.manager.transaction("layouts");
                transaction.replace(reconciled.owner);
                const stagedResult = transaction.stage();
                if (!stagedResult.staged)
                  throw new Error(stagedResult.fault?.message ?? "layout state staging failed");
              }
            }
            layoutDraft.receiptsWritten = reconciled.receiptsWritten;
            input.runtime.publishLayout(
              layoutRuntimeResult(layoutDraft, layoutDraft.receiptsWritten),
            );
          },
          () => input.manager?.discard("layouts"),
        );
      },
    },
    {
      descriptor: {
        id: "state.reconcile",
        phase: "reconcile",
        criticality: "mandatory",
        cadence: 1,
        estimate: 1,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ context, mode }) => {
        input.onPhase?.("reconcile");
        const persistentKernelState = serializeKernelState(input.getKernel(), mode);
        let rootCommitted = false;
        return staged(
          () => {
            if (input.manager === null) {
              return;
            }
            let telemetryCandidate: TickTelemetry | null = null;
            if (isFeatureEnabled(context.config, "phase1.telemetry")) {
              try {
                const telemetry = telemetryService.record(input.manager.ownerView("telemetry"), {
                  base: telemetryBase(input, context),
                  colony: context.colony,
                  contracts: context.contracts,
                  execution: context.execution,
                  growth: growthCandidates,
                  maintenance: maintenanceCandidates,
                  ...maintenanceTelemetryProperty(
                    maintenanceTelemetryInput(
                      context,
                      maintenanceBudget,
                      authorizedMaintenance,
                      maintenanceTowerCommands,
                      maintenanceTowerRejections,
                      maintenanceDuplicateTargetsSuppressed,
                    ),
                  ),
                  movement: context.movement,
                  snapshot: context.snapshot,
                  spawn: context.spawn,
                  staticMining: {
                    cpuUsed: staticMiningCpuUsed,
                    observations: staticMiningObservations(context, staticMiningPlan),
                  },
                  logistics: {
                    cpuUsed: logisticsCpuUsed,
                    observations: logisticsObservations(context, logisticsRuntime),
                  },
                  industry: industryDraft.telemetry,
                  layout: context.layout,
                  links: context.links,
                  reporterSignals: reporterSignals(input.getKernel().getHealthSnapshot()),
                });
                const telemetryTransaction = input.manager.transaction("telemetry");
                telemetryTransaction.replace(telemetry.owner);
                const telemetryStaged = telemetryTransaction.stage();
                if (!telemetryStaged.staged) {
                  throw new Error(telemetryStaged.fault?.message ?? "telemetry staging failed");
                }
                telemetryCandidate = telemetry.telemetry;
              } catch {
                input.manager.discard("telemetry");
              }
            }
            const transaction = input.manager.transaction("kernel");
            transaction.mutate((draft) => {
              draft.runtime = persistentKernelState;
            });
            const stagedResult = transaction.stage();
            if (!stagedResult.staged) {
              throw new Error(stagedResult.fault?.message ?? "kernel state staging failed");
            }
            const commit = input.manager.commitReconciliation();
            input.runtime.publishStateCommit(commit);
            if (!commit.committed) {
              throw new Error(
                commit.faults.map(({ code, owner }) => `${owner ?? "root"}:${code}`).join(","),
              );
            }
            rootCommitted = true;
            collectedTelemetry = telemetryCandidate;
          },
          () => {
            if (!rootCommitted) {
              input.runtime.clearColony();
              input.runtime.clearContracts();
              input.runtime.clearSpawn();
            }
          },
        );
      },
    },
    {
      descriptor: {
        id: "telemetry.minimum",
        phase: "telemetry",
        criticality: "mandatory",
        cadence: 1,
        estimate: 0.5,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ context }) => {
        input.onPhase?.("telemetry");
        let telemetry = collectedTelemetry;
        if (telemetry === null) {
          try {
            telemetry = withoutDurableReporterState(
              telemetryService.record(undefined, {
                base: telemetryBase(input, context),
                colony: context.colony,
                contracts: context.contracts,
                execution: context.execution,
                growth: growthCandidates,
                maintenance: maintenanceCandidates,
                ...maintenanceTelemetryProperty(
                  maintenanceTelemetryInput(
                    context,
                    maintenanceBudget,
                    authorizedMaintenance,
                    maintenanceTowerCommands,
                    maintenanceTowerRejections,
                    maintenanceDuplicateTargetsSuppressed,
                  ),
                ),
                movement: context.movement,
                snapshot: context.snapshot,
                spawn: context.spawn,
                staticMining: {
                  cpuUsed: staticMiningCpuUsed,
                  observations: staticMiningObservations(context, staticMiningPlan),
                },
                logistics: {
                  cpuUsed: logisticsCpuUsed,
                  observations: logisticsObservations(context, logisticsRuntime),
                },
                industry: industryDraft.telemetry,
                layout: context.layout,
                links: context.links,
                reporterSignals: reporterSignals(input.getKernel().getHealthSnapshot()),
              }).telemetry,
            );
          } catch {
            telemetry = null;
          }
        }
        return staged(() => {
          if (telemetry !== null) input.runtime.publishTelemetry(telemetry);
        });
      },
    },
  ]);
}

function maintenanceTelemetryInput(
  context: TickContext,
  budget: MaintenanceBudgetProjection,
  authorized: AuthorizedMaintenanceProjection,
  towerCommands: MaintenanceTelemetryInput["towerCommands"],
  towerRejections: MaintenanceTelemetryInput["towerRejections"],
  duplicateTargetsSuppressed: number,
): MaintenanceTelemetryInput | undefined {
  if (!isFeatureEnabled(context.config, "phase2.maintenance")) return undefined;
  const fundedRooms = new Set(
    context.colony.reservations
      .filter(({ category, status }) => category === "maintenance" && status === "active")
      .map(({ colonyId }) => colonyId),
  );
  const acceptedTowerIds = new Set(
    towerCommands
      .filter(({ command, status }) => command.kind === "tower.repair" && status === "executed")
      .map(({ command }) => command.exclusiveResourceKey.replace(/^tower\//u, "")),
  );
  const emergencyReservePreserved = context.snapshot.rooms.every((room) =>
    room.ownedTowers.every((tower) => {
      if (!acceptedTowerIds.has(tower.id)) return true;
      const energy =
        tower.store.resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0;
      return energy > context.config.policy.tower.emergencyReserveEnergy;
    }),
  );
  return {
    planning: budget.planning,
    requestedEnergyCaps: budget.budgets.flatMap(({ energy }) =>
      energy === null ? [] : [energy.desired],
    ),
    fundedEnergyCaps: budget.budgets
      .filter(({ colonyId, energy }) => fundedRooms.has(colonyId) && energy !== null)
      .flatMap(({ energy }) => (energy === null ? [] : [energy.desired])),
    towerCommands,
    towerRejections,
    emergencyReservePreserved,
    duplicateTargetsSuppressed,
    workOutcomes: maintenanceWorkOutcomes(
      context.contractPlanning,
      context.snapshot,
      authorized.retirements,
    ),
  };
}

function maintenanceTelemetryProperty(
  input: MaintenanceTelemetryInput | undefined,
): Readonly<Partial<{ maintenanceTelemetry: MaintenanceTelemetryInput }>> {
  return input === undefined ? {} : { maintenanceTelemetry: input };
}

function telemetryBase(
  input: CompositionInput,
  context: TickContext,
): Omit<
  TickTelemetry,
  | "activity"
  | "status"
  | "recoveryProgress"
  | "reporterTransitions"
  | "staticMining"
  | "maintenanceV2"
  | "industry"
  | "phase2"
> {
  return recordTickTelemetry({
    tick: context.tick,
    shard: context.shard,
    memoryStatus: context.memoryStatus,
    cpuBucket: input.game.cpu.bucket,
    snapshot: context.snapshot,
    cache: input.cacheManager.metrics(),
    config: context.config,
    configResolution: context.configResolution,
    colony: context.colony,
    energyFlow: measureSurvivalEnergyFlow(context.snapshot, context.movement),
  });
}

function layoutPlanningSystem(
  input: CompositionInput,
  draft: LayoutTickDraft,
  currentLogistics: () => LogisticsRuntimeProjection,
  currentLabs: () => LabCompositionProjection,
  currentTerminalWork: () => IndustryTerminalWorkProjection,
): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "layout.plan",
      phase: "plan",
      criticality: "economic",
      cadence: 1,
      estimate: 1.5,
      admitInRecovery: false,
      mandatoryTail: false,
    },
    run: ({ context }) => {
      if (!isFeatureEnabled(context.config, "phase2.layout")) {
        return staged(() => {
          draft.status = "disabled";
          input.runtime.publishLayout(layoutRuntimeResult(draft, 0));
        });
      }
      if (input.manager === null) return staged(() => undefined);
      const initialOwner = resolveLayoutsOwner(input.manager.ownerView("layouts"));
      const activeLogisticsFlowIds = new Set(
        context.contractPlanning.contracts.flatMap(({ execution, state }) =>
          execution.version === 3 && (state === "assigned" || state === "active")
            ? [execution.flowId]
            : [],
        ),
      );
      const activeLeasedWorkTargetIds = projectActiveLeaseTargetIds(
        context.contractPlanning.contracts,
      );
      const activeLogisticsEndpoints = context.contractPlanning.contracts.flatMap(
        ({ execution, state, targetId }) =>
          state === "assigned" || state === "active"
            ? [
                {
                  counterpartId: execution.counterpartId,
                  flowId: execution.version === 3 ? execution.flowId : null,
                  targetId,
                  version: execution.version,
                },
              ]
            : [],
      );
      const activeLogisticsTargetIds = new Set(activeLeasedWorkTargetIds);
      const activeTerminalLogisticsTargetIds = new Set(activeLeasedWorkTargetIds);
      for (const contract of context.contractPlanning.contracts) {
        if (contract.execution.version !== 3) continue;
        activeTerminalLogisticsTargetIds.add(contract.targetId);
        activeTerminalLogisticsTargetIds.add(contract.execution.counterpartId);
      }
      for (const commitment of currentLogistics().contracts.commitments) {
        const request = commitment.request;
        if (request?.execution?.version !== 3 || request.targetId === null) continue;
        activeLogisticsTargetIds.add(request.targetId);
        activeLogisticsTargetIds.add(request.execution.counterpartId);
        activeTerminalLogisticsTargetIds.add(request.targetId);
        activeTerminalLogisticsTargetIds.add(request.execution.counterpartId);
      }
      let owner = initialOwner;
      let changed = false;
      let sourceServiceHandoffChanged = false;
      const planning: LayoutRuntimePlanRecord[] = [];
      const linkEvidence: LinkRoomLayoutEvidence[] = [];
      const maintenanceLayouts: { placements: readonly LayoutPlacement[]; roomName: string }[] = [];
      const migrationInputs: Parameters<ConstructionPlanner["planMigration"]>[0][] = [];
      const activeSpawnClaimIds = projectActiveSpawnClaimIds(context.spawn.broker);
      const proposals = [] as ReturnType<typeof diffOwnedRoomLayout>["proposals"][number][];
      const authorizations: {
        authorized: boolean;
        colonyId: string;
        roomName: string;
      }[] = [];
      const eligibleColonies = [...context.colony.colonies]
        .filter(({ state, visibility }) => state !== "lost" && visibility === "visible")
        .sort((a, b) => a.id.localeCompare(b.id));
      const colonies = selectLayoutPlanningWindow(eligibleColonies, context.tick);
      const cache = getLayoutCompiledCache(input.cacheManager);
      for (const colony of colonies) {
        const room = context.snapshot.rooms.find(({ name }) => name === colony.roomName);
        if (room?.controller?.ownership !== "owned") continue;
        authorizations.push({
          authorized:
            colony.rclPolicy.progression.authorized || isInfrastructureRecoveryAuthorized(colony),
          colonyId: colony.id,
          roomName: room.name,
        });
        if (room.terrain === undefined || room.exits === undefined) {
          planning.push({
            blocker: "invalid-input",
            fingerprint:
              owner.records.find((record) => record.roomName === room.name)?.fingerprint ?? null,
            roomName: room.name,
            status: "degraded",
          });
          continue;
        }
        const priorRecord = owner.records.find((record) => record.roomName === room.name);
        const priorCommitment =
          priorRecord === undefined ? null : commitmentFromRecord(priorRecord);
        const labMigration = currentLabs().migrationRooms.find(
          ({ roomName }) => roomName === room.name,
        );
        const pinnedHandoff = projectPinnedLabHandoffLayout({
          handoffLayoutFingerprint: labMigration?.assignmentHandoff?.layoutFingerprint ?? null,
          record: priorRecord,
          roomName: room.name,
          sourceCount: room.sources.length,
          unlocks: colony.rclPolicy.unlocks,
        });
        if (labMigration?.assignmentHandoff != null && pinnedHandoff === null) {
          planning.push({
            blocker: "policy-unavailable",
            fingerprint: priorCommitment?.fingerprint ?? null,
            roomName: room.name,
            status: "degraded",
          });
          continue;
        }
        const labHandoffPinned = pinnedHandoff !== null;
        const result = labHandoffPinned
          ? Object.freeze({
              candidatesInspected: 0,
              commitment: pinnedHandoff.commitment,
              floodCellsInspected: 0,
              placements: pinnedHandoff.placements,
              status: "complete" as const,
              transformsInspected: 0,
            })
          : planOwnedRoomLayout({
              constructionSites: room.constructionSites,
              controller: room.controller.pos,
              exits: room.exits,
              mineral: room.mineral ?? null,
              policy: colony.rclPolicy,
              priorCommitment,
              ...(priorRecord?.sourceServices === undefined
                ? {}
                : { priorSourceServices: priorRecord.sourceServices }),
              roomName: room.name,
              sourceServiceHandoffAuthorized:
                colony.activeThreat === false &&
                colony.controllerRisk === false &&
                colony.legalWorkforce === true &&
                colony.rclPolicy.protectedSpawnReserve.state === "restored",
              sources: room.sources.map(({ pos }) => pos),
              structures: room.structures ?? [],
              terrain: room.terrain,
              tick: context.tick,
            });
        if (result.status === "degraded") {
          planning.push({
            blocker: result.blocker,
            fingerprint: result.commitment?.fingerprint ?? null,
            roomName: room.name,
            status: "degraded",
          });
          continue;
        }
        const commitment =
          priorCommitment?.fingerprint === result.commitment.fingerprint
            ? priorCommitment
            : result.commitment;
        const priorSourceServices = freshSourceServicePlacements(owner, room.name);
        const sourceServices = labHandoffPinned
          ? priorSourceServices
          : result.placements.filter((placement) => placement.service?.kind === "source-container");
        const sourceServicesChanged =
          !labHandoffPinned &&
          JSON.stringify(priorSourceServices) !== JSON.stringify(sourceServices);
        sourceServiceHandoffChanged ||= sourceServices.some((service) => {
          const sourceId = service.service?.sourceId;
          const prior = priorSourceServices.find(
            (candidate) => candidate.service?.sourceId === sourceId,
          );
          return (
            service.service?.issuerSequence !== undefined &&
            service.service.issuerSequence > (prior?.service?.issuerSequence ?? 1)
          );
        });
        if (priorCommitment?.fingerprint !== commitment.fingerprint || sourceServicesChanged) {
          owner = persistLayoutCommitment(owner, room.name, commitment, result.placements);
          changed = true;
        }
        const observationFingerprint = layoutObservationFingerprint(room);
        const policyFingerprint = stableHash(JSON.stringify(colony.rclPolicy), "layout-policy-v1");
        const placements = cache.getOrCompute(
          { fingerprint: commitment.fingerprint, roomName: room.name },
          {
            dependencies: layoutCacheDependencies({
              algorithmRevision: commitment.algorithmRevision,
              factsRevision: observationFingerprint,
              policyRevision: policyFingerprint,
              terrainRevision: room.terrain.revision,
            }),
            tick: context.tick,
          },
          () => result.placements,
        );
        linkEvidence.push({
          evidence: {
            algorithmRevision: commitment.algorithmRevision,
            controller: room.controller.pos,
            fingerprint: commitment.fingerprint,
            linkPlacements: placements
              .filter(({ structureType }) => structureType === "link")
              .map(({ pos }) => pos),
            sourceServices: placements.flatMap((placement) =>
              placement.service?.kind === "source-container"
                ? [{ pos: placement.pos, sourceId: placement.service.sourceId }]
                : [],
            ),
            storage:
              room.storedStructures.find(
                ({ ownership, structureType }) =>
                  ownership === "owned" && structureType === "storage",
              )?.pos ?? null,
          },
          roomName: room.name,
        });
        maintenanceLayouts.push({ placements, roomName: room.name });
        const convergencePlacements =
          colony.rclPolicy.unlocks === null
            ? placements
            : projectLayoutConvergencePlacements({
                commitment,
                current: placements,
                roomName: room.name,
                sourceCount: room.sources.length,
                sources: room.sources.map(({ pos }) => pos),
                unlocks: colony.rclPolicy.unlocks,
              });
        const terminalWork = currentTerminalWork();
        const industryTerminalWork =
          terminalWork.status === "available"
            ? (terminalWork.rooms.find(({ roomName }) => roomName === room.name) ?? null)
            : null;
        migrationInputs.push({
          activeLeasedWorkTargetIds,
          activeLogisticsEndpoints,
          activeLogisticsFlowIds,
          activeLogisticsTargetIds,
          activeTerminalLogisticsTargetIds,
          ...(activeSpawnClaimIds === null ? {} : { activeSpawnClaimIds }),
          colony,
          commitment,
          containerMigration:
            owner.records.find(({ roomName }) => roomName === room.name)?.containerMigration ??
            null,
          currentPlacements: placements,
          extensionEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.extensionEvacuation ??
            null,
          labEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.labEvacuation ?? null,
          linkEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.linkEvacuation ?? null,
          spawnEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.spawnEvacuation ?? null,
          terminalEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.terminalEvacuation ??
            null,
          towerEvacuation:
            owner.records.find(({ roomName }) => roomName === room.name)?.towerEvacuation ?? null,
          globalOwnedSiteCount: context.snapshot.ownedConstructionSiteCount,
          industryTerminalWork,
          labMigration: labMigration ?? null,
          logisticsEvidenceReady:
            context.contractExecution.status === "ready" &&
            context.contractPlanning.status === "ready",
          observationFingerprint,
          placements: convergencePlacements,
          policyFingerprint,
          removalReceipt:
            owner.records.find(({ roomName }) => roomName === room.name)?.removalReceipt ?? null,
          room,
        });
        if (!labHandoffPinned)
          proposals.push(
            ...diffOwnedRoomLayout({
              colonyId: colony.id,
              commitment,
              commitmentConflicted: false,
              constructionSites: room.constructionSites,
              observationFingerprint,
              placements: convergencePlacements,
              policy: colony.rclPolicy,
              policyEnabled: true,
              policyFingerprint,
              roomName: room.name,
              roomStatus: "owned",
              structures: room.structures ?? [],
            }).proposals,
          );
        planning.push({
          blocker: null,
          fingerprint: commitment.fingerprint,
          roomName: room.name,
          status: "complete",
        });
      }
      const arbitration = arbitrateConstructionSites({
        globalOwnedSiteCount: context.snapshot.ownedConstructionSiteCount,
        limits: CONSTRUCTION_SITE_LIMITS,
        perRoomSiteCounts: context.snapshot.rooms.map((room) => ({
          count: room.constructionSites.filter(({ ownership }) => ownership === "owned").length,
          roomName: room.name,
        })),
        priorReceipts: owner.records.flatMap(({ siteReceipts }) => siteReceipts ?? []),
        progressionAuthorizations: authorizations,
        proposals,
        tick: context.tick,
      });
      return staged(() => {
        draft.arbitration = arbitration;
        draft.changed = changed;
        draft.execution = Object.freeze([]);
        draft.migrationArbitration = null;
        draft.migrationBlockers = Object.freeze([]);
        draft.migrationExecution = Object.freeze([]);
        draft.migrationInputs = Object.freeze(migrationInputs);
        draft.migrationProposals = Object.freeze([]);
        draft.migrationScannedCandidates = 0;
        draft.migrationTruncatedCandidates = 0;
        draft.owner = owner;
        draft.planning = Object.freeze(planning);
        draft.sourceServiceHandoffChanged = sourceServiceHandoffChanged;
        draft.linkEvidence = Object.freeze(linkEvidence);
        draft.maintenanceLayouts = Object.freeze(maintenanceLayouts);
        draft.status = "planned";
        input.runtime.publishLayout(layoutRuntimeResult(draft, 0));
      });
    },
  };
}

export function projectLayoutTerminalSendBlockedRoomNames(
  records: readonly LayoutRecord[],
  tick: number,
): ReadonlySet<string> {
  return new Set(
    records.flatMap(({ labEvacuation, roomName, terminalEvacuation }) =>
      (terminalEvacuation !== undefined &&
        tick > terminalEvacuation.startedAt &&
        tick < terminalEvacuation.expiresAt) ||
      (labEvacuation !== undefined && "destinationStructureType" in labEvacuation)
        ? [roomName]
        : [],
    ),
  );
}

export function projectActiveSpawnClaimIds(
  broker: SpawnBrokerResult | null,
): ReadonlySet<string> | null {
  return broker?.status === "planned"
    ? new Set(broker.selections.map(({ spawnId }) => spawnId))
    : null;
}

export function projectActiveLeaseTargetIds(
  contracts: ContractPlanningView["contracts"],
): ReadonlySet<string> {
  const targetIds = new Set<string>();
  for (const { execution, state, targetId } of contracts) {
    if (state !== "assigned" && state !== "active") continue;
    targetIds.add(targetId);
    if (execution.counterpartId !== null) targetIds.add(execution.counterpartId);
  }
  return targetIds;
}

function layoutMigrationPlanningSystem(
  input: CompositionInput,
  draft: LayoutTickDraft,
  currentLinks: () => LinkRuntimeResult,
  currentAuthorizedSpawnEvacuations: () => ReadonlySet<string>,
  currentLogistics: () => LogisticsRuntimeProjection,
  currentLeaseAgentPlan: () => LeaseAgentPlan,
  publishLeaseAgentPlan: (plan: LeaseAgentPlan) => void,
): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "migration.layout",
      phase: "plan",
      criticality: "economic",
      cadence: 1,
      estimate: 1.5,
      admitInRecovery: false,
      mandatoryTail: false,
    },
    run: ({ context, budget }) => {
      if (draft.status !== "planned" || draft.owner === null) return staged(() => undefined);
      const initialOwner = draft.owner;
      let owner = initialOwner;
      const authorizations: LayoutMigrationAuthorization[] = [];
      const blockers: LayoutMigrationBlockerRecord[] = [];
      const proposals: LayoutMigrationProposal[] = [];
      const authorizedSpawnEvacuations = new Set<string>();
      let scannedCandidates = 0;
      let truncatedCandidates = 0;
      for (const migrationInput of draft.migrationInputs) {
        const linkRuntime =
          currentLinks().rooms.find(({ roomName }) => roomName === migrationInput.room.name) ??
          null;
        const migration = constructionPlanner.planMigration({
          ...migrationInput,
          linkRuntime,
        });
        if (migration.authorization !== null) {
          authorizations.push(migration.authorization);
          if (migration.spawnEvacuation !== null) {
            const flowId = layoutSpawnEvacuationFlowId(
              migrationInput.room.name,
              migration.spawnEvacuation,
            );
            const evacuationCanExecute =
              migration.blockers.length > 0 &&
              migration.blockers.every(
                ({ reason, targetId }) =>
                  targetId === migration.spawnEvacuation?.sourceId &&
                  (reason === "target-stocked" || reason === "evacuation-pending"),
              );
            if (
              flowId !== null &&
              currentAuthorizedSpawnEvacuations().has(flowId) &&
              evacuationCanExecute
            )
              authorizedSpawnEvacuations.add(flowId);
          }
        }
        let migrationOwner = persistLayoutContainerMigration(
          owner,
          migrationInput.room.name,
          migration.containerMigration,
        );
        migrationOwner = persistLayoutExtensionEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.extensionEvacuation,
        );
        migrationOwner = persistLayoutLabEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.labEvacuation,
        );
        migrationOwner = persistLayoutLinkEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.linkEvacuation,
        );
        migrationOwner = persistLayoutSpawnEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.spawnEvacuation,
        );
        migrationOwner = persistLayoutTerminalEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.terminalEvacuation,
        );
        migrationOwner = persistLayoutTowerEvacuation(
          migrationOwner,
          migrationInput.room.name,
          migration.towerEvacuation,
        );
        migrationOwner = persistLayoutRemovalReceipt(
          migrationOwner,
          migrationInput.room.name,
          migration.removalReceipt,
        );
        owner = migrationOwner;
        blockers.push(...migration.blockers);
        proposals.push(...migration.proposals);
        scannedCandidates += migration.scannedCandidates;
        truncatedCandidates += migration.truncatedCandidates;
      }
      const arbitration = arbitrateStructureRemovals({
        authorizations,
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals,
      });
      const spawnFlowContinuation = prepareSpawnEvacuationFlowContinuation({
        authorizedFlowIds: authorizedSpawnEvacuations,
        budget,
        context,
        composition: input,
        currentLeaseAgentPlan,
        logistics: currentLogistics(),
        publishLeaseAgentPlan,
      });
      return staged(
        () => {
          draft.changed ||= owner !== initialOwner;
          draft.migrationArbitration = arbitration;
          draft.migrationBlockers = Object.freeze(blockers);
          draft.migrationExecution = Object.freeze([]);
          draft.migrationProposals = Object.freeze(proposals);
          draft.migrationScannedCandidates = scannedCandidates;
          draft.migrationTruncatedCandidates = truncatedCandidates;
          draft.owner = owner;
          spawnFlowContinuation.commit();
          input.runtime.publishLayout(layoutRuntimeResult(draft, 0));
        },
        () => {
          spawnFlowContinuation.discard();
        },
      );
    },
  };
}

/** Prepares the exact authorized spawn-evacuation continuation inside `migration.layout`. */
function prepareSpawnEvacuationFlowContinuation(input: {
  readonly authorizedFlowIds: ReadonlySet<string>;
  readonly budget: CpuBudget;
  readonly composition: CompositionInput;
  readonly context: TickContext;
  readonly currentLeaseAgentPlan: () => LeaseAgentPlan;
  readonly logistics: LogisticsRuntimeProjection;
  readonly publishLeaseAgentPlan: (plan: LeaseAgentPlan) => void;
}): { readonly commit: () => void; readonly discard: () => void } {
  if (
    !isFeatureEnabled(input.context.config, "phase2.mining") ||
    input.authorizedFlowIds.size === 0
  )
    return { commit: () => undefined, discard: () => undefined };

  const funded = new Set(
    input.context.colony.reservations
      .filter(({ status }) => status === "active")
      .map(({ category, colonyId, issuer }) => `${colonyId}\u0000${category}\u0000${issuer}`),
  );
  const scope = input.composition.contractChannel.openProducer("migration.spawn-flow");
  for (const commitment of input.logistics.contracts.commitments) {
    const request = commitment.request;
    if (
      request !== null &&
      input.authorizedFlowIds.has(commitment.flowId) &&
      funded.has(
        `${request.owner.id}\u0000${request.budgetBinding.category}\u0000${request.budgetBinding.issuer}`,
      )
    )
      scope.producer.submit(request);
  }
  for (const contract of input.context.contractPlanning.contracts) {
    if (
      contract.execution.version === 3 &&
      input.authorizedFlowIds.has(contract.execution.flowId) &&
      contract.issuer.startsWith("logistics/") &&
      (contract.state === "proposed" || contract.state === "suspended") &&
      funded.has(
        `${contract.owner.id}\u0000${contract.budgetBinding.category}\u0000${contract.budgetBinding.issuer}`,
      )
    )
      scope.producer.transition({
        contractId: contract.contractId,
        reason: "logistics-funded",
        tick: input.context.tick,
        to: "funded",
      });
  }
  const stagedRequests = scope.stage();
  const planned = isFeatureEnabled(input.context.config, "phase1.agents")
    ? planLeaseAgents({
        availablePathCpu: localPathSearchAllowance(input.budget),
        execution: spawnEvacuationExecutionView(
          input.context.contractExecution,
          input.authorizedFlowIds,
        ),
        paths: input.context.localPathPlanning,
        snapshot: input.context.snapshot,
        tick: input.context.tick,
      })
    : null;

  return {
    commit: () => {
      stagedRequests.commit();
      if (planned === null) return;
      for (const intent of planned.actions)
        input.composition.movementRuntime.actionProducer.submit(intent);
      for (const intent of planned.movement)
        input.composition.movementRuntime.movementProducer.submit(intent);
      input.publishLeaseAgentPlan(mergeLeaseAgentPlans(input.currentLeaseAgentPlan(), planned));
    },
    discard: () => {
      stagedRequests.discard();
    },
  };
}

export function withoutSuppressedSurvivalTransfers(
  candidates: readonly SurvivalFlowCandidate[],
  suppressedTargetIds: ReadonlySet<string>,
): readonly SurvivalFlowCandidate[] {
  if (suppressedTargetIds.size === 0) return candidates;
  return Object.freeze(
    candidates.filter(
      ({ action, targetId }) => action !== "transfer" || !suppressedTargetIds.has(targetId),
    ),
  );
}

export function orphanedSpawnEvacuationTransition(
  state: ContractPlanningView["contracts"][number]["state"],
): "cancelled" | "failed" | "suspended" {
  if (state === "proposed") return "cancelled";
  if (state === "funded") return "suspended";
  return "failed";
}

export function withoutSuppressedLeaseTargets(
  execution: ContractExecutionView,
  suppressedTargetIds: ReadonlySet<string>,
  allowedFlowIds: ReadonlySet<string> = new Set(),
): ContractExecutionView {
  if (execution.status !== "ready" || suppressedTargetIds.size === 0) return execution;
  return Object.freeze({
    leases: Object.freeze(
      execution.leases.filter(({ execution: terms, targetId }) => {
        if (terms.version === 3 && allowedFlowIds.has(terms.flowId)) return true;
        return (
          !suppressedTargetIds.has(targetId) &&
          (terms.counterpartId === null || !suppressedTargetIds.has(terms.counterpartId))
        );
      }),
    ),
    status: execution.status,
  });
}

function spawnEvacuationExecutionView(
  execution: ContractExecutionView,
  authorizedFlowIds: ReadonlySet<string>,
): ContractExecutionView {
  return Object.freeze({
    leases: Object.freeze(
      execution.leases.filter(
        ({ execution: terms }) => terms.version === 3 && authorizedFlowIds.has(terms.flowId),
      ),
    ),
    status: execution.status,
  });
}

function mergeLeaseAgentPlans(left: LeaseAgentPlan, right: LeaseAgentPlan): LeaseAgentPlan {
  return Object.freeze({
    actions: Object.freeze([...left.actions, ...right.actions]),
    dispositions: Object.freeze([...left.dispositions, ...right.dispositions]),
    movement: Object.freeze([...left.movement, ...right.movement]),
  });
}

function reconcileLayoutDraft(
  draft: LayoutTickDraft,
  tick: number,
): { readonly owner: LayoutsOwnerV19 | null; readonly receiptsWritten: number } {
  if (draft.owner === null) return { owner: null, receiptsWritten: 0 };
  const site = reconcileConstructionSiteExecution(draft.owner, draft.execution, tick);
  const destroy =
    draft.migrationExecution.length === 0
      ? { owner: site.owner, receipts: [] as const }
      : reconcileStructureDestroyExecution(site.owner, draft.migrationExecution, tick);
  return {
    owner: destroy.owner,
    receiptsWritten: site.receipts.length + destroy.receipts.length,
  };
}

function resolveLayoutsOwner(value: unknown): LayoutsOwnerV19 {
  const parsed = parseLayoutsOwner(value);
  if (parsed !== null) return parsed;
  if (value !== null && typeof value === "object" && Object.keys(value).length === 0)
    return emptyLayoutsOwner();
  throw new Error("layouts-owner-invalid");
}
function commitmentFromRecord(record: LayoutsOwnerV19["records"][number]): LayoutCommitment {
  return {
    algorithmRevision: record.algorithmRevision,
    anchor: record.anchor,
    blockers: record.blockers,
    committedAt: record.committedAt,
    fingerprint: record.fingerprint,
    ...(record.serviceBlockers === undefined ? {} : { serviceBlockers: record.serviceBlockers }),
    transform: record.transform,
  };
}
function getLayoutCompiledCache(manager: CacheManager) {
  const existing = layoutCaches.get(manager);
  if (existing !== undefined) return existing;
  const registered = registerLayoutCompiledCache(manager);
  layoutCaches.set(manager, registered);
  return registered;
}
function layoutObservationFingerprint(room: WorldSnapshot["rooms"][number]): string {
  const facts = {
    controller:
      room.controller === null
        ? null
        : { level: room.controller.level, ownership: room.controller.ownership },
    sites: [...room.constructionSites]
      .map(({ id, ownership, pos, structureType }) => ({ id, ownership, pos, structureType }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    structures: [...(room.structures ?? [])]
      .map(({ id, ownership, pos, structureType }) => ({ id, ownership, pos, structureType }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return stableHash(JSON.stringify(facts), "layout-observation-v1");
}
function stableHash(value: string, prefix: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}:${(hash >>> 0).toString(36)}`;
}
function layoutRuntimeResult(draft: LayoutTickDraft, receiptsWritten: number): LayoutRuntimeResult {
  return Object.freeze({
    arbitration: draft.arbitration,
    execution: draft.execution,
    migration: Object.freeze({
      arbitration: draft.migrationArbitration,
      blockers: draft.migrationBlockers,
      execution: draft.migrationExecution,
      proposals: draft.migrationProposals,
      scannedCandidates: draft.migrationScannedCandidates,
      truncatedCandidates: draft.migrationTruncatedCandidates,
    }),
    planning: draft.planning,
    receiptsWritten,
    status: draft.status,
  });
}
function emptyLayoutRuntimeResult(): LayoutRuntimeResult {
  return Object.freeze({
    arbitration: null,
    execution: Object.freeze([]),
    migration: Object.freeze({
      arbitration: null,
      blockers: Object.freeze([]),
      execution: Object.freeze([]),
      proposals: Object.freeze([]),
      scannedCandidates: 0,
      truncatedCandidates: 0,
    }),
    planning: Object.freeze([]),
    receiptsWritten: 0,
    status: "not-run",
  });
}

function reporterSignals(health: readonly SystemHealthRecord[]) {
  return health
    .filter(
      ({ consecutiveFailures, systemId }) =>
        consecutiveFailures > 0 &&
        // A failing tail cannot commit aggregation state; its final report remains authoritative.
        systemId !== "state.reconcile" &&
        systemId !== "telemetry.minimum",
    )
    .map(({ systemId }) => ({
      kind: "fault",
      identity: systemId,
      reasonCode: "unexpected-exception",
    }));
}

function withoutDurableReporterState(telemetry: TickTelemetry): TickTelemetry {
  return Object.freeze({
    ...telemetry,
    recoveryProgress: null,
    reporterTransitions: Object.freeze([]),
  });
}

function colonyDirectorSystem(
  input: CompositionInput,
  spawnDraft: SpawnTickDraft,
  industryDraft: IndustryTickDraft,
  publishCandidates: (
    economy: readonly SurvivalFlowCandidate[],
    maintenance: readonly CriticalMaintenanceCandidate[],
    growth: readonly GrowthCandidate[],
    mining: StaticMiningPlan,
    miningCpuUsed: number,
    logistics: LogisticsRuntimeProjection,
    logisticsCpuUsed: number,
    matureMaintenance: MaintenanceBudgetProjection,
    activeLabEvacuations: ReadonlySet<string>,
    authorizedLabEvacuations: ReadonlySet<string>,
    activeLinkEvacuations: ReadonlySet<string>,
    authorizedLinkEvacuations: ReadonlySet<string>,
    activeSpawnEvacuations: ReadonlySet<string>,
    authorizedSpawnEvacuations: ReadonlySet<string>,
    suppressedSpawnEvacuationTargets: ReadonlySet<string>,
    activeTerminalEvacuations: ReadonlySet<string>,
    authorizedTerminalEvacuations: ReadonlySet<string>,
    suppressedTerminalEvacuationTargets: ReadonlySet<string>,
  ) => void,
): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "colony.director",
      phase: "plan",
      criticality: "mandatory",
      cadence: 1,
      estimate: 1.5,
      admitInRecovery: true,
      mandatoryTail: false,
    },
    run: ({ context, mode, budget }) => {
      input.onPhase?.("plan");
      resetSpawnDraft(spawnDraft);
      const plannedEconomyCandidates = isFeatureEnabled(context.config, "phase1.economy")
        ? planSurvivalFlow(context.snapshot, context.contractExecution, context.contractPlanning)
        : Object.freeze([]);
      const owner = input.manager?.ownerView("colonies") ?? null;
      let economyCandidates = renewSurvivalFlowBudgets(
        plannedEconomyCandidates,
        resolveColoniesOwner(owner).owner?.ledger ?? [],
        context.tick,
        context.config.policy.leases.durationTicks,
        context.config.policy.leases.renewalWindowTicks,
      );
      const maintenanceEnabled = isFeatureEnabled(context.config, "phase1.critical-maintenance");
      const maintenanceCandidates = renewCriticalMaintenanceBudgets(
        maintenanceEnabled
          ? planCriticalMaintenance(context.snapshot, context.config)
          : Object.freeze([]),
        resolveColoniesOwner(owner).owner?.ledger ?? [],
        context.tick,
        context.config.policy.leases.durationTicks,
        context.config.policy.leases.renewalWindowTicks,
      );
      const growthCandidates = renewGrowthBudgets(
        isFeatureEnabled(context.config, "phase1.growth")
          ? planSurvivalGrowth(context.snapshot, context.config)
          : Object.freeze([]),
        resolveColoniesOwner(owner).owner?.ledger ?? [],
        context.tick,
        context.config.policy.leases.durationTicks,
        context.config.policy.leases.renewalWindowTicks,
      );
      let miningCpuUsed = 0;
      let miningPlan = emptyStaticMiningPlan();
      if (isFeatureEnabled(context.config, "phase2.mining")) {
        const startedAt = input.game.cpu.getUsed();
        miningPlan = planStaticMining({
          layouts: staticMiningLayouts(input.manager),
          planning: context.contractPlanning,
          snapshot: context.snapshot,
          tick: context.tick,
        });
        const elapsed = input.game.cpu.getUsed() - startedAt;
        miningCpuUsed = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      }
      let logisticsCpuUsed = 0;
      let logisticsPlan = emptyLogisticsRuntimeProjection();
      const priorLedger = resolveColoniesOwner(owner).owner?.ledger ?? [];
      // Persistent terminal reservations remain safety inputs even when optional layout work is disabled.
      const persistedLayoutRecords =
        parseLayoutsOwner(input.manager?.ownerView("layouts") ?? null)?.records ?? [];
      const layoutRecords =
        isFeatureEnabled(context.config, "phase2.layout") &&
        isFeatureEnabled(context.config, "phase2.logistics") &&
        context.contractExecution.status === "ready" &&
        context.contractPlanning.status === "ready"
          ? persistedLayoutRecords
          : [];
      const terminalSendBlockedRoomNames = projectLayoutTerminalSendBlockedRoomNames(
        persistedLayoutRecords,
        context.tick,
      );
      const industryProjection = isFeatureEnabled(context.config, "phase2.industry")
        ? projectIndustryTickPlan({
            policy: context.config.policy.industry,
            previous: industryDraft.owner.commands,
            snapshot: context.snapshot,
            terminalSendBlockedRoomNames,
            tick: context.tick,
            transactionCost: (amount, sourceRoom, destinationRoom) =>
              input.game.market?.calcTransactionCost(amount, sourceRoom, destinationRoom) ??
              Number.MAX_SAFE_INTEGER,
          })
        : emptyIndustryProjection();
      industryDraft.plan = industryProjection.plan;
      industryDraft.eligiblePlan = industryProjection.eligiblePlan;
      industryDraft.rooms = industryProjection.rooms;
      const terminalSendRoomNames = new Set(
        industryProjection.eligiblePlan.sends.flatMap(({ destinationRoom, sourceRoom }) => [
          destinationRoom,
          sourceRoom,
        ]),
      );
      const layoutContainerMigrations = projectLayoutContainerMigrations({
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const layoutEvacuations = projectLayoutExtensionEvacuations({
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const linkEvacuationTerms = layoutRecords.flatMap((record) => {
        const evacuation = record.linkEvacuation;
        if (evacuation === undefined) return [];
        const id = layoutLinkEvacuationFlowId(record.roomName, evacuation);
        return id === null ? [] : [{ evacuation, id, roomName: record.roomName }];
      });
      const linkEvacuationCandidates = linkEvacuationTerms.flatMap(
        ({ evacuation, id, roomName }) =>
          context.tick <= evacuation.startedAt || context.tick >= evacuation.expiresAt
            ? []
            : [
                {
                  id,
                  replacementId: evacuation.replacementId,
                  roomName,
                  sourceId: evacuation.sourceId,
                },
              ],
      );
      const authorizedLinkEvacuations = new Set(
        validateReserveLinkEvacuationContinuity({
          candidates: linkEvacuationCandidates,
          layouts: directLinkHealthLayouts(context.snapshot, input.manager),
          rooms: context.snapshot.rooms,
          tick: context.tick,
        }),
      );
      const layoutLinkEvacuations = projectLayoutLinkEvacuations({
        authorizedFlowIds: authorizedLinkEvacuations,
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const layoutSpawnEvacuations = projectLayoutSpawnEvacuations({
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const suppressedSpawnEvacuationTargets = new Set(
        layoutSpawnEvacuations.demands.suppressedSinkTargetIds,
      );
      economyCandidates = withoutSuppressedSurvivalTransfers(
        economyCandidates,
        suppressedSpawnEvacuationTargets,
      );
      const layoutTerminalEvacuations = projectLayoutTerminalEvacuations({
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const layoutTowerEvacuations = projectLayoutTowerEvacuations({
        existingBudgets: priorLedger,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const fundedIndustryBudgetIds = new Set(
        priorLedger
          .filter(
            ({ category, status }) =>
              category === "industry" && (status === "active" || status === "pending"),
          )
          .map(({ issuer }) => issuer),
      );
      const labs = isFeatureEnabled(context.config, "phase2.labs")
        ? composeLabRuntime({
            committedLabLayouts:
              isFeatureEnabled(context.config, "phase2.layout") &&
              context.snapshot.ownedRooms.some(({ controller }) => controller.level === 8)
                ? projectCommittedLabLayouts(
                    context.snapshot,
                    parseLayoutsOwner(input.manager?.ownerView("layouts") ?? null),
                  )
                : [],
            fundedBudgetIds: fundedIndustryBudgetIds,
            pendingAttempts: industryDraft.owner.labAttempts,
            policy: context.config.policy.industry,
            previousCommitments: industryDraft.owner.labCommitments,
            reactions: typeof REACTIONS === "undefined" ? {} : REACTIONS,
            reactionTimes: typeof REACTION_TIME === "undefined" ? {} : REACTION_TIME,
            snapshot: context.snapshot,
            snapshotRevision: snapshotRevision(context.snapshot),
            terminalSendRoomNames,
          })
        : emptyLabCompositionProjection();
      industryDraft.labs = labs;
      const layoutLabEvacuations = projectLayoutLabEvacuations({
        existingBudgets: priorLedger,
        migrationRooms: labs.migrationRooms,
        records: layoutRecords,
        snapshot: context.snapshot,
        tick: context.tick,
      });
      const mature =
        isFeatureEnabled(context.config, "phase2.mature") &&
        (mode === "normal" || mode === "surplus") &&
        hasMatureStructure(context.snapshot)
          ? composeMatureInfrastructure({
              fundedBudgetIds: fundedIndustryBudgetIds,
              labDemands: labs.policy.demands,
              mechanics: matureMechanicsInput(),
              pendingAttempts: industryDraft.owner.matureAttempts,
              policy: context.config.policy.industry,
              previousCommitments: industryDraft.owner.matureCommitments,
              snapshot: context.snapshot,
              snapshotRevision: snapshotRevision(context.snapshot),
            })
          : emptyMatureInfrastructureProjection();
      industryDraft.mature = mature;
      industryDraft.observer =
        mature.catalog === null
          ? emptyObserverRuntimeProjection()
          : composeObserverRuntime({
              authorizations: [],
              capabilities: mature.capabilities,
              catalog: mature.catalog,
              pendingAttempts: industryDraft.owner.observerAttempts,
              requests: [],
              snapshot: context.snapshot,
              snapshotRevision: snapshotRevision(context.snapshot),
            });
      if (isFeatureEnabled(context.config, "phase2.logistics")) {
        const startedAt = input.game.cpu.getUsed();
        logisticsPlan = planLogisticsRuntime({
          execution: context.contractExecution,
          includeOptional: mode === "normal" || mode === "surplus",
          planning: context.contractPlanning,
          resourceDemands: mergeResourceDemands(
            labs.resourceDemands,
            mature.resourceDemands,
            layoutContainerMigrations,
            layoutEvacuations.demands,
            layoutLabEvacuations.demands,
            layoutLinkEvacuations.demands,
            layoutSpawnEvacuations.demands,
            layoutTerminalEvacuations.demands,
            layoutTowerEvacuations.demands,
          ),
          snapshot: context.snapshot,
          tick: context.tick,
        });
        const elapsed = input.game.cpu.getUsed() - startedAt;
        logisticsCpuUsed = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      }
      const logistics = renewLogisticsBudgets(
        logisticsPlan,
        resolveColoniesOwner(owner).owner?.ledger ?? [],
      );
      const provisionalMaintenance = projectMaintenanceBudgets({
        existing: resolveColoniesOwner(owner).owner?.ledger ?? [],
        planning: isFeatureEnabled(context.config, "phase2.maintenance")
          ? constructionPlanner.plan({
              layouts: new Map(),
              reserves: context.snapshot.rooms.map((room) => ({
                roomName: room.name,
                state:
                  room.energyAvailable >= context.config.policy.recovery.protectedSpawnEnergy
                    ? "surplus"
                    : "protected",
              })),
              snapshot: context.snapshot,
              traffic: measureMaintenanceTraffic(context.snapshot),
            })
          : Object.freeze({
              deferred: Object.freeze([]),
              deferredCount: 0,
              health: Object.freeze([]),
              proposals: Object.freeze([]),
              scannedStructures: 0,
              truncatedStructures: 0,
            }),
        tick: context.tick,
        ttl: context.config.policy.leases.durationTicks,
      });
      const logisticsActorIds = new Set(
        context.contractExecution.leases.flatMap(({ actorId, execution }) =>
          execution.version === 3 ? [actorId] : [],
        ),
      );
      const logisticsPickupTargetIds = new Set(
        logistics.plan.projections
          .filter(({ admittedAmount, blocker }) => blocker === null && admittedAmount > 0)
          .flatMap(({ sourceNodeId }) => {
            const endpoint = logistics.graph.endpoints.find(
              ({ nodeId }) => nodeId === sourceNodeId,
            );
            return endpoint?.acquireAction === "pickup" && endpoint.targetId !== null
              ? [endpoint.targetId]
              : [];
          }),
      );
      economyCandidates = economyCandidates.filter(
        ({ action, actorId, targetId }) =>
          (action !== "transfer" || !logisticsActorIds.has(actorId)) &&
          (action !== "pickup" || !logisticsPickupTargetIds.has(targetId)),
      );
      const projectedLabEvacuationFlowIds = new Set(
        layoutLabEvacuations.demands.edges.map(({ id }) => id),
      );
      const logisticsExecutableLabEvacuationFlowIds =
        projectedLabEvacuationFlowIds.size === 0
          ? new Set<string>()
          : completeExecutableLayoutLabEvacuationFlowIds({
              executableFlowIds: currentlyExecutableLogisticsFlowIds(
                projectedLabEvacuationFlowIds,
                logistics,
              ),
              projectedFlowIds: projectedLabEvacuationFlowIds,
              records: layoutRecords,
            });
      const executableLinkEvacuationFlowIds = currentlyExecutableLogisticsFlowIds(
        new Set(layoutLinkEvacuations.demands.edges.map(({ id }) => id)),
        logistics,
      );
      const executableSpawnEvacuationFlowIds = currentlyExecutableLogisticsFlowIds(
        new Set(layoutSpawnEvacuations.demands.edges.map(({ id }) => id)),
        logistics,
      );
      const projectedTerminalEvacuationFlowIds = new Set(
        layoutTerminalEvacuations.demands.edges.map(({ id }) => id),
      );
      const logisticsExecutableTerminalEvacuationFlowIds =
        projectedTerminalEvacuationFlowIds.size === 0
          ? new Set<string>()
          : completeExecutableLayoutTerminalEvacuationFlowIds({
              executableFlowIds: currentlyExecutableLogisticsFlowIds(
                projectedTerminalEvacuationFlowIds,
                logistics,
              ),
              projectedFlowIds: projectedTerminalEvacuationFlowIds,
              records: layoutRecords,
            });
      const enabledHealthDomains = new Set(
        [
          ["layout", "phase2.layout"],
          ["mining", "phase2.mining"],
          ["logistics", "phase2.logistics"],
          ["links", "phase2.links"],
          ["maintenance", "phase2.maintenance"],
          ["resources", "phase2.industry"],
          ["labs", "phase2.labs"],
          ["industry", "phase2.mature"],
        ].flatMap(([domain, gate]) =>
          isFeatureEnabled(context.config, gate as Parameters<typeof isFeatureEnabled>[1])
            ? [domain]
            : [],
        ),
      ) as ReadonlySet<ColonyDomainHealthDomain>;
      const domainHealth = deriveRuntimeColonyDomainHealth({
        tick: context.tick,
        enabledDomains: enabledHealthDomains,
        rooms: context.snapshot.rooms,
        layoutRecords:
          parseLayoutsOwner(input.manager?.ownerView("layouts") ?? null)?.records ?? [],
        miningProjections: miningPlan.projections,
        activeHarvestTargetIds: new Set(
          context.contractExecution.leases
            .filter(({ execution }) => execution.action === "harvest")
            .map(({ targetId }) => targetId),
        ),
        logisticsHealth: logistics.health,
        linkHealth: projectLinkDomainHealth({
          layouts: directLinkHealthLayouts(context.snapshot, input.manager),
          rooms: context.snapshot.rooms,
          tick: context.tick,
        }),
        maintenanceHealth: provisionalMaintenance.planning.health,
        resources: industryDraft.rooms.map((room) => ({
          extractorActive: room.extractor?.active === true,
          hasMineral: room.mineral !== null,
          hasStorage: room.storage !== null,
          hasTerminal: room.terminal !== null,
          roomName: room.roomName,
        })),
        labAssignments: labs.assignments,
        mature: {
          catalogAvailable: mature.catalog !== null,
          capabilities: mature.capabilities,
          status: mature.status,
        },
      });
      const budgetRequests = [
        ...economyCandidates.map(({ budgetRequest }) => budgetRequest),
        ...maintenanceCandidates.map(({ budgetRequest }) => budgetRequest),
        ...growthCandidates.map(({ budgetRequest }) => budgetRequest),
        ...miningPlan.projections.flatMap(({ budgetRequest }) =>
          budgetRequest === null ? [] : [budgetRequest],
        ),
        ...logistics.budgets,
        ...layoutContainerMigrations.budgets,
        ...layoutEvacuations.budgets,
        ...layoutLabEvacuations.budgets.filter(({ issuer }) =>
          layoutLabEvacuations.demands.edges.some(
            ({ budgetBinding, id }) =>
              logisticsExecutableLabEvacuationFlowIds.has(id) && budgetBinding?.issuer === issuer,
          ),
        ),
        ...(executableLinkEvacuationFlowIds.size === layoutLinkEvacuations.demands.edges.length
          ? layoutLinkEvacuations.budgets
          : []),
        ...authorizedLayoutSpawnEvacuationBudgets(
          layoutSpawnEvacuations,
          executableSpawnEvacuationFlowIds,
        ),
        ...layoutTerminalEvacuations.budgets.filter(({ issuer }) =>
          layoutTerminalEvacuations.demands.edges.some(
            ({ budgetBinding, id }) =>
              logisticsExecutableTerminalEvacuationFlowIds.has(id) &&
              budgetBinding?.issuer === issuer,
          ),
        ),
        ...layoutTowerEvacuations.budgets,
        ...provisionalMaintenance.budgets,
        ...projectIndustryBudgets(industryProjection.eligiblePlan, context.tick),
        ...projectLabBudgetRequests(labs, context.tick),
        ...mature.policy.budgets,
      ];
      const provisional = colonyDirector.begin({
        tick: context.tick,
        snapshot: context.snapshot,
        config: context.config,
        owner,
        cpuMode: mode,
        cpuBudget: budget,
        requests: budgetRequests,
        population: bindPopulationReservations(input.contractPopulation, owner),
        domainHealth,
      });
      const spawnEnabled = isFeatureEnabled(context.config, "phase1.spawn");
      const brokerResult = spawnEnabled
        ? spawnBroker.arbitrate({
            tick: context.tick,
            snapshot: context.snapshot,
            demands: [
              ...recoverySpawnDemands(
                provisional.result,
                owner,
                context.snapshot,
                context.config,
                context.tick,
              ),
              ...populationSpawnDemands(provisional.result, context.tick),
            ],
            expectations: recoverySpawnExpectations(owner, context.snapshot),
            policy: {
              maximumBodyParts: context.config.policy.spawn.maximumBodyParts,
              maximumBodyEnergy: context.config.policy.spawn.maximumBodyEnergy,
              maximumNonMovePartsPerMovePart:
                context.config.policy.spawn.maximumNonMovePartsPerMovePart,
              nameCollisionRetryLimit: context.config.policy.spawn.nameCollisionRetryLimit,
              retryDelayTicks: context.config.policy.retries.initialDelayTicks,
            },
          })
        : null;
      const selections = brokerResult?.selections ?? [];
      const authorizedSpawnEvacuationFlows = authorizeLayoutSpawnEvacuationFlowIds(
        layoutRecords,
        executableSpawnEvacuationFlowIds,
        new Set(selections.map(({ spawnId }) => spawnId)),
      );
      const authorizedSpawnEvacuationBudgets = authorizedLayoutSpawnEvacuationBudgets(
        layoutSpawnEvacuations,
        authorizedSpawnEvacuationFlows,
      );
      const projectedSpawnEvacuationBudgetIssuers = new Set(
        layoutSpawnEvacuations.budgets.map(({ issuer }) => issuer),
      );
      const authorizedSpawnEvacuationBudgetIssuers = new Set(
        authorizedSpawnEvacuationBudgets.map(({ issuer }) => issuer),
      );
      const exactBudgetRequests = budgetRequests.filter(
        ({ category, issuer }) =>
          category !== "optional-growth" ||
          !projectedSpawnEvacuationBudgetIssuers.has(issuer) ||
          authorizedSpawnEvacuationBudgetIssuers.has(issuer),
      );
      const satisfiedObjectiveIds =
        brokerResult?.decisions
          .filter(
            ({ status, reason }) =>
              status === "satisfied" ||
              reason === "observed-spawning" ||
              reason === "expectation-pending",
          )
          .map(({ demandId }) => demandId) ?? [];
      const hasFundedRecoveryObjective = provisional.result.objectives.some(
        ({ status }) => status === "funded",
      );
      const session =
        spawnEnabled &&
        !hasFundedRecoveryObjective &&
        !selections.some(({ category }) => category === "funded-workforce") &&
        exactBudgetRequests.length === budgetRequests.length
          ? provisional
          : colonyDirector.begin({
              tick: context.tick,
              snapshot: context.snapshot,
              config: context.config,
              owner,
              cpuMode: mode,
              cpuBudget: budget,
              requests: exactBudgetRequests,
              recoverySpawnSelections: selections
                .filter(({ category }) => category === "emergency-recovery")
                .map((selection) => ({
                  objectiveId: selection.demandId,
                  colonyId: selection.colonyId,
                  revision: selection.revision,
                  reservationId: selection.budgetId,
                  energyCost: selection.energyCost,
                  spawn: selection.spawnClaim,
                })),
              populationSpawnSelections: selections
                .filter(({ category }) => category === "funded-workforce")
                .map((selection) => ({
                  objectiveId: selection.demandId,
                  colonyId: selection.colonyId,
                  revision: selection.revision,
                  reservationId: selection.budgetId,
                  energyCost: selection.energyCost,
                  spawn: selection.spawnClaim,
                })),
              satisfiedRecoveryObjectiveIds: satisfiedObjectiveIds,
              population: bindPopulationReservations(input.contractPopulation, owner),
              domainHealth,
            });
      const activeSpawnEvacuationBudgetIssuers = new Set(
        session.result.reservations.flatMap(({ category, issuer, status }) =>
          category === "optional-growth" && status === "active" ? [issuer] : [],
        ),
      );
      const fundedAuthorizedSpawnEvacuationFlows = new Set(
        layoutSpawnEvacuations.demands.edges.flatMap(({ budgetBinding, id }) =>
          authorizedSpawnEvacuationFlows.has(id) &&
          budgetBinding !== undefined &&
          activeSpawnEvacuationBudgetIssuers.has(budgetBinding.issuer)
            ? [id]
            : [],
        ),
      );
      const activeTerminalEvacuationBudgetIssuers = new Set(
        session.result.reservations.flatMap(({ category, issuer, status }) =>
          category === "optional-growth" && status === "active" ? [issuer] : [],
        ),
      );
      const budgetExecutableTerminalEvacuationFlowIds = new Set(
        layoutTerminalEvacuations.demands.edges.flatMap(({ budgetBinding, id }) =>
          logisticsExecutableTerminalEvacuationFlowIds.has(id) &&
          budgetBinding !== undefined &&
          activeTerminalEvacuationBudgetIssuers.has(budgetBinding.issuer)
            ? [id]
            : [],
        ),
      );
      const executableTerminalEvacuationFlowIds = completeExecutableLayoutTerminalEvacuationFlowIds(
        {
          executableFlowIds: budgetExecutableTerminalEvacuationFlowIds,
          projectedFlowIds: projectedTerminalEvacuationFlowIds,
          records: layoutRecords,
        },
      );
      let executableLabEvacuationFlowIds: ReadonlySet<string> =
        logisticsExecutableLabEvacuationFlowIds;
      if (logisticsExecutableLabEvacuationFlowIds.size > 0) {
        const activeLabEvacuationBudgetIssuers = new Set(
          session.result.reservations.flatMap(({ category, issuer, status }) =>
            category === "optional-growth" && status === "active" ? [issuer] : [],
          ),
        );
        const budgetExecutableLabEvacuationFlowIds = new Set(
          layoutLabEvacuations.demands.edges.flatMap(({ budgetBinding, id }) =>
            logisticsExecutableLabEvacuationFlowIds.has(id) &&
            budgetBinding !== undefined &&
            activeLabEvacuationBudgetIssuers.has(budgetBinding.issuer)
              ? [id]
              : [],
          ),
        );
        executableLabEvacuationFlowIds = completeExecutableLayoutLabEvacuationFlowIds({
          executableFlowIds: budgetExecutableLabEvacuationFlowIds,
          projectedFlowIds: projectedLabEvacuationFlowIds,
          records: layoutRecords,
        });
      }
      publishCandidates(
        economyCandidates,
        maintenanceCandidates,
        growthCandidates,
        miningPlan,
        miningCpuUsed,
        logistics,
        logisticsCpuUsed,
        provisionalMaintenance,
        persistedLayoutLabEvacuationFlowIds(input.manager),
        executableLabEvacuationFlowIds,
        persistedLayoutLinkEvacuationFlowIds(input.manager),
        executableLinkEvacuationFlowIds,
        persistedLayoutSpawnEvacuationFlowIds(input.manager),
        fundedAuthorizedSpawnEvacuationFlows,
        suppressedSpawnEvacuationTargets,
        persistedLayoutTerminalEvacuationFlowIds(input.manager),
        executableTerminalEvacuationFlowIds,
        persistedLayoutTerminalEvacuationTargetIds(input.manager, context.tick),
      );
      const intents = authorizedSpawnIntents(session, selections, context.tick);
      spawnDraft.session = session;
      spawnDraft.broker = brokerResult;
      spawnDraft.intents = intents;
      spawnDraft.status = spawnEnabled ? "planned" : "disabled";
      const planningView = colonyPlanningView(session.result);
      const spawnView = spawnRuntimeResult(spawnDraft.status, brokerResult);

      return staged(
        () => {
          input.runtime.publishColony(planningView);
          input.runtime.publishSpawn(spawnView);
        },
        () => {
          resetSpawnDraft(spawnDraft);
          input.runtime.clearColony();
          input.runtime.clearSpawn();
        },
      );
    },
  };
}

function persistedLayoutLabEvacuationFlowIds(manager: MemoryManager | null): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ labEvacuation, roomName }) => {
      if (labEvacuation === undefined) return [];
      return layoutLabEvacuationFlowIds(roomName, labEvacuation) ?? [];
    }),
  );
}

function persistedLayoutSpawnEvacuationFlowIds(manager: MemoryManager | null): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ roomName, spawnEvacuation }) => {
      if (spawnEvacuation === undefined) return [];
      const id = layoutSpawnEvacuationFlowId(roomName, spawnEvacuation);
      return id === null ? [] : [id];
    }),
  );
}

function persistedLayoutTerminalEvacuationFlowIds(
  manager: MemoryManager | null,
): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ roomName, terminalEvacuation }) => {
      if (terminalEvacuation === undefined) return [];
      return layoutTerminalEvacuationFlowIds(roomName, terminalEvacuation) ?? [];
    }),
  );
}

export function isAuthorizedLayoutTerminalEvacuationFlowId(
  flowId: string,
  persistedFlowIds: ReadonlySet<string>,
  authorizedFlowIds: ReadonlySet<string>,
): boolean {
  return !persistedFlowIds.has(flowId) || authorizedFlowIds.has(flowId);
}

function persistedLayoutTerminalEvacuationTargetIds(
  manager: MemoryManager | null,
  tick: number,
): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ terminalEvacuation }) =>
      terminalEvacuation === undefined ||
      tick <= terminalEvacuation.startedAt ||
      tick >= terminalEvacuation.expiresAt
        ? []
        : [terminalEvacuation.sourceId, terminalEvacuation.replacementId],
    ),
  );
}

export function authorizeLayoutSpawnEvacuationFlowIds(
  records: readonly LayoutRecord[],
  executableFlowIds: ReadonlySet<string>,
  selectedSpawnIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    records.flatMap(({ roomName, spawnEvacuation }) => {
      if (
        spawnEvacuation === undefined ||
        selectedSpawnIds.has(spawnEvacuation.sourceId) ||
        selectedSpawnIds.has(spawnEvacuation.replacementId)
      )
        return [];
      const id = layoutSpawnEvacuationFlowId(roomName, spawnEvacuation);
      return id !== null && executableFlowIds.has(id) ? [id] : [];
    }),
  );
}

function persistedLayoutLinkEvacuationFlowIds(manager: MemoryManager | null): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ linkEvacuation, roomName }) => {
      if (linkEvacuation === undefined) return [];
      const id = layoutLinkEvacuationFlowId(roomName, linkEvacuation);
      return id === null ? [] : [id];
    }),
  );
}

function activeLayoutLinkEvacuationIds(manager: MemoryManager | null): ReadonlySet<string> {
  if (manager === null) return new Set();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Set();
  return new Set(
    owner.records.flatMap(({ linkEvacuation }) =>
      linkEvacuation === undefined ? [] : [linkEvacuation.sourceId, linkEvacuation.replacementId],
    ),
  );
}

function staticMiningLayouts(manager: MemoryManager | null) {
  if (manager === null) return new Map<string, readonly LayoutPlacement[]>();
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  if (owner === null) return new Map<string, readonly LayoutPlacement[]>();
  return new Map(
    owner.records.map(({ roomName }) => [roomName, freshSourceServicePlacements(owner, roomName)]),
  );
}

export function projectPinnedLabHandoffLayout(input: {
  readonly handoffLayoutFingerprint: string | null;
  readonly record: LayoutsOwnerV19["records"][number] | undefined;
  readonly roomName: string;
  readonly sourceCount: number;
  readonly unlocks: ColonyRclUnlockAllowances | null;
}): {
  readonly commitment: LayoutCommitment;
  readonly placements: readonly LayoutPlacement[];
} | null {
  if (
    input.record === undefined ||
    input.unlocks === null ||
    input.handoffLayoutFingerprint !== input.record.fingerprint ||
    input.record.roomName !== input.roomName
  )
    return null;
  const commitment = commitmentFromRecord(input.record);
  const placements = reconstructCommittedLayout({
    commitment,
    roomName: input.roomName,
    sourceCount: input.sourceCount,
    unlocks: input.unlocks,
  });
  return placements === null ? null : Object.freeze({ commitment, placements });
}

export function projectCommittedLabLayouts(
  snapshot: WorldSnapshot,
  owner: LayoutsOwnerV19 | null,
): readonly CommittedLabLayout[] {
  const unlocks = COLONY_RCL_POLICY_TABLE.find(({ level }) => level === 8)?.unlocks;
  if (
    owner === null ||
    unlocks === undefined ||
    owner.records.length > 64 ||
    snapshot.rooms.length > 64
  )
    return Object.freeze([]);
  const layouts = [...snapshot.rooms]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((room): readonly CommittedLabLayout[] => {
      if (room.controller?.ownership !== "owned" || room.controller.level !== 8) return [];
      const records = owner.records.filter(({ roomName }) => roomName === room.name);
      const record = records[0];
      if (records.length !== 1 || record === undefined) return [];
      const placements = reconstructCommittedLayout({
        commitment: commitmentFromRecord(record),
        roomName: room.name,
        sourceCount: room.sources.length,
        unlocks,
      });
      if (placements === null) return [];
      const labPositions = placements
        .filter(({ layer, structureType }) => layer === "primary" && structureType === "lab")
        .map(({ pos }) => Object.freeze({ ...pos }))
        .sort(
          (left, right) =>
            left.y - right.y || left.x - right.x || left.roomName.localeCompare(right.roomName),
        );
      if (
        labPositions.length !== unlocks.labs ||
        new Set(labPositions.map(({ roomName, x, y }) => `${roomName}:${String(x)}:${String(y)}`))
          .size !== labPositions.length
      )
        return [];
      return [
        Object.freeze({
          labPositions: Object.freeze(labPositions),
          layoutFingerprint: record.fingerprint,
          roomName: room.name,
        }),
      ];
    });
  return Object.freeze(layouts.slice(0, 64));
}

function directLinkHealthLayouts(
  snapshot: WorldSnapshot,
  manager: MemoryManager | null,
): readonly LinkRoomLayoutEvidence[] {
  if (manager === null) return [];
  const owner = parseLayoutsOwner(manager.ownerView("layouts"));
  const unlocks = COLONY_RCL_POLICY_TABLE.find(({ level }) => level === 8)?.unlocks;
  if (owner === null || unlocks === undefined) return [];
  return snapshot.rooms.flatMap((room): readonly LinkRoomLayoutEvidence[] => {
    if (room.controller?.ownership !== "owned" || room.controller.level !== 8) return [];
    const records = owner.records.filter(({ roomName }) => roomName === room.name);
    const record = records[0];
    if (records.length !== 1 || record === undefined) return [];
    const placements = reconstructCommittedLayout({
      commitment: commitmentFromRecord(record),
      roomName: room.name,
      sourceCount: room.sources.length,
      unlocks,
    });
    if (placements === null) return [];
    return [
      {
        evidence: {
          algorithmRevision: record.algorithmRevision,
          controller: room.controller.pos,
          fingerprint: record.fingerprint,
          linkPlacements: placements
            .filter(({ structureType }) => structureType === "link")
            .map(({ pos }) => pos),
          sourceServices: freshSourceServicePlacements(owner, room.name).flatMap((placement) =>
            placement.service?.kind === "source-container"
              ? [{ pos: placement.pos, sourceId: placement.service.sourceId }]
              : [],
          ),
          storage:
            room.storedStructures.find(
              ({ ownership, structureType }) =>
                ownership === "owned" && structureType === "storage",
            )?.pos ?? null,
        },
        roomName: room.name,
      },
    ];
  });
}

function industryPublicationSystem(
  input: CompositionInput,
  draft: IndustryTickDraft,
): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "industry.publish",
      phase: "plan",
      criticality: "economic",
      cadence: 1,
      estimate: 0.5,
      admitInRecovery: false,
      mandatoryTail: false,
    },
    run: ({ context }) => {
      if (!isFeatureEnabled(context.config, "phase2.industry")) return staged(() => undefined);
      const authorized = authorizeIndustryWork({
        plan: draft.eligiblePlan,
        reservations: context.colony.reservations,
        rooms: draft.rooms,
        tick: context.tick,
      });
      const terminalIds = new Map(
        context.snapshot.ownedRooms.flatMap((room) => {
          const terminal = room.ownedTerminals?.[0];
          return terminal === undefined ? [] : [[room.name, terminal.id] as const];
        }),
      );
      const terminalIntents = projectTerminalSendIntents({
        plan: draft.eligiblePlan,
        reservations: context.colony.reservations,
        terminalIds,
        tick: context.tick,
      });
      const terminalWork = projectIndustryTerminalWork({
        plan: draft.plan,
        previous: draft.states,
        roomNames: context.snapshot.ownedRooms.map(({ name }) => name),
      });
      const contracts = input.contractChannel.openProducer("industry.contracts");
      for (const request of authorized.extractionContracts) contracts.producer.submit(request);
      const stagedContracts = contracts.stage();
      const intents = input.intentChannel.openProducer("industry.terminals");
      const currentSnapshotRevision = snapshotRevision(context.snapshot);
      for (const intent of terminalIntents)
        intents.producer.submit(
          Object.freeze({ ...intent, snapshotRevision: currentSnapshotRevision }),
        );
      for (const intent of draft.labs.intents) intents.producer.submit(intent);
      for (const intent of draft.mature.intents) intents.producer.submit(intent);
      for (const intent of draft.observer.arbitration.intents) intents.producer.submit(intent);
      const stagedIntents = intents.stage();
      return staged(
        () => {
          stagedContracts.commit();
          stagedIntents.commit();
          draft.terminalWork = terminalWork;
        },
        () => {
          stagedContracts.discard();
          stagedIntents.discard();
        },
      );
    },
  };
}

export interface IndustryTickProjection {
  readonly eligiblePlan: IndustryPlan;
  readonly plan: IndustryPlan;
  readonly rooms: readonly IndustryRoomState[];
}

export function projectIndustryTickPlan(input: {
  readonly policy: RuntimeConfig["policy"]["industry"];
  readonly previous: readonly IndustryCommandState[];
  readonly snapshot: WorldSnapshot;
  readonly terminalSendBlockedRoomNames?: ReadonlySet<string>;
  readonly tick: number;
  readonly transactionCost: (amount: number, sourceRoom: string, destinationRoom: string) => number;
}): IndustryTickProjection {
  const resourceTypes = Object.freeze(
    [
      ...new Set(input.snapshot.ownedRooms.flatMap((room) => room.mineral?.mineralType ?? [])),
    ].sort(),
  );
  const policies = input.snapshot.ownedRooms.map((room) => ({
    bands: resourceTypes.map((resourceType) => ({
      resourceType,
      min: input.policy.stockMinimum,
      target: input.policy.stockTarget,
      max: input.policy.stockMaximum,
    })),
    commitments:
      room.mineral === null || room.mineral === undefined
        ? []
        : [
            {
              amount: 0,
              fundedAmount: input.policy.stockTarget,
              id: `stock/${room.name}/${room.mineral.mineralType}`,
              resourceType: room.mineral.mineralType,
            },
          ],
    protectedEnergy: input.policy.protectedTerminalEnergy,
    roomName: room.name,
  }));
  const rooms = observeIndustryRooms(input.snapshot, policies);
  const plan = industryDirector.plan({
    limits: {
      maxExtractionProposals: input.policy.maximumExtractionProposalsPerTick,
      maxRoomsScanned: input.policy.maximumRoomsPerTick,
      maxSendProposals: input.policy.maximumSendProposalsPerTick,
      maxSendRequestsScanned: Math.max(
        input.policy.maximumSendProposalsPerTick,
        input.policy.maximumRoomsPerTick * input.policy.maximumRoomsPerTick,
      ),
    },
    requests: industrySendRequests(rooms, resourceTypes, input.policy, input.tick),
    rooms,
    ...(input.terminalSendBlockedRoomNames === undefined
      ? {}
      : { terminalSendBlockedRoomNames: input.terminalSendBlockedRoomNames }),
    tick: input.tick,
    transactionCost: (amount, sourceRoom, destinationRoom) => {
      const cost = input.transactionCost(amount, sourceRoom, destinationRoom);
      return Number.isSafeInteger(cost) &&
        cost >= 0 &&
        cost <= input.policy.maximumTransactionEnergyPerSend
        ? cost
        : Number.MAX_SAFE_INTEGER;
    },
  });
  const eligible = new Set(
    eligibleIndustrySendIds(
      plan.sends.map(({ identity }) => identity),
      input.previous,
      input.tick,
    ),
  );
  return Object.freeze({
    eligiblePlan: Object.freeze({
      ...plan,
      sends: Object.freeze(plan.sends.filter(({ identity }) => eligible.has(identity))),
    }),
    plan,
    rooms,
  });
}

function industrySendRequests(
  rooms: readonly IndustryRoomState[],
  resourceTypes: readonly string[],
  policy: RuntimeConfig["policy"]["industry"],
  tick: number,
): readonly InternalSendRequest[] {
  const requests: InternalSendRequest[] = [];
  for (const resourceType of resourceTypes) {
    const donors = rooms
      .filter((room) => industryRoomStock(room, resourceType) > policy.stockTarget)
      .sort((a, b) => a.roomName.localeCompare(b.roomName));
    const destinations = rooms
      .filter((room) => industryRoomStock(room, resourceType) < policy.stockMinimum)
      .sort((a, b) => a.roomName.localeCompare(b.roomName));
    for (const destination of destinations) {
      const destinationStock = industryRoomStock(destination, resourceType);
      for (const donor of donors) {
        if (donor.roomName === destination.roomName) continue;
        requests.push({
          amount: Math.min(policy.maximumResourcePerSend, policy.stockTarget - destinationStock),
          deadline: safeAddTick(tick, 20),
          destinationRoom: destination.roomName,
          id: `rebalance/${donor.roomName}/${destination.roomName}/${resourceType}/${String(destinationStock)}`,
          resourceType,
          sourceRoom: donor.roomName,
        });
      }
    }
  }
  return Object.freeze(requests);
}

function industryRoomStock(room: IndustryRoomState, resourceType: string): number {
  return [room.storage, room.terminal].reduce(
    (total, store) =>
      total + (store?.stocks.find((stock) => stock.resourceType === resourceType)?.amount ?? 0),
    0,
  );
}

function hasMatureStructure(snapshot: WorldSnapshot): boolean {
  return snapshot.ownedRooms.some(
    (room) =>
      (room.ownedFactories?.length ?? 0) > 0 ||
      (room.ownedNukers?.length ?? 0) > 0 ||
      (room.ownedObservers?.length ?? 0) > 0 ||
      (room.ownedPowerSpawns?.length ?? 0) > 0,
  );
}

function mergeResourceDemands(
  ...projections: readonly LogisticsResourceDemandProjection[]
): LogisticsResourceDemandProjection {
  return Object.freeze({
    blockers: Object.freeze(projections.flatMap(({ blockers }) => blockers ?? [])),
    dispositions: Object.freeze(projections.flatMap(({ dispositions }) => dispositions ?? [])),
    edges: Object.freeze(
      projections
        .flatMap(({ edges }) => edges)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    endpoints: Object.freeze(
      projections
        .flatMap(({ endpoints }) => endpoints)
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    ),
    nodes: Object.freeze(
      projections
        .flatMap(({ nodes }) => nodes)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    suppressedSinkTargetIds: Object.freeze(
      projections
        .flatMap(({ suppressedSinkTargetIds }) => suppressedSinkTargetIds ?? [])
        .sort((left, right) => left.localeCompare(right)),
    ),
    suppressedSourceTargetIds: Object.freeze(
      projections
        .flatMap(({ suppressedSourceTargetIds }) => suppressedSourceTargetIds ?? [])
        .sort((left, right) => left.localeCompare(right)),
    ),
  });
}

function matureMechanicsInput(): MatureMechanicsInput {
  return Object.freeze({
    commodities: typeof COMMODITIES === "undefined" ? null : COMMODITIES,
    constants: Object.freeze({
      factoryCapacity: typeof FACTORY_CAPACITY === "undefined" ? null : FACTORY_CAPACITY,
      nukerCooldown: typeof NUKER_COOLDOWN === "undefined" ? null : NUKER_COOLDOWN,
      nukerEnergyCapacity:
        typeof NUKER_ENERGY_CAPACITY === "undefined" ? null : NUKER_ENERGY_CAPACITY,
      nukerGhodiumCapacity:
        typeof NUKER_GHODIUM_CAPACITY === "undefined" ? null : NUKER_GHODIUM_CAPACITY,
      nukerRange: typeof NUKE_RANGE === "undefined" ? null : NUKE_RANGE,
      observerRange: typeof OBSERVER_RANGE === "undefined" ? null : OBSERVER_RANGE,
      operateFactoryPower: typeof PWR_OPERATE_FACTORY === "undefined" ? null : PWR_OPERATE_FACTORY,
      operateObserverPower:
        typeof PWR_OPERATE_OBSERVER === "undefined" ? null : PWR_OPERATE_OBSERVER,
      operatePowerEffects:
        typeof POWER_INFO === "undefined" || typeof PWR_OPERATE_POWER === "undefined"
          ? null
          : POWER_INFO[PWR_OPERATE_POWER].effect,
      operatePowerPower: typeof PWR_OPERATE_POWER === "undefined" ? null : PWR_OPERATE_POWER,
      powerSpawnEnergyCapacity:
        typeof POWER_SPAWN_ENERGY_CAPACITY === "undefined" ? null : POWER_SPAWN_ENERGY_CAPACITY,
      powerSpawnEnergyPerPower:
        typeof POWER_SPAWN_ENERGY_RATIO === "undefined" ? null : POWER_SPAWN_ENERGY_RATIO,
      powerSpawnPowerCapacity:
        typeof POWER_SPAWN_POWER_CAPACITY === "undefined" ? null : POWER_SPAWN_POWER_CAPACITY,
    }),
    resourceTypes: typeof RESOURCES_ALL === "undefined" ? [] : RESOURCES_ALL,
  });
}

function matureCatalogFromGlobals(config: RuntimeConfig) {
  const mechanics = matureMechanicsInput();
  const limits = config.policy.industry.mature;
  const result = normalizeMatureMechanics({
    commodities: mechanics.commodities,
    constants: mechanics.constants,
    limits: {
      maximumCommodities: limits.maximumCommodities,
      maximumComponentsPerCommodity: limits.maximumComponentsPerCommodity,
      maximumResourceTypes: limits.maximumResourceTypes,
      maximumStringLength: limits.maximumStringLength,
    },
    resourceTypes: mechanics.resourceTypes,
  });
  return result.status === "ready" ? result.catalog : null;
}

function industryOwnerForPolicy(
  value: unknown,
  policySourceVersion: string,
): { readonly needsPersistence: boolean; readonly owner: IndustryOwnerV5 } {
  const parsed = parseIndustryOwner(value);
  if (parsed !== null && parsed.policySourceVersion === policySourceVersion)
    return Object.freeze({ needsPersistence: false, owner: parsed });
  const migrated = migrateIndustryOwner(value);
  if (migrated !== null && migrated.policySourceVersion === policySourceVersion)
    return Object.freeze({ needsPersistence: parsed === null, owner: migrated });
  const owner = Object.freeze({ ...emptyIndustryOwner(), policySourceVersion });
  return Object.freeze({ needsPersistence: false, owner });
}

function emptyIndustryProjection(): IndustryTickProjection {
  return Object.freeze({
    eligiblePlan: emptyIndustryPlan(),
    plan: emptyIndustryPlan(),
    rooms: Object.freeze([]),
  });
}

function emptyIndustryPlan(): IndustryPlan {
  return Object.freeze({
    accounting: Object.freeze({
      consumed: 0,
      hauled: 0,
      mined: 0,
      reserved: 0,
      sent: 0,
      transactionEnergy: 0,
      unmet: 0,
    }),
    deferrals: Object.freeze([]),
    extraction: Object.freeze([]),
    scannedRooms: 0,
    scannedSendRequests: 0,
    sends: Object.freeze([]),
  });
}

function staticMiningObservations(
  context: TickContext,
  plan: StaticMiningPlan,
): readonly StaticMiningSourceObservation[] {
  const executed = new Set(
    context.movement.actionExecution
      .filter(({ intent, status }) => status === "executed" && intent.kind === "harvest")
      .map(({ intent }) => intent.targetId),
  );
  const leased = new Set(
    context.contractExecution.leases
      .filter(({ execution }) => execution.action === "harvest")
      .map(({ targetId }) => targetId),
  );
  const pending = new Set(
    context.contractPlanning.contracts
      .filter(
        ({ execution, issuer }) => execution.action === "harvest" && issuer.startsWith("mining/"),
      )
      .map(({ targetId }) => targetId),
  );
  return Object.freeze(
    plan.projections.flatMap((projection): readonly StaticMiningSourceObservation[] => {
      const room = context.snapshot.rooms.find(({ name }) => name === projection.colonyId);
      const source = room?.sources.find(({ id }) => id === projection.sourceId);
      if (room === undefined || source === undefined) return [];
      const position = projection.workPosition;
      const container =
        position === null
          ? null
          : (room.storedStructures.find(
              ({ pos, structureType }) =>
                structureType === "container" && pos.x === position.x && pos.y === position.y,
            ) ?? null);
      const minerState = executed.has(source.id)
        ? "active"
        : leased.has(source.id)
          ? "idle"
          : pending.has(source.id)
            ? "replacement-pending"
            : "missing";
      return [
        Object.freeze({
          sourceId: source.id,
          energy: source.energy,
          energyCapacity: source.energyCapacity,
          ticksToRegeneration: source.ticksToRegeneration,
          minerState,
          container:
            container === null
              ? null
              : Object.freeze({
                  capacity: container.store.capacity ?? container.store.usedCapacity,
                  used: container.store.usedCapacity,
                  ticksToDecay: container.ticksToDecay ?? null,
                }),
        }),
      ];
    }),
  );
}

function logisticsObservations(
  context: TickContext,
  runtime: LogisticsRuntimeProjection,
): readonly LogisticsFlowObservation[] {
  const commitments = new Map(
    runtime.contracts.commitments.map((commitment) => [commitment.flowId, commitment]),
  );
  const nodes = new Map(runtime.graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(runtime.graph.edges.map((edge) => [edge.id, edge]));
  return Object.freeze(
    runtime.plan.projections.map((projection): LogisticsFlowObservation => {
      const commitment = commitments.get(projection.id);
      const source = nodes.get(projection.sourceNodeId);
      const sink = nodes.get(projection.sinkNodeId);
      const edge = edges.get(projection.id);
      const requested = Math.max(
        0,
        Math.min(
          source?.observedAmount ?? 0,
          sink?.freeCapacity ?? 0,
          edge?.maximumAmount ?? Number.MAX_SAFE_INTEGER,
        ),
      );
      const activeContract = context.contractPlanning.contracts.find(
        ({ execution, state }) =>
          state === "active" && execution.version === 3 && execution.flowId === projection.id,
      );
      const loss = commitment === undefined || commitment.cycle === 0 ? 0 : commitment.cycleAmount;
      return Object.freeze({
        flowId: projection.id,
        contractId: commitment?.request?.issuer ?? activeContract?.issuer ?? null,
        requested,
        scheduled: commitment?.reservedAmount ?? projection.admittedAmount,
        pickedUp:
          (commitment?.deliveredAmount ?? 0) +
          (commitment?.stage === "deliver"
            ? commitment.reservedAmount - commitment.deliveredAmount
            : 0) +
          loss,
        delivered: commitment?.deliveredAmount ?? 0,
        loss,
        firstRequestedAt: commitment?.stageStartedAt ?? context.tick,
        active: commitment?.request != null || activeContract !== undefined,
      });
    }),
  );
}

function defenseSafetySystem(input: CompositionInput): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "defense.plan",
      phase: "safety",
      criticality: "mandatory",
      cadence: 1,
      estimate: 0.5,
      admitInRecovery: true,
      mandatoryTail: false,
    },
    run: ({ context }) => {
      input.onPhase?.("safety");
      if (!isFeatureEnabled(context.config, "phase1.safety")) return staged(() => undefined);
      const scope = input.intentChannel.openProducer("defense.plan");
      for (const intent of planDefense(context.snapshot, context.config))
        scope.producer.submit(intent);
      const stagedIntents = scope.stage();
      return staged(
        () => {
          stagedIntents.commit();
        },
        () => {
          stagedIntents.discard();
        },
      );
    },
  };
}

function spawnSettleSystem(
  input: CompositionInput,
  spawnDraft: SpawnTickDraft,
): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "spawn.settle",
      phase: "execute",
      criticality: "mandatory",
      cadence: 1,
      estimate: 0.75,
      admitInRecovery: true,
      mandatoryTail: true,
    },
    run: ({ context }) => {
      const settled = settleSpawnDraft(spawnDraft, context.tick);
      return staged(
        () => {
          if (settled?.replacementOwner !== null && settled?.replacementOwner !== undefined) {
            if (input.manager === null) {
              throw new Error("colony owner replacement requires a ready Memory manager");
            }
            const transaction = input.manager.transaction("colonies");
            transaction.replace(settled.replacementOwner);
            const stagedResult = transaction.stage();
            if (!stagedResult.staged) {
              throw new Error(stagedResult.fault?.message ?? "colony state staging failed");
            }
          }
          spawnDraft.settlementStaged = settled !== null;
          if (settled !== null) {
            input.runtime.publishColony(colonyPlanningView(settled));
          }
          input.runtime.publishSpawn(
            spawnRuntimeResult(spawnDraft.status, spawnDraft.broker, spawnDraft.execution ?? []),
          );
        },
        () => {
          input.manager?.discard("colonies");
          spawnDraft.settlementStaged = false;
          input.runtime.clearColony();
          input.runtime.clearSpawn();
        },
      );
    },
  };
}

function colonyPlanningView(result: ReturnType<ColonyDirector["plan"]>): ColonyPlanningResult {
  return Object.freeze({
    status: result.status,
    reasonCode: result.reasonCode,
    ownerRevision: result.ownerRevision,
    colonies: result.colonies,
    objectives: result.objectives,
    decisions: result.decisions,
    reservations: result.reservations,
    transitions: result.transitions,
    totals: result.totals,
  });
}

function recoverySpawnDemands(
  colony: ColonyPlanningResult,
  ownerValue: unknown,
  snapshot: WorldSnapshot,
  config: RuntimeConfig,
  tick: number,
): readonly SpawnDemand[] {
  if (colony.status !== "planned") {
    return [];
  }
  const owner = resolveColoniesOwner(ownerValue).owner;
  const demands: SpawnDemand[] = [];
  for (const objective of colony.objectives) {
    if (objective.status !== "funded" || objective.reservationId === null) {
      continue;
    }
    const reservation = colony.reservations.find(
      ({ reservationId }) => reservationId === objective.reservationId,
    );
    if (reservation === undefined || reservation.grant.energy < 200) {
      continue;
    }
    const colonyRevision = colony.colonies.find(({ id }) => id === objective.colonyId)?.revision;
    if (colonyRevision === undefined) {
      throw new Error("funded recovery objective has no visible colony revision");
    }
    const binding = recoverySpawnDemandBinding(objective, colonyRevision, ownerValue);
    const failed = owner?.ledger.find(
      (entry) =>
        entry.issuer === objective.id &&
        entry.request.spawn !== null &&
        entry.status === "released" &&
        !entry.consumed.spawn,
    );
    const earliestTick =
      failed === undefined
        ? tick
        : Math.max(tick, safeAddTick(failed.updatedAt, config.policy.retries.initialDelayTicks));
    const deadline = Math.max(earliestTick, safeAddTick(tick, config.policy.leases.durationTicks));
    demands.push({
      id: objective.id,
      issuer: objective.id,
      colonyId: objective.colonyId,
      revision: binding.revision,
      category: "emergency-recovery",
      priorityValue: 1_000,
      deadline,
      earliestTick,
      destinationRoomName: objective.colonyId,
      replacementCreepName: recoveryReplacementCreepName(
        snapshot,
        owner,
        objective.id,
        objective.colonyId,
        config,
      ),
      budgetId: binding.reservationId,
      requiredPartCounts: {
        tough: 0,
        work: objective.demand.work,
        carry: objective.demand.carry,
        attack: 0,
        ranged_attack: 0,
        heal: 0,
        claim: 0,
        move: objective.demand.move,
      },
      energyCap: Math.min(
        reservation.grant.energy,
        config.policy.recovery.emergencyWorkerEnergyBudget,
        config.policy.spawn.maximumBodyEnergy,
      ),
      nameBasis: null,
    });
  }
  return Object.freeze(demands);
}

function readContractPopulation(manager: MemoryManager | null): ContractPopulationView {
  if (manager === null) return Object.freeze({ loads: Object.freeze([]), status: "unavailable" });
  const opened = ContractLedger.open(manager.ownerView("contracts"));
  if (opened.status !== "ready")
    return Object.freeze({ loads: Object.freeze([]), status: "unavailable" });
  return opened.ledger.populationView();
}

function bindPopulationReservations(
  population: ContractPopulationView,
  ownerValue: unknown,
): ContractPopulationView {
  if (population.status !== "ready") return population;
  const owner = resolveColoniesOwner(ownerValue).owner;
  if (owner === null) return Object.freeze({ loads: Object.freeze([]), status: "unavailable" });
  const loads = population.loads.flatMap((load) => {
    const reservation = owner.ledger.find(
      (entry) =>
        entry.colonyId === load.colonyId &&
        entry.category === load.category &&
        entry.issuer === load.objectiveId &&
        entry.status === "active",
    );
    return reservation === undefined
      ? []
      : [{ ...load, reservationId: reservation.reservationId, revision: reservation.revision }];
  });
  return Object.freeze({ loads: Object.freeze(loads), status: "ready" });
}

function populationSpawnDemands(
  colony: ColonyPlanningResult,
  tick: number,
): readonly SpawnDemand[] {
  return Object.freeze(
    colony.colonies.flatMap(({ populationPolicy }) =>
      populationPolicy.demands.map((demand) => {
        const binding = populationSpawnDemandBinding(demand);
        return {
          id: demand.id,
          issuer: demand.objectiveId,
          colonyId: demand.colonyId,
          revision: binding.revision,
          category: "funded-workforce" as const,
          priorityValue: Math.max(0, 1_000 - BUDGET_CATEGORIES.indexOf(demand.category) * 100),
          deadline: safeAddTick(tick, 50),
          earliestTick: tick,
          destinationRoomName: demand.colonyId,
          replacementCreepName: null,
          budgetId: binding.reservationId,
          requiredPartCounts: {
            tough: demand.requiredCapability.tough,
            work: demand.requiredCapability.work,
            carry: demand.requiredCapability.carry,
            attack: demand.requiredCapability.attack,
            ranged_attack: demand.requiredCapability.rangedAttack,
            heal: demand.requiredCapability.heal,
            claim: demand.requiredCapability.claim,
            move: demand.requiredCapability.move,
          },
          energyCap: demand.energyCap,
          nameBasis: null,
        };
      }),
    ),
  );
}

function recoverySpawnExpectations(
  ownerValue: unknown,
  snapshot: WorldSnapshot,
): readonly SpawnExpectation[] {
  const owner = resolveColoniesOwner(ownerValue).owner;
  if (owner === null) {
    return [];
  }
  const expectationEntries = owner.ledger.filter(
    (entry) =>
      entry.category === "emergency-spawn" && entry.request.spawn !== null && entry.consumed.spawn,
  );
  const candidateNamesByReservation = new Map(
    expectationEntries.map((entry) => [
      entry.reservationId,
      generatedSpawnCreepNameCandidates({
        id: entry.issuer,
        issuer: entry.issuer,
        colonyId: entry.colonyId,
        revision: entry.revision,
        category: "emergency-recovery",
      }),
    ]),
  );
  const candidateNames = new Set([...candidateNamesByReservation.values()].flat());
  const observedNames = new Set<string>();
  for (const room of snapshot.rooms) {
    for (const creep of room.ownedCreeps) {
      if (candidateNames.has(creep.name)) {
        observedNames.add(creep.name);
      }
    }
    for (const spawn of room.ownedSpawns) {
      if (spawn.spawning !== null && candidateNames.has(spawn.spawning.creepName)) {
        observedNames.add(spawn.spawning.creepName);
      }
    }
  }
  return Object.freeze(
    expectationEntries
      .map((entry) => {
        const spawn = entry.request.spawn;
        if (spawn === null) {
          throw new Error("filtered recovery expectation lost its spawn interval");
        }
        const nameCandidates = candidateNamesByReservation.get(entry.reservationId);
        if (nameCandidates === undefined) {
          throw new Error("recovery expectation lost its bounded name candidates");
        }
        const observedName = nameCandidates.find((name) => observedNames.has(name));
        return Object.freeze({
          demandId: entry.issuer,
          revision: entry.revision,
          spawnId: spawn.spawnId,
          creepName: observedName ?? nameCandidates[0],
          scheduledAt: spawn.startTick,
          expectedReadyAt: spawn.endTick,
          retryAt: Math.max(spawn.endTick, entry.request.expiresAt),
        });
      })
      .sort(
        (left, right) =>
          left.scheduledAt - right.scheduledAt ||
          (left.demandId < right.demandId ? -1 : left.demandId > right.demandId ? 1 : 0),
      ),
  );
}

function recoveryReplacementCreepName(
  snapshot: WorldSnapshot,
  owner: ReturnType<typeof resolveColoniesOwner>["owner"],
  objectiveId: string,
  colonyId: string,
  config: RuntimeConfig,
): string | null {
  const room = snapshot.rooms.find(({ name }) => name === colonyId);
  if (room === undefined) {
    return null;
  }
  const replacementLeadTicks =
    3 * CREEP_SPAWN_TICKS_PER_PART + config.policy.spawn.replacementSafetyMarginTicks;
  const expiringWorkers = room.ownedCreeps
    .filter(
      (creep) =>
        !creep.spawning &&
        creep.body.work.active >= 1 &&
        creep.body.carry.active >= 1 &&
        creep.body.move.active >= 1 &&
        creep.ticksToLive !== null &&
        creep.ticksToLive <= replacementLeadTicks,
    )
    .sort((left, right) => {
      const leftTtl = left.ticksToLive ?? -1;
      const rightTtl = right.ticksToLive ?? -1;
      if (leftTtl !== rightTtl) {
        return rightTtl - leftTtl;
      }
      if (left.name !== right.name) {
        return left.name < right.name ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const previousSuccessful = owner?.ledger.find(
    (entry) =>
      entry.issuer === objectiveId &&
      entry.category === "emergency-spawn" &&
      entry.request.spawn !== null &&
      entry.consumed.spawn,
  );
  if (previousSuccessful !== undefined) {
    const previousName = generatedSpawnCreepName({
      id: previousSuccessful.issuer,
      issuer: previousSuccessful.issuer,
      colonyId: previousSuccessful.colonyId,
      revision: previousSuccessful.revision,
      category: "emergency-recovery",
    });
    if (expiringWorkers.some(({ name }) => name === previousName)) {
      return previousName;
    }
  }
  return expiringWorkers[0]?.name ?? null;
}

function authorizedSpawnIntents(
  session: ColonyDirectorSession,
  selections: readonly SpawnSelection[],
  tick: number,
): readonly SpawnCommandIntent[] {
  const intents: SpawnCommandIntent[] = [];
  for (const selection of selections) {
    const authority =
      selection.category === "funded-workforce"
        ? session.result.colonies
            .flatMap(({ populationPolicy }) => populationPolicy.demands)
            .find(({ id }) => id === selection.demandId)
        : session.result.objectives.find(
            ({ id, status }) => id === selection.demandId && status === "funded",
          );
    if (authority === undefined || authority.reservationId === null) continue;
    const reservation = session.result.reservations.find(
      ({ reservationId }) => reservationId === authority.reservationId,
    );
    if (
      selection.revision !== authority.revision ||
      selection.budgetId !== authority.reservationId ||
      reservation === undefined ||
      reservation.grant.energy < selection.energyCost ||
      reservation.grant.spawn === null ||
      reservation.grant.spawn.spawnId !== selection.spawnClaim.spawnId ||
      reservation.grant.spawn.startTick !== selection.spawnClaim.startTick ||
      reservation.grant.spawn.endTick !== selection.spawnClaim.endTick
    ) {
      throw new Error("SpawnBroker selection does not match its atomic colony grant");
    }
    intents.push({
      intentId: `spawn/${selection.spawnId}/${selection.name}/${String(authority.revision)}`,
      demandId: selection.demandId,
      colonyId: selection.colonyId,
      issuer: selection.issuer,
      revision: authority.revision,
      reservationId: authority.reservationId,
      spawnId: selection.spawnId,
      spawnName: selection.spawnName,
      roomName: selection.destinationRoomName,
      body: selection.body,
      name: selection.name,
      energyCost: selection.energyCost,
      spawnTicks: selection.spawnTicks,
      scheduledTick: tick,
    });
  }
  return Object.freeze(intents);
}

function settleSpawnDraft(
  draft: SpawnTickDraft,
  tick: number,
): ReturnType<ColonyDirectorSession["settle"]> | null {
  if (draft.settled !== null || draft.session === null) {
    return draft.settled;
  }
  const resultByIntent = new Map(
    (draft.execution ?? []).map((result) => [result.intentId, result] as const),
  );
  const settlements: ColonySpawnCommandSettlement[] = draft.intents.map((intent) => {
    const result = resultByIntent.get(intent.intentId);
    return result?.status === "scheduled"
      ? {
          reservationId: intent.reservationId,
          status: "scheduled",
          energyCost: intent.energyCost,
        }
      : { reservationId: intent.reservationId, status: "not-scheduled" };
  });
  draft.settled = draft.session.settle(tick, settlements);
  return draft.settled;
}

function resolveLiveSpawn(game: RuntimeGame, spawnId: string): unknown {
  return resolveLiveObject(game, spawnId);
}

function resolveLiveObject(game: RuntimeGame, objectId: string): unknown {
  const resolver = game.getObjectById;
  return resolver === undefined ? null : resolver.call(game, objectId);
}

function resetSpawnDraft(draft: SpawnTickDraft): void {
  draft.session = null;
  draft.broker = null;
  draft.intents = [];
  draft.execution = null;
  draft.settled = null;
  draft.settlementStaged = false;
  draft.status = "not-run";
}

function safeAddTick(tick: number, delta: number): number {
  return tick <= Number.MAX_SAFE_INTEGER - delta ? tick + delta : Number.MAX_SAFE_INTEGER;
}

function contractFundingView(colony: ColonyPlanningResult): ContractFundingView {
  if (colony.status !== "planned") {
    const reason =
      colony.status === "owner-future-schema"
        ? "colony-owner-future-schema"
        : colony.status === "owner-malformed"
          ? "colony-owner-malformed"
          : colony.status === "owner-unavailable"
            ? "colony-owner-unavailable"
            : "colony-planning-not-run";
    return Object.freeze({ reason, status: "unavailable" });
  }
  return Object.freeze({
    authorizations: Object.freeze(
      colony.reservations.map((entry) =>
        Object.freeze({
          category: entry.category,
          colonyId: entry.colonyId,
          expiresAt: entry.request.expiresAt,
          issuer: entry.issuer,
          reservationId: entry.reservationId,
          revision: entry.revision,
          status: entry.status,
        }),
      ),
    ),
    owners: Object.freeze(
      colony.colonies.map(({ id, visibility }) => Object.freeze({ id, visibility })),
    ),
    status: "ready",
  });
}

function configBootSystem(input: CompositionInput): TickSystem<TickContext> {
  return {
    descriptor: {
      id: "core.boot",
      phase: "boot",
      criticality: "mandatory",
      cadence: 1,
      estimate: 0.05,
      admitInRecovery: true,
      mandatoryTail: false,
    },
    run: () => {
      input.onPhase?.("boot");
      return staged(
        () => {
          if (input.manager === null || input.configReplacement === null) {
            return;
          }
          const transaction = input.manager.transaction("config");
          transaction.replace(input.configReplacement);
          const stagedResult = transaction.stage();
          if (!stagedResult.staged) {
            throw new Error(stagedResult.fault?.message ?? "config state staging failed");
          }
        },
        () => {
          input.manager?.discard("config");
        },
      );
    },
  };
}

function staged(commit: () => void, discard?: () => void): StagedSystemResult {
  return {
    commit,
    ...(discard === undefined ? {} : { discard }),
  };
}

function createTickRuntime(
  game: RuntimeGame,
  memoryStatus: TickContext["memoryStatus"],
  state: StateView | null,
  config: RuntimeConfig,
  configResolution: RuntimeConfigResolutionMetadata,
  contractExecution: ContractExecutionView,
  contractPlanning: ContractPlanningView,
  localPathPlanning: LocalPathPlanningService,
  movementChannels: TickContext["movementChannels"],
): TickRuntimeControl {
  let snapshot = emptyWorldSnapshot(game.time, game.shard.name);
  let colony: ColonyPlanningResult = emptyColonyPlanningResult();
  let contracts: ContractReconciliationResult | null = null;
  let execution: ArbitrationBatch | null = null;
  let movement: MovementRuntimeResult = emptyMovementRuntimeResult();
  let layout: LayoutRuntimeResult = emptyLayoutRuntimeResult();
  let links: LinkRuntimeResult = emptyLinkRuntimeResult();
  let spawn: SpawnRuntimeResult = spawnRuntimeResult("not-run");
  let stateCommit: MemoryCommitResult | null = null;
  let telemetry: TickTelemetry | null = null;
  const context = Object.freeze({
    tick: game.time,
    shard: game.shard.name,
    memoryStatus,
    config,
    configResolution,
    state,
    get snapshot(): WorldSnapshot {
      return snapshot;
    },
    get colony(): ColonyPlanningResult {
      return colony;
    },
    get contracts(): ContractReconciliationResult | null {
      return contracts;
    },
    contractExecution,
    contractPlanning,
    get execution(): ArbitrationBatch | null {
      return execution;
    },
    movementChannels,
    localPathPlanning,
    get movement(): MovementRuntimeResult {
      return movement;
    },
    get layout(): LayoutRuntimeResult {
      return layout;
    },
    get links(): LinkRuntimeResult {
      return links;
    },
    get spawn(): SpawnRuntimeResult {
      return spawn;
    },
    get stateCommit(): MemoryCommitResult | null {
      return stateCommit;
    },
    get telemetry(): TickTelemetry | null {
      return telemetry;
    },
  });

  return Object.freeze({
    context,
    publishSnapshot(value: WorldSnapshot): void {
      snapshot = value;
    },
    publishColony(value: ColonyPlanningResult): void {
      colony = value;
    },
    clearColony(): void {
      colony = emptyColonyPlanningResult();
    },
    publishContracts(value: ContractReconciliationResult): void {
      contracts = value;
    },
    clearContracts(): void {
      contracts = null;
    },
    publishExecution(value: ArbitrationBatch): void {
      execution = value;
    },
    publishMovement(value: MovementRuntimeResult): void {
      movement = value;
    },
    clearMovement(): void {
      movement = emptyMovementRuntimeResult();
    },
    publishLayout(value: LayoutRuntimeResult): void {
      layout = value;
    },
    publishLinks(value: LinkRuntimeResult): void {
      links = value;
    },
    publishSpawn(value: SpawnRuntimeResult): void {
      spawn = value;
    },
    clearSpawn(): void {
      spawn = spawnRuntimeResult("not-run");
    },
    publishStateCommit(value: MemoryCommitResult): void {
      stateCommit = value;
    },
    publishTelemetry(value: TickTelemetry): void {
      telemetry = value;
    },
  });
}

function readContractExecution(manager: MemoryManager | null): ContractExecutionView {
  if (manager === null) return emptyContractExecutionView();
  const opened = ContractLedger.open(manager.ownerView("contracts"));
  return opened.status === "ready" ? opened.ledger.executionView() : emptyContractExecutionView();
}

function readContractPlanning(manager: MemoryManager | null): ContractPlanningView {
  if (manager === null) return emptyContractPlanningView();
  const opened = ContractLedger.open(manager.ownerView("contracts"));
  return opened.status === "ready" ? opened.ledger.planningView() : emptyContractPlanningView();
}

function serializeKernelState(kernel: RuntimeKernel<TickContext>, mode: CpuMode): JsonObject {
  return {
    schemaVersion: KERNEL_STATE_SCHEMA_VERSION,
    cpuMode: mode,
    health: kernel.getHealthSnapshot().map((record) => ({
      systemId: record.systemId,
      consecutiveFailures: record.consecutiveFailures,
      lastSuccessfulTick: record.lastSuccessfulTick,
      nextProbeTick: record.nextProbeTick,
    })),
  };
}

function restoreKernelState(state: StateView | null): RestoredKernelState {
  if (state === null) {
    return { cpuMode: null, health: [] };
  }
  const raw = state.kernel.runtime;
  if (!isRecord(raw) || raw.schemaVersion !== KERNEL_STATE_SCHEMA_VERSION) {
    return { cpuMode: null, health: [] };
  }

  const cpuMode =
    typeof raw.cpuMode === "string" && CPU_MODES.includes(raw.cpuMode as CpuMode)
      ? (raw.cpuMode as CpuMode)
      : null;
  if (!Array.isArray(raw.health) || raw.health.length > MAX_RESTORED_SYSTEM_HEALTH) {
    return { cpuMode, health: [] };
  }

  const health: SystemHealthRecord[] = [];
  for (const candidate of raw.health) {
    if (!isRecord(candidate)) {
      return { cpuMode, health: [] };
    }
    const record = parseHealthRecord(candidate);
    if (record === null) {
      return { cpuMode, health: [] };
    }
    health.push(record);
  }
  return { cpuMode, health: Object.freeze(health) };
}

function parseHealthRecord(value: Readonly<Record<string, unknown>>): SystemHealthRecord | null {
  if (
    typeof value.systemId !== "string" ||
    !isNonNegativeInteger(value.consecutiveFailures) ||
    !isOptionalTick(value.lastSuccessfulTick) ||
    !isOptionalTick(value.nextProbeTick)
  ) {
    return null;
  }
  return Object.freeze({
    systemId: value.systemId,
    consecutiveFailures: value.consecutiveFailures,
    lastSuccessfulTick: value.lastSuccessfulTick,
    nextProbeTick: value.nextProbeTick,
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTick(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectLabBudgetRequests(
  projection: LabCompositionProjection,
  tick: number,
): readonly BudgetRequest[] {
  return [...projection.objectiveBudgets, ...projection.policy.budgets].map((budget) => ({
    colonyId: budget.colonyId,
    category: "industry" as const,
    cpu: { minimum: 0, desired: 100 },
    energy: null,
    expiresAt: Math.max(tick, budget.deadline),
    issuer: budget.identity,
    revision: 1,
    spawn: null,
  }));
}

function snapshotRevision(snapshot: WorldSnapshot): string {
  return `${snapshot.observation.shard}:${String(snapshot.observation.tick)}:${String(
    snapshot.stats.estimatedPayloadBytes,
  )}`;
}

function runtimeInputRevision(snapshot: WorldSnapshot, config: RuntimeConfig): string {
  return `${snapshotRevision(snapshot)}|config:${config.revision}|policy:${config.policyRevision}`;
}
