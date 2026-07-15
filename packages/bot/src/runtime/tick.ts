import { createIntentChannel, type ArbitrationBatch, type IntentChannel } from "../execution";
import { getRuntimeCacheManager, type CacheManager } from "../cache";
import { ColonyDirector, emptyColonyPlanningResult, type ColonyPlanningResult } from "../colony";
import {
  isFeatureEnabled,
  type RuntimeConfig,
  type RuntimeConfigResolutionMetadata,
} from "../config";
import { RuntimeConfigAuthority, type RuntimeConfigResolution } from "../config/authority";
import {
  ContractLedger,
  createContractRequestChannel,
  inRangeOrUnknownTravel,
  workforceActorFromCreep,
  type ContractFundingView,
  type ContractReconciliationResult,
  type ContractRequestChannel,
} from "../contracts";
import {
  openMyrmexMemory,
  type MemoryCommitResult,
  type MemoryManager,
  type OpenMemoryResult,
} from "../state/memory";
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

export interface TickInput {
  readonly game: RuntimeGame;
  readonly memory: Memory;
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
  readonly contracts: ContractReconciliationResult | null;
  readonly execution: ArbitrationBatch | null;
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
  const manager = opened.status === "ready" ? opened.manager : null;
  const state = manager?.view() ?? null;
  const configResolution = runtimeConfigAuthority.resolve(
    manager?.ownerView("config") ?? null,
    input.game.time,
  );
  const restored = restoreKernelState(state);
  const runtime = createTickRuntime(
    input.game,
    opened.status,
    state,
    configResolution.config,
    configResolution.metadata,
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
    contracts: runtime.context.contracts,
    execution: runtime.context.execution,
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
  readonly configReplacement: RuntimeConfigResolution["replacementOwner"];
  readonly contractChannel: ContractRequestChannel;
  readonly onPhase: ((phase: TickPhase) => void) | undefined;
  readonly getKernel: () => RuntimeKernel<TickContext>;
}

/** Static, explicit composition. Roadmap systems replace foundation markers in dependency order. */
function composeRuntimeSystems(input: CompositionInput): readonly TickSystem<TickContext>[] {
  return Object.freeze([
    configBootSystem(input),
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
    colonyDirectorSystem(input),
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
              input.runtime.clearContracts();
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

function colonyDirectorSystem(input: CompositionInput): TickSystem<TickContext> {
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
      const result = colonyDirector.plan({
        tick: context.tick,
        snapshot: context.snapshot,
        config: context.config,
        owner: input.manager?.ownerView("colonies") ?? null,
        cpuMode: mode,
        cpuBudget: budget,
      });
      const planningView = colonyPlanningView(result);
      if (result.replacementOwner !== null) {
        if (input.manager === null) {
          throw new Error("colony owner replacement requires a ready Memory manager");
        }
        const transaction = input.manager.transaction("colonies");
        transaction.replace(result.replacementOwner);
        const stagedResult = transaction.stage();
        if (!stagedResult.staged) {
          throw new Error(stagedResult.fault?.message ?? "colony state staging failed");
        }
      }
      return staged(
        () => {
          input.runtime.publishColony(planningView);
        },
        () => {
          input.manager?.discard("colonies");
          input.runtime.clearColony();
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
): TickRuntimeControl {
  let snapshot = emptyWorldSnapshot(game.time, game.shard.name);
  let colony: ColonyPlanningResult = emptyColonyPlanningResult();
  let contracts: ContractReconciliationResult | null = null;
  let execution: ArbitrationBatch | null = null;
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
    get execution(): ArbitrationBatch | null {
      return execution;
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
    publishStateCommit(value: MemoryCommitResult): void {
      stateCommit = value;
    },
    publishTelemetry(value: TickTelemetry): void {
      telemetry = value;
    },
  });
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
