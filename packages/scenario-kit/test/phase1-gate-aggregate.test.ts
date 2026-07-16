import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import checkedResult from "../../../docs/phase1-gate-results.json";
import { survivalWorld } from "../../bot/test/support/survival-flow-fixture";
import { runTick, type TickOutcome } from "../../bot/src/runtime/tick";
import { collectConstrainedCpuEvidence } from "./phase1-constrained-cpu.test";
import { collectHostilePressureEvidence } from "./phase1-hostile-pressure-recovery.test";
import { collectPathTargetEvidence } from "./phase1-path-target-recovery.test";
import { collectSpawnBlockerEvidence } from "./phase1-spawn-blockers.test";
import { canonicalSerialize } from "../src";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("Phase 1 aggregate deterministic evidence (#30)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches checked-in component outputs and keeps unavailable measurements explicit", async () => {
    const actual = await collectAggregateEvidence();
    expect(actual).toEqual(checkedResult);

    for (const row of actual.rows) {
      for (const value of Object.values(row.measurements)) {
        expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
      }
      for (const [field, value] of Object.entries(row.measurements)) {
        if (value === null) expect(row.unevidenced).toContain(field);
      }
      for (const value of Object.values(row.hashes)) {
        expect(value === null || /^(?:fnv1a64-utf16:)?[0-9a-f]{8,64}$/u.test(value)).toBe(true);
      }
    }

    expect(actual.status).toBe("blocked");
    expect(actual.externalLive).toEqual({
      deployment: "unevidenced",
      engineTiming: "unevidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "unevidenced",
      rollbackIncident: "unevidenced",
    });
  }, 30_000);
});

export async function collectAggregateEvidence() {
  const rcl1 = await collectRcl1RuntimeEvidence();
  const components = [
    componentRow("spawn-blocker-recovery", collectSpawnBlockerEvidence(), {
      energyFlow: 200,
      recoveryTime: 2,
      spawnUtilizationPct: 25,
    }),
    componentRow("path-target-recovery", collectPathTargetEvidence(), {
      energyFlow: 0,
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    componentRow("hostile-pressure-recovery", collectHostilePressureEvidence(), {
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    componentRow("constrained-cpu", collectConstrainedCpuEvidence(), {
      energyFlow: 0,
      recoveryTime: 4,
      spawnUtilizationPct: 0,
    }),
  ];
  const rcl1Row = runtimeRow("rcl1-cold-boot-growth", rcl1, "partial");
  const evidenceRows = [rcl1Row, ...components];
  const resetReorder = equivalenceRow(evidenceRows);
  return Object.freeze({
    schemaVersion: 1,
    issue: 30,
    status: "blocked",
    productionBundleExclusion: "evidenced-local",
    externalLive: Object.freeze({
      deployment: "unevidenced",
      engineTiming: "unevidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "unevidenced",
      rollbackIncident: "unevidenced",
    }),
    rows: Object.freeze([
      unavailableRuntimeRow("rcl2-established", "evidenced"),
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

interface RuntimeEvidenceRun {
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

function componentRow(id: string, runs: Runs, measured: Partial<Record<MeasurementName, number>>) {
  const ticks = runs.warm.transcript.ticks.length;
  const modeledCpu = runs.warm.transcript.ticks.reduce((total, tick) => total + tick.cpu.used, 0);
  return Object.freeze({
    id,
    status: "partial",
    scope: "deterministic-component",
    measurements: Object.freeze({ ...emptyMeasurements(), ticks, modeledCpu, ...measured }),
    hashes: Object.freeze({
      warmOutcome: runs.warm.outcomeHash,
      resetOutcome: runs.reset.outcomeHash,
      reorderedOutcome: runs.reordered.outcomeHash,
      warmTranscript: runs.warm.transcriptHash,
      resetTranscript: runs.reset.transcriptHash,
      reorderedTranscript: runs.reordered.transcriptHash,
    }),
    unevidenced: Object.freeze(
      Object.entries({ ...emptyMeasurements(), ticks, modeledCpu, ...measured })
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

function unavailableRuntimeRow(id: string, status: "evidenced" | "partial") {
  return Object.freeze({
    id,
    status,
    scope: "focused-runtime-not-exported",
    measurements: Object.freeze(emptyMeasurements()),
    hashes: Object.freeze(emptyHashes()),
    unevidenced: Object.freeze(Object.keys(emptyMeasurements())),
  });
}

function runtimeRow(id: string, runs: RuntimeRuns, status: "evidenced" | "partial") {
  const ticks = runs.warm.transcript.ticks.length;
  const modeledCpu = runs.warm.transcript.ticks.reduce((total, tick) => total + tick.cpu.used, 0);
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

async function collectRcl1RuntimeEvidence(): Promise<RuntimeRuns> {
  return {
    warm: await runRcl1Variant(false, false, runTick),
    reset: await runRcl1Variant(true, false),
    reordered: await runRcl1Variant(true, true),
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
  samples.push({
    cpu: { used: afterDeath.kernel.cpuUsed },
    gameTime: afterDeathTick,
    heapReset: false,
    sourceOrder: world.reverseSources ? "reversed" : "normal",
  });

  for (let tick = afterDeathTick + 1; tick <= afterDeathTick + 122; tick += 1) {
    const outcome = executeTick({
      game: world.game(tick),
      localPathSearch: world.pathSearch,
      memory,
    });
    outcomes.push({ outcome, tick });
    world.assertEnergyConserved();
    samples.push({
      cpu: { used: outcome.kernel.cpuUsed },
      gameTime: tick,
      heapReset: false,
      sourceOrder: world.reverseSources ? "reversed" : "normal",
    });
    if (world.sourceBDelivered > deliveredBeforeDeath) break;
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
  return {
    measurements: {
      energyFlow: deliveredEnergy,
      recoveryTime,
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

type AggregateEvidenceRow = ReturnType<typeof componentRow> | ReturnType<typeof runtimeRow>;

function equivalenceRow(components: readonly AggregateEvidenceRow[]) {
  const warmOutcome = hashText(components.map((row) => row.hashes.warmOutcome).join(":"));
  const resetOutcome = hashText(components.map((row) => row.hashes.resetOutcome).join(":"));
  const reorderedOutcome = hashText(components.map((row) => row.hashes.reorderedOutcome).join(":"));
  const measurements = {
    ...emptyMeasurements(),
    ticks: components.reduce((total, row) => total + row.measurements.ticks, 0),
    modeledCpu: components.reduce((total, row) => total + row.measurements.modeledCpu, 0),
    recoveryTime: Math.max(...components.map((row) => row.measurements.recoveryTime ?? 0)),
  };
  return Object.freeze({
    id: "reset-reorder-equivalence",
    status: "partial",
    scope: "deterministic-component-equivalence",
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
    unevidenced: Object.freeze(
      Object.entries(measurements)
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

function aggregateRow(
  components: readonly AggregateEvidenceRow[],
  equivalence: ReturnType<typeof equivalenceRow>,
) {
  return Object.freeze({
    id: "aggregate-phase1-matrix",
    status: "unevidenced",
    scope: "local-component-subset",
    measurements: equivalence.measurements,
    hashes: Object.freeze({
      warmOutcome: hashText(components.map((row) => row.hashes.warmOutcome).join("|")),
      resetOutcome: hashText(components.map((row) => row.hashes.resetOutcome).join("|")),
      reorderedOutcome: hashText(components.map((row) => row.hashes.reorderedOutcome).join("|")),
      warmTranscript: null,
      resetTranscript: null,
      reorderedTranscript: null,
    }),
    unevidenced: Object.freeze([
      ...equivalence.unevidenced,
      "warmTranscript",
      "resetTranscript",
      "reorderedTranscript",
      "rcl2RuntimeExport",
      "externalLive",
    ]),
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

function emptyHashes() {
  return {
    warmOutcome: null,
    resetOutcome: null,
    reorderedOutcome: null,
    warmTranscript: null,
    resetTranscript: null,
    reorderedTranscript: null,
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
