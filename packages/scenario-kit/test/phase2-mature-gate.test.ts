import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-mature-results.json";
import {
  composeMatureFixture,
  MATURE_FIXTURE_MECHANICS,
  matureCompositionWorld,
} from "../../bot/test/support/mature-composition-fixture";
import { projectMatureCommandTelemetry, type MatureMechanicsInput } from "../../bot/src/industry";
import type { WorldSnapshot } from "../../bot/src/world/snapshot";
import {
  createPendingObserverAttempt,
  projectObserverIntents,
  projectObserverTelemetry,
  reconcilePendingObserverAttempts,
  type ObservationRequestV1,
} from "../../bot/src/observer";
import { canonicalHash } from "../src";

describe("Phase 2 mature infrastructure deterministic evidence (#267)", () => {
  it("matches checked evidence for mature commands, observer contention, and capped stocking", () => {
    expect(collectMatureEvidence()).toEqual(checked);
  });
});

export function collectMatureEvidence() {
  const unfunded = composeMatureFixture();
  const funded = composeMatureFixture({
    funded: new Set(unfunded.policy.budgets.map(({ issuer }) => issuer)),
  });
  const catalog = required(funded.catalog);
  const snapshotRevision = "snapshot/100";
  const authorizations = [
    { id: "vision", revision: 1, issuer: "intel", active: true, expiresAt: 110 },
  ] as const;
  const requests = [request("alpha", "W2N2"), request("beta", "W3N3")];
  const observer = projectObserverIntents({
    authorizations,
    capabilities: funded.capabilities,
    catalog,
    requests,
    snapshot: matureCompositionWorld(),
    snapshotRevision,
  });
  const observerReordered = projectObserverIntents({
    authorizations: JSON.parse(JSON.stringify(authorizations)) as typeof authorizations,
    capabilities: JSON.parse(JSON.stringify(funded.capabilities)) as typeof funded.capabilities,
    catalog: JSON.parse(JSON.stringify(catalog)) as typeof catalog,
    requests: [...requests].reverse(),
    snapshot: matureCompositionWorld({ reverse: true }),
    snapshotRevision,
  });
  const winningIntent = required(observer.intents[0]);
  const pending = required(createPendingObserverAttempt(winningIntent, "OK"));
  const observerSettlements = reconcilePendingObserverAttempts({
    authorizations,
    pendingAttempts: [pending],
    snapshot: matureCompositionWorld({
      tick: 101,
      visibleRoomName: winningIntent.payload.targetRoomName,
    }),
  });
  const protectedProjection = composeMatureFixture({
    snapshot: matureCompositionWorld({
      inventory: { G: 5_000, energy: 10_000, power: 1_000, silicon: 1_000, wire: 0 },
    }),
  });
  const fundedProtected = composeMatureFixture({
    funded: new Set(protectedProjection.policy.budgets.map(({ issuer }) => issuer)),
    snapshot: matureCompositionWorld({
      inventory: { G: 5_000, energy: 10_000, power: 1_000, silicon: 1_000, wire: 0 },
    }),
  });
  const invalid = composeMatureFixture({
    mechanics: { ...MATURE_FIXTURE_MECHANICS, constants: {} },
  });
  const reset = composeMatureFixture({
    mechanics: JSON.parse(JSON.stringify(MATURE_FIXTURE_MECHANICS)) as MatureMechanicsInput,
    snapshot: JSON.parse(JSON.stringify(matureCompositionWorld())) as WorldSnapshot,
  });
  const reordered = composeMatureFixture({
    mechanics: {
      ...MATURE_FIXTURE_MECHANICS,
      resourceTypes: [...MATURE_FIXTURE_MECHANICS.resourceTypes].reverse(),
    },
    snapshot: matureCompositionWorld({ reverse: true }),
  });
  const nuker = funded.policy.objectives.find(({ kind }) => kind === "nuker-stock");
  return {
    schemaVersion: 1,
    deterministic: {
      commandKinds: funded.intents.map(({ kind }) => kind),
      observerSettlement: observerSettlements[0]?.reason ?? null,
      observerWinner:
        observer.dispositions.find(({ status }) => status === "accepted")?.requestId ?? null,
      resetAndReorderEquivalent:
        canonicalHash(canonicalProjection(unfunded)) ===
          canonicalHash(canonicalProjection(reset)) &&
        canonicalHash(canonicalProjection(unfunded)) ===
          canonicalHash(canonicalProjection(reordered)) &&
        canonicalHash(observer) === canonicalHash(observerReordered),
    },
    resources: {
      fundedBudgets: funded.policy.budgets.length,
      nukerEnergyTarget: nuker?.kind === "nuker-stock" ? nuker.energyTarget : 0,
      nukerGhodiumTarget: nuker?.kind === "nuker-stock" ? nuker.ghodiumTarget : 0,
      nukerProjectedTransfers:
        funded.resourceDemands.dispositions.find(({ objectiveId }) => objectiveId.includes("nuker"))
          ?.projectedTransfers ?? 0,
      protectedSourceTransfers: fundedProtected.resourceDemands.dispositions.reduce(
        (total, disposition) => total + disposition.projectedTransfers,
        0,
      ),
      stagedObjectives: protectedProjection.policy.objectives.length,
    },
    failures: {
      invalidMechanics: invalid.status,
      invalidReason: invalid.reason,
      launchIntentCount: funded.intents.filter(({ kind }) => kind.includes("nuke")).length,
      observerLosers: observer.dispositions.filter(({ status }) => status === "deferred").length,
    },
    telemetry: {
      mature: projectMatureCommandTelemetry({
        execution: [],
        intents: funded.intents,
        settlements: [],
      }),
      observer: projectObserverTelemetry({
        dispositions: observer.dispositions,
        execution: [],
        intents: observer.intents,
        settlements: observerSettlements,
      }),
    },
    boundaries: {
      gate: "phase2.mature",
      maximumCommandsPerStructure: 1,
      ownerSchemaVersion: 5,
      observerExclusiveKey: winningIntent.exclusiveResourceKey,
    },
  };
}

function request(id: string, targetRoomName: string): ObservationRequestV1 {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    issuer: "intel",
    requestedAt: 100,
    deadline: 110,
    targetRoomName,
    minimumObservationTick: 101,
    priority: { class: "growth", value: 10 },
    authorizationId: "vision",
    authorizationRevision: 1,
    snapshotRevision: "snapshot/100",
  };
}

function canonicalProjection(value: ReturnType<typeof composeMatureFixture>) {
  return JSON.parse(
    JSON.stringify({
      capabilities: value.capabilities,
      catalog: value.catalog,
      intents: value.intents,
      policy: value.policy,
      reason: value.reason,
      resourceDemands: value.resourceDemands,
      settlements: value.settlements,
      status: value.status,
    }),
  ) as unknown;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected mature evidence value");
  return value;
}
