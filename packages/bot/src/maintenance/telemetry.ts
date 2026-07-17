import type { CommandExecutionResult, IntentEnvelope } from "../execution";
import type { DefenseIntentKind } from "../defense/director";
import type { ConstructionPlanningResult } from "./construction-planner";

const MAXIMUM_TOWER_OBSERVATIONS = 128;
const MAXIMUM_REASON_BUCKETS = 16;
const TOWER_REPAIR_ENERGY = 10;

export interface MaintenanceTowerRejection {
  readonly reason: string;
  readonly targetId: string;
}

export type MaintenanceWorkOutcome = "overshoot" | "retired" | "satisfied";

export interface MaintenanceTelemetryInput {
  readonly planning: ConstructionPlanningResult | null;
  readonly requestedEnergyCaps: readonly number[];
  readonly fundedEnergyCaps: readonly number[];
  readonly towerCommands: readonly CommandExecutionResult<IntentEnvelope<DefenseIntentKind>>[];
  readonly towerRejections: readonly MaintenanceTowerRejection[];
  readonly emergencyReservePreserved: boolean;
  readonly duplicateTargetsSuppressed: number;
  readonly workOutcomes: readonly MaintenanceWorkOutcome[];
}

export interface MaintenanceTelemetry {
  readonly planner: {
    readonly scanned: number;
    readonly admitted: number;
    readonly deferred: number;
    readonly truncated: number;
  };
  readonly energy: {
    readonly requestedCap: number;
    readonly fundedCap: number;
  };
  readonly towers: {
    readonly scheduled: number;
    readonly rejected: number;
    readonly failed: number;
    readonly cpuUsed: number;
    readonly energyScheduled: number;
    readonly reasons: readonly { readonly reason: string; readonly count: number }[];
    readonly droppedReasonBuckets: number;
    readonly truncatedObservations: number;
  };
  readonly emergencyReservePreserved: boolean;
  readonly duplicateTargetsSuppressed: number;
  readonly work: {
    readonly overshoot: number;
    readonly satisfied: number;
    readonly retired: number;
  };
}

/** Stateless observer projection over settled maintenance receipts; never an authorization input. */
export function projectMaintenanceTelemetry(
  input: MaintenanceTelemetryInput | undefined,
): MaintenanceTelemetry {
  if (input === undefined) return emptyTelemetry();
  const repairCommands = input.towerCommands
    .filter(({ command }) => command.kind === "tower.repair")
    .sort(compareCommand);
  const rejections = [...input.towerRejections].sort(
    (left, right) =>
      left.targetId.localeCompare(right.targetId) || left.reason.localeCompare(right.reason),
  );
  const observations = [
    ...repairCommands.map((result) => ({
      status: result.status,
      reason: result.reason,
      cpuUsed: finiteNonnegative(result.cpuUsed),
    })),
    ...rejections.map(({ reason }) => ({ status: "rejected" as const, reason, cpuUsed: 0 })),
  ];
  const bounded = observations.slice(0, MAXIMUM_TOWER_OBSERVATIONS);
  const reasonCounts = new Map<string, number>();
  for (const observation of bounded) {
    const reason = normalizeReason(observation.reason);
    reasonCounts.set(reason, saturatingAdd(reasonCounts.get(reason) ?? 0, 1));
  }
  const reasons = [...reasonCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => Object.freeze({ reason, count }));
  const retainedReasons = reasons.slice(0, MAXIMUM_REASON_BUCKETS);
  const work = { overshoot: 0, retired: 0, satisfied: 0 };
  for (const outcome of input.workOutcomes) work[outcome] = saturatingAdd(work[outcome], 1);
  const planning = input.planning;
  return deepFreeze({
    planner: {
      scanned: safeCount(planning?.scannedStructures ?? 0),
      admitted: safeCount(planning?.proposals.length ?? 0),
      deferred: safeCount(planning?.deferredCount ?? 0),
      truncated: safeCount(planning?.truncatedStructures ?? 0),
    },
    energy: {
      requestedCap: sum(input.requestedEnergyCaps),
      fundedCap: sum(input.fundedEnergyCaps),
    },
    towers: {
      scheduled: bounded.filter(({ status }) => status === "executed").length,
      rejected: bounded.filter(({ status }) => status === "rejected").length,
      failed: bounded.filter(({ status }) => status === "failed").length,
      cpuUsed: bounded.reduce((total, { cpuUsed }) => finiteNonnegative(total + cpuUsed), 0),
      energyScheduled:
        bounded.filter(({ status }) => status === "executed").length * TOWER_REPAIR_ENERGY,
      reasons: retainedReasons,
      droppedReasonBuckets: Math.max(0, reasons.length - retainedReasons.length),
      truncatedObservations: Math.max(0, observations.length - bounded.length),
    },
    emergencyReservePreserved: input.emergencyReservePreserved,
    duplicateTargetsSuppressed: safeCount(input.duplicateTargetsSuppressed),
    work,
  });
}

function emptyTelemetry(): MaintenanceTelemetry {
  return deepFreeze({
    planner: { scanned: 0, admitted: 0, deferred: 0, truncated: 0 },
    energy: { requestedCap: 0, fundedCap: 0 },
    towers: {
      scheduled: 0,
      rejected: 0,
      failed: 0,
      cpuUsed: 0,
      energyScheduled: 0,
      reasons: [],
      droppedReasonBuckets: 0,
      truncatedObservations: 0,
    },
    emergencyReservePreserved: true,
    duplicateTargetsSuppressed: 0,
    work: { overshoot: 0, satisfied: 0, retired: 0 },
  });
}

function compareCommand(
  left: CommandExecutionResult<IntentEnvelope<DefenseIntentKind>>,
  right: CommandExecutionResult<IntentEnvelope<DefenseIntentKind>>,
): number {
  return left.intentId.localeCompare(right.intentId);
}

function normalizeReason(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : "unknown";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => saturatingAdd(total, safeCount(value)), 0);
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function saturatingAdd(left: number, right: number): number {
  return left >= Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
