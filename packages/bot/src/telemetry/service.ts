import type { ColonyPlanningResult } from "../colony";
import type { ContractReconciliationResult } from "../contracts";
import type { ArbitrationBatch } from "../execution";
import type { GrowthCandidate } from "../growth";
import type { CriticalMaintenanceCandidate } from "../maintenance";
import type { MovementRuntimeResult } from "../movement";
import type { SpawnRuntimeResult } from "../spawn";
import type { JsonObject } from "../state/schema";
import type { WorldSnapshot } from "../world/snapshot";
import { opaqueId, safeCode } from "../security";
import { advanceRecoveryProgress, advanceReporterState } from "./reporter-state";
import type { TickTelemetry } from "./metrics";

type TickTelemetryBase = Omit<TickTelemetry, "activity" | "status" | "recoveryProgress">;

export const TELEMETRY_OWNER_SCHEMA_VERSION = 2 as const;

export interface TelemetryDetail {
  readonly domain: "budget" | "contract" | "intent" | "movement" | "spawn";
  readonly entityId: string;
  readonly reason: string;
  readonly status: string;
}

export interface TelemetryStatus {
  readonly hash: string;
  readonly details: readonly TelemetryDetail[];
  readonly droppedDetails: number;
}

export interface TelemetryServiceInput {
  readonly base: TickTelemetryBase;
  readonly colony: ColonyPlanningResult;
  readonly contracts: ContractReconciliationResult | null;
  readonly execution: ArbitrationBatch | null;
  readonly growth: readonly GrowthCandidate[];
  readonly maintenance: readonly CriticalMaintenanceCandidate[];
  readonly movement: MovementRuntimeResult;
  readonly snapshot: WorldSnapshot;
  readonly spawn: SpawnRuntimeResult;
}

export interface TelemetryServiceResult {
  readonly owner: JsonObject;
  readonly telemetry: TickTelemetry;
}

/**
 * The sole observer-owned telemetry authority. It consumes completed, immutable receipts only;
 * gameplay systems neither read this output nor receive the telemetry owner.
 */
export class TelemetryService {
  public record(ownerValue: unknown, input: TelemetryServiceInput): TelemetryServiceResult {
    const owner = readOwner(ownerValue);
    const detailLimit = input.base.telemetryPolicy.maximumDetailRecords;
    const allDetails = collectDetails(input);
    const details = allDetails
      .sort(compareDetails)
      .slice(0, detailLimit)
      .map((detail) => deepFreeze(detail));
    const droppedDetails = Math.max(0, allDetails.length - details.length);
    const status = deepFreeze({
      hash: canonicalHash({ base: telemetryHashView(input.base), details }),
      details: Object.freeze(details),
      droppedDetails,
    });
    const telemetryWithoutRecovery = {
      ...input.base,
      activity: activity(input),
      status,
    };
    const persisted = writeOwner(owner, telemetryWithoutRecovery, details);
    const telemetry = deepFreeze({
      ...telemetryWithoutRecovery,
      recoveryProgress: persisted.recoveryProgress,
    });
    return deepFreeze({
      owner: persisted.owner,
      telemetry,
    });
  }
}

interface ParsedOwner {
  readonly history: readonly { readonly tick: number; readonly hash: string }[];
  readonly droppedHistory: number;
  readonly reporter: unknown;
}

function readOwner(value: unknown): ParsedOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { history: [], droppedHistory: 0, reporter: undefined };
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length === 0)
    return { history: [], droppedHistory: 0, reporter: undefined };
  if (
    (root.schemaVersion !== 1 && root.schemaVersion !== TELEMETRY_OWNER_SCHEMA_VERSION) ||
    !Array.isArray(root.history)
  ) {
    return { history: [], droppedHistory: 0, reporter: undefined };
  }
  const history: { tick: number; hash: string }[] = root.history.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const tick = row.tick;
    return typeof row.hash === "string" &&
      typeof tick === "number" &&
      Number.isSafeInteger(tick) &&
      tick >= 0
      ? [{ tick, hash: row.hash.slice(0, 64) }]
      : [];
  });
  return {
    history: history.slice(-64),
    droppedHistory:
      typeof root.droppedHistory === "number" && Number.isSafeInteger(root.droppedHistory)
        ? Math.max(0, root.droppedHistory)
        : 0,
    reporter: root.schemaVersion === TELEMETRY_OWNER_SCHEMA_VERSION ? root.reporter : undefined,
  };
}

function writeOwner(
  owner: ParsedOwner,
  telemetry: Omit<TickTelemetry, "recoveryProgress">,
  details: readonly TelemetryDetail[],
): { readonly owner: JsonObject; readonly recoveryProgress: TickTelemetry["recoveryProgress"] } {
  const policy = telemetry.telemetryPolicy;
  const appended = [...owner.history, { tick: telemetry.tick, hash: telemetry.status.hash }];
  const bounded = appended.slice(-policy.maximumHistoryEntries);
  const droppedHistory = owner.droppedHistory + appended.length - bounded.length;
  const history = bounded.map(({ tick, hash }) => ({ tick, hash }));
  const reporterOwner = reporterSections(owner.reporter);
  const reporter = advanceReporterState(
    reporterOwner.entries,
    telemetry.tick,
    details.map((detail) => ({
      kind: detail.domain,
      identity: detail.entityId,
      reasonCode: detail.reason,
    })),
    {
      maximumFingerprints: Math.min(24, telemetry.reporterPolicy.maximumFingerprints),
      initialReminderDelayTicks: telemetry.reporterPolicy.initialReminderDelayTicks,
      maximumReminderDelayTicks: telemetry.reporterPolicy.maximumReminderDelayTicks,
    },
  );
  const blocker = details[0] ?? null;
  const recovery = advanceRecoveryProgress(
    reporterOwner.recovery,
    {
      active: telemetry.memoryStatus === "recovery",
      blockerRef: blocker?.entityId ?? null,
      blockerReasonCode: blocker?.reason ?? "none",
      delivered: telemetry.energyFlow.delivered,
      harvested: telemetry.energyFlow.harvested,
      spawnDemand: telemetry.activity.spawnDemand,
      spawnScheduled: telemetry.activity.spawnScheduled,
      status: telemetry.colony.status,
      tick: telemetry.tick,
      unmet: telemetry.energyFlow.unmet,
    },
    {
      stuckWindowTicks: telemetry.reporterPolicy.stuckRecoveryWindowTicks,
      initialReminderDelayTicks: telemetry.reporterPolicy.initialReminderDelayTicks,
      maximumReminderDelayTicks: telemetry.reporterPolicy.maximumReminderDelayTicks,
    },
  );
  const result = {
    schemaVersion: TELEMETRY_OWNER_SCHEMA_VERSION,
    last: {
      tick: telemetry.tick,
      hash: telemetry.status.hash,
      droppedDetails: telemetry.status.droppedDetails,
    },
    history,
    droppedHistory,
    reporter: {
      schemaVersion: 2,
      entries: reporter.owner as JsonObject,
      recovery: recovery.owner as JsonObject | null,
    },
  };
  while (
    utf8ByteLength(canonicalSerialize(result)) > policy.maximumHistoryBytes &&
    history.length > 0
  ) {
    history.shift();
    result.droppedHistory += 1;
  }
  return { owner: result, recoveryProgress: recovery.status };
}

function reporterSections(value: unknown): {
  readonly entries: unknown;
  readonly recovery: unknown;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { entries: undefined, recovery: undefined };
  }
  const row = value as Record<string, unknown>;
  return {
    entries: row.schemaVersion === 2 ? row.entries : row,
    recovery: row.schemaVersion === 2 ? row.recovery : undefined,
  };
}

function activity(input: TelemetryServiceInput): TickTelemetry["activity"] {
  const contracts = input.contracts;
  const broker = input.spawn.broker;
  return deepFreeze({
    activeContracts: input.contracts?.allocation.assignments.length ?? 0,
    contractFundingDenied:
      contracts?.funding.filter(({ status }) => status === "denied").length ?? 0,
    contractReleases: contracts?.releases.length ?? 0,
    controllerRisks: input.colony.colonies.filter(({ controllerRisk }) => controllerRisk === true)
      .length,
    criticalMaintenance: input.maintenance.length,
    growthCandidates: input.growth.length,
    hostileRooms: input.snapshot.rooms.filter(({ hostileCreeps }) => hostileCreeps.length > 0)
      .length,
    intentAccepted: input.execution?.accepted.length ?? 0,
    intentDenied:
      input.execution?.decisions.filter(({ status }) => status !== "accepted").length ?? 0,
    leaseCount: contracts?.allocation.assignments.length ?? 0,
    movementBlocked: input.movement.movementDecisions.filter(({ reason }) => reason === "blocked")
      .length,
    spawnDemand: broker?.decisions.length ?? 0,
    spawnScheduled: input.spawn.execution.filter(({ status }) => status === "scheduled").length,
  });
}

function collectDetails(input: TelemetryServiceInput): TelemetryDetail[] {
  const details: TelemetryDetail[] = [];
  for (const decision of input.colony.decisions) {
    if (decision.status !== "granted" && decision.status !== "retained") {
      details.push(detail("budget", decision.reservationId, decision.status, decision.reasonCode));
    }
  }
  for (const decision of input.contracts?.funding ?? []) {
    if (decision.status !== "authorized") {
      details.push(detail("contract", decision.contractId, decision.status, decision.reason));
    }
  }
  for (const release of input.contracts?.releases ?? []) {
    details.push(detail("contract", release.contractId, "released", release.reason));
  }
  for (const decision of input.execution?.decisions ?? []) {
    if (decision.status !== "accepted") {
      details.push(detail("intent", decision.intent.id, decision.status, decision.reason));
    }
  }
  for (const decision of input.movement.movementDecisions) {
    if (decision.status !== "accepted") {
      details.push(detail("movement", decision.intent.id, decision.status, decision.reason));
    }
  }
  for (const result of input.spawn.execution) {
    if (result.status !== "scheduled") {
      details.push(detail("spawn", result.intentId, result.status, result.reason));
    }
  }
  return details;
}

function detail(
  domain: TelemetryDetail["domain"],
  id: string,
  status: string,
  reason: string,
): TelemetryDetail {
  return {
    domain,
    entityId: opaqueId(domain, id),
    status: safeCode(status),
    reason: safeCode(reason),
  };
}

function compareDetails(left: TelemetryDetail, right: TelemetryDetail): number {
  return (
    left.domain.localeCompare(right.domain) ||
    left.entityId.localeCompare(right.entityId) ||
    left.status.localeCompare(right.status) ||
    left.reason.localeCompare(right.reason)
  );
}

function telemetryHashView(telemetry: TickTelemetryBase): TickTelemetryBase {
  return telemetry;
}

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
    .join(",")}}`;
}

function canonicalHash(value: unknown): string {
  const serialized = canonicalSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-utf16:${hash.toString(16).padStart(8, "0")}`;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
