import { vi } from "vitest";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import { openContractLedgerState } from "../../../bot/src/contracts";
import type { TickOutcome } from "../../../bot/src/runtime/tick";
import { matureRuntimeWorld } from "../../../bot/test/support/mature-runtime-fixture";
import { remoteRuntimeGame } from "../../../bot/test/support/remote-runtime-fixture";
import { canonicalHash, canonicalSerialize } from "../../src";

const FIRST_TICK = 1_000;
const TICK_COUNT = 30;
type Variant = "reordered" | "reset" | "warm";

export async function collectPhase3CurrentRuntimeCompatibilityReceipt() {
  const warm = await runVariant("warm");
  const reset = await runVariant("reset");
  const reordered = await runVariant("reordered");
  const summaries = [warm.summary, reset.summary, reordered.summary];
  if (new Set(summaries.map((summary) => canonicalSerialize(summary))).size !== 1) {
    throw new Error(
      `Phase 3 current-runtime portfolio semantic drift: ${canonicalSerialize({ reordered: reordered.summary, reset: reset.summary, warm: warm.summary })}`,
    );
  }
  return Object.freeze({
    id: "phase3/portfolio/current-runtime-compatibility-v1",
    executor: "packages/bot/src/runtime/tick.runTick",
    executedVariants: Object.freeze([warm.kind, reset.kind, reordered.kind]),
    ticksPerVariant: Object.freeze([
      warm.executedTicks,
      reset.executedTicks,
      reordered.executedTicks,
    ]),
    totalExecutedTicks: warm.executedTicks + reset.executedTicks + reordered.executedTicks,
    memoryResetObserved: reset.resetApplied,
    maximumPersistentBytes: Math.max(
      warm.maximumPersistentBytes,
      reset.maximumPersistentBytes,
      reordered.maximumPersistentBytes,
    ),
    maximumRemotesOwnerBytes: Math.max(
      warm.maximumRemotesOwnerBytes,
      reset.maximumRemotesOwnerBytes,
      reordered.maximumRemotesOwnerBytes,
    ),
    runtimeConfigSourceRevision: warm.summary.runtimeConfigSourceRevision,
    runtimePolicyRevision: warm.summary.runtimePolicyRevision,
    semanticHashes: Object.freeze({
      reordered: canonicalHash(reordered.summary),
      reset: canonicalHash(reset.summary),
      warm: canonicalHash(warm.summary),
    }),
    finalActiveRooms: warm.summary.activeRooms[warm.summary.activeRooms.length - 1] ?? [],
    stateRows: warm.summary.stateRows,
    reasonRows: warm.summary.reasonRows,
    kernelFaults:
      warm.summary.kernelFaults + reset.summary.kernelFaults + reordered.summary.kernelFaults,
    maximumActiveRemoteBudgetReservations: warm.summary.maximumActiveRemoteBudgetReservations,
    maximumRemoteContracts: warm.summary.maximumRemoteContracts,
    maximumReservedCpuMilli: warm.summary.maximumReservedCpuMilli,
    maximumReservedEnergy: warm.summary.maximumReservedEnergy,
    maximumReservedMemoryCodeUnits: warm.summary.maximumReservedMemoryCodeUnits,
    maximumReservedSpawnTicks: warm.summary.maximumReservedSpawnTicks,
    expectedCommandErrors: warm.summary.expectedCommandErrors,
    scheduledRemoteSpawnCommands: warm.summary.scheduledRemoteSpawnCommands,
    minimumProtectedEnergy: warm.summary.minimumProtectedEnergy,
  });
}

async function runVariant(kind: Variant) {
  vi.resetModules();
  const world = matureRuntimeWorld({ reverseCollections: kind === "reordered" });
  let memory = {} as Memory;
  let executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
  let maximumPersistentBytes = 0;
  let maximumRemotesOwnerBytes = 0;
  let resetApplied = false;
  const outcomes: TickOutcome[] = [];
  const activeRemoteBudgetReservations: number[] = [];
  const remoteContractCounts: number[] = [];

  for (let index = 0; index < TICK_COUNT; index += 1) {
    if (kind === "reset" && (index === 6 || index === 21)) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
      resetApplied = true;
    }
    const outcome = executeTick({
      game: remoteRuntimeGame(world, FIRST_TICK + index, {
        bucket: index === 10 ? 4_000 : 10_000,
        hideRemote: index === 18,
        reducedPrimarySourceCapacity: index >= 20 && index < 26,
        removePrimarySources: index >= 26,
        reverseCollections: kind === "reordered",
        routeClosed: index === 14,
        secondRemote: true,
        ...(index === 4 ? { spawnReturnCode: -6 } : {}),
        threat: index === 7,
        totalWorkerLoss: index === 23,
      }),
      memory,
    });
    outcomes.push(outcome);
    activeRemoteBudgetReservations.push(
      outcome.colony.reservations.filter(
        ({ issuer, status }) => issuer.startsWith("remote-") && status === "active",
      ).length,
    );
    const contracts = openContractLedgerState(memory.myrmex?.contracts);
    if (contracts.status !== "ready") {
      throw new Error(`${kind} Phase 3 soak could not open the contracts owner`);
    }
    remoteContractCounts.push(
      contracts.state.active.filter(({ execution }) =>
        execution === undefined ? false : [4, 5, 6].includes(execution.version),
      ).length,
    );
    maximumPersistentBytes = Math.max(
      maximumPersistentBytes,
      utf8ByteLength(canonicalSerialize(memory)),
    );
    maximumRemotesOwnerBytes = Math.max(
      maximumRemotesOwnerBytes,
      utf8ByteLength(canonicalSerialize(memory.myrmex?.remotes ?? {})),
    );
  }

  const firstOutcome = outcomes[0];
  if (firstOutcome === undefined) throw new Error(`${kind} Phase 3 soak executed no ticks`);
  const summary = Object.freeze({
    finalGameplayPersistentHash: canonicalHash(memory.myrmex ?? {}),
    runtimeConfigSourceRevision: firstOutcome.config.sourceRevision,
    runtimePolicyRevision: firstOutcome.config.policyRevision,
    kernelFaults: outcomes.reduce((sum, outcome) => sum + outcome.kernel.faults.length, 0),
    maximumActiveRemoteBudgetReservations: Math.max(...activeRemoteBudgetReservations),
    maximumRemoteContracts: Math.max(...remoteContractCounts),
    maximumReservedCpuMilli: Math.max(
      ...outcomes.map((outcome) => outcome.remotes.metrics.reservedCpuMilli),
    ),
    maximumReservedEnergy: Math.max(
      ...outcomes.map((outcome) => outcome.remotes.metrics.reservedEnergy),
    ),
    maximumReservedMemoryCodeUnits: Math.max(
      ...outcomes.map((outcome) => outcome.remotes.metrics.reservedMemoryCodeUnits),
    ),
    maximumReservedSpawnTicks: Math.max(
      ...outcomes.map((outcome) => outcome.remotes.metrics.reservedSpawnTicks),
    ),
    minimumProtectedEnergy: Math.min(
      ...outcomes.map(
        (outcome) =>
          outcome.colony.colonies[0]?.rclPolicy.protectedSpawnReserve.target ??
          outcome.config.policy.recovery.protectedSpawnEnergy,
      ),
    ),
    expectedCommandErrors: outcomes.reduce(
      (total, outcome) =>
        total + outcome.spawn.execution.filter(({ returnCode }) => returnCode === -6).length,
      0,
    ),
    scheduledRemoteSpawnCommands: outcomes.reduce(
      (total, outcome) =>
        total +
        outcome.spawn.execution.filter(
          ({ command, status }) => status === "scheduled" && command.issuer.startsWith("remote-"),
        ).length,
      0,
    ),
    activeRooms: Object.freeze(
      outcomes.map((outcome) =>
        outcome.remotes.objectives
          .filter(({ state }) => state === "active")
          .map(({ roomName }) => roomName)
          .sort(),
      ),
    ),
    reasonRows: Object.freeze(
      outcomes.map((outcome) =>
        outcome.remotes.dispositions.map(({ reason, roomName }) => `${roomName}:${reason}`).sort(),
      ),
    ),
    stateRows: Object.freeze(
      outcomes.map((outcome) =>
        outcome.remotes.dispositions.map(({ roomName, state }) => `${roomName}:${state}`).sort(),
      ),
    ),
  });
  if (summary.kernelFaults !== 0) {
    throw new Error(
      `${kind} Phase 3 current-runtime portfolio soak reported kernel faults: ${canonicalSerialize(
        outcomes.flatMap((outcome) => outcome.kernel.faults),
      )}`,
    );
  }
  return {
    executedTicks: outcomes.length,
    kind,
    maximumPersistentBytes,
    maximumRemotesOwnerBytes,
    resetApplied,
    summary,
  };
}
