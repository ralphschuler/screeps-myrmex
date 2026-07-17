import { describe, expect, it } from "vitest";
import type { MatureMechanicsInput } from "../src/industry/mature-composition";
import type { WorldSnapshot } from "../src/world/snapshot";
import {
  composeMatureFixture,
  MATURE_FIXTURE_MECHANICS,
  matureCompositionWorld,
} from "./support/mature-composition-fixture";

describe("mature infrastructure composition", () => {
  it("composes budgets, logistics readiness, and factory/power intents without a nuke command", () => {
    const first = composeMatureFixture();
    expect(first.status).toBe("ready");
    expect(first.policy.budgets.map(({ issuer }) => issuer)).toEqual(
      first.policy.objectives.map(({ industryBudgetId }) => industryBudgetId),
    );
    expect(first.intents).toEqual([]);

    const funded = composeMatureFixture({
      funded: new Set(first.policy.budgets.map(({ issuer }) => issuer)),
    });
    expect(
      funded.policy.commitments.map(({ objective, status }) => [objective.kind, status]),
    ).toEqual([
      ["factory-batch", "ready"],
      ["nuker-stock", "staging"],
      ["power-processing", "ready"],
    ]);
    expect(funded.intents.map(({ kind }) => kind)).toEqual([
      "factory.produce",
      "power-spawn.process-power",
    ]);
    expect(
      funded.resourceDemands.dispositions.find(({ objectiveId }) => objectiveId.includes("nuker")),
    ).toMatchObject({ status: "projected" });
    expect(JSON.stringify(funded)).not.toContain("launchNuke");
  });

  it("protects source stock, consumes staged stock, and survives reset/reordering", () => {
    const protectedWorld = matureCompositionWorld({
      inventory: { G: 5_000, energy: 10_000, power: 1_000, silicon: 1_000, wire: 0 },
    });
    const protectedProjection = composeMatureFixture({ snapshot: protectedWorld });
    expect(protectedProjection.policy.objectives.map(({ kind }) => kind)).toEqual([
      "factory-batch",
      "power-processing",
    ]);
    expect(protectedProjection.policy.blockers).toContainEqual({
      identity: "nuker:W1N1",
      reason: "protected-stock",
    });
    const fundedProtected = composeMatureFixture({
      funded: new Set(protectedProjection.policy.budgets.map(({ issuer }) => issuer)),
      snapshot: protectedWorld,
    });
    expect(fundedProtected.resourceDemands.dispositions).toMatchObject([
      { status: "satisfied" },
      { status: "satisfied" },
    ]);
    expect(fundedProtected.intents.map(({ kind }) => kind)).toEqual([
      "factory.produce",
      "power-spawn.process-power",
    ]);

    const baseline = composeMatureFixture();
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
    expect(JSON.stringify(reset)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(baseline));
  });
});
