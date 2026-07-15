import { describe, expect, it, vi } from "vitest";
import {
  MAX_ASSERTION_SAMPLES,
  ScenarioAssertionError,
  assertForbiddenOutcome,
  assertOutcomeByDeadline,
  assertPersistentMemoryGrowthCap,
  assertRequiredOutcome,
} from "../src/index";

describe("scenario outcome assertions", () => {
  it("finds a required outcome and fails with a stable code when it is absent", () => {
    const outcomes = [{ spawned: false }, { spawned: true }, { spawned: true }];

    expect(
      assertRequiredOutcome(outcomes, (outcome) => outcome.spawned, {
        label: "the first survival creep",
      }),
    ).toBe(1);

    expectScenarioFailure(
      () => assertRequiredOutcome(outcomes, () => false),
      "required-outcome-missing",
      null,
    );
  });

  it("rejects the first forbidden outcome and otherwise inspects all samples", () => {
    const safe = [{ enemyOwnedSpawn: false }, { enemyOwnedSpawn: false }];
    const predicate = vi.fn((outcome: (typeof safe)[number]) => outcome.enemyOwnedSpawn);

    assertForbiddenOutcome(safe, predicate);
    expect(predicate).toHaveBeenCalledTimes(2);

    expectScenarioFailure(
      () => {
        assertForbiddenOutcome(
          [...safe, { enemyOwnedSpawn: true }, { enemyOwnedSpawn: true }],
          (outcome) => outcome.enemyOwnedSpawn,
          { label: "hostile spawn ownership" },
        );
      },
      "forbidden-outcome-observed",
      2,
    );
  });

  it("caps peak persistent Memory growth selected independently of volatile data", () => {
    const samples = [
      { memory: { colonies: {} }, volatileSnapshot: "x".repeat(20_000) },
      { memory: { colonies: { W1N1: { level: 1 } } }, volatileSnapshot: "y".repeat(40_000) },
      { memory: { colonies: {} }, volatileSnapshot: "z".repeat(60_000) },
    ];
    const unconstrained = assertPersistentMemoryGrowthCap(samples, {
      maximumGrowthBytes: 1_000,
      selectMemory: (sample) => sample.memory,
    });

    expect(unconstrained.sampleCount).toBe(3);
    expect(unconstrained.peakBytes).toBeGreaterThan(unconstrained.initialBytes);
    expect(unconstrained.finalBytes).toBe(unconstrained.initialBytes);
    expect(unconstrained.growthBytes).toBe(unconstrained.peakBytes - unconstrained.initialBytes);

    expectScenarioFailure(
      () =>
        assertPersistentMemoryGrowthCap(samples, {
          maximumGrowthBytes: unconstrained.growthBytes - 1,
          selectMemory: (sample) => sample.memory,
          label: "Memory.myrmex",
        }),
      "persistent-memory-growth-exceeded",
      1,
    );
  });

  it("requires an outcome by an inclusive absolute deadline", () => {
    const ticks = [
      { gameTime: 100, outcome: { replacementReady: false } },
      { gameTime: 101, outcome: { replacementReady: false } },
      { gameTime: 102, outcome: { replacementReady: true } },
    ];
    const options = {
      deadline: 102,
      selectGameTime: (tick: (typeof ticks)[number]) => tick.gameTime,
      label: "replacement readiness",
    };

    expect(assertOutcomeByDeadline(ticks, (tick) => tick.outcome.replacementReady, options)).toBe(
      2,
    );
    expectScenarioFailure(
      () =>
        assertOutcomeByDeadline(ticks, (tick) => tick.outcome.replacementReady, {
          ...options,
          deadline: 101,
        }),
      "outcome-deadline-missed",
      null,
    );
  });

  it("rejects unbounded or ambiguous inputs before invoking caller predicates", () => {
    const predicate = vi.fn(() => true);
    const oversized = Array.from({ length: MAX_ASSERTION_SAMPLES + 1 }, () => null);
    expect(() => assertRequiredOutcome(oversized, predicate)).toThrow(/at most/u);
    expect(predicate).not.toHaveBeenCalled();

    const sparse = [null];
    sparse.length = 2;
    expect(() => {
      assertForbiddenOutcome(sparse, predicate);
    }).toThrow(/sparse/u);
    expect(predicate).not.toHaveBeenCalled();

    expect(() =>
      assertOutcomeByDeadline([{ gameTime: 2 }, { gameTime: 1 }], () => false, {
        deadline: 2,
        selectGameTime: (sample) => sample.gameTime,
      }),
    ).toThrow(/strictly increasing/u);
  });
});

function expectScenarioFailure(
  operation: () => unknown,
  code: ScenarioAssertionError["code"],
  sampleIndex: number | null,
): void {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ScenarioAssertionError);
    expect(error).toMatchObject({ code, sampleIndex });
    return;
  }

  throw new Error(`Expected scenario assertion failure ${code}`);
}
