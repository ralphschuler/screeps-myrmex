import type { BudgetGrant, BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { RemoteCandidateEvidence, RemotePortfolioObjective } from "./contracts";

export const REMOTE_RESERVATION_LIMITS = Object.freeze({
  maximumBudgetEntries: 512,
  maximumContractCodeUnits: 4_096,
  maximumContractRecords: 256,
  maximumObjectivesPerTick: 8,
  maximumRouteRooms: 16,
  maximumTransitionsPerTick: 16,
  reservationMaximumTicks: 5_000,
} as const);

export interface RemoteReservationPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly claimParts: number;
  readonly moveParts: number;
  readonly claimPartEnergy: number;
  readonly movePartEnergy: number;
  readonly spawnTicksPerPart: number;
  readonly claimCreepLifetime: number;
  readonly reservationTargetTicks: number;
  readonly replacementSafetyTicks: number;
  readonly cpuMilli: number;
  readonly maximumThreatRisk: number;
  readonly maximumIntelAgeTicks: number;
  readonly maximumCommandAttempts: number;
  readonly retryInitialDelayTicks: number;
  readonly retryMaximumDelayTicks: number;
  readonly signText: string | null;
}
export interface RemoteReservationObjectiveEvidence {
  readonly objective: RemotePortfolioObjective;
  readonly candidate: RemoteCandidateEvidence;
}
export interface RemoteReservationBudgetEntry {
  readonly category: string;
  readonly colonyId: string;
  readonly issuer: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly status: "active" | "pending" | "consumed" | "released" | "expired";
  readonly grant: BudgetGrant | null;
}
export type RemoteReservationReason =
  | "budget-insufficient"
  | "budget-unavailable"
  | "contract-active"
  | "controller-blocked"
  | "controller-missing"
  | "intel-partial"
  | "intel-stale"
  | "intel-unavailable"
  | "memory-budget"
  | "objective-not-active"
  | "portfolio-budget"
  | "portfolio-unavailable"
  | "reservation-due"
  | "reservation-healthy"
  | "reservation-target-reached"
  | "retry-exhausted"
  | "retry-wait"
  | "route-unavailable"
  | "threat-risk"
  | "timeout";
export interface RemoteReservationDisposition {
  readonly roomName: string;
  readonly reason: RemoteReservationReason;
  readonly currentReservationTicks: number;
  readonly leadTicks: number;
}
export interface RemoteReservationMetrics {
  readonly objectives: number;
  readonly due: number;
  readonly budgeted: number;
  readonly contracts: number;
  readonly suspended: number;
  readonly completed: number;
  readonly retries: number;
}
export interface RemoteReservationPlanInput {
  readonly tick: number;
  readonly objectives: readonly RemoteReservationObjectiveEvidence[];
  readonly budgets: readonly RemoteReservationBudgetEntry[];
  readonly contracts: ContractPlanningView;
  readonly policy: RemoteReservationPolicyV1;
}
export type RemoteReservationPlanStatus =
  "ready" | "contracts-unavailable" | "invalid-input" | "limit-exceeded";
export interface RemoteReservationPlan {
  readonly status: RemoteReservationPlanStatus;
  readonly budgetRequests: readonly BudgetRequest[];
  readonly contractRequests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
  readonly dispositions: readonly RemoteReservationDisposition[];
  readonly metrics: RemoteReservationMetrics;
}
