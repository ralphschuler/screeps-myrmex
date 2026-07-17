import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import checkedResult from "../../../docs/phase1-gate-results.json";
import { utf8ByteLength } from "../../bot/src/config/canonical";
import { survivalWorld } from "../../bot/test/support/survival-flow-fixture";
import { establishedRcl2World } from "../../bot/test/support/established-rcl2-fixture";
import { runTick, type TickOutcome } from "../../bot/src/runtime/tick";
import { collectConstrainedCpuEvidence } from "./phase1-constrained-cpu.test";
import { collectHostilePressureEvidence } from "./phase1-hostile-pressure-recovery.test";
import { collectPathTargetEvidence } from "./phase1-path-target-recovery.test";
import { collectSpawnBlockerEvidence } from "./phase1-spawn-blockers.test";
import { canonicalSerialize } from "../src";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("Phase 1 aggregate deterministic evidence (#30)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches checked-in component outputs and keeps unavailable measurements explicit", async () => {
    const actual = await collectAggregateEvidence();
    const { productionBundle, ...checkedAggregate } = checkedResult;
    expect(productionBundle).toBeDefined();
    expect(actual).toEqual(checkedAggregate);

    for (const row of actual.rows) {
      for (const value of Object.values(row.measurements)) {
        expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
      }
      for (const [field, value] of Object.entries(row.measurements)) {
        if (value === null) expect(row.unevidenced).toContain(field);
      }
      for (const value of Object.values(row.hashes)) {
        expect(
          typeof value === "string" && /^(?:fnv1a64-utf16:)?[0-9a-f]{8,64}$/u.test(value),
        ).toBe(true);
      }
    }
    for (const id of [
      "spawn-blocker-recovery",
      "path-target-recovery",
      "hostile-pressure-recovery",
      "constrained-cpu",
    ]) {
      const row = actual.rows.find((candidate) => candidate.id === id);
      expect(row?.unevidenced).toEqual([]);
      expect(
        Object.values(row?.measurements ?? {}).every((value) => typeof value === "number"),
      ).toBe(true);
    }

    expect(actual.status).toBe("complete");
    expect(actual.externalLive).toEqual({
      deployment: "evidenced",
      engineTiming: "evidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "evidenced",
      rollbackIncident: "unevidenced",
    });
  }, 120_000);
});

export async function collectAggregateEvidence() {
  const rcl2 = await collectRcl2RuntimeEvidence();
  const rcl1 = await collectRcl1RuntimeEvidence();
  const composed = await collectComposedRuntimeEvidence();
  const components = [
    composedComponentRow("spawn-blocker-recovery", collectSpawnBlockerEvidence(), composed, {
      ...composedRuntimeMeasurements(composed, "spawn-blocker-recovery"),
      energyFlow: 200,
      recoveryTime: 2,
      spawnUtilizationPct: 25,
    }),
    composedComponentRow("path-target-recovery", collectPathTargetEvidence(), composed, {
      ...composedRuntimeMeasurements(composed, "path-target-recovery"),
      energyFlow: 0,
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    composedComponentRow("hostile-pressure-recovery", collectHostilePressureEvidence(), composed, {
      ...composedRuntimeMeasurements(composed, "hostile-pressure-recovery"),
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    composedComponentRow("constrained-cpu", collectConstrainedCpuEvidence(), composed, {
      ...composedRuntimeMeasurements(composed, "constrained-cpu"),
      energyFlow: 0,
      recoveryTime: 4,
      spawnUtilizationPct: 0,
    }),
  ];
  const rcl2Row = runtimeRow("rcl2-established", rcl2, "evidenced");
  const rcl1Row = runtimeRow("rcl1-cold-boot-growth", rcl1, "evidenced");
  const evidenceRows = [rcl2Row, rcl1Row, ...components];
  const resetReorder = equivalenceRow(evidenceRows);
  return Object.freeze({
    schemaVersion: 1,
    issue: 30,
    status: "complete",
    productionBundleExclusion: "evidenced-local",
    externalLive: Object.freeze({
      deployment: "evidenced",
      engineTiming: "evidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "evidenced",
      rollbackIncident: "unevidenced",
    }),
    rows: Object.freeze([
      rcl2Row,
      rcl1Row,
      ...components,
      resetReorder,
      aggregateRow(evidenceRows, resetReorder),
    ]),
  });
}

interface EvidenceRun {
  readonly outcomeHash: string;
  readonly transcript: {
    readonly ticks: readonly { readonly cpu: { readonly used: number } }[];
  };
  readonly transcriptHash: string;
}

type ComposedRuntimeRowId =
  | "spawn-blocker-recovery"
  | "path-target-recovery"
  | "hostile-pressure-recovery"
  | "constrained-cpu";

interface RuntimeEvidenceRun {
  readonly componentMeasurements?: Readonly<
    Record<ComposedRuntimeRowId, Partial<Record<MeasurementName, number>>>
  >;
  readonly measurements: Partial<Record<MeasurementName, number>>;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly transcript: {
    readonly ticks: readonly {
      readonly cpu: { readonly used: number };
      readonly gameTime: number;
      readonly heapReset: boolean;
      readonly sourceOrder: "normal" | "reversed";
    }[];
  };
}

interface RuntimeRuns {
  readonly reordered: RuntimeEvidenceRun;
  readonly reset: RuntimeEvidenceRun;
  readonly warm: RuntimeEvidenceRun;
}

interface Runs {
  readonly reordered: EvidenceRun;
  readonly reset: EvidenceRun;
  readonly warm: EvidenceRun;
}
type MeasurementName = keyof ReturnType<typeof emptyMeasurements>;

function composedComponentRow(
  id: string,
  runs: Runs,
  composed: RuntimeRuns,
  measured: Partial<Record<MeasurementName, number>>,
) {
  const ticks = runs.warm.transcript.ticks.length;
  const modeledCpu = Math.max(0, ...runs.warm.transcript.ticks.map((tick) => tick.cpu.used));
  const compositionHashes = {
    warmOutcome: hashText(canonicalSerialize(composed.warm.outcome)),
    resetOutcome: hashText(canonicalSerialize(composed.reset.outcome)),
    reorderedOutcome: hashText(canonicalSerialize(composed.reordered.outcome)),
    warmTranscript: hashText(canonicalSerialize(composed.warm.transcript)),
    resetTranscript: hashText(canonicalSerialize(composed.reset.transcript)),
    reorderedTranscript: hashText(canonicalSerialize(composed.reordered.transcript)),
  };
  expect(compositionHashes.resetOutcome).toBe(compositionHashes.warmOutcome);
  expect(compositionHashes.reorderedOutcome).toBe(compositionHashes.warmOutcome);
  const measurements = { ...emptyMeasurements(), ticks, modeledCpu, ...measured };
  return Object.freeze({
    id,
    status: "evidenced",
    scope: "composed-runtime-and-focused-component",
    measurements: Object.freeze(measurements),
    hashes: Object.freeze({
      warmOutcome: hashText(`${runs.warm.outcomeHash}:${compositionHashes.warmOutcome}`),
      resetOutcome: hashText(`${runs.reset.outcomeHash}:${compositionHashes.resetOutcome}`),
      reorderedOutcome: hashText(
        `${runs.reordered.outcomeHash}:${compositionHashes.reorderedOutcome}`,
      ),
      warmTranscript: hashText(`${runs.warm.transcriptHash}:${compositionHashes.warmTranscript}`),
      resetTranscript: hashText(
        `${runs.reset.transcriptHash}:${compositionHashes.resetTranscript}`,
      ),
      reorderedTranscript: hashText(
        `${runs.reordered.transcriptHash}:${compositionHashes.reorderedTranscript}`,
      ),
    }),
    unevidenced: Object.freeze(
      Object.entries(measurements)
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

function composedRuntimeMeasurements(runs: RuntimeRuns, id: ComposedRuntimeRowId) {
  const component = runs.warm.componentMeasurements?.[id];
  if (component === undefined) throw new Error(`composed runtime row ${id} is unavailable`);
  const measurement = (name: MeasurementName): number => {
    const value = component[name] ?? runs.warm.measurements[name];
    if (value === undefined) throw new Error(`composed runtime measurement ${name} is unavailable`);
    return value;
  };
  return {
    persistentBytes: measurement("persistentBytes"),
    persistentGrowth: measurement("persistentGrowth"),
    telemetryBytes: measurement("telemetryBytes"),
    telemetryCardinality: measurement("telemetryCardinality"),
    energyFlow: measurement("energyFlow"),
    replacementLateness: measurement("replacementLateness"),
    controllerMargin: measurement("controllerMargin"),
    controllerRisk: measurement("controllerRisk"),
  };
}

function runtimeRow(id: string, runs: RuntimeRuns, status: "evidenced" | "partial") {
  const ticks = runs.warm.transcript.ticks.length;
  const modeledCpu = Math.max(0, ...runs.warm.transcript.ticks.map((tick) => tick.cpu.used));
  const measurements = {
    ...emptyMeasurements(),
    ...runs.warm.measurements,
    ticks,
    modeledCpu,
  };
  const hashes = {
    warmOutcome: hashText(canonicalSerialize(runs.warm.outcome)),
    resetOutcome: hashText(canonicalSerialize(runs.reset.outcome)),
    reorderedOutcome: hashText(canonicalSerialize(runs.reordered.outcome)),
    warmTranscript: hashText(canonicalSerialize(runs.warm.transcript)),
    resetTranscript: hashText(canonicalSerialize(runs.reset.transcript)),
    reorderedTranscript: hashText(canonicalSerialize(runs.reordered.transcript)),
  };
  expect(hashes.resetOutcome).toBe(hashes.warmOutcome);
  expect(hashes.reorderedOutcome).toBe(hashes.warmOutcome);
  return Object.freeze({
    id,
    status,
    scope: "focused-runtime-export",
    measurements: Object.freeze(measurements),
    hashes: Object.freeze(hashes),
    unevidenced: Object.freeze(
      Object.entries(measurements)
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

type RuntimeExecuteTick = typeof runTick;
type RuntimeTickSample = RuntimeEvidenceRun["transcript"]["ticks"][number];

interface RuntimeMeasurementAccumulator {
  hasPersistentBaseline: boolean;
  maxPersistentBytes: number;
  maxPersistentGrowth: number;
  maxTelemetryBytes: number;
  maxTelemetryCardinality: number;
  previousPersistentBytes: number;
}

async function collectRcl2RuntimeEvidence(): Promise<RuntimeRuns> {
  return {
    warm: await runRcl2Variant(false, false, runTick),
    reset: await runRcl2Variant(true, false),
    reordered: await runRcl2Variant(true, true),
  };
}

async function runRcl2Variant(
  resetMemory: boolean,
  reverseCollections: boolean,
  initialExecuteTick?: RuntimeExecuteTick,
): Promise<RuntimeEvidenceRun> {
  const world = establishedRcl2World({ reverseCollections });
  let executeTick = initialExecuteTick;
  if (executeTick === undefined) {
    vi.resetModules();
    executeTick = (await import("../../bot/src/runtime/tick")).runTick;
  }
  let memory = {} as Memory;
  let memoryResetAt: number | null = null;
  let markHeapReset = false;
  const runtimeMeasurements = createRuntimeMeasurementAccumulator(memory, false);
  const samples: RuntimeTickSample[] = [];
  const outcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];
  let establishedAt: number | null = null;
  let progressBeforeDeath = 0;

  for (let tick = 100; tick < 100 + 150; tick += 1) {
    const outcome = executeTick({ game: world.game(tick), memory });
    outcomes.push({ outcome, tick });
    observeRuntimeMeasurements(runtimeMeasurements, memory, outcome.telemetry);
    samples.push({
      cpu: { used: outcome.kernel.cpuUsed },
      gameTime: tick,
      heapReset: markHeapReset,
      sourceOrder: reverseCollections ? "reversed" : "normal",
    });
    markHeapReset = false;

    if (resetMemory && memoryResetAt === null && world.extensionEnergy() > 0) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../bot/src/runtime/tick")).runTick;
      memoryResetAt = tick;
      markHeapReset = true;
    }
    if (establishedAt === null && world.roomEnergy() === 400 && world.siteProgress() > 0) {
      establishedAt = tick;
      progressBeforeDeath = world.siteProgress();
      world.killWorker();
    } else if (
      establishedAt !== null &&
      world.replacementUsefulWorkAt() !== null &&
      world.roomEnergy() >= 300 &&
      world.siteProgress() >= progressBeforeDeath
    ) {
      break;
    }
  }

  const last = outcomes[outcomes.length - 1];
  if (last === undefined) throw new Error("RCL2 runtime evidence produced no ticks");
  if (establishedAt === null) throw new Error("RCL2 runtime never established its economy");
  const replacementUsefulWorkAt = world.replacementUsefulWorkAt();
  if (replacementUsefulWorkAt === null)
    throw new Error("RCL2 replacement performed no useful work");
  expect(world.spawnCalls()).toHaveLength(1);
  expect(world.spawnCalls()[0]).toMatchObject({ body: ["work", "carry", "move"], cost: 200 });
  expect(world.replacementVisibleAt()).not.toBeNull();
  expect(replacementUsefulWorkAt).toBeLessThanOrEqual(establishedAt + 50);
  expect(world.roomEnergy()).toBeGreaterThanOrEqual(300);
  expect(world.siteProgress()).toBeGreaterThanOrEqual(progressBeforeDeath);
  const deliveredEnergy = outcomes.reduce(
    (total, { outcome }) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
    0,
  );
  const recoveryTime = samples.length;
  const controllerMargin = Math.max(0, world.controllerTicksToDowngrade() - recoveryTime);
  const spawnTicks = world.spawnCalls().reduce((total, call) => total + call.body.length * 3, 0);
  return {
    measurements: {
      ...finalizeRuntimeMeasurements(runtimeMeasurements),
      controllerMargin,
      controllerRisk: controllerMargin >= 1 ? 0 : 1,
      energyFlow: deliveredEnergy,
      replacementLateness: Math.max(0, replacementUsefulWorkAt - establishedAt - 50),
      recoveryTime,
      spawnUtilizationPct: (spawnTicks / samples.length) * 100,
    },
    outcome: {
      constructionSiteCalls: world.constructionSiteCalls(),
      extensionEnergy: world.extensionEnergy(),
      roomEnergy: world.roomEnergy(),
      replacementUsefulWorkAt,
      replacementVisibleAt: world.replacementVisibleAt(),
      replacementWorkerId: world.replacementWorkerId(),
      siteCount: world.siteCount(),
      siteProgress: world.siteProgress(),
      spawnCalls: world.spawnCalls(),
      spawnEnergy: world.spawnEnergy(),
    },
    transcript: { ticks: samples },
  };
}

async function collectRcl1RuntimeEvidence(): Promise<RuntimeRuns> {
  return {
    warm: await runRcl1Variant(false, false, runTick),
    reset: await runRcl1Variant(true, false),
    reordered: await runRcl1Variant(true, true),
  };
}

async function collectComposedRuntimeEvidence(): Promise<RuntimeRuns> {
  return {
    warm: await runComposedRuntimeVariant(false, false),
    reset: await runComposedRuntimeVariant(true, false),
    reordered: await runComposedRuntimeVariant(true, true),
  };
}

async function runComposedRuntimeVariant(
  resetMemory: boolean,
  reorderAfterReset: boolean,
): Promise<RuntimeEvidenceRun> {
  const world = survivalWorld();
  vi.resetModules();
  let executeTick = (await import("../../bot/src/runtime/tick")).runTick;
  let memory = {} as Memory;
  let nextTick = 100;
  let markHeapReset = false;
  const samples: RuntimeTickSample[] = [];
  const outcomes: TickOutcome[] = [];
  const runtimeMeasurements = createRuntimeMeasurementAccumulator(memory, false);
  const spawnMeasurements = createRuntimeMeasurementAccumulator(memory, false);
  const spawnOutcomes: TickOutcome[] = [];

  const runOne = (stage?: {
    readonly accumulator: RuntimeMeasurementAccumulator;
    readonly outcomes: TickOutcome[];
  }): TickOutcome => {
    const tick = nextTick;
    nextTick += 1;
    const outcome = executeTick({
      game: world.game(tick),
      localPathSearch: world.pathSearch,
      memory,
    });
    outcomes.push(outcome);
    world.assertEnergyConserved();
    observeRuntimeMeasurements(runtimeMeasurements, memory, outcome.telemetry);
    if (stage !== undefined) {
      observeRuntimeMeasurements(stage.accumulator, memory, outcome.telemetry);
      stage.outcomes.push(outcome);
    }
    samples.push({
      cpu: { used: outcome.kernel.cpuUsed },
      gameTime: tick,
      heapReset: markHeapReset,
      sourceOrder: world.reverseSources ? "reversed" : "normal",
    });
    markHeapReset = false;
    return outcome;
  };
  const spawnStage = { accumulator: spawnMeasurements, outcomes: spawnOutcomes };

  world.setSpawnBlocker("busy");
  runOne(spawnStage);
  world.setSpawnBlocker("energy");
  runOne(spawnStage);
  world.setSpawnBlocker(null);
  runOne(spawnStage);
  const initialSpawn = world.spawnCalls[0];
  if (initialSpawn === undefined) throw new Error("composed runtime did not schedule its worker");
  const workerReadyAt = initialSpawn.tick + initialSpawn.body.length * 3;
  while (nextTick < workerReadyAt) runOne(spawnStage);

  const pathMeasurements = createRuntimeMeasurementAccumulator(memory, false);
  const pathOutcomes: TickOutcome[] = [];
  const pathStage = { accumulator: pathMeasurements, outcomes: pathOutcomes };
  world.setPathUnavailable(true);
  for (let attempt = 0; attempt < 12 && world.pathUnavailableObservations === 0; attempt += 1) {
    runOne(pathStage);
  }
  world.setPathUnavailable(false);
  if (world.pathUnavailableObservations === 0) {
    throw new Error("composed runtime never exercised the unavailable path adapter");
  }
  world.setTargetResolverUnavailable(true);
  for (let attempt = 0; attempt < 30 && world.targetMissingObservations === 0; attempt += 1) {
    runOne(pathStage);
  }
  world.setTargetResolverUnavailable(false);
  if (world.targetMissingObservations === 0) {
    throw new Error("composed runtime never exercised the stale target resolver");
  }

  if (resetMemory) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../../bot/src/runtime/tick")).runTick;
    if (reorderAfterReset) world.reverseSources = true;
    markHeapReset = true;
  }

  const hostileMeasurements = createRuntimeMeasurementAccumulator(memory, true);
  const hostileStageOutcomes: TickOutcome[] = [];
  const hostileStage = { accumulator: hostileMeasurements, outcomes: hostileStageOutcomes };
  world.setHostilePressure(true);
  const hostileOutcomes = [runOne(hostileStage), runOne(hostileStage), runOne(hostileStage)];
  world.setHostilePressure(false);
  const threatObserved = hostileOutcomes.some(
    (outcome) =>
      (outcome.telemetry?.colony.states.find(({ id }) => id === "threatened")?.count ?? 0) > 0,
  );

  const constrainedMeasurements = createRuntimeMeasurementAccumulator(memory, true);
  const constrainedStageOutcomes: TickOutcome[] = [];
  const constrainedStage = {
    accumulator: constrainedMeasurements,
    outcomes: constrainedStageOutcomes,
  };
  world.setCpuBucket(3_000);
  const constrainedOutcomes = [
    runOne(constrainedStage),
    runOne(constrainedStage),
    runOne(constrainedStage),
    runOne(constrainedStage),
  ];
  world.setCpuBucket(10_000);
  const mandatoryTailIds = [
    "execution.arbitrate",
    "execution.defense",
    "spawn.execute",
    "spawn.settle",
    "state.reconcile",
    "telemetry.minimum",
  ];
  const constrainedTailCompleted = constrainedOutcomes.every(
    (outcome) =>
      outcome.kernel.mode === "constrained" &&
      mandatoryTailIds.every(
        (id) =>
          outcome.kernel.systems.find(({ systemId }) => systemId === id)?.status === "completed",
      ) &&
      outcome.telemetry !== null,
  );
  const constrainedGrowthDeferred = constrainedOutcomes.every((outcome) => {
    const growth = outcome.kernel.systems.find(({ systemId }) => systemId === "growth.contracts");
    return growth?.status === "skipped" && growth.skipReason === "cpu-mode";
  });

  while ((world.firstDeliveryAt === null || world.spawnEnergy < 200) && nextTick <= 500) runOne();
  if (world.firstDeliveryAt === null || world.spawnEnergy < 200) {
    throw new Error("composed runtime did not recover normal delivery before worker death");
  }
  const deliveredBeforeDeath = world.sourceBDelivered;
  const afterDeathTick = nextTick;
  world.killWorker();
  runOne();
  let replacementRecoveredAt: number | null = null;
  while (nextTick <= afterDeathTick + 122) {
    runOne();
    if (world.sourceBDelivered > deliveredBeforeDeath) {
      replacementRecoveredAt = nextTick - 1;
      break;
    }
  }
  if (replacementRecoveredAt === null) {
    throw new Error("composed runtime replacement missed its recovery deadline");
  }

  expect(world.spawnBusyObservations).toBe(1);
  expect(world.spawnEnergyBlockerObservations).toBe(1);
  expect(world.targetMissingObservations).toBeGreaterThan(0);
  expect(world.pathUnavailableObservations).toBeGreaterThan(0);
  expect(world.hostileObservations).toBe(3);
  expect(world.constrainedCpuObservations).toBe(4);
  expect(threatObserved).toBe(true);
  expect(constrainedTailCompleted).toBe(true);
  expect(constrainedGrowthDeferred).toBe(true);
  expect(world.spawnCalls).toHaveLength(2);
  expect(world.sourceBDelivered).toBeGreaterThan(deliveredBeforeDeath);

  const deliveredEnergy = outcomes.reduce(
    (total, outcome) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
    0,
  );
  const tickCount = samples.length;
  const controllerMargin = Math.max(0, world.controllerTicksToDowngrade - tickCount);
  const sharedMeasurements = {
    controllerMargin,
    controllerRisk: controllerMargin >= 1 ? 0 : 1,
    replacementLateness: Math.max(0, replacementRecoveredAt - afterDeathTick - 122),
  };
  const stageMeasurements = (
    accumulator: RuntimeMeasurementAccumulator,
    stageOutcomes: readonly TickOutcome[],
  ) => ({
    ...finalizeRuntimeMeasurements(accumulator),
    ...sharedMeasurements,
    energyFlow: stageOutcomes.reduce(
      (total, outcome) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
      0,
    ),
  });
  return {
    componentMeasurements: {
      "spawn-blocker-recovery": stageMeasurements(spawnMeasurements, spawnOutcomes),
      "path-target-recovery": stageMeasurements(pathMeasurements, pathOutcomes),
      "hostile-pressure-recovery": stageMeasurements(hostileMeasurements, hostileStageOutcomes),
      "constrained-cpu": stageMeasurements(constrainedMeasurements, constrainedStageOutcomes),
    },
    measurements: {
      ...finalizeRuntimeMeasurements(runtimeMeasurements),
      ...sharedMeasurements,
      energyFlow: deliveredEnergy,
      recoveryTime: tickCount,
      spawnUtilizationPct:
        Math.round(
          (world.spawnCalls.reduce((total, call) => total + call.body.length * 3, 0) / tickCount) *
            10_000,
        ) / 100,
    },
    outcome: {
      constrainedCpuObservations: world.constrainedCpuObservations,
      constrainedGrowthDeferred,
      constrainedTailCompleted,
      hostileObservations: world.hostileObservations,
      pathUnavailableObservations: world.pathUnavailableObservations,
      replacementRecovered: true,
      sourceBDelivered: world.sourceBDelivered,
      spawnBusyObservations: world.spawnBusyObservations,
      spawnCalls: world.spawnCalls.map(({ body, cost }) => ({ body, cost })),
      spawnEnergyBlockerObservations: world.spawnEnergyBlockerObservations,
      targetMissingObservations: world.targetMissingObservations,
      threatObserved,
    },
    transcript: { ticks: samples },
  };
}

async function runRcl1Variant(
  resetMemory: boolean,
  reorderAfterReset: boolean,
  initialExecuteTick?: RuntimeExecuteTick,
): Promise<RuntimeEvidenceRun> {
  const world = survivalWorld();
  let executeTick = initialExecuteTick;
  if (executeTick === undefined) {
    vi.resetModules();
    executeTick = (await import("../../bot/src/runtime/tick")).runTick;
  }
  let memory = {} as Memory;
  let memoryResetAt: number | null = null;
  let markHeapReset = false;
  const runtimeMeasurements = createRuntimeMeasurementAccumulator(memory, true);
  const samples: RuntimeTickSample[] = [];
  const outcomes: Array<{ readonly outcome: TickOutcome; readonly tick: number }> = [];

  for (let tick = 100; tick <= 100 + 1_499; tick += 1) {
    const outcome = executeTick({
      game: world.game(tick),
      localPathSearch: world.pathSearch,
      memory,
    });
    outcomes.push({ outcome, tick });
    world.assertEnergyConserved();
    observeRuntimeMeasurements(runtimeMeasurements, memory, outcome.telemetry);
    samples.push({
      cpu: { used: outcome.kernel.cpuUsed },
      gameTime: tick,
      heapReset: markHeapReset,
      sourceOrder: world.reverseSources ? "reversed" : "normal",
    });
    markHeapReset = false;

    if (
      resetMemory &&
      memoryResetAt === null &&
      world.workerEnergy >= 10 &&
      world.firstHarvestAt !== null
    ) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../bot/src/runtime/tick")).runTick;
      if (reorderAfterReset) world.reverseSources = true;
      memoryResetAt = tick;
      markHeapReset = true;
    }
    if (world.controllerLevel >= 2) break;
  }

  const last = outcomes[outcomes.length - 1];
  if (last === undefined) throw new Error("RCL1 runtime evidence produced no ticks");
  const deliveredBeforeDeath = world.sourceBDelivered;
  world.killWorker();
  const afterDeathTick = last.tick + 1;
  const afterDeath = executeTick({
    game: world.game(afterDeathTick),
    localPathSearch: world.pathSearch,
    memory,
  });
  outcomes.push({ outcome: afterDeath, tick: afterDeathTick });
  world.assertEnergyConserved();
  observeRuntimeMeasurements(runtimeMeasurements, memory, afterDeath.telemetry);
  samples.push({
    cpu: { used: afterDeath.kernel.cpuUsed },
    gameTime: afterDeathTick,
    heapReset: false,
    sourceOrder: world.reverseSources ? "reversed" : "normal",
  });

  let replacementRecoveredAt: number | null = null;
  for (let tick = afterDeathTick + 1; tick <= afterDeathTick + 122; tick += 1) {
    const outcome = executeTick({
      game: world.game(tick),
      localPathSearch: world.pathSearch,
      memory,
    });
    outcomes.push({ outcome, tick });
    world.assertEnergyConserved();
    observeRuntimeMeasurements(runtimeMeasurements, memory, outcome.telemetry);
    samples.push({
      cpu: { used: outcome.kernel.cpuUsed },
      gameTime: tick,
      heapReset: false,
      sourceOrder: world.reverseSources ? "reversed" : "normal",
    });
    if (world.sourceBDelivered > deliveredBeforeDeath) {
      replacementRecoveredAt = tick;
      break;
    }
  }

  expect(world.controllerLevel).toBe(2);
  expect(world.firstHarvestTargetId).toBe("source-a");
  expect(world.spawnCalls).toHaveLength(2);
  expect(world.sourceBDelivered).toBeGreaterThan(deliveredBeforeDeath);
  const deliveredEnergy = outcomes.reduce(
    (total, { outcome }) => total + (outcome.telemetry?.energyFlow.delivered ?? 0),
    0,
  );
  const recoveryTime = last.tick - 100;
  const tickCount = samples.length;
  if (replacementRecoveredAt === null) throw new Error("RCL1 replacement missed its deadline");
  const controllerMargin = Math.max(0, world.controllerTicksToDowngrade - tickCount);
  return {
    measurements: {
      ...finalizeRuntimeMeasurements(runtimeMeasurements),
      controllerMargin,
      controllerRisk: controllerMargin >= 1 ? 0 : 1,
      energyFlow: deliveredEnergy,
      recoveryTime,
      replacementLateness: Math.max(0, replacementRecoveredAt - afterDeathTick - 122),
      spawnUtilizationPct:
        Math.round(
          (world.spawnCalls.reduce((total, call) => total + call.body.length * 3, 0) / tickCount) *
            10_000,
        ) / 100,
    },
    outcome: {
      controllerLevel: world.controllerLevel,
      firstHarvestTargetId: world.firstHarvestTargetId,
      sourceAEnergy: world.sourceAEnergy,
      sourceBDelivered: world.sourceBDelivered,
      sourceBHarvested: world.sourceBHarvested,
      spawnCalls: world.spawnCalls.map(({ body, cost }) => ({ body, cost })),
      spawnEnergy: world.spawnEnergy,
      workerVisibleAt: world.workerVisibleAt,
    },
    transcript: { ticks: samples },
  };
}

function createRuntimeMeasurementAccumulator(
  memory: Memory,
  includeInitialGrowth: boolean,
): RuntimeMeasurementAccumulator {
  const initialPersistentBytes = canonicalUtf8Bytes(memory);
  return {
    hasPersistentBaseline: includeInitialGrowth,
    maxPersistentBytes: initialPersistentBytes,
    maxPersistentGrowth: 0,
    maxTelemetryBytes: 0,
    maxTelemetryCardinality: 0,
    previousPersistentBytes: initialPersistentBytes,
  };
}

function observeRuntimeMeasurements(
  accumulator: RuntimeMeasurementAccumulator,
  memory: Memory,
  telemetry: unknown,
): void {
  const persistentBytes = canonicalUtf8Bytes(memory);
  if (accumulator.hasPersistentBaseline) {
    accumulator.maxPersistentGrowth = Math.max(
      accumulator.maxPersistentGrowth,
      persistentBytes - accumulator.previousPersistentBytes,
    );
  }
  accumulator.hasPersistentBaseline = true;
  accumulator.previousPersistentBytes = persistentBytes;
  accumulator.maxPersistentBytes = Math.max(accumulator.maxPersistentBytes, persistentBytes);
  if (telemetry === undefined) return;
  accumulator.maxTelemetryBytes = Math.max(
    accumulator.maxTelemetryBytes,
    canonicalUtf8Bytes(telemetry),
  );
  accumulator.maxTelemetryCardinality = Math.max(
    accumulator.maxTelemetryCardinality,
    telemetryChannelCardinality(telemetry),
  );
}

function finalizeRuntimeMeasurements(accumulator: RuntimeMeasurementAccumulator) {
  return {
    persistentBytes: accumulator.maxPersistentBytes,
    persistentGrowth: accumulator.maxPersistentGrowth,
    telemetryBytes: accumulator.maxTelemetryBytes,
    telemetryCardinality: accumulator.maxTelemetryCardinality,
  };
}

function canonicalUtf8Bytes(value: unknown): number {
  return utf8ByteLength(canonicalSerialize(value));
}

function telemetryChannelCardinality(value: unknown): number {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

type AggregateEvidenceRow = ReturnType<typeof composedComponentRow> | ReturnType<typeof runtimeRow>;

function availableRowMeasurements(
  rows: readonly AggregateEvidenceRow[],
  name: MeasurementName,
): readonly number[] {
  const values = rows.flatMap((row) => {
    const value = row.measurements[name];
    return value === null ? [] : [value];
  });
  if (values.length === 0) throw new Error(`aggregate measurement ${name} is unavailable`);
  return values;
}

function equivalenceRow(components: readonly AggregateEvidenceRow[]) {
  const warmOutcome = hashText(components.map((row) => row.hashes.warmOutcome).join(":"));
  const resetOutcome = hashText(components.map((row) => row.hashes.resetOutcome).join(":"));
  const reorderedOutcome = hashText(components.map((row) => row.hashes.reorderedOutcome).join(":"));
  const measurements = {
    ticks: components.reduce((total, row) => total + row.measurements.ticks, 0),
    modeledCpu: Math.max(...components.map((row) => row.measurements.modeledCpu)),
    persistentBytes: Math.max(...availableRowMeasurements(components, "persistentBytes")),
    persistentGrowth: Math.max(...availableRowMeasurements(components, "persistentGrowth")),
    telemetryBytes: Math.max(...availableRowMeasurements(components, "telemetryBytes")),
    telemetryCardinality: Math.max(...availableRowMeasurements(components, "telemetryCardinality")),
    spawnUtilizationPct: Math.max(...availableRowMeasurements(components, "spawnUtilizationPct")),
    energyFlow: Math.max(...availableRowMeasurements(components, "energyFlow")),
    replacementLateness: Math.max(...availableRowMeasurements(components, "replacementLateness")),
    controllerMargin: Math.min(...availableRowMeasurements(components, "controllerMargin")),
    controllerRisk: Math.max(...availableRowMeasurements(components, "controllerRisk")),
    recoveryTime: Math.max(...availableRowMeasurements(components, "recoveryTime")),
  };
  return Object.freeze({
    id: "reset-reorder-equivalence",
    status: "evidenced",
    scope: "composed-runtime-equivalence",
    measurements: Object.freeze(measurements),
    hashes: Object.freeze({
      warmOutcome,
      resetOutcome,
      reorderedOutcome,
      warmTranscript: hashText(components.map((row) => row.hashes.warmTranscript).join(":")),
      resetTranscript: hashText(components.map((row) => row.hashes.resetTranscript).join(":")),
      reorderedTranscript: hashText(
        components.map((row) => row.hashes.reorderedTranscript).join(":"),
      ),
    }),
    unevidenced: Object.freeze([]),
  });
}

function aggregateRow(
  components: readonly AggregateEvidenceRow[],
  equivalence: ReturnType<typeof equivalenceRow>,
) {
  return Object.freeze({
    id: "aggregate-phase1-matrix",
    status: "evidenced",
    scope: "local-composed-runtime",
    measurements: equivalence.measurements,
    hashes: Object.freeze({
      warmOutcome: hashText(components.map((row) => row.hashes.warmOutcome).join("|")),
      resetOutcome: hashText(components.map((row) => row.hashes.resetOutcome).join("|")),
      reorderedOutcome: hashText(components.map((row) => row.hashes.reorderedOutcome).join("|")),
      warmTranscript: equivalence.hashes.warmTranscript,
      resetTranscript: equivalence.hashes.resetTranscript,
      reorderedTranscript: equivalence.hashes.reorderedTranscript,
    }),
    unevidenced: Object.freeze([]),
  });
}

function emptyMeasurements() {
  return {
    ticks: null as number | null,
    modeledCpu: null as number | null,
    persistentBytes: null as number | null,
    persistentGrowth: null as number | null,
    telemetryBytes: null as number | null,
    telemetryCardinality: null as number | null,
    spawnUtilizationPct: null as number | null,
    energyFlow: null as number | null,
    replacementLateness: null as number | null,
    controllerMargin: null as number | null,
    controllerRisk: null as number | null,
    recoveryTime: null as number | null,
  };
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
