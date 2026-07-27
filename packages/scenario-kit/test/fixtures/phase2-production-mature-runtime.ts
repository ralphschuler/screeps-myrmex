import { vi } from "vitest";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import type { TickOutcome } from "../../../bot/src/runtime/tick";
import { matureRuntimeWorld } from "../../../bot/test/support/mature-runtime-fixture";
import { canonicalHash, canonicalSerialize } from "../../src";

const FIRST_TICK = 100;
const LAST_TICK = 102;

type Variant = "reordered" | "reset" | "warm";

export async function collectPhase2ProductionMatureRuntimeReceipt() {
  const warm = await runVariant("warm");
  const reset = await runVariant("reset");
  const reordered = await runVariant("reordered");
  const summaries = [warm.summary, reset.summary, reordered.summary];
  const semanticHashes = Object.freeze({
    reordered: canonicalHash(reordered.summary),
    reset: canonicalHash(reset.summary),
    warm: canonicalHash(warm.summary),
  });

  if (new Set(summaries.map((summary) => canonicalSerialize(summary))).size !== 1) {
    throw new Error(
      `mature production runtime semantic drift: ${canonicalSerialize({ reordered: reordered.summary, reset: reset.summary, warm: warm.summary })}`,
    );
  }

  return Object.freeze({
    accounting: warm.summary.accounting,
    commands: Object.freeze([
      Object.freeze({
        callsPerVariant: warm.summary.factoryCalls,
        kind: "StructureFactory.produce",
      }),
      Object.freeze({
        callsPerVariant: warm.summary.powerProcessingCalls,
        kind: "StructurePowerSpawn.processPower",
      }),
    ]),
    completeColonySoak: false,
    controllerLevel: 8,
    executedVariants: Object.freeze([warm, reset, reordered].map(({ kind }) => kind)),
    executor: "packages/bot/src/runtime/tick.runTick",
    healthObservation: Object.freeze({
      blockerDomain: warm.summary.blockerDomain,
      colonyStates: warm.summary.colonyStates,
    }),
    id: "rcl8-mature-command-settlement",
    kernelFaults:
      warm.summary.kernelFaults + reset.summary.kernelFaults + reordered.summary.kernelFaults,
    maximumPersistentBytes: Math.max(
      warm.maximumPersistentBytes,
      reset.maximumPersistentBytes,
      reordered.maximumPersistentBytes,
    ),
    memoryResetObserved: reset.resetApplied,
    semanticHashes,
    settled: warm.summary.settled,
    ticksPerVariant: Object.freeze(
      [warm, reset, reordered].map(({ executedTicks }) => executedTicks),
    ),
    totalExecutedTicks: [warm, reset, reordered].reduce(
      (sum, { executedTicks }) => sum + executedTicks,
      0,
    ),
  });
}

async function runVariant(kind: Variant) {
  vi.resetModules();
  const world = matureRuntimeWorld({ reverseCollections: kind === "reordered" });
  let memory = {} as Memory;
  let executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
  let maximumPersistentBytes = 0;
  let resetApplied = false;
  const outcomes: TickOutcome[] = [];

  const execute = (tick: number) => {
    const outcome = executeTick({ game: world.game(tick), memory });
    outcomes.push(outcome);
    maximumPersistentBytes = Math.max(
      maximumPersistentBytes,
      utf8ByteLength(canonicalSerialize(memory)),
    );
    return outcome;
  };

  execute(FIRST_TICK);
  execute(FIRST_TICK + 1);
  world.applyScheduledEffects();
  if (kind === "reset") {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
    resetApplied = true;
  }
  const settled = execute(LAST_TICK);
  const colonyStates = outcomes.map((outcome) => outcome.colony.colonies[0]?.state ?? "absent");
  const blockerDomain = outcomes[0]?.colony.colonies[0]?.domainHealth.blocker?.domain ?? null;
  const accounting = settled.telemetry?.industry.mature?.accounting;
  if (accounting === undefined) throw new Error(`${kind} mature runtime did not settle accounting`);

  const summary = Object.freeze({
    accounting: Object.freeze({
      factory: Object.freeze([...accounting.factory]),
      powerProcessing: Object.freeze([...accounting.powerProcessing]),
    }),
    blockerDomain,
    colonyStates: Object.freeze(colonyStates),
    factoryCalls: world.produce.mock.calls.length,
    finalGameplayPersistentHash: canonicalHash(memory.myrmex ?? {}),
    kernelFaults: outcomes.reduce((sum, outcome) => sum + outcome.kernel.faults.length, 0),
    powerProcessingCalls: world.processPower.mock.calls.length,
    settled:
      accounting.factory.join(",") === "40,100,20" &&
      accounting.powerProcessing.join(",") === "50,1,1",
  });

  if (
    summary.factoryCalls !== 1 ||
    summary.powerProcessingCalls !== 1 ||
    summary.kernelFaults !== 0 ||
    !summary.settled
  ) {
    throw new Error(`${kind} mature production runtime did not execute and settle exactly once`);
  }

  return { executedTicks: outcomes.length, kind, maximumPersistentBytes, resetApplied, summary };
}
