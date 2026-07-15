import { describe, expect, it } from "vitest";
import {
  BODY_PART_ENERGY_COSTS,
  CREEP_SPAWN_TICKS_PER_PART,
  ENGINE_MAX_BODY_PARTS,
  OFFICIAL_BODY_PARTS,
  buildSpawnBody,
  type SpawnBodyBuildRequest,
  type SpawnBodyInvalidReason,
  type SpawnBodyPart,
  type SpawnBodyPartCounts,
} from "../src/spawn/body-builder";

describe("buildSpawnBody", () => {
  it("exports the official part names, costs, and engine constants", () => {
    expect(OFFICIAL_BODY_PARTS).toEqual([
      "tough",
      "work",
      "carry",
      "attack",
      "ranged_attack",
      "heal",
      "claim",
      "move",
    ]);
    expect(BODY_PART_ENERGY_COSTS).toEqual({
      tough: 10,
      work: 100,
      carry: 50,
      attack: 80,
      ranged_attack: 150,
      heal: 250,
      claim: 600,
      move: 50,
    });
    expect(CREEP_SPAWN_TICKS_PER_PART).toBe(3);
    expect(ENGINE_MAX_BODY_PARTS).toBe(50);
    expect(Object.isFrozen(OFFICIAL_BODY_PARTS)).toBe(true);
    expect(Object.isFrozen(BODY_PART_ENERGY_COSTS)).toBe(true);
  });

  it("builds the canonical recovery body at 200 or 300 energy and defers at 199", () => {
    expect(buildSpawnBody(request({ availableEnergy: 199 }))).toEqual({
      reason: "insufficient-available-energy",
      requiredEnergy: 200,
      requiredParts: 3,
      status: "deferred",
    });

    const atTwoHundred = buildSpawnBody(request({ availableEnergy: 200 }));
    const atThreeHundred = buildSpawnBody(request({ availableEnergy: 300 }));
    const expected = {
      body: ["work", "carry", "move"],
      energyCost: 200,
      partCount: 3,
      requiredEnergy: 200,
      spawnTicks: 9,
      status: "built",
    };

    expect(atTwoHundred).toEqual(expected);
    expect(atThreeHundred).toEqual(expected);
  });

  it("uses canonical order for every official part and never removes explicit MOVE", () => {
    const oneOfEach = buildSpawnBody(
      request({
        availableEnergy: 2_000,
        energyCapacity: 2_000,
        maximumBodyEnergy: 2_000,
        maximumNonMovePartsPerMovePart: 7,
        requiredPartCounts: counts({
          tough: 1,
          work: 1,
          carry: 1,
          attack: 1,
          ranged_attack: 1,
          heal: 1,
          claim: 1,
          move: 1,
        }),
      }),
    );
    expect(oneOfEach).toEqual({
      body: [...OFFICIAL_BODY_PARTS],
      energyCost: 1_290,
      partCount: 8,
      requiredEnergy: 1_290,
      spawnTicks: 24,
      status: "built",
    });

    const explicitMovement = buildSpawnBody(
      request({
        requiredPartCounts: counts({ work: 1, carry: 1, move: 3 }),
      }),
    );
    expect(explicitMovement).toMatchObject({
      body: ["work", "carry", "move", "move", "move"],
      partCount: 5,
      status: "built",
    });
  });

  it("enforces the zero, one, fifty, and fifty-one part boundaries", () => {
    expect(
      buildSpawnBody(
        request({
          requiredPartCounts: counts(),
        }),
      ),
    ).toEqual({
      reason: "empty-capabilities",
      requiredEnergy: 0,
      requiredParts: 0,
      status: "invalid",
    });

    expect(
      buildSpawnBody(
        request({
          availableEnergy: 50,
          energyCapacity: 50,
          maximumBodyEnergy: 50,
          maximumNonMovePartsPerMovePart: 1,
          requiredPartCounts: counts({ move: 1 }),
        }),
      ),
    ).toEqual({
      body: ["move"],
      energyCost: 50,
      partCount: 1,
      requiredEnergy: 50,
      spawnTicks: 3,
      status: "built",
    });

    const fiftyParts = buildSpawnBody(
      request({
        availableEnergy: 2_500,
        energyCapacity: 2_500,
        maximumBodyEnergy: 2_500,
        maximumNonMovePartsPerMovePart: 1,
        requiredPartCounts: counts({ carry: 25 }),
      }),
    );
    expect(fiftyParts).toEqual({
      body: [...Array<SpawnBodyPart>(25).fill("carry"), ...Array<SpawnBodyPart>(25).fill("move")],
      energyCost: 2_500,
      partCount: 50,
      requiredEnergy: 2_500,
      spawnTicks: 150,
      status: "built",
    });

    expect(
      buildSpawnBody(
        request({
          requiredPartCounts: counts({ move: 51 }),
        }),
      ),
    ).toEqual({
      reason: "engine-part-limit-exceeded",
      requiredEnergy: null,
      requiredParts: 51,
      status: "impossible",
    });
  });

  it("reports movement expansion beyond the engine limit as terminal", () => {
    expect(
      buildSpawnBody(
        request({
          availableEnergy: 0,
          energyCapacity: 5_000,
          maximumBodyEnergy: 5_000,
          maximumNonMovePartsPerMovePart: 2,
          requiredPartCounts: counts({ carry: 34 }),
        }),
      ),
    ).toEqual({
      reason: "movement-engine-limit-exceeded",
      requiredEnergy: 2_550,
      requiredParts: 51,
      status: "impossible",
    });
  });

  it("distinguishes terminal capacity, energy policy, part policy, and movement policy", () => {
    expect(
      buildSpawnBody(
        request({
          availableEnergy: 199,
          energyCapacity: 199,
        }),
      ),
    ).toMatchObject({
      reason: "energy-capacity-exceeded",
      requiredEnergy: 200,
      requiredParts: 3,
      status: "impossible",
    });
    expect(
      buildSpawnBody(
        request({
          maximumBodyEnergy: 199,
        }),
      ),
    ).toMatchObject({
      reason: "energy-policy-limit-exceeded",
      requiredEnergy: 200,
      requiredParts: 3,
      status: "impossible",
    });
    expect(
      buildSpawnBody(
        request({
          maximumBodyParts: 2,
          requiredPartCounts: counts({ work: 1, carry: 1, move: 1 }),
        }),
      ),
    ).toMatchObject({
      reason: "policy-part-limit-exceeded",
      requiredParts: 3,
      status: "impossible",
    });
    expect(
      buildSpawnBody(
        request({
          maximumBodyParts: 2,
        }),
      ),
    ).toMatchObject({
      reason: "movement-policy-limit-exceeded",
      requiredParts: 3,
      status: "impossible",
    });
  });

  it("rejects malformed numeric inputs and impossible configuration bounds without throwing", () => {
    const invalidScalars: readonly [Partial<SpawnBodyBuildRequest>, SpawnBodyInvalidReason][] = [
      [{ availableEnergy: Number.NaN }, "invalid-available-energy"],
      [{ availableEnergy: -1 }, "invalid-available-energy"],
      [{ energyCapacity: Number.POSITIVE_INFINITY }, "invalid-energy-capacity"],
      [{ energyCapacity: 1.5 }, "invalid-energy-capacity"],
      [{ maximumBodyEnergy: -1 }, "invalid-maximum-body-energy"],
      [{ maximumBodyParts: 1.5 }, "invalid-maximum-body-parts"],
      [{ maximumBodyParts: 51 }, "maximum-body-parts-exceeds-engine-limit"],
      [{ maximumNonMovePartsPerMovePart: 0 }, "invalid-movement-ratio"],
      [{ maximumNonMovePartsPerMovePart: 1.5 }, "invalid-movement-ratio"],
      [{ maximumNonMovePartsPerMovePart: Number.NaN }, "invalid-movement-ratio"],
      [{ availableEnergy: 301 }, "available-energy-exceeds-capacity"],
    ];

    for (const [override, reason] of invalidScalars) {
      expect(buildSpawnBody(request(override))).toMatchObject({ reason, status: "invalid" });
    }

    for (const malformedCount of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        buildSpawnBody(
          request({
            requiredPartCounts: counts({ work: malformedCount }),
          }),
        ),
      ).toMatchObject({ reason: "invalid-required-part-counts", status: "invalid" });
    }

    const missingMove = {
      attack: 0,
      carry: 1,
      claim: 0,
      heal: 0,
      ranged_attack: 0,
      tough: 0,
      work: 1,
    } as unknown as SpawnBodyPartCounts;
    const extraPart = { ...counts({ work: 1 }), source: 1 } as SpawnBodyPartCounts;

    expect(buildSpawnBody(request({ requiredPartCounts: missingMove }))).toMatchObject({
      reason: "invalid-required-part-counts",
      status: "invalid",
    });
    expect(buildSpawnBody(request({ requiredPartCounts: extraPart }))).toMatchObject({
      reason: "invalid-required-part-counts",
      status: "invalid",
    });
    expect(buildSpawnBody(null as unknown as SpawnBodyBuildRequest)).toMatchObject({
      reason: "invalid-request",
      status: "invalid",
    });
  });

  it("is deterministic, does not mutate inputs, and freezes every returned outcome", () => {
    const mutableCounts = counts({ carry: 1, work: 1 }) as Record<SpawnBodyPart, number>;
    const forwardRequest = request({ requiredPartCounts: mutableCounts });
    const reorderedRequest = request({
      requiredPartCounts: {
        move: 0,
        claim: 0,
        heal: 0,
        ranged_attack: 0,
        attack: 0,
        carry: 1,
        work: 1,
        tough: 0,
      },
    });

    const forward = buildSpawnBody(forwardRequest);
    const reordered = buildSpawnBody(reorderedRequest);
    mutableCounts.work = 0;

    expect(reordered).toEqual(forward);
    expect(forward).toMatchObject({ body: ["work", "carry", "move"], status: "built" });
    expect(Object.isFrozen(forward)).toBe(true);
    if (forward.status === "built") {
      expect(Object.isFrozen(forward.body)).toBe(true);
    }

    const nonBuilt = [
      buildSpawnBody(request({ availableEnergy: 199 })),
      buildSpawnBody(request({ requiredPartCounts: counts({ move: 51 }) })),
      buildSpawnBody(request({ requiredPartCounts: counts() })),
    ];
    expect(nonBuilt.every((result) => Object.isFrozen(result))).toBe(true);
    expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
  });
});

function counts(overrides: Partial<Record<SpawnBodyPart, number>> = {}): SpawnBodyPartCounts {
  return {
    tough: 0,
    work: 0,
    carry: 0,
    attack: 0,
    ranged_attack: 0,
    heal: 0,
    claim: 0,
    move: 0,
    ...overrides,
  };
}

function request(overrides: Partial<SpawnBodyBuildRequest> = {}): SpawnBodyBuildRequest {
  return {
    availableEnergy: 300,
    energyCapacity: 300,
    maximumBodyEnergy: 300,
    maximumBodyParts: 50,
    maximumNonMovePartsPerMovePart: 2,
    requiredPartCounts: counts({ work: 1, carry: 1 }),
    ...overrides,
  };
}
