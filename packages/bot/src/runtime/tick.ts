import { createIntentChannel, type ArbitrationBatch, type IntentChannel } from "../execution";
import {
  dispositionTransitions,
  planLeaseAgents,
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
  ColonyDirector,
  emptyColonyPlanningResult,
  resolveColoniesOwner,
  type ColonyDirectorSession,
  type ColonyPlanningResult,
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
  createContractRequestChannel,
  emptyContractExecutionView,
  inRangeOrUnknownTravel,
  workforceActorFromCreep,
  type ContractFundingView,
  type ContractExecutionView,
  type ContractReconciliationResult,
  type ContractRequestChannel,
} from "../contracts";
import {
  openMyrmexMemory,
  type MemoryCommitResult,
  type MemoryManager,
  type OpenMemoryResult,
} from "../state/memory";
import {
  SpawnBroker,
  SpawnExecutor,
  generatedSpawnCreepName,
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
import { observeWorld } from "../world/observe";
import { emptyWorldSnapshot, type WorldSnapshot } from "../world/snapshot";
import type { RuntimeGame, TickContext } from "./context";
import {
  CPU_MODES,
  RuntimeKernel,
  type CpuMode,
  type KernelTickReport,
  type StagedSystemResult,
  type SystemHealthRecord,
  type TickSystem,
} from "./kernel";
import type { TickPhase } from "./phases";

const KERNEL_STATE_SCHEMA_VERSION = 1 as const;
const MAX_RESTORED_SYSTEM_HEALTH = 128;
const runtimeConfigAuthority = new RuntimeConfigAuthority();
const colonyDirector = new ColonyDirector();
const spawnBroker = new SpawnBroker();
const spawnExecutor = new SpawnExecutor();

export interface TickInput {
  readonly game: RuntimeGame;
  readonly memory: Memory;
  /** Test-only replacement for the runtime-owned Screeps PathFinder adapter. */
  readonly localPathSearch?: LocalPathSearch;
  /** Test/diagnostic observer. A throwing callback is isolated like its owning system. */
  readonly onPhase?: (phase: TickPhase) => void;
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
  readonly spawn: SpawnRuntimeResult;
  readonly stateCommit: MemoryCommitResult | null;
  /** Null only when the mandatory telemetry system itself faults; the kernel report still survives. */
  readonly telemetry: TickTelemetry | null;
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
    spawn: runtime.context.spawn,
    stateCommit: runtime.context.stateCommit,
    telemetry: runtime.context.telemetry,
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
  let leaseAgentPlan: LeaseAgentPlan = Object.freeze({
    actions: Object.freeze([]),
    dispositions: Object.freeze([]),
    movement: Object.freeze([]),
  });
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
      run: ({ context }) => {
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
          requests: batch.requests,
          tick: context.tick,
          transitions: batch.transitions,
          travel: inRangeOrUnknownTravel,
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
    phaseMarker("safety.foundation", "safety", true, false, 0.1, input.onPhase),
    colonyDirectorSystem(input, spawnDraft),
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
        const planned = planLeaseAgents({
          availablePathCpu: budget.available,
          execution: context.contractExecution,
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
        id: "state.reconcile",
        phase: "reconcile",
        criticality: "mandatory",
        cadence: 1,
        estimate: 1,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      run: ({ mode }) => {
        input.onPhase?.("reconcile");
        const persistentKernelState = serializeKernelState(input.getKernel(), mode);
        let rootCommitted = false;
        return staged(
          () => {
            if (input.manager === null) {
              return;
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
        const telemetry = recordTickTelemetry({
          tick: context.tick,
          shard: context.shard,
          memoryStatus: context.memoryStatus,
          cpuBucket: input.game.cpu.bucket,
          snapshot: context.snapshot,
          cache: input.cacheManager.metrics(),
          config: context.config,
          configResolution: context.configResolution,
          colony: context.colony,
        });
        return staged(() => {
          input.runtime.publishTelemetry(telemetry);
        });
      },
    },
  ]);
}

function colonyDirectorSystem(
  input: CompositionInput,
  spawnDraft: SpawnTickDraft,
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
      const owner = input.manager?.ownerView("colonies") ?? null;
      const provisional = colonyDirector.begin({
        tick: context.tick,
        snapshot: context.snapshot,
        config: context.config,
        owner,
        cpuMode: mode,
        cpuBudget: budget,
      });
      const spawnEnabled = isFeatureEnabled(context.config, "phase1.spawn");
      const brokerResult = spawnEnabled
        ? spawnBroker.arbitrate({
            tick: context.tick,
            snapshot: context.snapshot,
            demands: recoverySpawnDemands(provisional.result, owner, context.config, context.tick),
            expectations: recoverySpawnExpectations(owner),
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
        spawnEnabled && !hasFundedRecoveryObjective
          ? provisional
          : colonyDirector.begin({
              tick: context.tick,
              snapshot: context.snapshot,
              config: context.config,
              owner,
              cpuMode: mode,
              cpuBudget: budget,
              recoverySpawnSelections: selections.map((selection) => ({
                objectiveId: selection.demandId,
                colonyId: selection.colonyId,
                energyCost: selection.energyCost,
                spawn: selection.spawnClaim,
              })),
              satisfiedRecoveryObjectiveIds: satisfiedObjectiveIds,
            });
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
      revision: objective.revision,
      category: "emergency-recovery",
      priorityValue: 1_000,
      deadline,
      earliestTick,
      destinationRoomName: objective.colonyId,
      replacementCreepName: null,
      budgetId: objective.reservationId,
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

function recoverySpawnExpectations(ownerValue: unknown): readonly SpawnExpectation[] {
  const owner = resolveColoniesOwner(ownerValue).owner;
  if (owner === null) {
    return [];
  }
  return Object.freeze(
    owner.ledger
      .filter(
        (entry) =>
          entry.category === "emergency-spawn" &&
          entry.request.spawn !== null &&
          entry.consumed.spawn,
      )
      .map((entry) => {
        const spawn = entry.request.spawn;
        if (spawn === null) {
          throw new Error("filtered recovery expectation lost its spawn interval");
        }
        return Object.freeze({
          demandId: entry.issuer,
          revision: entry.revision,
          spawnId: spawn.spawnId,
          creepName: generatedSpawnCreepName({
            id: entry.issuer,
            issuer: entry.issuer,
            colonyId: entry.colonyId,
          }),
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

function authorizedSpawnIntents(
  session: ColonyDirectorSession,
  selections: readonly SpawnSelection[],
  tick: number,
): readonly SpawnCommandIntent[] {
  const intents: SpawnCommandIntent[] = [];
  for (const selection of selections) {
    const objective = session.result.objectives.find(({ id }) => id === selection.demandId);
    if (objective?.status !== "funded" || objective.reservationId === null) {
      continue;
    }
    const reservation = session.result.reservations.find(
      ({ reservationId }) => reservationId === objective.reservationId,
    );
    if (
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
      intentId: `spawn/${selection.spawnId}/${selection.name}/${String(objective.revision)}`,
      demandId: selection.demandId,
      colonyId: selection.colonyId,
      issuer: selection.issuer,
      revision: objective.revision,
      reservationId: objective.reservationId,
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

function phaseMarker(
  id: string,
  phase: TickPhase,
  admitInRecovery: boolean,
  mandatoryTail: boolean,
  estimate: number,
  onPhase: TickInput["onPhase"],
): TickSystem<TickContext> {
  return {
    descriptor: {
      id,
      phase,
      criticality: mandatoryTail || admitInRecovery ? "mandatory" : "economic",
      cadence: 1,
      estimate,
      admitInRecovery,
      mandatoryTail,
    },
    run: () => {
      onPhase?.(phase);
      return staged(() => undefined);
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
  localPathPlanning: LocalPathPlanningService,
  movementChannels: TickContext["movementChannels"],
): TickRuntimeControl {
  let snapshot = emptyWorldSnapshot(game.time, game.shard.name);
  let colony: ColonyPlanningResult = emptyColonyPlanningResult();
  let contracts: ContractReconciliationResult | null = null;
  let execution: ArbitrationBatch | null = null;
  let movement: MovementRuntimeResult = emptyMovementRuntimeResult();
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
    get execution(): ArbitrationBatch | null {
      return execution;
    },
    movementChannels,
    localPathPlanning,
    get movement(): MovementRuntimeResult {
      return movement;
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

function snapshotRevision(snapshot: WorldSnapshot): string {
  return `${snapshot.observation.shard}:${String(snapshot.observation.tick)}:${String(
    snapshot.stats.estimatedPayloadBytes,
  )}`;
}

function runtimeInputRevision(snapshot: WorldSnapshot, config: RuntimeConfig): string {
  return `${snapshotRevision(snapshot)}|config:${config.revision}|policy:${config.policyRevision}`;
}
