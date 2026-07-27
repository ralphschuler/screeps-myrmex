import type { BudgetGrant, BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { ConstructionProgressionAuthorization, LayoutSiteProposal } from "../layout";
import type { PositionSnapshot, RoomSnapshot } from "../world/snapshot";
import type { RemoteCandidateEvidence, RemotePortfolioObjective } from "./contracts";

export const REMOTE_MINING_LIMITS = Object.freeze({
  maximumBudgetEntries: 512,
  maximumCapitalProposalsPerObjective: 8,
  maximumContractCodeUnits: 4_096,
  maximumContractRecords: 256,
  maximumObjectivesPerTick: 8,
  maximumRoadCandidatesPerObjective: 16,
  maximumRoadExpectedBodyPartUses: 1_000_000,
  maximumRouteRooms: 16,
  maximumSourcesPerObjective: 8,
  maximumTransitionsPerTick: 32,
} as const);

export interface RemoteMiningPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly sourceRegenerationTicks: number;
  readonly harvestPower: number;
  readonly maximumSourceEnergyCapacity: number;
  readonly workPartEnergy: number;
  readonly movePartEnergy: number;
  readonly spawnTicksPerPart: number;
  readonly creepLifetime: number;
  readonly replacementSafetyTicks: number;
  readonly minimumOperatingTicks: number;
  readonly cpuMilliPerSource: number;
  readonly memoryCodeUnitsPerSource: number;
  readonly maximumIntelAgeTicks: number;
  readonly maximumThreatRisk: number;
  readonly maximumCommandAttempts: number;
  readonly retryInitialDelayTicks: number;
  readonly retryMaximumDelayTicks: number;
  readonly containerBuildEnergy: number;
  readonly containerUpkeepMilliEnergyPerTick: number;
  readonly infrastructureCpuMilli: number;
  readonly roadPlainBuildEnergy: number;
  readonly roadSwampBuildEnergy: number;
  readonly roadFatigueValueMilliEnergy: number;
}

export interface RemoteMiningRoadCandidate {
  readonly expectedBodyPartUses: number;
  readonly pos: PositionSnapshot;
  readonly routeRevision: string;
  readonly sourceId: string;
  readonly terrain: "plain" | "swamp";
}

export interface RemoteMiningObjectiveEvidence {
  readonly objective: RemotePortfolioObjective;
  readonly candidate: RemoteCandidateEvidence;
  readonly roadCandidates: readonly RemoteMiningRoadCandidate[];
  /** Current detached observation. Historical intel may authorize mining, never capital spend. */
  readonly visibleRoom: RoomSnapshot | null;
}

export interface RemoteMiningBudgetEntry {
  readonly category: string;
  readonly colonyId: string;
  readonly issuer: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly status: "active" | "pending" | "consumed" | "released" | "expired";
  readonly grant: BudgetGrant | null;
}

export type RemoteMiningReason =
  | "budget-insufficient"
  | "budget-unavailable"
  | "capital-limit"
  | "capital-not-profitable"
  | "container-active"
  | "container-budget-unavailable"
  | "container-pending"
  | "container-proposed"
  | "contract-active"
  | "controller-blocked"
  | "intel-partial"
  | "intel-stale"
  | "intel-unavailable"
  | "invalid-work-position"
  | "memory-budget"
  | "mining-unavailable"
  | "objective-not-active"
  | "portfolio-budget"
  | "portfolio-unavailable"
  | "retry-exhausted"
  | "retry-wait"
  | "road-budget-unavailable"
  | "road-evidence-unavailable"
  | "road-not-profitable"
  | "road-proposed"
  | "route-unavailable"
  | "source-missing"
  | "source-unsupported"
  | "threat-risk"
  | "timeout"
  | "transition-limit"
  | "vision-unavailable";

export type RemoteMiningOffload = "container" | "container-full-drop" | "drop";

export interface RemoteMiningDisposition {
  readonly infrastructureReason: RemoteMiningReason;
  readonly miningReason: RemoteMiningReason;
  readonly offload: RemoteMiningOffload;
  readonly replacementLeadTicks: number;
  readonly roomName: string;
  readonly sourceId: string;
  readonly workPosition: PositionSnapshot | null;
}

export interface RemoteMiningMetrics {
  readonly objectives: number;
  readonly sources: number;
  readonly budgeted: number;
  readonly contracts: number;
  readonly suspended: number;
  readonly capitalProposals: number;
  readonly dropFallbacks: number;
  readonly retries: number;
}

export interface RemoteMiningPlanInput {
  readonly tick: number;
  readonly objectives: readonly RemoteMiningObjectiveEvidence[];
  readonly budgets: readonly RemoteMiningBudgetEntry[];
  readonly contracts: ContractPlanningView;
  readonly policy: RemoteMiningPolicyV1;
}

export type RemoteMiningPlanStatus =
  "ready" | "contracts-unavailable" | "invalid-input" | "limit-exceeded";

export interface RemoteMiningPlan {
  readonly status: RemoteMiningPlanStatus;
  readonly budgetRequests: readonly BudgetRequest[];
  readonly contractRequests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
  readonly siteAuthorizations: readonly ConstructionProgressionAuthorization[];
  readonly siteProposals: readonly LayoutSiteProposal[];
  readonly dispositions: readonly RemoteMiningDisposition[];
  readonly metrics: RemoteMiningMetrics;
}
