import { FEATURE_GATE_IDS, type FeatureGateId } from "../config";
import type { KernelTickReport } from "../runtime/kernel/contracts";
import { opaqueId, safeCode } from "../security";
import { recoveryObservationActive, type TickTelemetry } from "./metrics";

export const REPORTER_STATUS_SCHEMA_VERSION = 2 as const;
const MAXIMUM_TRANSITION_COUNT = 1_000_000;
const MAXIMUM_TRANSITIONS_PER_TICK = 64;

export interface ReporterStatusPolicy {
  readonly maximumDiagnosticDurationTicks: number;
  readonly maximumImmediateEventsPerTick: number;
  readonly maximumReminderDelayTicks: number;
}

export interface ReporterDiagnostic {
  readonly level: "debug" | "trace";
  readonly categories: readonly ("recovery" | "blockers" | "faults")[];
  readonly expiresAtTick: number;
}

export interface ReporterStatus {
  readonly schemaVersion: typeof REPORTER_STATUS_SCHEMA_VERSION;
  readonly tick: number;
  readonly projectionStatus: "ready" | "fallback";
  readonly runtime: {
    readonly buildSource: string;
    readonly shardRef: string;
    readonly memoryStatus: "ready" | "recovery" | "unsupported";
    readonly cpuMode: KernelTickReport["mode"];
    readonly cpuBucket: number;
    readonly cpuLimit: number;
    readonly cpuUsedMilli: number;
    readonly degraded: boolean;
  };
  readonly observer: { readonly status: "ready" | "unavailable"; readonly hash: string | null };
  readonly diagnostic: ReporterDiagnostic | null;
  readonly colony: { readonly status: string; readonly objectives: number };
  readonly recovery: {
    readonly required: boolean;
    readonly spawnDemand: number;
    readonly harvested: number;
    readonly delivered: number;
    readonly unmet: number;
    readonly stuck: {
      readonly blockerReasonCode: string;
      readonly blockerRef: string | null;
      readonly lastProgressTick: number;
      readonly reminderAtTick: number | null;
      readonly active: boolean;
    } | null;
  };
  readonly gates: readonly {
    readonly id: FeatureGateId;
    readonly enabled: boolean;
    readonly reason: string;
  }[];
  readonly blockers: readonly {
    readonly domain: string;
    readonly entityRef: string;
    readonly status: string;
    readonly reasonCode: string;
  }[];
  readonly faults: readonly {
    readonly systemId: string;
    readonly phase: string;
    readonly stage: string;
    readonly reasonCode: "unexpected-exception";
  }[];
  readonly transitions: readonly ReporterStatusTransition[];
}

export type ReporterStatusTransition =
  | {
      readonly category: "signal";
      readonly kind: "first" | "reminder" | "resolved";
      readonly fingerprint: string;
      readonly count: number;
      readonly reasonCode: string;
    }
  | {
      readonly category: "recovery";
      readonly kind: "stuck";
      readonly owner: "colony";
      readonly blockerReasonCode: string;
      readonly blockerRef: string | null;
      readonly lastProgressTick: number;
      readonly reminderAtTick: number | null;
      readonly reasonCode: "recovery-progress-unchanged";
    };

/** Builds a renderer-safe, tick-local observer view after the final kernel report exists. */
export function projectReporterStatus(
  telemetry: TickTelemetry | null,
  kernel: KernelTickReport,
  policy: ReporterStatusPolicy,
): ReporterStatus {
  try {
    const limit = policy.maximumImmediateEventsPerTick;
    const blockers =
      telemetry === null
        ? []
        : [...telemetry.status.details]
            .sort(
              (left, right) =>
                left.domain.localeCompare(right.domain) ||
                left.entityId.localeCompare(right.entityId),
            )
            .slice(0, limit)
            .map((detail) => ({
              domain: safeCode(detail.domain),
              entityRef: opaqueId("telemetry-detail", detail.entityId),
              status: safeCode(detail.status),
              reasonCode: safeCode(detail.reason),
            }));
    const faults = [...kernel.faults]
      .sort(
        (left, right) =>
          left.phase.localeCompare(right.phase) ||
          left.systemId.localeCompare(right.systemId) ||
          left.stage.localeCompare(right.stage),
      )
      .slice(0, limit)
      .map((fault) => ({
        systemId: safeCode(fault.systemId),
        phase: safeCode(fault.phase),
        stage: safeCode(fault.stage),
        reasonCode: "unexpected-exception" as const,
      }));
    const transitions = projectTransitions(
      telemetry?.reporterTransitions,
      kernel.tick,
      limit,
      policy.maximumReminderDelayTicks,
    );
    const source = telemetry?.configSourceRevision ?? "telemetry-unavailable";
    return Object.freeze({
      schemaVersion: REPORTER_STATUS_SCHEMA_VERSION,
      tick: kernel.tick,
      projectionStatus: "ready" as const,
      runtime: Object.freeze({
        buildSource: safeCode(source),
        shardRef: opaqueId("shard", telemetry?.shard ?? "unavailable"),
        memoryStatus: telemetry?.memoryStatus ?? "unsupported",
        cpuMode: kernel.mode,
        cpuBucket: telemetry?.cpuBucket ?? 0,
        cpuLimit: kernel.cpu.limit,
        cpuUsedMilli: Math.round(kernel.cpuUsed * 1_000),
        degraded: kernel.degraded,
      }),
      observer: Object.freeze({
        status: telemetry === null ? "unavailable" : "ready",
        hash: telemetry?.status.hash ?? null,
      }),
      diagnostic: projectDiagnostic(
        telemetry?.observerDiagnostic,
        kernel.tick,
        policy.maximumDiagnosticDurationTicks,
      ),
      colony: Object.freeze({
        status: safeCode(telemetry?.colony.status ?? "unavailable"),
        objectives: telemetry?.colony.objectives ?? 0,
      }),
      recovery: Object.freeze({
        required: telemetry === null ? false : recoveryObservationActive(telemetry),
        spawnDemand: telemetry?.activity.spawnDemand ?? 0,
        harvested: telemetry?.energyFlow.harvested ?? 0,
        delivered: telemetry?.energyFlow.delivered ?? 0,
        unmet: telemetry?.energyFlow.unmet ?? 0,
        stuck: projectRecoveryProgress(
          telemetry?.recoveryProgress,
          kernel.tick,
          policy.maximumReminderDelayTicks,
        ),
      }),
      gates: Object.freeze(
        FEATURE_GATE_IDS.map((id) => ({
          id,
          enabled: telemetry?.featureGates.find((gate) => gate.id === id)?.enabled ?? false,
          reason: safeCode(
            telemetry?.featureGates.find((gate) => gate.id === id)?.reason ?? "unavailable",
          ),
        })),
      ),
      blockers: Object.freeze(blockers),
      faults: Object.freeze(faults),
      transitions: Object.freeze(transitions),
    });
  } catch {
    return fallback(kernel);
  }
}

function fallback(kernel: KernelTickReport): ReporterStatus {
  return Object.freeze({
    schemaVersion: REPORTER_STATUS_SCHEMA_VERSION,
    tick: kernel.tick,
    projectionStatus: "fallback",
    runtime: Object.freeze({
      buildSource: "invalid-code",
      shardRef: opaqueId("shard", "unavailable"),
      memoryStatus: "unsupported",
      cpuMode: kernel.mode,
      cpuBucket: 0,
      cpuLimit: kernel.cpu.limit,
      cpuUsedMilli: 0,
      degraded: true,
    }),
    observer: Object.freeze({ status: "unavailable", hash: null }),
    diagnostic: null,
    colony: Object.freeze({ status: "unavailable", objectives: 0 }),
    recovery: Object.freeze({
      required: false,
      spawnDemand: 0,
      harvested: 0,
      delivered: 0,
      unmet: 0,
      stuck: null,
    }),
    gates: Object.freeze([]),
    blockers: Object.freeze([]),
    faults: Object.freeze([]),
    transitions: Object.freeze([]),
  });
}

function projectTransitions(
  value: unknown,
  tick: number,
  limit: number,
  maximumReminderDelayTicks: number,
): ReporterStatusTransition[] {
  const traversalLimit =
    Number.isSafeInteger(limit) && limit >= 0 ? Math.min(limit, MAXIMUM_TRANSITIONS_PER_TICK) : 0;
  const input = readBoundedDataArray(value, traversalLimit);
  if (input === null) return [];
  const projected: ReporterStatusTransition[] = [];
  for (const candidate of input) {
    const transition = projectTransition(candidate, tick, maximumReminderDelayTicks);
    if (transition !== null) projected.push(transition);
  }
  return projected.sort(compareTransitions);
}

function projectTransition(
  value: unknown,
  tick: number,
  maximumReminderDelayTicks: number,
): ReporterStatusTransition | null {
  const signal = readDataRecord(value, ["category", "kind", "fingerprint", "count", "reasonCode"]);
  if (
    signal !== null &&
    signal.category === "signal" &&
    (signal.kind === "first" || signal.kind === "reminder" || signal.kind === "resolved") &&
    typeof signal.fingerprint === "string" &&
    typeof signal.count === "number" &&
    Number.isSafeInteger(signal.count) &&
    signal.count >= 1 &&
    typeof signal.reasonCode === "string"
  ) {
    return Object.freeze({
      category: "signal" as const,
      kind: signal.kind,
      fingerprint: opaqueId("reporter-transition", signal.fingerprint),
      count: Math.min(MAXIMUM_TRANSITION_COUNT, signal.count),
      reasonCode: safeCode(signal.reasonCode),
    });
  }
  const recovery = readDataRecord(value, [
    "category",
    "kind",
    "owner",
    "blockerReasonCode",
    "blockerRef",
    "lastProgressTick",
    "reminderAtTick",
    "reasonCode",
  ]);
  if (
    recovery !== null &&
    recovery.category === "recovery" &&
    recovery.kind === "stuck" &&
    recovery.owner === "colony" &&
    typeof recovery.blockerReasonCode === "string" &&
    (typeof recovery.blockerRef === "string" || recovery.blockerRef === null) &&
    isTick(recovery.lastProgressTick) &&
    isOptionalTick(recovery.reminderAtTick) &&
    recovery.reasonCode === "recovery-progress-unchanged"
  ) {
    return Object.freeze({
      category: "recovery" as const,
      kind: "stuck" as const,
      owner: "colony" as const,
      blockerReasonCode: safeCode(recovery.blockerReasonCode),
      blockerRef:
        recovery.blockerRef === null ? null : opaqueId("reporter-blocker", recovery.blockerRef),
      lastProgressTick: Math.min(tick, recovery.lastProgressTick),
      reminderAtTick: boundedReminderTick(recovery.reminderAtTick, tick, maximumReminderDelayTicks),
      reasonCode: "recovery-progress-unchanged" as const,
    });
  }
  return null;
}

function projectRecoveryProgress(
  value: unknown,
  tick: number,
  maximumReminderDelayTicks: number,
): ReporterStatus["recovery"]["stuck"] {
  if (
    !isRecord(value) ||
    typeof value.blockerReasonCode !== "string" ||
    (typeof value.blockerRef !== "string" && value.blockerRef !== null) ||
    !isTick(value.lastProgressTick) ||
    !isOptionalTick(value.reminderAtTick) ||
    typeof value.stuck !== "boolean"
  )
    return null;
  return Object.freeze({
    blockerReasonCode: safeCode(value.blockerReasonCode),
    blockerRef: value.blockerRef === null ? null : opaqueId("reporter-blocker", value.blockerRef),
    lastProgressTick: Math.min(tick, value.lastProgressTick),
    reminderAtTick: boundedReminderTick(value.reminderAtTick, tick, maximumReminderDelayTicks),
    active: value.stuck,
  });
}

function projectDiagnostic(
  value: unknown,
  tick: number,
  maximumDurationTicks: number,
): ReporterDiagnostic | null {
  const diagnostic = readDataRecord(value, ["level", "categories", "expiresAtTick"]);
  if (
    diagnostic === null ||
    (diagnostic.level !== "debug" && diagnostic.level !== "trace") ||
    !isTick(diagnostic.expiresAtTick) ||
    diagnostic.expiresAtTick <= tick ||
    diagnostic.expiresAtTick > saturatingAdd(tick, maximumDurationTicks)
  )
    return null;
  const categories = readBoundedDataArray(diagnostic.categories, 3);
  if (categories === null) return null;
  if (
    categories.length === 0 ||
    categories.some(
      (category) => category !== "recovery" && category !== "blockers" && category !== "faults",
    ) ||
    new Set(categories).size !== categories.length
  )
    return null;
  return Object.freeze({
    level: diagnostic.level,
    categories: Object.freeze(
      [...(categories as ReporterDiagnostic["categories"])].sort(compareStrings),
    ),
    expiresAtTick: diagnostic.expiresAtTick,
  });
}

function compareTransitions(left: ReporterStatusTransition, right: ReporterStatusTransition) {
  const priority = (transition: ReporterStatusTransition) => {
    if (transition.category === "recovery") return 0;
    if (transition.kind === "resolved") return 5;
    const overflow = transition.reasonCode === "reporter-cardinality-overflow";
    if (overflow) return transition.kind === "first" ? 1 : 2;
    return transition.kind === "first" ? 3 : 4;
  };
  const leftRef = left.category === "signal" ? left.fingerprint : (left.blockerRef ?? "none");
  const rightRef = right.category === "signal" ? right.fingerprint : (right.blockerRef ?? "none");
  const leftReason = left.category === "signal" ? left.reasonCode : left.blockerReasonCode;
  const rightReason = right.category === "signal" ? right.reasonCode : right.blockerReasonCode;
  const leftCount = left.category === "signal" ? left.count : left.lastProgressTick;
  const rightCount = right.category === "signal" ? right.count : right.lastProgressTick;
  const leftReminder = left.category === "recovery" ? (left.reminderAtTick ?? -1) : -1;
  const rightReminder = right.category === "recovery" ? (right.reminderAtTick ?? -1) : -1;
  return (
    priority(left) - priority(right) ||
    compareStrings(leftRef, rightRef) ||
    compareStrings(leftReason, rightReason) ||
    leftCount - rightCount ||
    leftReminder - rightReminder
  );
}

function boundedReminderTick(
  value: number | null,
  tick: number,
  maximumReminderDelayTicks: number,
): number | null {
  if (value === null) return null;
  const delay =
    Number.isSafeInteger(maximumReminderDelayTicks) && maximumReminderDelayTicks >= 0
      ? maximumReminderDelayTicks
      : 0;
  const maximum = Math.min(Number.MAX_SAFE_INTEGER, tick, Number.MAX_SAFE_INTEGER - delay) + delay;
  return Math.min(value, maximum);
}

function saturatingAdd(left: number, right: number): number {
  const safeLeft = isTick(left) ? left : 0;
  const safeRight = isTick(right) ? right : 0;
  return safeLeft > Number.MAX_SAFE_INTEGER - safeRight
    ? Number.MAX_SAFE_INTEGER
    : safeLeft + safeRight;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedDataArray(value: unknown, maximumLength: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maximumLength
    )
      return null;
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (entry === undefined || !("value" in entry)) return null;
      output.push(entry.value);
    }
    return output;
  } catch {
    return null;
  }
}

function readDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!isRecord(value)) return null;
    const output: Record<string, unknown> = {};
    for (const key of expected) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field === undefined || !field.enumerable || !("value" in field)) return null;
      output[key] = field.value;
    }
    return output;
  } catch {
    return null;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTick(value: unknown): value is number | null {
  return value === null || isTick(value);
}
