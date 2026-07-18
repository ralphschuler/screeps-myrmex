import type { ColonyPlanningResult } from "../colony";
import type { IndustryTelemetry } from "../industry";
import type { LayoutRuntimeResult } from "../layout";
import type { LinkRuntimeResult } from "../links";
import type { MaintenanceTelemetry } from "../maintenance";
import { opaqueId } from "../security";
import type { SpawnRuntimeResult } from "../spawn";
import type { WorldSnapshot } from "../world/snapshot";
import type { LogisticsTelemetry } from "./logistics";
import {
  emptyPhase2AttritionState,
  hasPhase2AttritionEvidence,
  observePhase2Attrition,
  reducePhase2Attrition,
  type Phase2AttritionObservation,
  type Phase2AttritionState,
  type Phase2AttritionTelemetry,
} from "./phase2-attrition";
import type { StaticMiningTelemetry } from "./static-mining";

export const PHASE2_TELEMETRY_SCHEMA_VERSION = 3 as const;
export const MAX_PHASE2_TELEMETRY_SAMPLES = 64 as const;
export const MAX_PHASE2_CONTROLLER_TRACKERS = 64 as const;
export const PHASE2_RCL_TIMING_SCHEMA_VERSION = 1 as const;

export const PHASE2_RCL_DESTINATIONS = Object.freeze([2, 3, 4, 5, 6, 7, 8] as const);

export const PHASE2_AUTHORITY_IDS = Object.freeze([
  "colony",
  "spawn",
  "mining",
  "logistics",
  "layout",
  "links",
  "maintenance",
  "resources",
  "labs",
  "mature",
  "observer",
] as const);

export type Phase2AuthorityId = (typeof PHASE2_AUTHORITY_IDS)[number];

export const PHASE2_FLOW_IDENTITY_IDS = Object.freeze([
  "links-sent",
  "logistics-requested",
  "maintenance-budget",
] as const);

export const PHASE2_WINDOW_FIELDS = Object.freeze([
  "samples",
  "firstTick",
  "lastTick",
  "harvestedEnergy",
  "logisticsDelivered",
  "linkDelivered",
  "industryOutput",
  "authorityFailures",
  "reserveViolations",
  "measuredCpuMilli",
  "droppedSamples",
] as const);

/** Fixed-cardinality settled observations. Every quantity is current-tick evidence, never policy. */
export interface Phase2ControllerObservation {
  readonly colonyRef: string;
  readonly level: number;
}

export interface Phase2TelemetryObservation {
  readonly tick: number;
  /** Complete bounded road/container facts used only for adjacent-snapshot net attrition. */
  readonly attrition: Phase2AttritionObservation;
  /** Bounded opaque owned-controller identities used only for continuous transition timing. */
  readonly controllerLevels: readonly Phase2ControllerObservation[];
  /** Whole timing batch is invalid when positive; value counts all omitted controller facts. */
  readonly droppedControllerLevels: number;
  readonly controllers: number;
  readonly rcl8Controllers: number;
  readonly sustainingColonies: number;
  readonly controllerProgress: number;
  readonly controllerProgressTotal: number;
  readonly minimumDowngradeTicks: number | null;
  readonly energyAvailable: number;
  readonly energyCapacity: number;
  readonly storedEnergy: number;
  readonly terminalEnergy: number;
  readonly reserveViolations: number;
  readonly colonyEnergyReserved: number;
  readonly colonyCpuReserved: number;
  readonly colonySpawnTicksReserved: number;
  readonly activeSpawns: number;
  readonly busySpawns: number;
  readonly scheduledSpawns: number;
  readonly deferredSpawns: number;
  readonly failedSpawns: number;
  readonly scheduledSpawnEnergy: number;
  readonly scheduledSpawnTicks: number;
  readonly constructionBacklog: number;
  readonly constructionProgressRemaining: number;
  readonly layoutComplete: number;
  readonly layoutDegraded: number;
  readonly layoutAccepted: number;
  readonly layoutDeferred: number;
  readonly layoutRejected: number;
  readonly layoutExecuted: number;
  readonly layoutFailed: number;
  readonly harvestedEnergy: number;
  readonly wastedEnergy: number;
  readonly sourceUptimeTicks: number;
  readonly sourceDowntimeTicks: number;
  readonly logisticsActiveFlows: number;
  readonly logisticsDeferredFlows: number;
  readonly logisticsRequested: number;
  readonly logisticsScheduled: number;
  readonly logisticsDelivered: number;
  readonly logisticsShortfall: number;
  readonly logisticsLoss: number;
  readonly linkAccepted: number;
  readonly linkDeferred: number;
  readonly linkFailed: number;
  readonly linkSent: number;
  readonly linkDelivered: number;
  readonly linkLost: number;
  readonly maintenanceAdmitted: number;
  readonly maintenanceDeferred: number;
  readonly maintenanceFailed: number;
  readonly maintenanceRequestedEnergy: number;
  readonly maintenanceFundedEnergy: number;
  readonly maintenanceEnergy: number;
  readonly industryAdmitted: number;
  readonly industryDeferred: number;
  readonly industryFailed: number;
  readonly industryReserved: number;
  readonly terminalTransactionEnergyPlanned: number;
  readonly labAdmitted: number;
  readonly labDeferred: number;
  readonly labFailed: number;
  readonly labOutput: number;
  readonly matureAdmitted: number;
  readonly matureDeferred: number;
  readonly matureFailed: number;
  readonly factoryOutput: number;
  readonly powerOutput: number;
  readonly observerAdmitted: number;
  readonly observerDeferred: number;
  readonly observerFailed: number;
  readonly measuredCpuMilli: number;
  readonly droppedInputs: number;
}

export interface Phase2TelemetrySample {
  readonly tick: number;
  readonly harvestedEnergy: number;
  readonly logisticsDelivered: number;
  readonly linkDelivered: number;
  readonly industryOutput: number;
  readonly authorityFailures: number;
  readonly reserveViolations: number;
  readonly measuredCpuMilli: number;
}

/** Compact persistent active baseline: colony ref, level, entered tick, latest continuous tick. */
export type Phase2RclTrack = readonly [
  colonyRef: string,
  level: number,
  enteredAtTick: number,
  lastObservedTick: number,
];

/** Fixed row aligned with PHASE2_RCL_DESTINATIONS. */
export type Phase2RclTransitionDuration = readonly [
  samples: number,
  totalTicks: number,
  minimumTicks: number | null,
  maximumTicks: number | null,
  latestTicks: number | null,
  latestTick: number | null,
];

/** Compact current projection of the latest fixed row plus cumulative evidence-loss counters. */
export type Phase2RclTelemetry = readonly [
  destinationRcl: number | null,
  samples: number,
  totalTicks: number,
  minimumTicks: number | null,
  maximumTicks: number | null,
  latestTicks: number | null,
  latestTick: number | null,
  interruptedTracks: number,
  droppedObservations: number,
  droppedTransitions: number,
];

export interface Phase2TelemetryStateV1 {
  readonly schemaVersion: 1;
  readonly droppedSamples: number;
  readonly samples: readonly Phase2TelemetrySample[];
}

export interface Phase2TelemetryStateV2 {
  readonly schemaVersion: 2;
  readonly droppedSamples: number;
  readonly samples: readonly Phase2TelemetrySample[];
  readonly rclTimingSchemaVersion: typeof PHASE2_RCL_TIMING_SCHEMA_VERSION;
  readonly interruptedRclTracks: number;
  readonly droppedRclObservations: number;
  readonly droppedRclTransitions: number;
  readonly rclTracks: readonly Phase2RclTrack[];
  readonly rclTransitionDurations: readonly Phase2RclTransitionDuration[];
}

export interface Phase2TelemetryState {
  readonly schemaVersion: typeof PHASE2_TELEMETRY_SCHEMA_VERSION;
  readonly droppedSamples: number;
  readonly samples: readonly Phase2TelemetrySample[];
  readonly rclTimingSchemaVersion: typeof PHASE2_RCL_TIMING_SCHEMA_VERSION;
  readonly interruptedRclTracks: number;
  readonly droppedRclObservations: number;
  readonly droppedRclTransitions: number;
  readonly rclTracks: readonly Phase2RclTrack[];
  readonly rclTransitionDurations: readonly Phase2RclTransitionDuration[];
  readonly attrition: Phase2AttritionState;
}

export type Phase2TelemetryStateInput =
  Phase2TelemetryState | Phase2TelemetryStateV2 | Phase2TelemetryStateV1;

/** One row aligned with PHASE2_AUTHORITY_IDS; tuple fields keep the tick summary byte-bounded. */
export type Phase2AuthorityTelemetry = readonly [
  admitted: number,
  deferred: number,
  failed: number,
  energy: number,
  resourceUnits: number,
  cpuMilli: number,
  spawnTicks: number,
];

/** One row aligned with PHASE2_FLOW_IDENTITY_IDS. */
export type Phase2FlowIdentityTelemetry = readonly [balanced: boolean, residual: number];

/** Aggregate row aligned with PHASE2_WINDOW_FIELDS. */
export type Phase2TelemetryWindow = readonly [
  samples: number,
  firstTick: number | null,
  lastTick: number | null,
  harvestedEnergy: number,
  logisticsDelivered: number,
  linkDelivered: number,
  industryOutput: number,
  authorityFailures: number,
  reserveViolations: number,
  measuredCpuMilli: number,
  droppedSamples: number,
];

export interface Phase2Telemetry {
  readonly schemaVersion: typeof PHASE2_TELEMETRY_SCHEMA_VERSION;
  readonly progression: {
    readonly controllers: number;
    readonly rcl8Controllers: number;
    readonly sustainingColonies: number;
    readonly controllerProgress: number;
    readonly controllerProgressTotal: number;
    readonly minimumDowngradeTicks: number | null;
    /** Omitted until timing completion or evidence loss exists; full seven-row history stays bounded. */
    readonly rcl?: Phase2RclTelemetry;
  };
  readonly reserves: {
    readonly energyAvailable: number;
    readonly energyCapacity: number;
    readonly storedEnergy: number;
    readonly terminalEnergy: number;
    readonly violations: number;
  };
  readonly spawn: {
    readonly active: number;
    readonly busy: number;
    readonly idle: number;
    readonly scheduled: number;
    readonly failed: number;
    readonly energy: number;
    readonly spawnTicks: number;
    readonly utilizationBasisPoints: number | null;
  };
  readonly construction: {
    readonly backlog: number;
    readonly progressRemaining: number;
    readonly completePlans: number;
    readonly degradedPlans: number;
  };
  readonly flows: {
    readonly harvestedEnergy: number;
    readonly wastedEnergy: number;
    readonly sourceUptimeTicks: number;
    readonly sourceDowntimeTicks: number;
    readonly logistics: {
      readonly requested: number;
      readonly scheduled: number;
      readonly delivered: number;
      readonly shortfall: number;
      readonly loss: number;
    };
    readonly links: {
      readonly sent: number;
      readonly delivered: number;
      readonly lost: number;
    };
    readonly maintenanceEnergy: number;
    readonly terminalTransactionEnergyPlanned: number;
    readonly labOutput: number;
    readonly factoryOutput: number;
    readonly powerOutput: number;
  };
  readonly authorities: readonly Phase2AuthorityTelemetry[];
  readonly identities: readonly Phase2FlowIdentityTelemetry[];
  /** Omitted while only a baseline exists and no attrition/loss counter has evidence. */
  readonly attrition?: Phase2AttritionTelemetry;
  readonly window: Phase2TelemetryWindow;
  readonly droppedInputs: number;
}

export interface Phase2TelemetryReduction {
  readonly state: Phase2TelemetryState;
  readonly telemetry: Phase2Telemetry;
}

/** Builds one fixed observation from direct current facts and settled authority receipts. */
export function observePhase2Telemetry(input: {
  readonly tick: number;
  readonly snapshot: WorldSnapshot;
  readonly colony: ColonyPlanningResult;
  readonly spawn: SpawnRuntimeResult;
  readonly layout?: LayoutRuntimeResult;
  readonly links?: LinkRuntimeResult;
  readonly staticMining: StaticMiningTelemetry;
  readonly logistics: LogisticsTelemetry;
  readonly maintenance: MaintenanceTelemetry;
  readonly industry: IndustryTelemetry;
}): Phase2TelemetryObservation {
  const rooms = input.snapshot.ownedRooms;
  const controllers = rooms.map(({ controller }) => controller);
  const downgradeTicks = controllers.flatMap(({ ticksToDowngrade }) =>
    ticksToDowngrade === null ? [] : [ticksToDowngrade],
  );
  const spawns = rooms.flatMap(({ ownedSpawns }) => ownedSpawns).filter(({ active }) => active);
  const scheduled = input.spawn.execution.filter(({ status }) => status === "scheduled");
  const layout = input.layout;
  const arbitration = layout?.arbitration;
  const links = input.links;
  const linkRooms = links?.rooms ?? [];
  const linkExecution = links?.execution ?? [];
  const maintenance = input.maintenance;
  const industry = input.industry;
  const labs = industry.labs;
  const mature = industry.mature;
  const observer = industry.observer;
  const constructionSites = rooms.flatMap(({ constructionSites: sites }) =>
    sites.filter(({ ownership }) => ownership === "owned"),
  );
  const energyIn = (
    resources: readonly { readonly amount: number; readonly resourceType: string }[],
  ) => resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0;
  const linkSent = total(linkExecution.map(({ actualSentAmount }) => actualSentAmount));
  const linkDelivered = total(
    linkExecution.map(({ actualDeliveredAmount }) => actualDeliveredAmount),
  );
  const linkLost = total(linkExecution.map(({ actualLostAmount }) => actualLostAmount));
  const matureSettlements = mature?.settlements;
  const measuredCpu =
    input.staticMining.cpuUsed +
    input.logistics.cpuUsed +
    maintenance.towers.cpuUsed +
    input.spawn.execution.reduce((sum, result) => sum + Math.max(0, result.cpuUsed), 0);
  return normalizeObservation({
    tick: input.tick,
    attrition: observePhase2Attrition(input.snapshot),
    controllerLevels: rooms.slice(0, MAX_PHASE2_CONTROLLER_TRACKERS).map((room) => ({
      colonyRef: opaqueId("colony", room.name),
      level: room.controller.level,
    })),
    droppedControllerLevels: rooms.length > MAX_PHASE2_CONTROLLER_TRACKERS ? rooms.length : 0,
    controllers: controllers.length,
    rcl8Controllers: controllers.filter(({ level }) => level === 8).length,
    sustainingColonies: input.colony.colonies.filter(
      ({ rclPolicy }) => rclPolicy.progression.status === "sustaining",
    ).length,
    controllerProgress: total(controllers.map(({ progress }) => progress ?? 0)),
    controllerProgressTotal: total(controllers.map(({ progressTotal }) => progressTotal ?? 0)),
    minimumDowngradeTicks: downgradeTicks.length === 0 ? null : Math.min(...downgradeTicks),
    energyAvailable: total(rooms.map(({ energyAvailable }) => energyAvailable)),
    energyCapacity: total(rooms.map(({ energyCapacityAvailable }) => energyCapacityAvailable)),
    storedEnergy: total(
      rooms.flatMap(({ ownedStorages }) =>
        (ownedStorages ?? []).map(({ store }) => energyIn(store.resources)),
      ),
    ),
    terminalEnergy: total(
      rooms.flatMap(({ ownedTerminals }) =>
        (ownedTerminals ?? []).map(({ store }) => energyIn(store.resources)),
      ),
    ),
    reserveViolations: input.colony.colonies.filter(
      ({ rclPolicy }) => rclPolicy.protectedSpawnReserve.state === "unrestored",
    ).length,
    colonyEnergyReserved: input.colony.totals.energyReserved,
    colonyCpuReserved: input.colony.totals.cpuReserved,
    colonySpawnTicksReserved: input.colony.totals.spawnTicksReserved,
    activeSpawns: spawns.length,
    busySpawns: spawns.filter(({ spawning }) => spawning !== null).length,
    scheduledSpawns: scheduled.length,
    deferredSpawns:
      input.spawn.broker?.decisions.filter(({ status }) => status === "deferred").length ?? 0,
    failedSpawns: total([
      input.spawn.execution.filter(({ status }) => status !== "scheduled").length,
      input.spawn.broker?.decisions.filter(
        ({ status }) => status === "impossible" || status === "invalid",
      ).length ?? 0,
    ]),
    scheduledSpawnEnergy: total(scheduled.map(({ command }) => command.energyCost)),
    scheduledSpawnTicks: total(scheduled.map(({ command }) => command.spawnTicks)),
    constructionBacklog: constructionSites.length,
    constructionProgressRemaining: total(
      constructionSites.map(({ progress, progressTotal }) => Math.max(0, progressTotal - progress)),
    ),
    layoutComplete: layout?.planning.filter(({ status }) => status === "complete").length ?? 0,
    layoutDegraded: layout?.planning.filter(({ status }) => status === "degraded").length ?? 0,
    layoutAccepted: arbitration?.accepted.length ?? 0,
    layoutDeferred: arbitration?.deferred.length ?? 0,
    layoutRejected: arbitration?.rejected.length ?? 0,
    layoutExecuted:
      layout?.execution.filter(({ called, code }) => called && code === "OK").length ?? 0,
    layoutFailed: layout?.execution.filter(({ code }) => code !== "OK").length ?? 0,
    harvestedEnergy: input.staticMining.harvestedEnergy,
    wastedEnergy: input.staticMining.wastedEnergy,
    sourceUptimeTicks: input.staticMining.sourceUptimeTicks,
    sourceDowntimeTicks: saturatingAdd(
      input.staticMining.minerIdleTicks,
      input.staticMining.replacementGapTicks,
    ),
    logisticsActiveFlows: input.logistics.activeFlows,
    logisticsDeferredFlows: input.logistics.flows.filter(({ shortfall }) => shortfall > 0).length,
    logisticsRequested: input.logistics.requested,
    logisticsScheduled: input.logistics.scheduled,
    logisticsDelivered: input.logistics.delivered,
    logisticsShortfall: input.logistics.shortfall,
    logisticsLoss: input.logistics.loss,
    linkAccepted: total(linkRooms.map(({ arbitration: value }) => value.accepted.length)),
    linkDeferred: saturatingAdd(
      total(linkRooms.map(({ arbitration: value }) => value.deferred.length)),
      linkExecution.filter(({ code }) => code === "DEFERRED_BACKOFF").length,
    ),
    linkFailed: linkExecution.filter(({ code }) => code !== "OK" && code !== "DEFERRED_BACKOFF")
      .length,
    linkSent,
    linkDelivered,
    linkLost,
    maintenanceAdmitted: maintenance.planner.admitted,
    maintenanceDeferred: maintenance.planner.deferred,
    maintenanceFailed: maintenance.towers.failed,
    maintenanceRequestedEnergy: maintenance.energy.requestedCap,
    maintenanceFundedEnergy: maintenance.energy.fundedCap,
    maintenanceEnergy: maintenance.towers.energyScheduled,
    industryAdmitted: saturatingAdd(industry.extractionProposals, industry.sendProposals),
    industryDeferred: industry.deferred,
    industryFailed: saturatingAdd(industry.commands.failed, industry.commands.rejected),
    industryReserved: industry.accounting.reserved,
    terminalTransactionEnergyPlanned: industry.accounting.transactionEnergy,
    labAdmitted: labs?.intents ?? 0,
    labDeferred: saturatingAdd(labs?.readinessBlockers ?? 0, labs?.retries ?? 0),
    labFailed: saturatingAdd(labs?.commands.failed ?? 0, labs?.commands.rejected ?? 0),
    labOutput: labs?.settledAmount ?? 0,
    matureAdmitted: mature?.intents.total ?? 0,
    matureDeferred: saturatingAdd(matureSettlements?.pending ?? 0, matureSettlements?.retries ?? 0),
    matureFailed: saturatingAdd(mature?.commands.failed ?? 0, mature?.commands.rejected ?? 0),
    factoryOutput: matureSettlements?.settledFactoryAmount ?? 0,
    powerOutput: matureSettlements?.settledPower ?? 0,
    observerAdmitted: observer?.dispositions.accepted ?? 0,
    observerDeferred: total([
      observer?.dispositions.deferred ?? 0,
      observer?.dispositions.pending ?? 0,
      observer?.settlements.retries ?? 0,
    ]),
    observerFailed: total([
      observer?.commands.failed ?? 0,
      observer?.commands.rejected ?? 0,
      observer?.dispositions.rejected ?? 0,
    ]),
    measuredCpuMilli: Math.round(measuredCpu * 1_000),
    droppedInputs: total([
      Math.max(0, rooms.length - MAX_PHASE2_CONTROLLER_TRACKERS),
      input.staticMining.droppedSources,
      input.logistics.droppedFlows,
      maintenance.planner.truncated,
      maintenance.towers.truncatedObservations,
      mature?.truncated === true ? 1 : 0,
      observer?.truncated === true ? 1 : 0,
    ]),
  });
}

export function emptyPhase2TelemetryObservation(tick: number): Phase2TelemetryObservation {
  return {
    tick,
    attrition: { colonies: [], assets: [], droppedObservations: 0 },
    controllerLevels: [],
    droppedControllerLevels: 0,
    controllers: 0,
    rcl8Controllers: 0,
    sustainingColonies: 0,
    controllerProgress: 0,
    controllerProgressTotal: 0,
    minimumDowngradeTicks: null,
    energyAvailable: 0,
    energyCapacity: 0,
    storedEnergy: 0,
    terminalEnergy: 0,
    reserveViolations: 0,
    colonyEnergyReserved: 0,
    colonyCpuReserved: 0,
    colonySpawnTicksReserved: 0,
    activeSpawns: 0,
    busySpawns: 0,
    scheduledSpawns: 0,
    deferredSpawns: 0,
    failedSpawns: 0,
    scheduledSpawnEnergy: 0,
    scheduledSpawnTicks: 0,
    constructionBacklog: 0,
    constructionProgressRemaining: 0,
    layoutComplete: 0,
    layoutDegraded: 0,
    layoutAccepted: 0,
    layoutDeferred: 0,
    layoutRejected: 0,
    layoutExecuted: 0,
    layoutFailed: 0,
    harvestedEnergy: 0,
    wastedEnergy: 0,
    sourceUptimeTicks: 0,
    sourceDowntimeTicks: 0,
    logisticsActiveFlows: 0,
    logisticsDeferredFlows: 0,
    logisticsRequested: 0,
    logisticsScheduled: 0,
    logisticsDelivered: 0,
    logisticsShortfall: 0,
    logisticsLoss: 0,
    linkAccepted: 0,
    linkDeferred: 0,
    linkFailed: 0,
    linkSent: 0,
    linkDelivered: 0,
    linkLost: 0,
    maintenanceAdmitted: 0,
    maintenanceDeferred: 0,
    maintenanceFailed: 0,
    maintenanceRequestedEnergy: 0,
    maintenanceFundedEnergy: 0,
    maintenanceEnergy: 0,
    industryAdmitted: 0,
    industryDeferred: 0,
    industryFailed: 0,
    industryReserved: 0,
    terminalTransactionEnergyPlanned: 0,
    labAdmitted: 0,
    labDeferred: 0,
    labFailed: 0,
    labOutput: 0,
    matureAdmitted: 0,
    matureDeferred: 0,
    matureFailed: 0,
    factoryOutput: 0,
    powerOutput: 0,
    observerAdmitted: 0,
    observerDeferred: 0,
    observerFailed: 0,
    measuredCpuMilli: 0,
    droppedInputs: 0,
  };
}

/**
 * Reduces fixed settled observations into current gate inputs and a bounded rolling window.
 * The result is observer-only and cannot authorize colony or domain work.
 */
export function reducePhase2Telemetry(input: {
  readonly observation: Phase2TelemetryObservation;
  readonly previous?: Phase2TelemetryStateInput | null;
  readonly maximumSamples?: number;
  /** Authoritative owner-level replay signal when retained samples were byte-evicted. */
  readonly sameTickReplay?: boolean;
}): Phase2TelemetryReduction {
  const observation = normalizeObservation(input.observation);
  const limit = Math.min(
    MAX_PHASE2_TELEMETRY_SAMPLES,
    input.maximumSamples === undefined
      ? MAX_PHASE2_TELEMETRY_SAMPLES
      : nonnegativeSafeInteger(input.maximumSamples),
  );
  const opened = normalizePrevious(input.previous);
  const timingIsFuture =
    opened.rclTracks.some((track) => track[3] > observation.tick) ||
    opened.rclTransitionDurations.some((duration) => (duration[5] ?? 0) > observation.tick);
  const previous: Phase2TelemetryState = timingIsFuture
    ? { ...opened, ...emptyRclState() }
    : opened;
  const last = previous.samples[previous.samples.length - 1];
  const sameTickReplay = input.sameTickReplay === true || last?.tick === observation.tick;
  if (last !== undefined && observation.tick < last.tick)
    throw new RangeError("phase 2 telemetry tick order is invalid");

  const authorities = authorityTelemetry(observation);
  const authorityFailures = total(authorities.map((row) => row[2]));
  const sample = sampleFrom(observation, authorityFailures);
  const appended =
    last?.tick === observation.tick
      ? [...previous.samples.slice(0, -1), sample]
      : [...previous.samples, sample];
  const samples = limit === 0 ? [] : appended.slice(-limit);
  const newlyDropped = Math.max(0, appended.length - samples.length);
  const droppedSamples = saturatingAdd(previous.droppedSamples, newlyDropped);
  const rcl = advanceRclTransitions(
    previous,
    observation.tick,
    observation.controllerLevels,
    observation.droppedControllerLevels,
    sameTickReplay,
  );
  const attrition = reducePhase2Attrition({
    tick: observation.tick,
    observation: observation.attrition,
    previous: previous.attrition,
    sameTickReplay,
  });
  const state: Phase2TelemetryState = {
    schemaVersion: PHASE2_TELEMETRY_SCHEMA_VERSION,
    droppedSamples,
    samples,
    ...rcl,
    attrition: attrition.state,
  };
  const identities = flowIdentities(observation);
  const busy = Math.min(observation.activeSpawns, observation.busySpawns);
  const rclTelemetry = projectPhase2RclTelemetry(rcl);
  const telemetry: Phase2Telemetry = {
    schemaVersion: PHASE2_TELEMETRY_SCHEMA_VERSION,
    progression: {
      controllers: observation.controllers,
      rcl8Controllers: observation.rcl8Controllers,
      sustainingColonies: observation.sustainingColonies,
      controllerProgress: observation.controllerProgress,
      controllerProgressTotal: observation.controllerProgressTotal,
      minimumDowngradeTicks: observation.minimumDowngradeTicks,
      ...(rclTelemetry === undefined ? {} : { rcl: rclTelemetry }),
    },
    reserves: {
      energyAvailable: observation.energyAvailable,
      energyCapacity: observation.energyCapacity,
      storedEnergy: observation.storedEnergy,
      terminalEnergy: observation.terminalEnergy,
      violations: observation.reserveViolations,
    },
    spawn: {
      active: observation.activeSpawns,
      busy,
      idle: observation.activeSpawns - busy,
      scheduled: observation.scheduledSpawns,
      failed: observation.failedSpawns,
      energy: observation.scheduledSpawnEnergy,
      spawnTicks: observation.scheduledSpawnTicks,
      utilizationBasisPoints:
        observation.activeSpawns === 0
          ? null
          : Math.floor((busy * 10_000) / observation.activeSpawns),
    },
    construction: {
      backlog: observation.constructionBacklog,
      progressRemaining: observation.constructionProgressRemaining,
      completePlans: observation.layoutComplete,
      degradedPlans: observation.layoutDegraded,
    },
    flows: {
      harvestedEnergy: observation.harvestedEnergy,
      wastedEnergy: observation.wastedEnergy,
      sourceUptimeTicks: observation.sourceUptimeTicks,
      sourceDowntimeTicks: observation.sourceDowntimeTicks,
      logistics: {
        requested: observation.logisticsRequested,
        scheduled: observation.logisticsScheduled,
        delivered: observation.logisticsDelivered,
        shortfall: observation.logisticsShortfall,
        loss: observation.logisticsLoss,
      },
      links: {
        sent: observation.linkSent,
        delivered: observation.linkDelivered,
        lost: observation.linkLost,
      },
      maintenanceEnergy: observation.maintenanceEnergy,
      terminalTransactionEnergyPlanned: observation.terminalTransactionEnergyPlanned,
      labOutput: observation.labOutput,
      factoryOutput: observation.factoryOutput,
      powerOutput: observation.powerOutput,
    },
    authorities,
    identities,
    ...(hasPhase2AttritionEvidence(attrition.telemetry) ? { attrition: attrition.telemetry } : {}),
    window: rollingWindow(samples, droppedSamples),
    droppedInputs: observation.droppedInputs,
  };
  return deepFreeze({ state, telemetry });
}

export function projectPhase2RclTelemetry(
  value: Pick<
    Phase2TelemetryState,
    | "interruptedRclTracks"
    | "droppedRclObservations"
    | "droppedRclTransitions"
    | "rclTransitionDurations"
  >,
): Phase2RclTelemetry | undefined {
  let selectedIndex: number | null = null;
  let selected: Phase2RclTransitionDuration | null = null;
  for (let index = 0; index < value.rclTransitionDurations.length; index += 1) {
    const candidate = value.rclTransitionDurations[index];
    if (candidate === undefined || candidate[0] === 0) continue;
    if (selected === null || (candidate[5] ?? 0) > (selected[5] ?? 0)) {
      selectedIndex = index;
      selected = candidate;
    }
  }
  if (
    selected === null &&
    value.interruptedRclTracks === 0 &&
    value.droppedRclObservations === 0 &&
    value.droppedRclTransitions === 0
  )
    return undefined;
  return [
    selectedIndex === null ? null : (PHASE2_RCL_DESTINATIONS[selectedIndex] ?? null),
    ...(selected ?? [0, 0, null, null, null, null]),
    value.interruptedRclTracks,
    value.droppedRclObservations,
    value.droppedRclTransitions,
  ];
}

function authorityTelemetry(
  value: Phase2TelemetryObservation,
): readonly Phase2AuthorityTelemetry[] {
  return [
    outcome(
      value.sustainingColonies,
      Math.max(0, value.controllers - value.sustainingColonies),
      value.reserveViolations,
      value.colonyEnergyReserved,
      0,
      value.colonyCpuReserved,
      value.colonySpawnTicksReserved,
    ),
    outcome(
      value.scheduledSpawns,
      value.deferredSpawns,
      value.failedSpawns,
      value.scheduledSpawnEnergy,
      0,
      0,
      value.scheduledSpawnTicks,
    ),
    outcome(value.sourceUptimeTicks, value.sourceDowntimeTicks, value.droppedInputs, 0, 0, 0, 0),
    outcome(
      value.logisticsActiveFlows,
      value.logisticsDeferredFlows,
      0,
      0,
      value.logisticsScheduled,
      0,
      0,
    ),
    outcome(
      value.layoutAccepted,
      value.layoutDeferred,
      saturatingAdd(value.layoutRejected, value.layoutFailed),
      0,
      0,
      0,
      0,
    ),
    outcome(value.linkAccepted, value.linkDeferred, value.linkFailed, 0, value.linkSent, 0, 0),
    outcome(
      value.maintenanceAdmitted,
      value.maintenanceDeferred,
      value.maintenanceFailed,
      value.maintenanceFundedEnergy,
      0,
      0,
      0,
    ),
    outcome(
      value.industryAdmitted,
      value.industryDeferred,
      value.industryFailed,
      0,
      value.industryReserved,
      0,
      0,
    ),
    outcome(value.labAdmitted, value.labDeferred, value.labFailed, 0, 0, 0, 0),
    outcome(value.matureAdmitted, value.matureDeferred, value.matureFailed, 0, 0, 0, 0),
    outcome(value.observerAdmitted, value.observerDeferred, value.observerFailed, 0, 0, 0, 0),
  ];
}

function outcome(
  admitted: number,
  deferred: number,
  failed: number,
  energy: number,
  resourceUnits: number,
  cpuMilli: number,
  spawnTicks: number,
): Phase2AuthorityTelemetry {
  return [admitted, deferred, failed, energy, resourceUnits, cpuMilli, spawnTicks];
}

function flowIdentities(value: Phase2TelemetryObservation): readonly Phase2FlowIdentityTelemetry[] {
  const linkResidual = value.linkSent - value.linkDelivered - value.linkLost;
  const logisticsResidual =
    value.logisticsRequested - value.logisticsScheduled - value.logisticsShortfall;
  const maintenanceResidual = value.maintenanceRequestedEnergy - value.maintenanceFundedEnergy;
  return [
    [linkResidual === 0, linkResidual],
    [logisticsResidual === 0, logisticsResidual],
    [maintenanceResidual >= 0, maintenanceResidual],
  ];
}

function sampleFrom(
  value: Phase2TelemetryObservation,
  authorityFailures: number,
): Phase2TelemetrySample {
  return {
    tick: value.tick,
    harvestedEnergy: value.harvestedEnergy,
    logisticsDelivered: value.logisticsDelivered,
    linkDelivered: value.linkDelivered,
    industryOutput: total([value.labOutput, value.factoryOutput, value.powerOutput]),
    authorityFailures,
    reserveViolations: value.reserveViolations,
    measuredCpuMilli: value.measuredCpuMilli,
  };
}

export function projectPhase2TelemetryWindow(
  value: Pick<Phase2TelemetryState, "samples" | "droppedSamples">,
): Phase2TelemetryWindow {
  return rollingWindow(value.samples, value.droppedSamples);
}

function rollingWindow(
  samples: readonly Phase2TelemetrySample[],
  droppedSamples: number,
): Phase2TelemetryWindow {
  return [
    samples.length,
    samples[0]?.tick ?? null,
    samples[samples.length - 1]?.tick ?? null,
    total(samples.map(({ harvestedEnergy }) => harvestedEnergy)),
    total(samples.map(({ logisticsDelivered }) => logisticsDelivered)),
    total(samples.map(({ linkDelivered }) => linkDelivered)),
    total(samples.map(({ industryOutput }) => industryOutput)),
    total(samples.map(({ authorityFailures }) => authorityFailures)),
    total(samples.map(({ reserveViolations }) => reserveViolations)),
    total(samples.map(({ measuredCpuMilli }) => measuredCpuMilli)),
    droppedSamples,
  ];
}

function normalizeObservation(value: Phase2TelemetryObservation): Phase2TelemetryObservation {
  const result = { ...value } as Record<string, unknown>;
  for (const [key, entry] of Object.entries(result)) {
    if (key === "controllerLevels" || key === "attrition") continue;
    if (key === "minimumDowngradeTicks" && entry === null) continue;
    result[key] = nonnegativeSafeInteger(entry);
  }
  const normalized = result as unknown as Phase2TelemetryObservation;
  return {
    ...normalized,
    attrition: value.attrition,
    controllerLevels: value.controllerLevels,
    rcl8Controllers: Math.min(normalized.controllers, normalized.rcl8Controllers),
    sustainingColonies: Math.min(normalized.controllers, normalized.sustainingColonies),
    energyAvailable: Math.min(normalized.energyCapacity, normalized.energyAvailable),
    busySpawns: Math.min(normalized.activeSpawns, normalized.busySpawns),
  };
}

function normalizePrevious(
  value: Phase2TelemetryStateInput | null | undefined,
): Phase2TelemetryState {
  const empty = emptyPhase2State();
  const rawSamples: unknown = value?.samples;
  if (
    (value?.schemaVersion !== 1 && value?.schemaVersion !== 2 && value?.schemaVersion !== 3) ||
    !Array.isArray(rawSamples)
  )
    return empty;
  const droppedSamples = nonnegativeSafeInteger(value.droppedSamples);
  let samples: Phase2TelemetrySample[];
  let normalizedDroppedSamples = droppedSamples;
  if (rawSamples.length > MAX_PHASE2_TELEMETRY_SAMPLES) {
    samples = [];
    normalizedDroppedSamples = saturatingAdd(droppedSamples, rawSamples.length);
  } else {
    samples = rawSamples.map((sample: unknown) => normalizeSample(sample));
    for (let index = 1; index < samples.length; index += 1) {
      if ((samples[index - 1]?.tick ?? 0) >= (samples[index]?.tick ?? 0)) {
        normalizedDroppedSamples = saturatingAdd(droppedSamples, samples.length);
        samples = [];
        break;
      }
    }
  }
  const sampleState = {
    schemaVersion: PHASE2_TELEMETRY_SCHEMA_VERSION,
    droppedSamples: normalizedDroppedSamples,
    samples,
  } as const;
  if (value.schemaVersion === 1)
    return { ...sampleState, ...emptyRclState(), attrition: emptyPhase2AttritionState() };
  return {
    ...sampleState,
    ...normalizePersistedRclState(value),
    attrition:
      value.schemaVersion === PHASE2_TELEMETRY_SCHEMA_VERSION
        ? value.attrition
        : emptyPhase2AttritionState(),
  };
}

function normalizeSample(sample: unknown): Phase2TelemetrySample {
  if (typeof sample !== "object" || sample === null || Array.isArray(sample))
    throw new TypeError("phase 2 telemetry sample is invalid");
  const row = sample as Record<string, unknown>;
  return {
    tick: nonnegativeSafeInteger(row.tick),
    harvestedEnergy: nonnegativeSafeInteger(row.harvestedEnergy),
    logisticsDelivered: nonnegativeSafeInteger(row.logisticsDelivered),
    linkDelivered: nonnegativeSafeInteger(row.linkDelivered),
    industryOutput: nonnegativeSafeInteger(row.industryOutput),
    authorityFailures: nonnegativeSafeInteger(row.authorityFailures),
    reserveViolations: nonnegativeSafeInteger(row.reserveViolations),
    measuredCpuMilli: nonnegativeSafeInteger(row.measuredCpuMilli),
  };
}

function emptyPhase2State(): Phase2TelemetryState {
  return {
    schemaVersion: PHASE2_TELEMETRY_SCHEMA_VERSION,
    droppedSamples: 0,
    samples: [],
    ...emptyRclState(),
    attrition: emptyPhase2AttritionState(),
  };
}

type RclState = Pick<
  Phase2TelemetryState,
  | "rclTimingSchemaVersion"
  | "interruptedRclTracks"
  | "droppedRclObservations"
  | "droppedRclTransitions"
  | "rclTracks"
  | "rclTransitionDurations"
>;

function emptyRclState(): RclState {
  return {
    rclTimingSchemaVersion: PHASE2_RCL_TIMING_SCHEMA_VERSION,
    interruptedRclTracks: 0,
    droppedRclObservations: 0,
    droppedRclTransitions: 0,
    rclTracks: [],
    rclTransitionDurations: emptyRclTransitionDurations(),
  };
}

function emptyRclTransitionDurations(): Phase2RclTransitionDuration[] {
  return PHASE2_RCL_DESTINATIONS.map(() => [0, 0, null, null, null, null]);
}

function normalizePersistedRclState(
  value: Phase2TelemetryState | Phase2TelemetryStateV2,
): RclState {
  try {
    const timingSchema: unknown = (value as unknown as Record<string, unknown>)
      .rclTimingSchemaVersion;
    if (timingSchema !== PHASE2_RCL_TIMING_SCHEMA_VERSION) return emptyRclState();
    if (!Array.isArray(value.rclTracks) || !Array.isArray(value.rclTransitionDurations))
      return emptyRclState();
    if (
      value.rclTracks.length > MAX_PHASE2_CONTROLLER_TRACKERS ||
      value.rclTransitionDurations.length !== PHASE2_RCL_DESTINATIONS.length
    )
      return emptyRclState();
    const tracks = value.rclTracks.map((track: unknown): Phase2RclTrack => {
      if (!Array.isArray(track) || track.length !== 4)
        throw new TypeError("phase 2 RCL track is invalid");
      const [colonyRef, rawLevel, rawEnteredAtTick, rawLastObservedTick] = track as unknown[];
      const level = rcl(rawLevel, 7);
      const enteredAtTick = nonnegativeSafeInteger(rawEnteredAtTick);
      const lastObservedTick = nonnegativeSafeInteger(rawLastObservedTick);
      if (!isOpaqueColonyRef(colonyRef) || enteredAtTick > lastObservedTick)
        throw new TypeError("phase 2 RCL track is invalid");
      return [colonyRef, level, enteredAtTick, lastObservedTick];
    });
    for (let index = 1; index < tracks.length; index += 1)
      if ((tracks[index - 1]?.[0] ?? "") >= (tracks[index]?.[0] ?? ""))
        throw new TypeError("phase 2 RCL tracks are not canonical");
    const durations = value.rclTransitionDurations.map(
      (duration: unknown): Phase2RclTransitionDuration => normalizeRclDuration(duration),
    );
    return {
      rclTimingSchemaVersion: PHASE2_RCL_TIMING_SCHEMA_VERSION,
      interruptedRclTracks: nonnegativeSafeInteger(value.interruptedRclTracks),
      droppedRclObservations: nonnegativeSafeInteger(value.droppedRclObservations),
      droppedRclTransitions: nonnegativeSafeInteger(value.droppedRclTransitions),
      rclTracks: tracks,
      rclTransitionDurations: durations,
    };
  } catch {
    return emptyRclState();
  }
}

function normalizeRclDuration(value: unknown): Phase2RclTransitionDuration {
  if (!Array.isArray(value) || value.length !== 6)
    throw new TypeError("phase 2 RCL duration is invalid");
  const [rawSamples, rawTotal, rawMinimum, rawMaximum, rawLatest, rawLatestTick] =
    value as unknown[];
  const samples = nonnegativeSafeInteger(rawSamples);
  const totalTicks = nonnegativeSafeInteger(rawTotal);
  const minimumTicks = nullableNonnegativeSafeInteger(rawMinimum);
  const maximumTicks = nullableNonnegativeSafeInteger(rawMaximum);
  const latestTicks = nullableNonnegativeSafeInteger(rawLatest);
  const latestTick = nullableNonnegativeSafeInteger(rawLatestTick);
  if (
    (samples === 0 &&
      (totalTicks !== 0 ||
        minimumTicks !== null ||
        maximumTicks !== null ||
        latestTicks !== null ||
        latestTick !== null)) ||
    (samples > 0 &&
      (minimumTicks === null ||
        maximumTicks === null ||
        latestTicks === null ||
        latestTick === null ||
        minimumTicks === 0 ||
        minimumTicks > maximumTicks ||
        totalTicks < maximumTicks ||
        maximumTicks > latestTick ||
        latestTicks < minimumTicks ||
        latestTicks > maximumTicks ||
        !rclDurationAggregateIsFeasible(
          samples,
          totalTicks,
          minimumTicks,
          maximumTicks,
          latestTicks,
        )))
  )
    throw new TypeError("phase 2 RCL duration is inconsistent");
  return [samples, totalTicks, minimumTicks, maximumTicks, latestTicks, latestTick];
}

function rclDurationAggregateIsFeasible(
  samples: number,
  totalTicks: number,
  minimumTicks: number,
  maximumTicks: number,
  latestTicks: number,
): boolean {
  if (samples === 1)
    return minimumTicks === totalTicks && maximumTicks === totalTicks && latestTicks === totalTicks;
  if (samples === Number.MAX_SAFE_INTEGER && totalTicks !== Number.MAX_SAFE_INTEGER) return false;
  const mandatoryValues = [...new Set([minimumTicks, maximumTicks, latestTicks])];
  if (mandatoryValues.length > samples) return false;
  const mandatorySum = total(mandatoryValues);
  const remainingSamples = samples - mandatoryValues.length;
  if (totalTicks === Number.MAX_SAFE_INTEGER) {
    if (mandatorySum === Number.MAX_SAFE_INTEGER) return true;
    if (remainingSamples === 0) return false;
    return maximumTicks >= Math.ceil((Number.MAX_SAFE_INTEGER - mandatorySum) / remainingSamples);
  }
  if (mandatorySum > totalTicks) return false;
  if (remainingSamples === 0) return mandatorySum === totalTicks;
  const remainingTotal = totalTicks - mandatorySum;
  return (
    minimumTicks <= Math.floor(remainingTotal / remainingSamples) &&
    maximumTicks >= Math.ceil(remainingTotal / remainingSamples)
  );
}

function advanceRclTransitions(
  previous: Phase2TelemetryState,
  tick: number,
  rawControllerLevels: unknown,
  droppedControllerLevels: number,
  sameTickReplay: boolean,
): RclState {
  const current =
    droppedControllerLevels > 0
      ? { controllers: [], dropped: droppedControllerLevels }
      : normalizeControllerLevels(rawControllerLevels);
  const tracks: Phase2RclTrack[] = [];
  const durations = previous.rclTransitionDurations.map((row) => [...row]) as [
    number,
    number,
    number | null,
    number | null,
    number | null,
    number | null,
  ][];
  let interrupted = previous.interruptedRclTracks;
  const prior = new Map(previous.rclTracks.map((track) => [track[0], track] as const));
  const seen = new Set<string>();

  for (const controller of current.controllers) {
    seen.add(controller.colonyRef);
    const track = prior.get(controller.colonyRef);
    if (track === undefined) {
      if (!sameTickReplay && controller.level < 8)
        tracks.push([controller.colonyRef, controller.level, tick, tick]);
      continue;
    }
    const [, previousLevel, enteredAtTick, lastObservedTick] = track;
    if (lastObservedTick === tick && previousLevel === controller.level) {
      tracks.push(track);
      continue;
    }
    if (lastObservedTick !== tick - 1) {
      interrupted = saturatingAdd(interrupted, 1);
      if (controller.level < 8) tracks.push([controller.colonyRef, controller.level, tick, tick]);
      continue;
    }
    if (controller.level === previousLevel) {
      tracks.push([controller.colonyRef, controller.level, enteredAtTick, tick]);
      continue;
    }
    if (controller.level === previousLevel + 1) {
      recordRclDuration(durations, controller.level, tick - enteredAtTick, tick);
      if (controller.level < 8) tracks.push([controller.colonyRef, controller.level, tick, tick]);
      continue;
    }
    interrupted = saturatingAdd(interrupted, 1);
    if (controller.level < 8) tracks.push([controller.colonyRef, controller.level, tick, tick]);
  }
  for (const [colonyRef] of previous.rclTracks)
    if (!seen.has(colonyRef)) interrupted = saturatingAdd(interrupted, 1);

  return {
    rclTimingSchemaVersion: PHASE2_RCL_TIMING_SCHEMA_VERSION,
    interruptedRclTracks: interrupted,
    droppedRclObservations: sameTickReplay
      ? previous.droppedRclObservations
      : saturatingAdd(previous.droppedRclObservations, current.dropped),
    droppedRclTransitions: previous.droppedRclTransitions,
    rclTracks: tracks,
    rclTransitionDurations: durations,
  };
}

function normalizeControllerLevels(value: unknown): {
  readonly controllers: readonly Phase2ControllerObservation[];
  readonly dropped: number;
} {
  if (!Array.isArray(value)) return { controllers: [], dropped: 1 };
  if (value.length > MAX_PHASE2_CONTROLLER_TRACKERS)
    return { controllers: [], dropped: value.length };
  try {
    const controllers = value.map((entry: unknown): Phase2ControllerObservation => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new TypeError("phase 2 controller observation is invalid");
      const row = entry as Record<string, unknown>;
      if (!isOpaqueColonyRef(row.colonyRef))
        throw new TypeError("phase 2 controller observation identity is invalid");
      return { colonyRef: row.colonyRef, level: rcl(row.level, 8) };
    });
    controllers.sort((left, right) => left.colonyRef.localeCompare(right.colonyRef));
    for (let index = 1; index < controllers.length; index += 1)
      if (controllers[index - 1]?.colonyRef === controllers[index]?.colonyRef)
        return { controllers: [], dropped: controllers.length };
    return { controllers, dropped: 0 };
  } catch {
    return { controllers: [], dropped: value.length === 0 ? 1 : value.length };
  }
}

function recordRclDuration(
  rows: [number, number, number | null, number | null, number | null, number | null][],
  destination: number,
  duration: number,
  tick: number,
): void {
  const index = destination - PHASE2_RCL_DESTINATIONS[0];
  const row = rows[index];
  if (row === undefined) return;
  const [samples, totalTicks, minimumTicks, maximumTicks, latestTicks, latestTick] = row;
  rows[index] = [
    saturatingAdd(samples, 1),
    saturatingAdd(totalTicks, duration),
    minimumTicks === null ? duration : Math.min(minimumTicks, duration),
    maximumTicks === null ? duration : Math.max(maximumTicks, duration),
    latestTick === tick && latestTicks !== null ? Math.max(latestTicks, duration) : duration,
    tick,
  ];
}

function rcl(value: unknown, maximum: 7 | 8): number {
  const level = nonnegativeSafeInteger(value);
  if (level < 1 || level > maximum) throw new RangeError("phase 2 RCL is invalid");
  return level;
}

function isOpaqueColonyRef(value: unknown): value is string {
  return typeof value === "string" && /^colony:[0-9a-f]{8}$/.test(value);
}

function nullableNonnegativeSafeInteger(value: unknown): number | null {
  return value === null ? null : nonnegativeSafeInteger(value);
}

function nonnegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError("phase 2 telemetry requires a nonnegative safe integer");
  return value;
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => saturatingAdd(sum, value), 0);
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
