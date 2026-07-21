import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-labs-results.json";
import {
  composeBoostFixture,
  composeBoostHandoffFixture,
  composeLabFixture,
  executeBoostFixture,
  labBoostHandoffFixtureWorld,
  labFixtureBoostProgressWorld,
  labFixtureBoostWorld,
  labFixtureObjective,
  labFixtureWorld,
} from "../../bot/test/support/lab-composition-fixture";
import {
  createPendingLabAttempt,
  projectLabTelemetry,
  settleLabComposition,
} from "../../bot/src/industry";
import { canonicalHash } from "../src";

describe("Phase 2 labs composed deterministic evidence (#257, #341)", () => {
  it("matches checked evidence and proves the bounded lab matrix", () => {
    expect(collectLabEvidence()).toEqual(checked);
  });
});

export function collectLabEvidence() {
  const forwardObjective = labFixtureObjective("forward");
  const reverseObjective = labFixtureObjective("reverse");
  const forward = composeLabFixture(labFixtureWorld("forward"), forwardObjective);
  const reverse = composeLabFixture(labFixtureWorld("reverse"), reverseObjective);
  const reverseIntent = required(reverse.intents[0]);
  const pending = required(createPendingLabAttempt(reverseIntent, "OK"));
  const exact = composeLabFixture(
    labFixtureWorld("reverse-settled", 101),
    reverseObjective,
    reverse.policy.commitments,
    [pending],
  );
  const settled = settleLabComposition({
    execution: [],
    previousAttempts: [pending],
    projection: exact,
  });
  const noEffect = composeLabFixture(
    labFixtureWorld("reverse", 101),
    reverseObjective,
    reverse.policy.commitments,
    [pending],
  );
  const retry = settleLabComposition({
    execution: [],
    previousAttempts: [pending],
    projection: noEffect,
  });
  const boostInitial = labFixtureBoostWorld(false);
  const boost = composeBoostFixture(boostInitial.snapshot, boostInitial.manifest);
  const boostIntent = required(boost.intents[0]);
  const boostExecution = executeBoostFixture(boostIntent);
  const boostPending = required(
    createPendingLabAttempt(boostIntent, required(boostExecution[0]).reason),
  );
  const boostObserved = labFixtureBoostWorld(true, 101);
  const boostExact = composeBoostFixture(
    boostObserved.snapshot,
    boostInitial.manifest,
    roundTrip(boost.policy.commitments),
    roundTrip([boostPending]),
  );
  const boostReordered = composeBoostFixture(
    {
      ...roundTrip(boostObserved.snapshot),
      ownedRooms: boostObserved.snapshot.ownedRooms.map((room) => ({
        ...roundTrip(room),
        ownedLabs: [...(room.ownedLabs ?? [])].reverse(),
      })),
    },
    roundTrip(boostInitial.manifest),
    roundTrip(boost.policy.commitments),
    roundTrip([boostPending]),
  );
  const boostProgressInitial = labFixtureBoostProgressWorld({
    boostedParts: 0,
    energy: 2_000,
    mineralAmount: 60,
    partCount: 2,
    tick: 100,
  });
  const boostProgress = composeBoostFixture(
    boostProgressInitial.snapshot,
    boostProgressInitial.manifest,
  );
  const boostProgressAttempt = required(
    createPendingLabAttempt(required(boostProgress.intents[0]), "OK"),
  );
  const boostPartialWorld = labFixtureBoostProgressWorld({
    boostedParts: 1,
    energy: 1_980,
    mineralAmount: 30,
    partCount: 2,
    tick: 101,
  });
  const boostPartial = composeBoostFixture(
    boostPartialWorld.snapshot,
    boostPartialWorld.manifest,
    boostProgress.policy.commitments,
    [boostProgressAttempt],
  );
  const boostPartialSettled = settleLabComposition({
    execution: [],
    previousAttempts: [boostProgressAttempt],
    projection: boostPartial,
  });
  const boostConflictWorld = labFixtureBoostProgressWorld({
    boostedParts: 2,
    energy: 1_960,
    mineralAmount: 30,
    partCount: 2,
    tick: 101,
  });
  const boostConflict = composeBoostFixture(
    boostConflictWorld.snapshot,
    boostConflictWorld.manifest,
    boostProgress.policy.commitments,
    [boostProgressAttempt],
  );
  const handoffInitial = labBoostHandoffFixtureWorld(100);
  const handoffFirst = composeBoostHandoffFixture(handoffInitial.snapshot, handoffInitial.manifest);
  const handoffPrevious = required(handoffFirst.policy.commitments[0]);
  const handoffPendingWorld = labBoostHandoffFixtureWorld(101, true);
  const handoffPending = composeBoostHandoffFixture(
    handoffPendingWorld.snapshot,
    handoffPendingWorld.manifest,
    [handoffPrevious],
  );
  const handoffRebound = required(handoffPending.policy.commitments[0]);
  const handoffDurable = roundTrip(handoffPending.policy.commitments);
  const handoffReadyWorld = labBoostHandoffFixtureWorld(102);
  const handoffReady = composeBoostHandoffFixture(
    handoffReadyWorld.snapshot,
    handoffReadyWorld.manifest,
    handoffDurable,
  );
  const handoffReadyReorderedWorld = labBoostHandoffFixtureWorld(102, true);
  const handoffReadyReordered = composeBoostHandoffFixture(
    roundTrip(handoffReadyReorderedWorld.snapshot),
    roundTrip(handoffReadyReorderedWorld.manifest),
    handoffDurable,
  );
  const handoffIntent = required(handoffReady.intents[0]);
  const handoffAttempt = required(createPendingLabAttempt(handoffIntent, "OK"));
  const handoffReadyRoom = required(handoffReadyWorld.snapshot.ownedRooms[0]);
  const handoffReadyCreep = required(handoffReadyRoom.ownedCreeps[0]);
  const handoffNonExecutable = composeBoostHandoffFixture(
    {
      ...handoffReadyWorld.snapshot,
      ownedRooms: [
        {
          ...handoffReadyRoom,
          ownedCreeps: [{ ...handoffReadyCreep, pos: { roomName: "W1N1", x: 20, y: 20 } }],
        },
      ],
    },
    handoffReadyWorld.manifest,
    handoffDurable,
  );
  const handoffWaiting = composeBoostHandoffFixture(
    handoffReadyWorld.snapshot,
    handoffReadyWorld.manifest,
    handoffDurable,
    [handoffAttempt],
  );
  const handoffWaitingMigration = required(handoffWaiting.migrationRooms[0]);
  const handoffSettledWorld = labBoostHandoffFixtureWorld(103, false, true);
  const handoffSettled = composeBoostHandoffFixture(
    handoffSettledWorld.snapshot,
    handoffSettledWorld.manifest,
    handoffDurable,
    [handoffAttempt],
  );
  const reordered = composeLabFixture(
    roundTrip(labFixtureWorld("forward")),
    roundTrip(forwardObjective),
  );
  const contaminated = composeLabFixture(labFixtureWorld("contaminated"), forwardObjective);
  const cooldown = composeLabFixture(labFixtureWorld("cooldown"), reverseObjective);
  const full = composeLabFixture(labFixtureWorld("full"), reverseObjective);
  const missing = composeLabFixture(labFixtureWorld("missing-lab"), forwardObjective);
  return {
    schemaVersion: 3,
    deterministic: {
      boostExecution: boostExecution[0]?.status ?? null,
      boostHandoffExactParts: handoffSettled.settlements[0]?.settledAmount ?? 0,
      boostHandoffFirstReboundIntents: handoffPending.intents.length,
      boostHandoffIntent: handoffReady.intents[0]?.kind ?? null,
      boostHandoffKind: handoffReady.migrationRooms[0]?.assignmentHandoff?.kind ?? null,
      boostHandoffOnlyAssignmentChanged:
        JSON.stringify({
          ...handoffPrevious,
          assignmentFingerprint: handoffRebound.assignmentFingerprint,
        }) === JSON.stringify(handoffRebound),
      boostHandoffNonExecutableStatus:
        handoffNonExecutable.migrationRooms[0]?.assignmentHandoff?.status ?? null,
      boostHandoffPendingAttemptVisible:
        !handoffWaitingMigration.quiescent &&
        handoffWaitingMigration.activity.includes("pending-attempt"),
      boostHandoffPendingStatus:
        handoffPending.migrationRooms[0]?.assignmentHandoff?.status ?? null,
      boostHandoffReadyStatus: handoffReady.migrationRooms[0]?.assignmentHandoff?.status ?? null,
      boostHandoffResetAndReorderEquivalent:
        canonicalHash(canonicalProjection(handoffReady)) ===
        canonicalHash(canonicalProjection(handoffReadyReordered)),
      boostIntent: boost.intents[0]?.kind ?? null,
      boostPartialAppliedOnce:
        boostPartialSettled.commitments[0]?.kind === "boost" &&
        boostPartialSettled.commitments[0].settledParts === 1,
      boostResetAndReorderEquivalent:
        canonicalHash(canonicalProjection(boostExact)) ===
        canonicalHash(canonicalProjection(boostReordered)),
      exactBoostParts: boostExact.settlements[0]?.settledAmount ?? 0,
      exactReverseAmount: exact.settlements[0]?.settledAmount ?? 0,
      forwardIntent: forward.intents[0]?.kind ?? null,
      resetAndReorderEquivalent:
        canonicalHash(canonicalProjection(forward)) ===
        canonicalHash(canonicalProjection(reordered)),
      reverseIntent: reverse.intents[0]?.kind ?? null,
      settledCommitmentAmount:
        settled.commitments[0]?.kind === "reaction" ? settled.commitments[0].settledAmount : 0,
    },
    failures: {
      boostConflictReason: boostConflict.settlements[0]?.reason ?? null,
      boostConflictRetainsCommitment:
        boostConflict.policy.commitments[0]?.kind === "boost" &&
        boostConflict.policy.commitments[0].settledParts === 0 &&
        boostConflict.migrationRooms[0]?.quiescent === false,
      contaminationDemands: contaminated.resourceDemands.dispositions.filter(
        ({ effectiveMode }) => effectiveMode === "drain",
      ).length,
      cooldownCommands: cooldown.intents.length,
      fullResultCommands: full.intents.length,
      missingLabAssignments: missing.assignments.length,
      retryReady: retry.attempts[0]?.retryReady === true,
    },
    telemetry: projectLabTelemetry(exact, []),
    boostCommandTelemetry: projectLabTelemetry(boost, boostExecution),
    boostSettlementTelemetry: projectLabTelemetry(boostExact, []),
    boundaries: {
      commandKinds: [
        ...new Set(
          [...boost.intents, ...forward.intents, ...reverse.intents].map(({ kind }) => kind),
        ),
      ].sort(),
      gate: "phase2.labs",
      maximumCommandsPerRoom: 1,
    },
  };
}

function canonicalProjection(value: ReturnType<typeof composeLabFixture>) {
  return {
    ...value,
    creepFingerprints: [...value.creepFingerprints].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected fixture value");
  return value;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
