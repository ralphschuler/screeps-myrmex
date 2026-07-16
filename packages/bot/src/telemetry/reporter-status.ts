import { FEATURE_GATE_IDS, type FeatureGateId } from "../config";
import type { KernelTickReport } from "../runtime/kernel/contracts";
import { opaqueId, safeCode } from "../security";
import { recoveryObservationActive, type TickTelemetry } from "./metrics";

export const REPORTER_STATUS_SCHEMA_VERSION = 2 as const;
const MAXIMUM_TRANSITION_COUNT = 1_000_000;

export interface ReporterStatusPolicy {
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
      diagnostic: telemetry?.observerDiagnostic ?? null,
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
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((transition): ReporterStatusTransition[] => {
      if (!isRecord(transition)) return [];
      if (
        transition.category === "signal" &&
        exactKeys(transition, ["category", "kind", "fingerprint", "count", "reasonCode"]) &&
        (transition.kind === "first" ||
          transition.kind === "reminder" ||
          transition.kind === "resolved") &&
        typeof transition.fingerprint === "string" &&
        typeof transition.count === "number" &&
        Number.isSafeInteger(transition.count) &&
        transition.count >= 1 &&
        typeof transition.reasonCode === "string"
      ) {
        return [
          Object.freeze({
            category: "signal" as const,
            kind: transition.kind,
            fingerprint: opaqueId("reporter-transition", transition.fingerprint),
            count: Math.min(MAXIMUM_TRANSITION_COUNT, transition.count),
            reasonCode: safeCode(transition.reasonCode),
          }),
        ];
      }
      if (
        transition.category === "recovery" &&
        exactKeys(transition, [
          "category",
          "kind",
          "owner",
          "blockerReasonCode",
          "blockerRef",
          "lastProgressTick",
          "reminderAtTick",
          "reasonCode",
        ]) &&
        transition.kind === "stuck" &&
        transition.owner === "colony" &&
        typeof transition.blockerReasonCode === "string" &&
        (typeof transition.blockerRef === "string" || transition.blockerRef === null) &&
        isTick(transition.lastProgressTick) &&
        isOptionalTick(transition.reminderAtTick) &&
        transition.reasonCode === "recovery-progress-unchanged"
      ) {
        return [
          Object.freeze({
            category: "recovery" as const,
            kind: "stuck" as const,
            owner: "colony" as const,
            blockerReasonCode: safeCode(transition.blockerReasonCode),
            blockerRef:
              transition.blockerRef === null
                ? null
                : opaqueId("reporter-blocker", transition.blockerRef),
            lastProgressTick: Math.min(tick, transition.lastProgressTick),
            reminderAtTick: boundedReminderTick(
              transition.reminderAtTick,
              tick,
              maximumReminderDelayTicks,
            ),
            reasonCode: "recovery-progress-unchanged" as const,
          }),
        ];
      }
      return [];
    })
    .sort(compareTransitions)
    .slice(0, Math.max(0, limit));
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

function compareTransitions(left: ReporterStatusTransition, right: ReporterStatusTransition) {
  const priority = (transition: ReporterStatusTransition) => {
    if (transition.category === "recovery") return 0;
    return transition.kind === "resolved" ? 1 : transition.kind === "first" ? 2 : 3;
  };
  const leftRef = left.category === "signal" ? left.fingerprint : (left.blockerRef ?? "none");
  const rightRef = right.category === "signal" ? right.fingerprint : (right.blockerRef ?? "none");
  return priority(left) - priority(right) || leftRef.localeCompare(rightRef);
}

function boundedReminderTick(
  value: number | null,
  tick: number,
  maximumReminderDelayTicks: number,
): number | null {
  return value === null ? null : Math.min(value, tick + Math.max(0, maximumReminderDelayTicks));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTick(value: unknown): value is number | null {
  return value === null || isTick(value);
}
