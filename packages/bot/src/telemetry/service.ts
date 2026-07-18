import type { ColonyPlanningResult } from "../colony";
import type { ContractReconciliationResult } from "../contracts";
import type { ArbitrationBatch } from "../execution";
import type { GrowthCandidate } from "../growth";
import type { IndustryTelemetry } from "../industry";
import type { LayoutRuntimeResult } from "../layout";
import type { LinkRuntimeResult } from "../links";
import {
  projectMaintenanceTelemetry,
  type CriticalMaintenanceCandidate,
  type MaintenanceTelemetryInput,
} from "../maintenance";
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
import {
  reduceLogisticsTelemetry,
  type LogisticsFlowObservation,
  type LogisticsTelemetryState,
} from "./logistics";
import {
  emptyPhase2TelemetryObservation,
  PHASE2_RCL_DESTINATIONS,
  observePhase2Telemetry,
  projectPhase2RclTelemetry,
  projectPhase2TelemetryWindow,
  reducePhase2Telemetry,
  type Phase2RclTransitionDuration,
  type Phase2TelemetryState,
  type Phase2TelemetryStateInput,
  type Phase2TelemetryStateV2,
} from "./phase2";
import {
  emptyPhase2AttritionState,
  hasPhase2AttritionEvidence,
  projectPhase2AttritionTelemetry,
  type Phase2AttritionRow,
  type Phase2AttritionState,
} from "./phase2-attrition";

type TickTelemetryBase = Omit<
  TickTelemetry,
  | "activity"
  | "status"
  | "recoveryProgress"
  | "reporterTransitions"
  | "staticMining"
  | "logistics"
  | "maintenanceV2"
  | "industry"
  | "phase2"
>;

export const TELEMETRY_OWNER_SCHEMA_VERSION = 5 as const;

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
  /** Settled phase-2 maintenance receipts; omitted while the gate is inactive. */
  readonly maintenanceTelemetry?: MaintenanceTelemetryInput;
  readonly industry?: IndustryTelemetry;
  /** Direct settled layout receipts; omitted only by legacy tests or while unavailable. */
  readonly layout?: LayoutRuntimeResult;
  /** Direct settled link receipts; omitted only by legacy tests or while unavailable. */
  readonly links?: LinkRuntimeResult;
  readonly movement: MovementRuntimeResult;
  readonly snapshot: WorldSnapshot;
  readonly spawn: SpawnRuntimeResult;
  /** Immutable observer inputs only; no planner may consume the resulting telemetry. */
  readonly staticMining?: {
    readonly cpuUsed: number;
    readonly observations: readonly StaticMiningSourceObservation[];
  };
  /** Cumulative settled flow facts; telemetry derives tick deltas from its bounded owner state. */
  readonly logistics?: {
    readonly cpuUsed: number;
    readonly observations: readonly LogisticsFlowObservation[];
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
    const logistics = safelyReduceLogistics(owner.logistics, input);
    const maintenanceV2 = projectMaintenanceTelemetry(input.maintenanceTelemetry);
    const industry = input.industry ?? emptyIndustryTelemetry();
    const phase2 = safelyReducePhase2(
      owner.phase2,
      input,
      {
        staticMining: staticMining.telemetry,
        logistics: logistics.telemetry,
        maintenance: maintenanceV2,
        industry,
      },
      owner.lastTick === input.base.tick,
    );
    const detailLimit = input.base.telemetryPolicy.maximumDetailRecords;
    const allDetails = collectDetails(input);
    const details = allDetails
      .sort(compareDetails)
      .slice(0, detailLimit)
      .map((detail) => deepFreeze(detail));
    const droppedDetails = Math.max(0, allDetails.length - details.length);
    const frozenDetails = Object.freeze(details);
    const statusFor = (phase2Telemetry: TickTelemetry["phase2"]): TelemetryStatus =>
      deepFreeze({
        hash: canonicalHash({
          base: telemetryHashView(input.base),
          details: frozenDetails,
          logistics: logistics.telemetry,
          maintenanceV2,
          industry,
          phase2: phase2Telemetry,
          staticMining: staticMining.telemetry,
        }),
        details: frozenDetails,
        droppedDetails,
      });
    const status = statusFor(phase2.telemetry);
    const telemetryWithoutRecovery = {
      ...input.base,
      activity: activity(input),
      logistics: logistics.telemetry,
      maintenanceV2,
      industry,
      phase2: phase2.telemetry,
      staticMining: staticMining.telemetry,
      status,
    };
    const persisted = writeOwner(
      owner,
      telemetryWithoutRecovery,
      details,
      input.reporterSignals,
      staticMining.state,
      logistics.state,
      phase2.state,
    );
    const fittedPhase2 = projectFittedPhase2Telemetry(phase2.telemetry, persisted.owner);
    const fittedStatus = statusFor(fittedPhase2);
    replaceCurrentTelemetryHash(persisted.owner, input.base.tick, fittedStatus.hash);
    const telemetry = deepFreeze({
      ...telemetryWithoutRecovery,
      phase2: fittedPhase2,
      status: fittedStatus,
      recoveryProgress: persisted.recoveryProgress,
      reporterTransitions: persisted.reporterTransitions,
    });
    return deepFreeze({
      owner: persisted.owner,
      telemetry,
    });
  }
}

function projectFittedPhase2Telemetry(
  telemetry: TickTelemetry["phase2"],
  owner: JsonObject,
): TickTelemetry["phase2"] {
  const phase2Owner = (owner as Record<string, unknown>).phase2;
  const fitted = readPhase2State(phase2Owner);
  const fittedRcl =
    fitted?.schemaVersion === 2 || fitted?.schemaVersion === 3
      ? projectPhase2RclTelemetry(fitted)
      : undefined;
  const fittedWindow =
    fitted?.schemaVersion === 2 || fitted?.schemaVersion === 3
      ? projectPhase2TelemetryWindow(fitted)
      : telemetry.window;
  const projectedAttrition =
    fitted?.schemaVersion === 3
      ? projectPhase2AttritionTelemetry(fitted.attrition)
      : telemetry.attrition;
  const fittedAttrition =
    projectedAttrition !== undefined && hasPhase2AttritionEvidence(projectedAttrition)
      ? projectedAttrition
      : undefined;
  const { rcl: _previousRcl, ...progression } = telemetry.progression;
  const { attrition: _previousAttrition, ...telemetryWithoutAttrition } = telemetry;
  void _previousRcl;
  void _previousAttrition;
  return deepFreeze({
    ...telemetryWithoutAttrition,
    progression: {
      ...progression,
      ...(fittedRcl === undefined ? {} : { rcl: fittedRcl }),
    },
    ...(fittedAttrition === undefined ? {} : { attrition: fittedAttrition }),
    window: fittedWindow,
  });
}

function replaceCurrentTelemetryHash(owner: JsonObject, tick: number, hash: string): void {
  const root = owner as Record<string, unknown>;
  const last = root.last;
  if (typeof last === "object" && last !== null && !Array.isArray(last)) {
    const row = last as Record<string, unknown>;
    if (row.tick === tick) row.hash = hash;
  }
  const history = root.history;
  if (!Array.isArray(history) || history.length === 0) return;
  const entry: unknown = history[history.length - 1];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
  const row = entry as Record<string, unknown>;
  if (row.tick === tick) row.hash = hash;
}

function emptyIndustryTelemetry(): IndustryTelemetry {
  return deepFreeze({
    accounting: {
      consumed: 0,
      hauled: 0,
      mined: 0,
      reserved: 0,
      sent: 0,
      transactionEnergy: 0,
      unmet: 0,
    },
    commands: { executed: 0, failed: 0, rejected: 0 },
    deferred: 0,
    extractionProposals: 0,
    sendProposals: 0,
    states: [],
  });
}

interface ParsedOwner {
  readonly lastTick: number | null;
  readonly history: readonly { readonly tick: number; readonly hash: string }[];
  readonly droppedHistory: number;
  readonly reporter: unknown;
  readonly staticMining: StaticMiningTelemetryState | null;
  readonly logistics: LogisticsTelemetryState | null;
  readonly phase2: Phase2TelemetryStateInput | null;
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
    (root.schemaVersion !== 1 &&
      root.schemaVersion !== 2 &&
      root.schemaVersion !== 3 &&
      root.schemaVersion !== 4 &&
      root.schemaVersion !== 5) ||
    !Array.isArray(root.history)
  ) {
    return emptyParsedOwner();
  }
  const lastTick = readLastTick(root.last);
  const reporter = root.schemaVersion >= 2 ? root.reporter : undefined;
  const staticMining = root.schemaVersion >= 3 ? readStaticMiningState(root.staticMining) : null;
  const logistics = root.schemaVersion >= 4 ? readLogisticsState(root.logistics) : null;
  const phase2 = root.schemaVersion === 5 ? readPhase2State(root.phase2) : null;
  const priorDroppedHistory = readCounter(root.droppedHistory);
  const retainedLimit = safeNonnegativeInteger(maximumHistoryEntries);
  if (root.history.length > retainedLimit) {
    return {
      lastTick,
      history: [],
      droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
      reporter,
      staticMining,
      logistics,
      phase2,
    };
  }
  const history: { tick: number; hash: string }[] = [];
  for (const entry of root.history) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        lastTick,
        history: [],
        droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
        reporter,
        staticMining,
        logistics,
        phase2,
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
        lastTick,
        history: [],
        droppedHistory: saturatingAdd(priorDroppedHistory, root.history.length),
        reporter,
        staticMining,
        logistics,
        phase2,
      };
    }
    history.push({ tick, hash: row.hash });
  }
  return {
    lastTick,
    history,
    droppedHistory: priorDroppedHistory,
    reporter,
    staticMining,
    logistics,
    phase2,
  };
}

function emptyParsedOwner(): ParsedOwner {
  return {
    lastTick: null,
    history: [],
    droppedHistory: 0,
    reporter: undefined,
    staticMining: null,
    logistics: null,
    phase2: null,
  };
}

function readLogisticsState(value: unknown): LogisticsTelemetryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1 && Array.isArray(row.flows)
    ? (value as LogisticsTelemetryState)
    : null;
}

function readStaticMiningState(value: unknown): StaticMiningTelemetryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1 && Array.isArray(row.sources)
    ? (value as StaticMiningTelemetryState)
    : null;
}

function readPhase2State(value: unknown): Phase2TelemetryStateInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.samples)) return null;
  if (row.schemaVersion === 1) return value as Phase2TelemetryStateInput;
  if (row.schemaVersion !== 2 && row.schemaVersion !== 3) return null;
  const attrition = row.schemaVersion === 3 ? readAttritionField(row) : undefined;
  const build = (timing: {
    readonly rclTimingSchemaVersion: 1;
    readonly interruptedRclTracks: number;
    readonly droppedRclObservations: number;
    readonly droppedRclTransitions: number;
    readonly rclTracks: Phase2TelemetryState["rclTracks"];
    readonly rclTransitionDurations: readonly Phase2RclTransitionDuration[];
  }): Phase2TelemetryState | Phase2TelemetryStateV2 => {
    const common = {
      droppedSamples: row.droppedSamples as number,
      samples: row.samples as Phase2TelemetryState["samples"],
      ...timing,
    };
    return row.schemaVersion === 3
      ? { schemaVersion: 3, ...common, attrition: attrition ?? emptyPhase2AttritionState() }
      : { schemaVersion: 2, ...common };
  };
  const invalidTiming = () =>
    build({
      rclTimingSchemaVersion: 0 as unknown as 1,
      interruptedRclTracks: 0,
      droppedRclObservations: 0,
      droppedRclTransitions: 0,
      rclTracks: [],
      rclTransitionDurations: [],
    });
  try {
    if (!Array.isArray(row.rcl) || row.rcl.length !== 6) return invalidTiming();
    const [timingSchema, interrupted, droppedObservations, droppedTransitions, tracks, entries] =
      row.rcl as unknown[];
    if (!Array.isArray(entries) || entries.length > PHASE2_RCL_DESTINATIONS.length)
      return invalidTiming();
    const durations: Phase2RclTransitionDuration[] = PHASE2_RCL_DESTINATIONS.map(() => [
      0,
      0,
      null,
      null,
      null,
      null,
    ]);
    const seen = new Set<number>();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 7) return invalidTiming();
      const [index, ...duration] = entry as unknown[];
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= durations.length ||
        seen.has(index)
      )
        return invalidTiming();
      seen.add(index);
      durations[index] = duration as unknown as Phase2RclTransitionDuration;
    }
    return build({
      rclTimingSchemaVersion: timingSchema as 1,
      interruptedRclTracks: interrupted as number,
      droppedRclObservations: droppedObservations as number,
      droppedRclTransitions: droppedTransitions as number,
      rclTracks: tracks as Phase2TelemetryState["rclTracks"],
      rclTransitionDurations: durations,
    });
  } catch {
    return invalidTiming();
  }
}

function readAttritionField(row: Record<string, unknown>): Phase2AttritionState {
  try {
    return readCompactAttritionState(row.attrition);
  } catch {
    return emptyPhase2AttritionState();
  }
}

function readCompactAttritionState(value: unknown): Phase2AttritionState {
  try {
    if (!Array.isArray(value) || value.length !== 8) return emptyPhase2AttritionState();
    const [
      schemaVersion,
      lastTick,
      interruptedAssets,
      droppedObservations,
      droppedRows,
      colonies,
      tracks,
      rows,
    ] = value as unknown[];
    if (!Array.isArray(colonies) || !Array.isArray(tracks) || !Array.isArray(rows))
      return emptyPhase2AttritionState();
    return {
      schemaVersion: schemaVersion as 1,
      lastTick: lastTick as number | null,
      interruptedAssets: interruptedAssets as number,
      droppedObservations: droppedObservations as number,
      droppedRows: droppedRows as number,
      colonies: colonies as string[],
      tracks: tracks as Phase2AttritionState["tracks"],
      rows: rows as unknown as [Phase2AttritionRow, Phase2AttritionRow],
    };
  } catch {
    return emptyPhase2AttritionState();
  }
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

function safelyReduceLogistics(
  previous: LogisticsTelemetryState | null,
  input: TelemetryServiceInput,
) {
  const reduction = {
    tick: input.base.tick,
    cpuUsed: input.logistics?.cpuUsed ?? 0,
    observations: input.logistics?.observations ?? [],
  };
  try {
    return reduceLogisticsTelemetry({ ...reduction, previous });
  } catch {
    return reduceLogisticsTelemetry({ ...reduction, previous: null, observations: [] });
  }
}

function safelyReducePhase2(
  previous: Phase2TelemetryStateInput | null,
  input: TelemetryServiceInput,
  evidence: {
    readonly staticMining: ReturnType<typeof reduceStaticMiningTelemetry>["telemetry"];
    readonly logistics: ReturnType<typeof reduceLogisticsTelemetry>["telemetry"];
    readonly maintenance: ReturnType<typeof projectMaintenanceTelemetry>;
    readonly industry: IndustryTelemetry;
  },
  sameTickReplay: boolean,
) {
  try {
    return reducePhase2Telemetry({
      observation: observePhase2Telemetry({
        tick: input.base.tick,
        snapshot: input.snapshot,
        colony: input.colony,
        spawn: input.spawn,
        ...(input.layout === undefined ? {} : { layout: input.layout }),
        ...(input.links === undefined ? {} : { links: input.links }),
        ...evidence,
      }),
      previous,
      maximumSamples: input.base.telemetryPolicy.maximumHistoryEntries,
      sameTickReplay,
    });
  } catch {
    return reducePhase2Telemetry({
      observation: { ...emptyPhase2TelemetryObservation(input.base.tick), droppedInputs: 1 },
      previous: null,
      maximumSamples: input.base.telemetryPolicy.maximumHistoryEntries,
    });
  }
}

function readCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readLastTick(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const tick = (value as Record<string, unknown>).tick;
  return typeof tick === "number" && Number.isSafeInteger(tick) && tick >= 0 ? tick : null;
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
  logistics: {
    schemaVersion: 1;
    flows: LogisticsTelemetryState["flows"][number][];
  };
  phase2: {
    schemaVersion: 3;
    droppedSamples: number;
    samples: Phase2TelemetryState["samples"][number][];
    rcl: [
      timingSchemaVersion: 1,
      interruptedTracks: number,
      droppedObservations: number,
      droppedTransitions: number,
      tracks: Phase2TelemetryState["rclTracks"][number][],
      durations: [destinationIndex: number, ...duration: Phase2RclTransitionDuration][],
    ];
    attrition?: [
      schemaVersion: 1,
      lastTick: number | null,
      interruptedAssets: number,
      droppedObservations: number,
      droppedRows: number,
      colonies: string[],
      tracks: Phase2AttritionState["tracks"][number][],
      rows: [Phase2AttritionRow, Phase2AttritionRow],
    ];
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

function fitOwnerToByteBudget(
  owner: MutableTelemetryOwner,
  maximumBytes: number,
  sameTickReplay: boolean,
): void {
  const exceedsBudget = () =>
    utf8ByteLength(canonicalSerialize(owner)) > safeNonnegativeInteger(maximumBytes);
  while (exceedsBudget() && owner.history.length > 0) {
    owner.history.shift();
    if (!sameTickReplay) owner.droppedHistory = saturatingIncrement(owner.droppedHistory);
  }
  while (exceedsBudget() && owner.phase2.samples.length > 0) {
    owner.phase2.samples.shift();
    if (!sameTickReplay)
      owner.phase2.droppedSamples = saturatingIncrement(owner.phase2.droppedSamples);
  }
  while (exceedsBudget() && owner.phase2.rcl[4].length > 0) {
    owner.phase2.rcl[4].pop();
    if (!sameTickReplay) owner.phase2.rcl[1] = saturatingIncrement(owner.phase2.rcl[1]);
  }
  if (exceedsBudget() && owner.phase2.rcl[5].length > 0) {
    const dropped = owner.phase2.rcl[5].reduce(
      (sum, [, samples]) => saturatingAdd(sum, samples),
      0,
    );
    if (!sameTickReplay) owner.phase2.rcl[3] = saturatingAdd(owner.phase2.rcl[3], dropped);
    owner.phase2.rcl[5] = [];
  }
  const attrition = owner.phase2.attrition;
  if (
    attrition !== undefined &&
    exceedsBudget() &&
    (attrition[1] !== null || attrition[5].length > 0 || attrition[6].length > 0)
  ) {
    if (!sameTickReplay) attrition[2] = saturatingAdd(attrition[2], attrition[6].length);
    attrition[1] = null;
    attrition[5] = [];
    attrition[6] = [];
  }
  if (
    attrition !== undefined &&
    exceedsBudget() &&
    attrition[7].some((row) => row.some((value) => value > 0))
  ) {
    const droppedRows = attrition[7].filter((row) => row.some((value) => value > 0)).length;
    if (!sameTickReplay) attrition[4] = saturatingAdd(attrition[4], droppedRows);
    attrition[7] = [
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ];
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
  while (exceedsBudget() && owner.logistics.flows.length > 0) {
    owner.logistics.flows.pop();
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

function shouldPersistPhase2Attrition(state: Phase2AttritionState): boolean {
  return (
    state.lastTick !== null ||
    state.colonies.length > 0 ||
    state.tracks.length > 0 ||
    state.interruptedAssets > 0 ||
    state.droppedObservations > 0 ||
    state.droppedRows > 0 ||
    state.rows.some((row) => row.some((value) => value > 0))
  );
}

function writeOwner(
  owner: ParsedOwner,
  telemetry: Omit<TickTelemetry, "recoveryProgress" | "reporterTransitions">,
  details: readonly TelemetryDetail[],
  reporterSignals: readonly ReporterSignal[],
  staticMining: StaticMiningTelemetryState,
  logistics: LogisticsTelemetryState,
  phase2: Phase2TelemetryState,
): {
  readonly owner: JsonObject;
  readonly recoveryProgress: TickTelemetry["recoveryProgress"];
  readonly reporterTransitions: TickTelemetry["reporterTransitions"];
} {
  const policy = telemetry.telemetryPolicy;
  const sameTickReplay = owner.lastTick === telemetry.tick;
  const previousHistory = owner.history[owner.history.length - 1];
  const appended =
    previousHistory?.tick === telemetry.tick
      ? [...owner.history.slice(0, -1), { tick: telemetry.tick, hash: telemetry.status.hash }]
      : [...owner.history, { tick: telemetry.tick, hash: telemetry.status.hash }];
  const bounded =
    policy.maximumHistoryEntries === 0 ? [] : appended.slice(-policy.maximumHistoryEntries);
  const droppedHistory = sameTickReplay
    ? owner.droppedHistory
    : saturatingAdd(owner.droppedHistory, appended.length - bounded.length);
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
      logistics: {
        schemaVersion: logistics.schemaVersion,
        flows: logistics.flows.map((flow) => ({ ...flow })),
      },
      phase2: {
        schemaVersion: phase2.schemaVersion,
        droppedSamples: phase2.droppedSamples,
        samples: phase2.samples.map((sample) => ({ ...sample })),
        rcl: [
          phase2.rclTimingSchemaVersion,
          phase2.interruptedRclTracks,
          phase2.droppedRclObservations,
          phase2.droppedRclTransitions,
          phase2.rclTracks.map((track) => [...track]),
          phase2.rclTransitionDurations.flatMap((duration, index) =>
            duration[0] === 0 ? [] : [[index, ...duration]],
          ),
        ],
        ...(shouldPersistPhase2Attrition(phase2.attrition)
          ? {
              attrition: [
                phase2.attrition.schemaVersion,
                phase2.attrition.lastTick,
                phase2.attrition.interruptedAssets,
                phase2.attrition.droppedObservations,
                phase2.attrition.droppedRows,
                [...phase2.attrition.colonies],
                phase2.attrition.tracks.map((track) => [...track]),
                phase2.attrition.rows.map((row) => [...row]) as unknown as [
                  Phase2AttritionRow,
                  Phase2AttritionRow,
                ],
              ] as NonNullable<MutableTelemetryOwner["phase2"]["attrition"]>,
            }
          : {}),
      },
    };
    const generatedEntries = generatedReporterEntries(result.reporter.entries).length;
    fitOwnerToByteBudget(result, policy.maximumHistoryBytes, sameTickReplay);
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
  for (const deferral of input.contracts?.allocation.deferred ?? []) {
    details.push(detail("contract", deferral.contractId, "deferred", deferral.reason));
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
