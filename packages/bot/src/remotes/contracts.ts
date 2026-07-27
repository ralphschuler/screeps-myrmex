import type { RoomIntelQueryResult } from "../world/intel";
import type { RoutePlanResult } from "../world/routes";

export const REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION = 1 as const;

export const REMOTE_PORTFOLIO_LIMITS = Object.freeze({
  maximumCandidatesPerTick: 8,
  maximumDeadlineTicks: 50_000,
  maximumIdentityCodeUnits: 128,
  maximumOwnerCodeUnits: 16_384,
  maximumRateMilliPerTick: 1_000_000_000,
  maximumCapacityUnits: 1_000_000_000_000,
  maximumRecords: 32,
  maximumSourceEnergyCapacity: 4_000,
  maximumSourcesPerRemote: 8,
  maximumThreatRisk: 10_000,
  maximumTransitionsPerTick: 32,
  sourceRegenerationTicks: 300,
} as const);

export const REMOTE_PORTFOLIO_STATES = [
  "candidate",
  "probing",
  "active",
  "threatened",
  "suspended",
  "cooldown",
  "retired",
] as const;
export type RemotePortfolioState = (typeof REMOTE_PORTFOLIO_STATES)[number];

export const REMOTE_PORTFOLIO_REASONS = [
  "positive-probe",
  "positive-active",
  "retained-active",
  "negative-value",
  "stale-intel",
  "partial-intel",
  "intel-unavailable",
  "route-unavailable",
  "controller-blocked",
  "donor-pressure",
  "threat-risk",
  "capacity-energy",
  "capacity-spawn",
  "capacity-cpu",
  "capacity-memory",
  "capacity-active",
  "cooldown-wait",
  "cooldown-probe",
  "resumed-active",
  "candidate-missing",
  "source-vanished",
  "timeout",
] as const;
export type RemotePortfolioReason = (typeof REMOTE_PORTFOLIO_REASONS)[number];

export const REMOTE_COST_COMPONENTS = [
  "latency",
  "spawn",
  "body",
  "hauling",
  "reservation",
  "roads",
  "repair",
  "expectedLoss",
  "cpu",
] as const;
export type RemoteCostComponent = (typeof REMOTE_COST_COMPONENTS)[number];

/** All rates use milli-energy per tick. They are detached forecasts from their owning planners. */
export type RemoteCostForecast = Readonly<Record<RemoteCostComponent, number>>;

export interface RemoteForecast {
  readonly revenue: number;
  readonly cost: number;
  readonly profit: number;
}

/** Portfolio-wide abstract commitment. It does not mint a colony BudgetLedger grant. */
export interface RemoteCapacityCommitment {
  readonly energy: number;
  readonly spawnTicks: number;
  readonly cpuMilli: number;
  readonly memoryCodeUnits: number;
}

/** Externally supplied envelope after owned-colony survival and defense preemption. */
export interface RemotePortfolioCapacity extends RemoteCapacityCommitment {
  readonly activeRemotes: number;
}

export interface RemotePortfolioPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly minimumProfitMilliPerTick: number;
  readonly activeRetentionBonusMilliPerTick: number;
  readonly maximumThreatRisk: number;
  readonly probingTicks: number;
  readonly suspensionCooldownTicks: number;
  readonly resumptionProbeTicks: number;
}

export type RemoteControllerDisposition = "available" | "self-reserved" | "blocked" | "unknown";
export type RemoteDonorPosture = "healthy" | "brownout" | "threatened" | "unknown";

/**
 * Candidate discovery output. Intel, route, diplomacy/threat, and donor owners remain authoritative
 * for their detached evidence; RemotePortfolio alone decides whether to reserve portfolio capacity.
 */
export interface RemoteCandidateEvidence {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly evidenceRevision: string;
  readonly expiresAt: number;
  readonly controller: RemoteControllerDisposition;
  readonly donor: RemoteDonorPosture;
  readonly threatRisk: number;
  readonly intel: RoomIntelQueryResult;
  readonly route: RoutePlanResult;
  readonly costs: RemoteCostForecast;
  readonly commitment: RemoteCapacityCommitment;
}

export interface RemotePortfolioRecord {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly state: RemotePortfolioState;
  readonly stateSince: number;
  readonly lastEvaluatedTick: number;
  readonly revision: number;
  readonly reasonCode: RemotePortfolioReason;
  readonly evidenceRevision: string;
  readonly expiresAt: number;
  readonly positiveTicks: number;
  readonly resumeAt: number;
  readonly forecast: RemoteForecast;
  readonly commitment: RemoteCapacityCommitment | null;
}

export interface RemotePortfolioOwnerV1 {
  readonly schemaVersion: typeof REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly RemotePortfolioRecord[];
}

export interface RemotePortfolioInput {
  readonly tick: number;
  readonly owner: unknown;
  readonly candidates: readonly RemoteCandidateEvidence[];
  readonly capacity: RemotePortfolioCapacity;
  readonly policy: RemotePortfolioPolicyV1;
}

export interface RemotePortfolioObjective {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly state: Extract<RemotePortfolioState, "probing" | "active" | "cooldown">;
  readonly revision: number;
  readonly profit: number;
  readonly commitment: RemoteCapacityCommitment;
}

export interface RemotePortfolioDisposition {
  readonly roomName: string;
  readonly state: RemotePortfolioState;
  readonly reason: RemotePortfolioReason;
  readonly profit: number;
}

export interface RemotePortfolioMetrics {
  readonly candidates: number;
  readonly profitable: number;
  readonly probing: number;
  readonly active: number;
  readonly threatened: number;
  readonly suspended: number;
  readonly cooldown: number;
  readonly retired: number;
  readonly released: number;
  readonly revenue: number;
  readonly cost: number;
  readonly profit: number;
  readonly reservedEnergy: number;
  readonly reservedSpawnTicks: number;
  readonly reservedCpuMilli: number;
  readonly reservedMemoryCodeUnits: number;
}

export type RemotePortfolioStatus =
  | "ready"
  | "owner-malformed"
  | "owner-future-schema"
  | "invalid-input"
  | "limit-exceeded"
  | "memory-budget";

export interface RemotePortfolioResult {
  readonly status: RemotePortfolioStatus;
  readonly changed: boolean;
  readonly owner: RemotePortfolioOwnerV1 | null;
  readonly objectives: readonly RemotePortfolioObjective[];
  readonly dispositions: readonly RemotePortfolioDisposition[];
  readonly metrics: RemotePortfolioMetrics;
}
