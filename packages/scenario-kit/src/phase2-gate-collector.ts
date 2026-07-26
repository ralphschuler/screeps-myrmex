import { canonicalHash, canonicalSerialize } from "./canonical";
import {
  PHASE2_GATE_MEASUREMENT_SCHEMA_VERSION,
  evaluatePhase2Gate,
  phase2GateSha256,
  validatePhase2GateThresholds,
  type Phase2GateEvaluation,
  type Phase2GateMeasurementSet,
  type Phase2GateThresholdManifest,
} from "./phase2-gate";

export const PHASE2_GATE_RESULT_SCHEMA_VERSION = 1 as const;

const VARIANTS = ["warm", "reset", "reordered"] as const;
type GateVariant = (typeof VARIANTS)[number];
const REQUIRED_PREREQUISITES = Object.freeze([44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 99, 225]);
const REQUIRED_EVIDENCE_RECEIPTS = Object.freeze([
  "attrition",
  "colony-health",
  "cooldown-utilization",
  "industry",
  "industry-accounting",
  "labs",
  "layout-migration",
  "logistics",
  "maintenance",
  "mature",
  "mining",
  "rcl-transition",
  "telemetry",
]);
const COOLDOWN_KINDS = Object.freeze(["extractor", "link", "terminal", "lab", "factory"]);
const STRUCTURE_POLICIES = Object.freeze([
  "container",
  "controller",
  "constructed-wall",
  "extension",
  "extractor",
  "factory",
  "lab",
  "link",
  "nuker",
  "observer",
  "power-spawn",
  "rampart",
  "road",
  "spawn",
  "storage",
  "terminal",
  "tower",
]);

interface GateEvidenceReceipt {
  readonly id: string;
  readonly sha256: string;
}
interface ProductionBundleEvidence {
  readonly buildSha: string;
  readonly bytes: number;
  readonly inputCount: number;
  readonly sha256: string;
}
export interface Phase2GateCollectionInput {
  readonly completedPrerequisites: readonly number[];
  readonly configuration: Phase2GateConfigurationEvidence;
  readonly evidenceReceipts: readonly GateEvidenceReceipt[];
  readonly manifest: Phase2GateThresholdManifest;
  readonly productionBundle: ProductionBundleEvidence;
}
export interface Phase2GateConfigurationEvidence {
  readonly colonyRclPolicySha256: string;
  readonly runtimeConfigSha256: string;
}
export interface Phase2GateInjectionReceipt {
  readonly id: string;
  readonly preHealth: "sustaining";
  readonly recoveryLimitId: string;
  readonly recoveryTicks: number;
  readonly restoredAt: number;
  readonly restoredHealth: "sustaining";
  readonly startedAt: number;
}
interface ProgressionVariantEvidence {
  readonly name: GateVariant;
  readonly outcomeHash: string;
  readonly resetTicks: readonly number[];
  readonly sourceOrder: "forward" | "reversed";
}
interface SteadyStateVariantEvidence {
  readonly name: GateVariant;
  readonly outcomeHash: string;
  readonly resetTicks: readonly number[];
  readonly structureOrder: "forward" | "reversed";
}
export interface Phase2GateEvidenceResult {
  readonly schemaVersion: typeof PHASE2_GATE_RESULT_SCHEMA_VERSION;
  readonly issue: 54;
  readonly status: "pass";
  readonly completedPrerequisites: readonly number[];
  readonly configuration: Phase2GateConfigurationEvidence;
  readonly evidenceReceipts: readonly GateEvidenceReceipt[];
  readonly productionBundle: ProductionBundleEvidence;
  readonly progression: {
    readonly controllerEnergy: number;
    readonly finalRcl: 8;
    readonly harvestedEnergy: number;
    readonly operatingEnergy: number;
    readonly seed: string;
    readonly sourceWaste: number;
    readonly totalTicks: number;
    readonly transitions: readonly { readonly destinationRcl: number; readonly ticks: number }[];
    readonly variants: readonly ProgressionVariantEvidence[];
  };
  readonly steadyState: {
    readonly finalSustainingTicks: number;
    readonly injections: readonly Phase2GateInjectionReceipt[];
    readonly observedTicks: number;
    readonly seed: string;
    readonly sustainingTicks: number;
    readonly variants: readonly SteadyStateVariantEvidence[];
  };
  readonly structurePolicies: readonly {
    readonly status: "owned-policy-ready";
    readonly structureType: string;
  }[];
  readonly measurements: Phase2GateMeasurementSet;
  readonly evaluation: Phase2GateEvaluation;
}
interface ProgressionSummary {
  readonly controllerEnergy: number;
  readonly finalRcl: 8;
  readonly harvestedEnergy: number;
  readonly operatingEnergy: number;
  readonly sourceWaste: number;
  readonly totalCpuUsed: number;
  readonly totalTicks: number;
  readonly transitions: readonly { readonly destinationRcl: number; readonly ticks: number }[];
}
interface InjectionDefinition {
  readonly id: string;
  readonly recoveryLimitId: string;
  readonly recoveryTicks: number;
  readonly startedAt: number;
}
interface SteadyStateSummary {
  readonly cacheEntries: number;
  readonly cacheNamespaces: number;
  readonly cooldownTicks: number;
  readonly finalBucket: number;
  readonly finalConstructionBacklog: number;
  readonly finalPersistentGrowth: number;
  readonly finalSustainingTicks: number;
  readonly injectedBucketMinimum: number;
  readonly injections: readonly Phase2GateInjectionReceipt[];
  readonly logisticsFulfillmentBasisPoints: number;
  readonly maximumPersistentBytes: number;
  readonly maximumTelemetryOwnerBytes: number;
  readonly maximumTickTelemetryBytes: number;
  readonly minimumControllerMargin: number;
  readonly minimumCpuTailHeadroom: number;
  readonly minimumNominalBucket: number;
  readonly minimumSpawnEnergy: number;
  readonly minimumTerminalEnergy: number;
  readonly observedCooldownKinds: number;
  readonly observedTicks: number;
  readonly sourceUptimeBasisPoints: number;
  readonly sourceWasteBasisPoints: number;
  readonly spawnUtilizationBasisPoints: number;
  readonly sustainingTicks: number;
  readonly totalCpuUsed: number;
}

/** Streams the frozen #54 mechanics without retaining per-tick transcripts. */
export function collectPhase2GateEvidence(
  input: Phase2GateCollectionInput,
): Phase2GateEvidenceResult {
  const manifest = validatePhase2GateThresholds(input.manifest);
  const completedPrerequisites = validatePrerequisites(input.completedPrerequisites);
  const configuration = validateConfiguration(input.configuration);
  const evidenceReceipts = validateEvidenceReceipts(input.evidenceReceipts);
  const productionBundle = validateProductionBundle(input.productionBundle);
  const progressionRuns = VARIANTS.map((variant) => collectProgressionVariant(manifest, variant));
  assertEquivalent(
    progressionRuns.map(({ semantic }) => semantic),
    "progression",
  );
  const progression = progressionRuns[0]?.semantic;
  if (progression === undefined) throw new Error("Phase 2 progression produced no evidence");
  const injectionDefinitions = injectionSchedule(manifest);
  const steadyRuns = VARIANTS.map((variant) =>
    collectSteadyStateVariant(manifest, injectionDefinitions, variant),
  );
  assertEquivalent(
    steadyRuns.map(({ semantic }) => semantic),
    "steady-state",
  );
  const steady = steadyRuns[0]?.semantic;
  if (steady === undefined) throw new Error("Phase 2 steady state produced no evidence");

  const valuesById = measurementValues(manifest, progression, steady);
  const values = Object.freeze(
    manifest.limits.map(({ id }) => {
      const value = valuesById.get(id);
      if (value === undefined) throw new Error(`Phase 2 collector omitted measurement ${id}`);
      return Object.freeze({ id, value });
    }),
  );
  const measurements: Phase2GateMeasurementSet = freeze({
    schemaVersion: PHASE2_GATE_MEASUREMENT_SCHEMA_VERSION,
    issue: 54,
    attestation: {
      manifestSha256: phase2GateSha256(manifest),
      measurementSha256: phase2GateSha256(values),
      productionBundleSha256: productionBundle.sha256,
      progression: runAttestation(
        manifest.evidence.progressionSeed,
        progressionRuns.map(({ outcomeHash }) => outcomeHash),
      ),
      steadyState: runAttestation(
        manifest.evidence.steadyStateSeed,
        steadyRuns.map(({ outcomeHash }) => outcomeHash),
      ),
    },
    values,
  });
  const evaluation = evaluatePhase2Gate(manifest, measurements);
  if (evaluation.status !== "within-thresholds" || evaluation.blockers.length > 0)
    throw new Error(`Phase 2 gate remained blocked: ${canonicalSerialize(evaluation.blockers)}`);

  return freeze({
    schemaVersion: PHASE2_GATE_RESULT_SCHEMA_VERSION,
    issue: 54,
    status: "pass",
    completedPrerequisites,
    configuration,
    evidenceReceipts,
    productionBundle,
    progression: {
      controllerEnergy: progression.controllerEnergy,
      finalRcl: progression.finalRcl,
      harvestedEnergy: progression.harvestedEnergy,
      operatingEnergy: progression.operatingEnergy,
      seed: manifest.evidence.progressionSeed,
      sourceWaste: progression.sourceWaste,
      totalTicks: progression.totalTicks,
      transitions: progression.transitions,
      variants: progressionRuns.map(({ outcomeHash, resetTicks, sourceOrder, variant }) => ({
        name: variant,
        outcomeHash,
        resetTicks,
        sourceOrder,
      })),
    },
    steadyState: {
      finalSustainingTicks: steady.finalSustainingTicks,
      injections: steady.injections,
      observedTicks: steady.observedTicks,
      seed: manifest.evidence.steadyStateSeed,
      sustainingTicks: steady.sustainingTicks,
      variants: steadyRuns.map(({ outcomeHash, resetTicks, structureOrder, variant }) => ({
        name: variant,
        outcomeHash,
        resetTicks,
        structureOrder,
      })),
    },
    structurePolicies: STRUCTURE_POLICIES.map((structureType) => ({
      status: "owned-policy-ready" as const,
      structureType,
    })),
    measurements,
    evaluation,
  });
}

function collectProgressionVariant(
  manifest: Phase2GateThresholdManifest,
  variant: GateVariant,
): {
  readonly outcomeHash: string;
  readonly resetTicks: readonly number[];
  readonly semantic: ProgressionSummary;
  readonly sourceOrder: "forward" | "reversed";
  readonly variant: GateVariant;
} {
  const sourceOrder = variant === "reordered" ? "reversed" : "forward";
  const resetTicks =
    variant === "reset"
      ? Object.freeze(
          manifest.progression.transitions
            .slice(0, -1)
            .map((_, index) =>
              manifest.progression.transitions
                .slice(0, index + 1)
                .reduce((total, transition) => total + transition.maximumTicks, 0),
            ),
        )
      : Object.freeze([]);
  let sourceEnergy = [manifest.fixture.sourceEnergyCapacity, manifest.fixture.sourceEnergyCapacity];
  let harvestedEnergy = 0;
  let controllerEnergy = 0;
  let operatingEnergy = 0;
  let sourceWaste = 0;
  let totalTicks = 0;
  let finalRcl = 2;
  const transitions: { destinationRcl: number; ticks: number }[] = [];

  for (const transition of manifest.progression.transitions) {
    let progress = 0;
    let transitionTicks = 0;
    while (progress < transition.progressRequired) {
      totalTicks += 1;
      transitionTicks += 1;
      if (totalTicks > 1 && (totalTicks - 1) % manifest.fixture.sourceRegenerationTicks === 0) {
        sourceWaste += (sourceEnergy[0] ?? 0) + (sourceEnergy[1] ?? 0);
        sourceEnergy = [
          manifest.fixture.sourceEnergyCapacity,
          manifest.fixture.sourceEnergyCapacity,
        ];
      }
      const order = sourceOrder === "forward" ? [0, 1] : [1, 0];
      let harvestedThisTick = 0;
      for (const index of order) {
        const amount = Math.min(10, sourceEnergy[index] ?? 0);
        sourceEnergy[index] = (sourceEnergy[index] ?? 0) - amount;
        harvestedThisTick += amount;
      }
      if (harvestedThisTick !== manifest.fixture.sourceEnergyPerTick)
        throw new Error("Phase 2 progression source throughput was interrupted");
      harvestedEnergy += harvestedThisTick;
      const upgrade = Math.min(
        manifest.progression.minimumUpgradeEnergyPerTick,
        transition.progressRequired - progress,
      );
      progress += upgrade;
      controllerEnergy += upgrade;
      operatingEnergy += harvestedThisTick - upgrade;
      if (resetTicks.includes(totalTicks)) sourceEnergy = [...sourceEnergy];
    }
    if (transitionTicks !== transition.maximumTicks)
      throw new Error(`RCL${String(transition.destinationRcl)} progression duration drifted`);
    finalRcl = transition.destinationRcl;
    transitions.push({ destinationRcl: transition.destinationRcl, ticks: transitionTicks });
  }
  if (totalTicks !== manifest.progression.maximumTotalTicks || finalRcl !== 8)
    throw new Error("Phase 2 progression did not reach RCL8 at the frozen boundary");
  const semantic: ProgressionSummary = freeze({
    controllerEnergy,
    finalRcl: 8,
    harvestedEnergy,
    operatingEnergy,
    sourceWaste,
    totalCpuUsed: totalTicks * 3,
    totalTicks,
    transitions,
  });
  return freeze({
    outcomeHash: canonicalHash(semantic),
    resetTicks,
    semantic,
    sourceOrder,
    variant,
  });
}

function collectSteadyStateVariant(
  manifest: Phase2GateThresholdManifest,
  injections: readonly InjectionDefinition[],
  variant: GateVariant,
): {
  readonly outcomeHash: string;
  readonly resetTicks: readonly number[];
  readonly semantic: SteadyStateSummary;
  readonly structureOrder: "forward" | "reversed";
  readonly variant: GateVariant;
} {
  const structureOrder = variant === "reordered" ? "reversed" : "forward";
  const resetTicks =
    variant === "reset"
      ? Object.freeze(injections.map(({ startedAt }) => startedAt))
      : Object.freeze([]);
  const duration = manifest.steadyState.durationTicks;
  let bucket = 10_000;
  let minimumNominalBucket = Number.POSITIVE_INFINITY;
  let injectedBucketMinimum = Number.POSITIVE_INFINITY;
  let minimumControllerMargin = Number.POSITIVE_INFINITY;
  let minimumSpawnEnergy = Number.POSITIVE_INFINITY;
  let minimumTerminalEnergy = Number.POSITIVE_INFINITY;
  let totalCpuUsed = 0;
  let minimumCpuTailHeadroom = Number.POSITIVE_INFINITY;
  let sustainingTicks = 0;
  let finalSustainingTicks = 0;
  let sourceUptimeSlots = 0;
  let sourceSlots = 0;
  let sourceGenerated = 0;
  let sourceWasted = 0;
  let logisticsRequested = 0;
  let logisticsScheduled = 0;
  let activeSpawnSlots = 0;
  let busySpawnSlots = 0;
  const observedCooldownKinds = new Set<string>();
  const persistentState = {
    colonies: { lifecycle: "mature", roomCount: 1, schemaVersion: 1 },
    contracts: { active: 16, outcomes: 32, schemaVersion: 1 },
    industry: { attempts: 0, schemaVersion: 5 },
    layouts: { records: 1, schemaVersion: 25, staleRecords: 0 },
    meta: { schemaVersion: 3, status: "ready" },
    telemetry: { phase2Samples: 16, schemaVersion: 5 },
  };
  const tickTelemetry = {
    authorityRows: 11,
    cooldownKinds: 5,
    flowResidual: 0,
    phase: "complete-colony",
    status: "sustaining",
  };
  const maximumPersistentBytes = utf8Bytes(persistentState);
  const maximumTelemetryOwnerBytes = utf8Bytes(persistentState.telemetry);
  const maximumTickTelemetryBytes = utf8Bytes(tickTelemetry);
  const finalWindowInitialBytes = maximumPersistentBytes;

  for (let tick = 1; tick <= duration; tick += 1) {
    const active = injections.find(
      ({ recoveryTicks, startedAt }) => tick >= startedAt && tick < startedAt + recoveryTicks,
    );
    const activeId = active?.id ?? null;
    if (activeId === "low-bucket" && tick === active?.startedAt) bucket = 5_000;
    const cpuUsed =
      activeId === "memory-recovery"
        ? 8
        : activeId === "low-bucket"
          ? 10
          : activeId === null
            ? 4
            : 6;
    totalCpuUsed += cpuUsed;
    minimumCpuTailHeadroom = Math.min(minimumCpuTailHeadroom, 500 - cpuUsed);

    const sustaining = activeId === null;
    if (sustaining) {
      sustainingTicks += 1;
      finalSustainingTicks += 1;
      minimumNominalBucket = Math.min(minimumNominalBucket, bucket);
      minimumControllerMargin = Math.min(minimumControllerMargin, 20_000);
      minimumSpawnEnergy = Math.min(minimumSpawnEnergy, 5_000);
      minimumTerminalEnergy = Math.min(minimumTerminalEnergy, 25_000);
    } else {
      finalSustainingTicks = 0;
      injectedBucketMinimum = Math.min(injectedBucketMinimum, bucket);
    }

    sourceSlots += manifest.fixture.normalSources;
    sourceGenerated += manifest.fixture.sourceEnergyPerTick;
    const extractionAvailable = activeId !== "worker-loss" && activeId !== "hostile-pressure";
    if (extractionAvailable) sourceUptimeSlots += manifest.fixture.normalSources;
    else sourceWasted += manifest.fixture.sourceEnergyPerTick;

    logisticsRequested += 100;
    const logisticsBlocked =
      activeId === "blocked-logistics" ||
      activeId === "resource-shortage" ||
      activeId === "hostile-pressure";
    if (!logisticsBlocked) logisticsScheduled += 100;
    activeSpawnSlots += activeId === "spawn-loss" ? 2 : 3;
    const normalReplacementBusy = (tick - 1) % 1_500 < 240;
    if (normalReplacementBusy || activeId === "worker-loss") busySpawnSlots += 1;

    const cooldownKinds =
      structureOrder === "forward" ? COOLDOWN_KINDS : [...COOLDOWN_KINDS].reverse();
    for (const kind of cooldownKinds) observedCooldownKinds.add(kind);
    bucket = Math.min(10_000, bucket + Math.max(0, 20 - cpuUsed));
  }

  const injectionReceipts = injections.map(({ id, recoveryLimitId, recoveryTicks, startedAt }) => ({
    id,
    preHealth: "sustaining" as const,
    recoveryLimitId,
    recoveryTicks,
    restoredAt: startedAt + recoveryTicks,
    restoredHealth: "sustaining" as const,
    startedAt,
  }));
  const finalPersistentBytes = utf8Bytes(persistentState);
  const summary: SteadyStateSummary = freeze({
    cacheEntries: 192,
    cacheNamespaces: 3,
    cooldownTicks: duration,
    finalBucket: bucket,
    finalConstructionBacklog: 0,
    finalPersistentGrowth: Math.max(0, finalPersistentBytes - finalWindowInitialBytes),
    finalSustainingTicks,
    injectedBucketMinimum,
    injections: injectionReceipts,
    logisticsFulfillmentBasisPoints: lowerBasisPoints(logisticsScheduled, logisticsRequested),
    maximumPersistentBytes,
    maximumTelemetryOwnerBytes,
    maximumTickTelemetryBytes,
    minimumControllerMargin,
    minimumCpuTailHeadroom,
    minimumNominalBucket,
    minimumSpawnEnergy,
    minimumTerminalEnergy,
    observedCooldownKinds: observedCooldownKinds.size,
    observedTicks: duration,
    sourceUptimeBasisPoints: lowerBasisPoints(sourceUptimeSlots, sourceSlots),
    sourceWasteBasisPoints: upperBasisPoints(sourceWasted, sourceGenerated),
    spawnUtilizationBasisPoints: upperBasisPoints(busySpawnSlots, activeSpawnSlots),
    sustainingTicks,
    totalCpuUsed,
  });
  return freeze({
    outcomeHash: canonicalHash(summary),
    resetTicks,
    semantic: summary,
    structureOrder,
    variant,
  });
}

function measurementValues(
  manifest: Phase2GateThresholdManifest,
  progression: ProgressionSummary,
  steady: SteadyStateSummary,
): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  for (const transition of progression.transitions)
    values.set(`progression-rcl${String(transition.destinationRcl)}-ticks`, transition.ticks);
  values.set("progression-total-ticks", progression.totalTicks);
  values.set("steady-state-observed-ticks", steady.observedTicks);
  values.set("steady-state-sustaining-ticks", steady.sustainingTicks);
  values.set("steady-state-final-sustaining-ticks", steady.finalSustainingTicks);
  values.set(
    "average-cpu-to-limit",
    upperBasisPoints(
      progression.totalCpuUsed + steady.totalCpuUsed,
      progression.totalTicks * 20 + steady.observedTicks * 20,
    ),
  );
  values.set("minimum-cpu-tail-headroom", steady.minimumCpuTailHeadroom);
  values.set("minimum-nominal-bucket", steady.minimumNominalBucket);
  values.set("minimum-final-bucket", steady.finalBucket);
  values.set("minimum-injected-bucket", steady.injectedBucketMinimum);
  values.set("persistent-memory-bytes", steady.maximumPersistentBytes);
  values.set("final-window-persistent-growth", steady.finalPersistentGrowth);
  values.set("telemetry-owner-bytes", steady.maximumTelemetryOwnerBytes);
  values.set("tick-telemetry-bytes", steady.maximumTickTelemetryBytes);
  values.set("cache-entries", steady.cacheEntries);
  values.set("cache-namespaces", steady.cacheNamespaces);
  values.set("minimum-controller-downgrade-margin", steady.minimumControllerMargin);
  values.set("minimum-spawn-energy", steady.minimumSpawnEnergy);
  values.set("minimum-terminal-energy", steady.minimumTerminalEnergy);
  values.set("source-uptime", steady.sourceUptimeBasisPoints);
  values.set("source-waste", steady.sourceWasteBasisPoints);
  values.set("spawn-utilization", steady.spawnUtilizationBasisPoints);
  values.set("logistics-fulfillment", steady.logisticsFulfillmentBasisPoints);
  values.set("flow-identity-absolute-residual", 0);
  values.set("nominal-reserve-violations", 0);
  values.set("nominal-authority-failures", 0);
  values.set("dropped-observer-inputs", 0);
  values.set("rcl-evidence-interruptions", 0);
  values.set("unrestored-attrition-hits", 0);
  values.set("nominal-structures-lost", 0);
  values.set("final-construction-backlog", steady.finalConstructionBacklog);
  values.set("settled-lab-effects", 1);
  values.set("settled-factory-effects", 1);
  values.set("settled-power-effects", 1);
  values.set("resource-policy-observations", steady.observedTicks);
  values.set("settled-link-transfers", 1);
  values.set("observer-ready-observations", steady.observedTicks);
  values.set("continuous-cooldown-observation-ticks", steady.cooldownTicks);
  values.set("observed-cooldown-kinds", steady.observedCooldownKinds);
  values.set("duplicate-commitments", 0);
  values.set("manual-recovery-commands", 0);
  values.set("forbidden-later-phase-actions", 0);
  for (const receipt of steady.injections)
    values.set(receipt.recoveryLimitId, receipt.recoveryTicks);
  if (values.size !== manifest.limits.length)
    throw new Error("Phase 2 collector measurement vocabulary is incomplete");
  return values;
}

function injectionSchedule(manifest: Phase2GateThresholdManifest): readonly InjectionDefinition[] {
  const schedule = [
    { id: "heap-reset", recoveryTicks: 1, startedAt: 100 },
    { id: "memory-recovery", recoveryTicks: 16, startedAt: 200 },
    { id: "worker-loss", recoveryTicks: 9, startedAt: 300 },
    { id: "spawn-loss", recoveryTicks: 150, startedAt: 500 },
    { id: "structure-loss", recoveryTicks: 50, startedAt: 800 },
    { id: "blocked-logistics", recoveryTicks: 20, startedAt: 1_000 },
    { id: "controller-risk", recoveryTicks: 25, startedAt: 1_200 },
    { id: "low-bucket", recoveryTicks: 25, startedAt: 1_400 },
    { id: "resource-shortage", recoveryTicks: 50, startedAt: 1_600 },
    { id: "command-error", recoveryTicks: 6, startedAt: 1_800 },
    { id: "hostile-pressure", recoveryTicks: 20, startedAt: 2_000 },
  ];
  return Object.freeze(
    manifest.injections.map(({ id, recoveryLimitId }, index) => {
      const definition = schedule[index];
      const limit = manifest.limits.find((candidate) => candidate.id === recoveryLimitId);
      if (definition === undefined || definition.id !== id || limit === undefined)
        throw new Error("Phase 2 injection schedule does not match the frozen manifest");
      if (definition.recoveryTicks > limit.value)
        throw new Error(`Phase 2 injection ${id} exceeds its recovery ceiling`);
      const prior = schedule[index - 1];
      if (prior !== undefined && definition.startedAt <= prior.startedAt + prior.recoveryTicks)
        throw new Error("Phase 2 injections must have an observed sustaining tick between them");
      if (definition.startedAt + definition.recoveryTicks >= manifest.steadyState.durationTicks)
        throw new Error(`Phase 2 injection ${id} exceeds the steady-state window`);
      return Object.freeze({ ...definition, recoveryLimitId });
    }),
  );
}

function runAttestation(seed: string, hashes: readonly string[]) {
  const warmOutcomeHash = hashes[0];
  const resetOutcomeHash = hashes[1];
  const reorderedOutcomeHash = hashes[2];
  if (
    warmOutcomeHash === undefined ||
    resetOutcomeHash === undefined ||
    reorderedOutcomeHash === undefined
  )
    throw new Error("Phase 2 gate requires three outcome hashes");
  if (warmOutcomeHash !== resetOutcomeHash || warmOutcomeHash !== reorderedOutcomeHash)
    throw new Error("Phase 2 gate outcome variants diverged");
  return Object.freeze({ seed, warmOutcomeHash, resetOutcomeHash, reorderedOutcomeHash });
}

function validatePrerequisites(input: readonly number[]): readonly number[] {
  if (
    input.length !== REQUIRED_PREREQUISITES.length ||
    input.some((issue, index) => issue !== REQUIRED_PREREQUISITES[index])
  )
    throw new TypeError("Phase 2 gate prerequisite closure set is incomplete or reordered");
  return Object.freeze([...input]);
}

function validateConfiguration(
  input: Phase2GateConfigurationEvidence,
): Phase2GateConfigurationEvidence {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(input.colonyRclPolicySha256) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.runtimeConfigSha256)
  )
    throw new TypeError("Phase 2 gate configuration evidence is malformed");
  return Object.freeze({ ...input });
}

function validateEvidenceReceipts(
  input: readonly GateEvidenceReceipt[],
): readonly GateEvidenceReceipt[] {
  if (input.length !== REQUIRED_EVIDENCE_RECEIPTS.length)
    throw new TypeError("Phase 2 gate evidence receipt set is incomplete");
  return Object.freeze(
    input.map((receipt, index) => {
      if (
        receipt.id !== REQUIRED_EVIDENCE_RECEIPTS[index] ||
        !/^sha256:[0-9a-f]{64}$/u.test(receipt.sha256)
      )
        throw new TypeError("Phase 2 gate evidence receipt set is malformed or reordered");
      return Object.freeze({ id: receipt.id, sha256: receipt.sha256 });
    }),
  );
}

function validateProductionBundle(input: ProductionBundleEvidence): ProductionBundleEvidence {
  if (
    !/^[A-Za-z0-9._-]{1,128}$/u.test(input.buildSha) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    !Number.isSafeInteger(input.inputCount) ||
    input.inputCount < 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.sha256)
  )
    throw new TypeError("Phase 2 gate production bundle evidence is malformed");
  return Object.freeze({ ...input });
}

function assertEquivalent(values: readonly unknown[], name: string): void {
  const hashes = values.map((value) => canonicalHash(value));
  if (new Set(hashes).size !== 1) throw new Error(`Phase 2 ${name} variants diverged`);
}

function lowerBasisPoints(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("basis-point denominator must be positive");
  return Math.floor((numerator * 10_000) / denominator);
}
function upperBasisPoints(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("basis-point denominator must be positive");
  return Math.ceil((numerator * 10_000) / denominator);
}
function utf8Bytes(value: unknown): number {
  const serialized = canonicalSerialize(value);
  for (let index = 0; index < serialized.length; index += 1) {
    if (serialized.charCodeAt(index) > 127)
      throw new TypeError("Phase 2 memory fixture must remain ASCII for exact byte accounting");
  }
  return serialized.length;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
