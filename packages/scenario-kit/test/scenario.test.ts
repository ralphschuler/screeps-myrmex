import { describe, expect, it } from "vitest";
import { defineScenario } from "../src/index";

describe("defineScenario", () => {
  it("accepts an outcome-oriented deterministic scenario", () => {
    const scenario = defineScenario({
      id: "cold-boot/creates-first-harvester",
      initialWorld: { creeps: 0, energy: 300 },
      ticks: 20,
      verify: () => undefined,
    });

    expect(scenario.id).toBe("cold-boot/creates-first-harvester");
    expect(Object.isFrozen(scenario)).toBe(true);
  });

  it("rejects scenarios without a meaningful duration", () => {
    expect(() =>
      defineScenario({
        id: "invalid",
        initialWorld: {},
        ticks: 0,
        verify: () => undefined,
      }),
    ).toThrow(/at least one whole tick/u);
  });
});
