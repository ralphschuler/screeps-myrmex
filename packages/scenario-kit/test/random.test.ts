import { describe, expect, it } from "vitest";
import { createSeededRandom } from "../src/index";

describe("deterministic scenario random", () => {
  it("replays the same sequence from the same typed seed", () => {
    const first = createSeededRandom("phase-0");
    const second = createSeededRandom("phase-0");

    const firstSequence = Array.from({ length: 8 }, () => first.integer(10_000));
    const secondSequence = Array.from({ length: 8 }, () => second.integer(10_000));

    expect(firstSequence).toEqual(secondSequence);
    expect(first.draws).toBe(8);
    expect(first.state).toBe(second.state);
  });

  it("keeps distinct seeds and seed types on distinct streams", () => {
    const stringSeed = createSeededRandom("42");
    const numberSeed = createSeededRandom(42);
    const otherSeed = createSeededRandom("43");

    const draw = (random: ReturnType<typeof createSeededRandom>): number[] =>
      Array.from({ length: 6 }, () => random.integer(1_000_000));

    expect(draw(stringSeed)).not.toEqual(draw(numberSeed));
    expect(draw(createSeededRandom("42"))).not.toEqual(draw(otherSeed));
  });

  it("validates bounded helpers", () => {
    const random = createSeededRandom("bounds");

    expect(random.pick(["worker"])).toBe("worker");
    expect(() => random.pick([])).toThrow(/empty collection/u);
    expect(() => random.integer(0)).toThrow(/positive safe integer/u);
    expect(() => random.boolean(1.1)).toThrow(/between 0 and 1/u);
  });
});
