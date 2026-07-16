import type { CacheManagerMetrics } from "../cache";
import {
  BUDGET_REASON_CODES,
  COLONY_STATES,
  type BudgetReasonCode,
  type ColonyPlanningResult,
  type ColonyState,
} from "../colony";
import {
  FEATURE_GATE_IDS,
  type FeatureGateId,
  type FeatureGateReason,
  type RuntimeConfig,
  type RuntimeConfigResolutionMetadata,
} from "../config";
import type { WorldSnapshot } from "../world/snapshot";
import type { TelemetryStatus } from "./service";

export interface FeatureGateTelemetry {
  readonly id: FeatureGateId;
  readonly enabled: boolean;
  readonly reason: FeatureGateReason;
  readonly blockedBy: FeatureGateId | null;
}

export interface BoundedCount<Id extends string> {
  readonly id: Id;
  readonly count: number;
}

export interface ColonyTelemetry {
  readonly status: ColonyPlanningResult["status"];
  readonly ownerRevision: number | null;
  readonly states: readonly BoundedCount<ColonyState>[];
  readonly budgetReasons: readonly BoundedCount<BudgetReasonCode>[];
  readonly objectives: number;
  readonly activeReservations: number;
  readonly pendingReservations: number;
  readonly energyReserved: number;
  readonly cpuReserved: number;
  readonly spawnTicksReserved: number;
}

export interface TickTelemetry {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: "ready" | "recovery" | "unsupported";
  readonly cpuBucket: number;
  readonly ownedRooms: number;
  readonly snapshotBytes: number;
  readonly cacheEntries: number;
  readonly cacheNamespaces: number;
  readonly configSourceRevision: string;
  readonly configRevision: string;
  readonly policyRevision: string;
  readonly configStatus: RuntimeConfigResolutionMetadata["status"];
  readonly configReasonCode: RuntimeConfigResolutionMetadata["reasonCode"];
  readonly configCandidateRevision: number | null;
  readonly configAcceptedCandidateRevision: number | null;
  readonly featureGates: readonly FeatureGateTelemetry[];
  readonly colony: ColonyTelemetry;
  readonly telemetryPolicy: {
    readonly maximumDetailRecords: number;
    readonly maximumHistoryEntries: number;
    readonly maximumHistoryBytes: number;
  };
  readonly reporterPolicy: {
    readonly initialReminderDelayTicks: number;
    readonly maximumFingerprints: number;
    readonly maximumReminderDelayTicks: number;
    readonly stuckRecoveryWindowTicks: number;
  };
  readonly activity: TelemetryActivity;
  readonly status: TelemetryStatus;
  readonly recoveryProgress: RecoveryProgressTelemetry | null;
  /** Bounded current-tick survival-flow evidence; it is observational and never an authority. */
  readonly energyFlow: EnergyFlowTelemetry;
}

export interface RecoveryProgressTelemetry {
  readonly blockerReasonCode: string;
  readonly blockerRef: string | null;
  readonly lastProgressTick: number;
  readonly reminderAtTick: number | null;
  readonly stuck: boolean;
}

export interface TelemetryActivity {
  readonly activeContracts: number;
  readonly contractFundingDenied: number;
  readonly contractReleases: number;
  readonly controllerRisks: number;
  readonly criticalMaintenance: number;
  readonly growthCandidates: number;
  readonly hostileRooms: number;
  readonly intentAccepted: number;
  readonly intentDenied: number;
  readonly leaseCount: number;
  readonly movementBlocked: number;
  readonly spawnDemand: number;
  readonly spawnScheduled: number;
}

export interface EnergyFlowTelemetry {
  readonly carried: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly harvested: number;
  readonly requested: number;
  readonly unmet: number;
}

export interface TickTelemetryInput {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: TickTelemetry["memoryStatus"];
  readonly cpuBucket: number;
  readonly snapshot: WorldSnapshot;
  readonly cache: CacheManagerMetrics;
  readonly config: RuntimeConfig;
  readonly configResolution: RuntimeConfigResolutionMetadata;
  readonly colony: ColonyPlanningResult;
  readonly energyFlow: EnergyFlowTelemetry;
}

/** Creates a bounded, immutable per-tick summary; durable history is a later telemetry policy. */
export function recordTickTelemetry(
  input: TickTelemetryInput,
): Omit<TickTelemetry, "activity" | "status" | "recoveryProgress"> {
  return Object.freeze({
    tick: input.tick,
    shard: input.shard,
    memoryStatus: input.memoryStatus,
    cpuBucket: input.cpuBucket,
    ownedRooms: input.snapshot.ownedRooms.length,
    snapshotBytes: input.snapshot.stats.estimatedPayloadBytes,
    cacheEntries: input.cache.entries,
    cacheNamespaces: input.cache.namespaces.length,
    configSourceRevision: input.config.sourceRevision,
    configRevision: input.config.revision,
    policyRevision: input.config.policyRevision,
    configStatus: input.configResolution.status,
    configReasonCode: input.configResolution.reasonCode,
    configCandidateRevision: input.configResolution.candidateRevision,
    configAcceptedCandidateRevision: input.configResolution.acceptedCandidateRevision,
    featureGates: Object.freeze(
      FEATURE_GATE_IDS.map((id) =>
        Object.freeze({
          id,
          enabled: input.config.features.gates[id].enabled,
          reason: input.config.features.gates[id].reason,
          blockedBy: input.config.features.gates[id].blockedBy,
        }),
      ),
    ),
    colony: Object.freeze({
      status: input.colony.status,
      ownerRevision: input.colony.ownerRevision,
      states: Object.freeze(
        COLONY_STATES.map((id) =>
          Object.freeze({
            id,
            count: input.colony.colonies.filter((colony) => colony.state === id).length,
          }),
        ),
      ),
      budgetReasons: Object.freeze(
        BUDGET_REASON_CODES.map((id) =>
          Object.freeze({
            id,
            count: input.colony.decisions.filter((decision) => decision.reasonCode === id).length,
          }),
        ),
      ),
      objectives: input.colony.objectives.length,
      activeReservations: input.colony.totals.active,
      pendingReservations: input.colony.totals.pending,
      energyReserved: input.colony.totals.energyReserved,
      cpuReserved: input.colony.totals.cpuReserved,
      spawnTicksReserved: input.colony.totals.spawnTicksReserved,
    }),
    telemetryPolicy: Object.freeze({ ...input.config.policy.telemetry }),
    reporterPolicy: Object.freeze({
      initialReminderDelayTicks: input.config.policy.reporter.initialReminderDelayTicks,
      maximumFingerprints: input.config.policy.reporter.maximumFingerprints,
      maximumReminderDelayTicks: input.config.policy.reporter.maximumReminderDelayTicks,
      stuckRecoveryWindowTicks: input.config.policy.reporter.stuckRecoveryWindowTicks,
    }),
    energyFlow: Object.freeze({ ...input.energyFlow }),
  });
}
