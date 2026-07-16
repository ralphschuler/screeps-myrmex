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
import {
  advancePreparedReporterState,
  advanceRecoveryProgress,
  prepareReporterSignals,
  type ReporterSignal,
  type ReporterSignalBatch,
} from "./reporter-state";
import {
  recoveryObservationActive,
  type ReporterTransitionTelemetry,
  type TickTelemetry,
} from "./metrics";
import {
  reduceStaticMiningTelemetry,
  type StaticMiningSourceObservation,
  type StaticMiningTelemetryState,
} from "./static-mining";

type TickTelemetryBase = Omit<
  TickTelemetry,
  "activity" | "status" | "recoveryProgress" | "reporterTransitions" | "staticMining"
>;

export const TELEMETRY_OWNER_SCHEMA_VERSION = 3 as const;

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
  /** Immutable observer inputs only; no planner may consume the resulting telemetry. */
  readonly staticMining?: {
    readonly cpuUsed: number;
    readonly observations: readonly StaticMiningSourceObservation[];
  };
  /** Fixed tick-local signals derived from settled runtime health; never raw error payloads. */
  readonly reporterSignals: readonly ReporterSignal[];
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
    const owner = readOwnerSafely(ownerValue, input.base.telemetryPolicy.maximumHistoryEntries);
    const staticMining = safelyReduceStaticMining(owner.staticMining, input);
    const detailLimit = input.base.telemetryPolicy.maximumDetailRecords;
    const allDetails = collectDetails(input);
    const details = allDetails
      .sort(compareDetails)
      .slice(0, detailLimit)
      .map((detail) => deepFreeze(detail));
    const droppedDetails = Math.max(0, allDetails.length - details.length);
    const status = deepFreeze({
      hash: canonicalHash({
        base: telemetryHashView(input.base),
        details,
        staticMining: staticMining.telemetry,
      }),
      details: Object.freeze(details),
      droppedDetails,
    });
    const telemetryWithoutRecovery = {
      ...input.base,
      activity: activity(input),
      staticMining: staticMining.telemetry,
      status,
    };
    const persisted = writeOwner(
      owner,
      telemetryWithoutRecovery,
      details,
      input.reporterSignals,
      staticMining.state,
    );
    const telemetry = deepFreeze({
      ...telemetryWithoutRecovery,
      recoveryProgress: persisted.recoveryProgress,
      reporterTransitions: persisted.reporterTransitions,
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
  readonly staticMining: StaticMiningTelemetryState | null;
}

function readOwnerSafely(value: unknown, maximumHistoryEntries: number): ParsedOwner {
  try {
    return readOwner(value, maximumHistoryEntries);
  } catch {
    return emptyParsedOwner();
  }
}

function readOwner(value: unknown, maximumHistoryEntries: number): ParsedOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyParsedOwner();
  }
  const root = value as Record<string, unknown>;
  if (
    (root.schemaVersion !== 1 && root.schemaVersion !== 2 && root.schemaVersion !== 3) ||
    !Array.isArray(root.history)
  ) {
    return emptyParsedOwner();
  }
  const reporter = root.schemaVersion === 2 || root.schemaVersion === 3 ? root.reporter : undefined;
  const staticMining = root.schemaVersion === 3 ? readStaticMiningState(root.staticMining) : null;
  const priorDroppedHistory = readCounter(root.droppedHistory);
  const retainedLimit = safeNonnegativeInteger(maximumHistoryEntries);
  if (root.history.length > retainedLimit) {
    return {
      history: [],
      droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
      reporter,
      staticMining,
    };
  }
  const history: { tick: number; hash: string }[] = [];
  for (const entry of root.history) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        history: [],
        droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
        reporter,
        staticMining,
      };
    }
    const row = entry as Record<string, unknown>;
    const tick = row.tick;
    if (
      typeof row.hash !== "string" ||
      !/^fnv1a32-utf16:[0-9a-f]{8}$/.test(row.hash) ||
      typeof tick !== "number" ||
      !Number.isSafeInteger(tick) ||
      tick < 0
    ) {
      return {
        history: [],
        droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
        reporter,
        staticMining,
      };
    }
    history.push({ tick, hash: row.hash });
  }
  return {
    history,
    droppedHistory: priorDroppedHistory,
    reporter,
    staticMining,
  };
}

function emptyParsedOwner(): ParsedOwner {
  return { history: [], droppedHistory: 0, reporter: undefined, staticMining: null };
}

function readStaticMiningState(value: unknown): StaticMiningTelemetryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1 && Array.isArray(row.sources)
    ? (value as StaticMiningTelemetryState)
    : null;
}

function safelyReduceStaticMining(
  previous: StaticMiningTelemetryState | null,
  input: TelemetryServiceInput,
) {
  const reduction = {
    tick: input.base.tick,
    cpuUsed: input.staticMining?.cpuUsed ?? 0,
    observations: input.staticMining?.observations ?? [],
  };
  try {
    return reduceStaticMiningTelemetry({ ...reduction, previous });
  } catch {
    return reduceStaticMiningTelemetry({ ...reduction, previous: null });
  }
}

function readCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

interface MutableTelemetryOwner {
  schemaVersion: typeof TELEMETRY_OWNER_SCHEMA_VERSION;
  last: {
    tick: number;
    hash: string;
    droppedDetails: number;
  };
  history: { tick: number; hash: string }[];
  droppedHistory: number;
  reporter: {
    schemaVersion: 2;
    entries: JsonObject;
    recovery: JsonObject | null;
  };
  staticMining: {
    schemaVersion: 1;
    sources: StaticMiningTelemetryState["sources"][number][];
  };
}

function generatedReporterEntries(value: unknown): JsonObject[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  return root.schemaVersion === 1 && Array.isArray(root.entries)
    ? (root.entries as JsonObject[])
    : [];
}

function retainedReporterFingerprints(value: unknown): Set<string> {
  return new Set(
    generatedReporterEntries(value).flatMap((entry) =>
      typeof entry.fingerprint === "string" ? [entry.fingerprint] : [],
    ),
  );
}

function fitOwnerToByteBudget(owner: MutableTelemetryOwner, maximumBytes: number): void {
  const exceedsBudget = () =>
    utf8ByteLength(canonicalSerialize(owner)) > safeNonnegativeInteger(maximumBytes);
  while (exceedsBudget() && owner.history.length > 0) {
    owner.history.shift();
    owner.droppedHistory = saturatingIncrement(owner.droppedHistory);
  }
  const entries = generatedReporterEntries(owner.reporter.entries);
  while (exceedsBudget() && entries.length > 0) {
    const ordinary = entries.findIndex(
      (entry) =>
        typeof entry.fingerprint !== "string" ||
        !entry.fingerprint.startsWith("reporter-overflow:"),
    );
    entries.splice(ordinary < 0 ? 0 : ordinary, 1);
  }
  if (exceedsBudget()) owner.reporter.recovery = null;
  while (exceedsBudget() && owner.staticMining.sources.length > 0) {
    owner.staticMining.sources.pop();
  }
}

const REPORTER_PREPARATION_FAILED = "reporter-preparation-failed" as const;
type PreparedReporterInput = ReporterSignalBatch | null | typeof REPORTER_PREPARATION_FAILED;

function safelyPrepareReporter(
  details: readonly TelemetryDetail[],
  reporterSignals: readonly ReporterSignal[],
  policy: Pick<TickTelemetry["reporterPolicy"], "maximumSignalsPerTick">,
): PreparedReporterInput {
  try {
    const boundedReporterSignals = readBoundedSignals(
      reporterSignals,
      policy.maximumSignalsPerTick,
    );
    if (boundedReporterSignals === null) return null;
    return prepareReporterSignals(
      [
        ...details.map((detail) => ({
          kind: detail.domain,
          identity: detail.entityId,
          reasonCode: detail.reason,
        })),
        ...boundedReporterSignals,
      ],
      saturatingAdd(policy.maximumSignalsPerTick, details.length),
    );
  } catch {
    return REPORTER_PREPARATION_FAILED;
  }
}

function safelyAdvanceReporter(
  owner: unknown,
  tick: number,
  input: PreparedReporterInput,
  maximumRetainedFingerprints: number,
  policy: Pick<
    TickTelemetry["reporterPolicy"],
    | "maximumFingerprints"
    | "maximumSignalsPerTick"
    | "initialReminderDelayTicks"
    | "maximumReminderDelayTicks"
  >,
): ReturnType<typeof advancePreparedReporterState> {
  if (input === REPORTER_PREPARATION_FAILED) return emptyReporterResult();
  try {
    return advancePreparedReporterState(owner, tick, input, {
      maximumFingerprints: policy.maximumFingerprints,
      maximumRetainedFingerprints,
      initialReminderDelayTicks: policy.initialReminderDelayTicks,
      maximumReminderDelayTicks: policy.maximumReminderDelayTicks,
    });
  } catch {
    return emptyReporterResult();
  }
}

function emptyReporterResult(): ReturnType<typeof advancePreparedReporterState> {
  return { owner: { schemaVersion: 1, entries: [] }, events: [] };
}

function readBoundedSignals(
  value: readonly ReporterSignal[],
  maximumLength: number,
): readonly ReporterSignal[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    const limit = safeNonnegativeInteger(maximumLength);
    if (
      length === undefined ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > limit
    )
      return null;
    const output: ReporterSignal[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (entry === undefined || !("value" in entry)) return null;
      output.push(entry.value as ReporterSignal);
    }
    return output;
  } catch {
    return null;
  }
}

function safelyAdvanceRecovery(
  owner: unknown,
  telemetry: Omit<TickTelemetry, "recoveryProgress" | "reporterTransitions">,
  blocker: TelemetryDetail | null,
): ReturnType<typeof advanceRecoveryProgress> {
  try {
    return advanceRecoveryProgress(
      owner,
      {
        active: recoveryObservationActive(telemetry),
        blockerRef: blocker?.entityId ?? null,
        blockerReasonCode: blocker?.reason ?? "none",
        delivered: telemetry.energyFlow.delivered,
        harvested: telemetry.energyFlow.harvested,
        spawnDemand: telemetry.activity.spawnDemand,
        spawnScheduled: telemetry.activity.spawnScheduled,
        status: recoveryStateCode(telemetry),
        tick: telemetry.tick,
        unmet: telemetry.energyFlow.unmet,
      },
      {
        stuckWindowTicks: telemetry.reporterPolicy.stuckRecoveryWindowTicks,
        initialReminderDelayTicks: telemetry.reporterPolicy.initialReminderDelayTicks,
        maximumReminderDelayTicks: telemetry.reporterPolicy.maximumReminderDelayTicks,
      },
    );
  } catch {
    return { owner: null, event: null, status: null };
  }
}

function safelyResolveReporterSections(value: unknown): {
  readonly entries: unknown;
  readonly recovery: unknown;
} {
  try {
    return reporterSections(value);
  } catch {
    return { entries: undefined, recovery: undefined };
  }
}

function writeOwner(
  owner: ParsedOwner,
  telemetry: Omit<TickTelemetry, "recoveryProgress" | "reporterTransitions">,
  details: readonly TelemetryDetail[],
  reporterSignals: readonly ReporterSignal[],
  staticMining: StaticMiningTelemetryState,
): {
  readonly owner: JsonObject;
  readonly recoveryProgress: TickTelemetry["recoveryProgress"];
  readonly reporterTransitions: TickTelemetry["reporterTransitions"];
} {
  const policy = telemetry.telemetryPolicy;
  const appended = [...owner.history, { tick: telemetry.tick, hash: telemetry.status.hash }];
  const bounded =
    policy.maximumHistoryEntries === 0 ? [] : appended.slice(-policy.maximumHistoryEntries);
  const droppedHistory = saturatingAdd(owner.droppedHistory, appended.length - bounded.length);
  const history = bounded.map(({ tick, hash }) => ({ tick, hash }));
  const reporterOwner = safelyResolveReporterSections(owner.reporter);
  const blocker = details[0] ?? null;
  const recovery = safelyAdvanceRecovery(reporterOwner.recovery, telemetry, blocker);
  const reporterPolicy = {
    maximumFingerprints: telemetry.reporterPolicy.maximumFingerprints,
    maximumSignalsPerTick: telemetry.reporterPolicy.maximumSignalsPerTick,
    initialReminderDelayTicks: telemetry.reporterPolicy.initialReminderDelayTicks,
    maximumReminderDelayTicks: telemetry.reporterPolicy.maximumReminderDelayTicks,
  };
  const preparedReporter = safelyPrepareReporter(details, reporterSignals, reporterPolicy);
  let maximumRetainedFingerprints = safeNonnegativeInteger(
    telemetry.reporterPolicy.maximumFingerprints,
  );
  let reporter: ReturnType<typeof advancePreparedReporterState>;
  let result: MutableTelemetryOwner;
  for (;;) {
    reporter = safelyAdvanceReporter(
      reporterOwner.entries,
      telemetry.tick,
      preparedReporter,
      maximumRetainedFingerprints,
      reporterPolicy,
    );
    result = {
      schemaVersion: TELEMETRY_OWNER_SCHEMA_VERSION,
      last: {
        tick: telemetry.tick,
        hash: telemetry.status.hash,
        droppedDetails: telemetry.status.droppedDetails,
      },
      history: history.map((entry) => ({ ...entry })),
      droppedHistory,
      reporter: {
        schemaVersion: 2,
        entries: reporter.owner as JsonObject,
        recovery: recovery.owner as JsonObject | null,
      },
      staticMining: {
        schemaVersion: staticMining.schemaVersion,
        sources: staticMining.sources.map((source) => ({ ...source })),
      },
    };
    const generatedEntries = generatedReporterEntries(result.reporter.entries).length;
    fitOwnerToByteBudget(result, policy.maximumHistoryBytes);
    const fittedEntries = generatedReporterEntries(result.reporter.entries).length;
    if (fittedEntries >= generatedEntries) break;
    maximumRetainedFingerprints = fittedEntries;
  }
  const retainedFingerprints = retainedReporterFingerprints(result.reporter.entries);
  const recoveryRetained = result.reporter.recovery !== null;
  const transitions: ReporterTransitionTelemetry[] = [];
  if (recovery.event !== null && recoveryRetained) {
    transitions.push({
      category: "recovery",
      kind: "stuck",
      owner: recovery.event.owner,
      blockerReasonCode: recovery.event.blockerReasonCode,
      blockerRef: recovery.event.blockerRef,
      lastProgressTick: recovery.event.lastProgressTick,
      reminderAtTick: recovery.event.reminderAtTick,
      reasonCode: recovery.event.reasonCode,
    });
  }
  transitions.push(
    ...[...reporter.events]
      .filter((event) => event.kind === "resolved" || retainedFingerprints.has(event.fingerprint))
      .sort(compareReporterEvents)
      .map((event): ReporterTransitionTelemetry => ({
        category: "signal",
        kind: event.kind,
        fingerprint: event.fingerprint,
        count: event.count,
        reasonCode: event.reasonCode,
      })),
  );
  return {
    owner: result as unknown as JsonObject,
    recoveryProgress: recoveryRetained ? recovery.status : null,
    reporterTransitions: Object.freeze(
      transitions.slice(0, telemetry.reporterPolicy.maximumImmediateEventsPerTick),
    ),
  };
}

function reporterSections(value: unknown): {
  readonly entries: unknown;
  readonly recovery: unknown;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { entries: undefined, recovery: undefined };
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2) {
    return { entries: undefined, recovery: undefined };
  }
  return {
    entries: row.schemaVersion === 2 ? row.entries : row,
    recovery: row.schemaVersion === 2 ? row.recovery : undefined,
  };
}

function compareReporterEvents(
  left: { readonly kind: "first" | "reminder" | "resolved"; readonly fingerprint: string },
  right: { readonly kind: "first" | "reminder" | "resolved"; readonly fingerprint: string },
): number {
  const priority = (event: typeof left) => {
    if (event.kind === "resolved") return 4;
    const overflow = event.fingerprint.startsWith("reporter-overflow:");
    if (overflow) return event.kind === "first" ? 0 : 1;
    return event.kind === "first" ? 2 : 3;
  };
  return priority(left) - priority(right) || left.fingerprint.localeCompare(right.fingerprint);
}

function recoveryStateCode(telemetry: Pick<TickTelemetry, "colony">): string {
  const count = (id: "bootstrapping" | "recovering") =>
    telemetry.colony.states.find((state) => state.id === id)?.count ?? 0;
  return `bootstrapping-${String(count("bootstrapping"))}-recovering-${String(count("recovering"))}`;
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

function safeNonnegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function saturatingAdd(left: number, right: number): number {
  const safeLeft = safeNonnegativeInteger(left);
  const safeRight = safeNonnegativeInteger(right);
  return safeLeft > Number.MAX_SAFE_INTEGER - safeRight
    ? Number.MAX_SAFE_INTEGER
    : safeLeft + safeRight;
}

function saturatingIncrement(value: number): number {
  return saturatingAdd(value, 1);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
