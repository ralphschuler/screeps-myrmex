import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-labs-results.json";
import {
  composeLabFixture,
  labFixtureObjective,
  labFixtureWorld,
} from "../../bot/test/support/lab-composition-fixture";
import {
  createPendingLabAttempt,
  projectLabTelemetry,
  settleLabComposition,
} from "../../bot/src/industry";
import { canonicalHash } from "../src";

describe("Phase 2 labs composed deterministic evidence (#257)", () => {
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
  const reordered = composeLabFixture(
    roundTrip(labFixtureWorld("forward")),
    roundTrip(forwardObjective),
  );
  const contaminated = composeLabFixture(labFixtureWorld("contaminated"), forwardObjective);
  const cooldown = composeLabFixture(labFixtureWorld("cooldown"), reverseObjective);
  const full = composeLabFixture(labFixtureWorld("full"), reverseObjective);
  const missing = composeLabFixture(labFixtureWorld("missing-lab"), forwardObjective);
  return {
    schemaVersion: 1,
    deterministic: {
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
      contaminationDemands: contaminated.resourceDemands.dispositions.filter(
        ({ effectiveMode }) => effectiveMode === "drain",
      ).length,
      cooldownCommands: cooldown.intents.length,
      fullResultCommands: full.intents.length,
      missingLabAssignments: missing.assignments.length,
      retryReady: retry.attempts[0]?.retryReady === true,
    },
    telemetry: projectLabTelemetry(exact, []),
    boundaries: {
      commandKinds: [
        ...new Set([...forward.intents, ...reverse.intents].map(({ kind }) => kind)),
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
