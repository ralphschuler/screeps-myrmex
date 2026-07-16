import { FEATURE_GATE_IDS, type FeatureGateId } from "../config";
import type { KernelTickReport } from "../runtime/kernel/contracts";
import { opaqueId, safeCode } from "../security";
import type { TickTelemetry } from "./metrics";

export const REPORTER_STATUS_SCHEMA_VERSION = 1 as const;

export interface ReporterStatusPolicy {
  readonly maximumImmediateEventsPerTick: number;
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
}

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
        required: telemetry?.memoryStatus === "recovery",
        spawnDemand: telemetry?.activity.spawnDemand ?? 0,
        harvested: telemetry?.energyFlow.harvested ?? 0,
        delivered: telemetry?.energyFlow.delivered ?? 0,
        unmet: telemetry?.energyFlow.unmet ?? 0,
        stuck:
          telemetry?.recoveryProgress === null || telemetry?.recoveryProgress === undefined
            ? null
            : Object.freeze({
                blockerReasonCode: safeCode(telemetry.recoveryProgress.blockerReasonCode),
                blockerRef: telemetry.recoveryProgress.blockerRef,
                lastProgressTick: telemetry.recoveryProgress.lastProgressTick,
                reminderAtTick: telemetry.recoveryProgress.reminderAtTick,
                active: telemetry.recoveryProgress.stuck,
              }),
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
  });
}
