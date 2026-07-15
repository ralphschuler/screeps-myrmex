import { describe, expect, it, vi } from "vitest";
import {
  ScenarioCpuBudgetError,
  ScenarioExecutionError,
  defineReplayScenario,
  runScenario,
  serializeScenarioTranscript,
  type ReplayScenario,
} from "../src/index";

interface CounterWorld {
  readonly total: number;
}

interface CounterInput {
  readonly delta: number;
}

interface CounterOutcome {
  readonly after: number;
  readonly before: number;
  readonly roll: number;
}

interface CounterHeap {
  expectedDerivedTotal: number;
}

describe("deterministic multi-tick replay", () => {
  it("repeats transitions, random draws, transcripts, and hashes exactly", () => {
    const scenario = counterScenario("repeatable", []);

    const first = runScenario(scenario);
    const second = runScenario(scenario);

    expect(second).toEqual(first);
    expect(first.transcriptHash).toMatch(/^fnv1a64-utf16:/u);
    expect(first.transcript.ticks.map((tick) => tick.random.draws)).toEqual([1, 2, 3]);
  });

  it("uses each next-world transition as the following beginning-of-tick snapshot", () => {
    const scenario = counterScenario("transitions", []);
    const result = runScenario(scenario);

    expect(result.transcript.ticks.map((tick) => tick.gameTime)).toEqual([50_000, 50_001, 50_002]);
    expect(result.transcript.ticks.map((tick) => tick.world.total)).toEqual([10, 12, 15]);
    expect(result.transcript.ticks.map((tick) => tick.nextWorld.total)).toEqual([12, 15, 14]);
    expect(result.outcomes.map((outcome) => [outcome.before, outcome.after])).toEqual([
      [10, 12],
      [12, 15],
      [15, 14],
    ]);
    expect(result.finalWorld).toEqual({ total: 14 });
  });

  it("protects beginning-of-tick world and input snapshots from mutation", () => {
    const scenario = defineReplayScenario({
      id: "contract/immutable-tick-snapshot",
      seed: 1,
      initialWorld: { count: 1 },
      ticks: [{ gameTime: 10, input: { delta: 1 }, cpuBudget: 1 }],
      step: ({ world, input }) => {
        world.count = 99;
        input.delta = 99;
        return { nextWorld: world, outcome: null, cpuUsed: 0 };
      },
    });

    expect(() => runScenario(scenario)).toThrow(ScenarioExecutionError);
  });

  it("changes deterministic outcomes when the scenario seed changes", () => {
    const first = runScenario(counterScenario("seed-a", []));
    const second = runScenario(counterScenario("seed-b", []));

    expect(first.outcomes.map((outcome) => outcome.roll)).not.toEqual(
      second.outcomes.map((outcome) => outcome.roll),
    );
    expect(first.outcomeHash).not.toBe(second.outcomeHash);
  });

  it("reconstructs heap on demand while preserving reset-equivalent domain outcomes", () => {
    const uninterrupted = runScenario(counterScenario("reset-equivalence", []));
    const resetTwice = runScenario(counterScenario("reset-equivalence", [1, 2]));

    expect(resetTwice.finalWorld).toEqual(uninterrupted.finalWorld);
    expect(resetTwice.outcomes).toEqual(uninterrupted.outcomes);
    expect(resetTwice.outcomeHash).toBe(uninterrupted.outcomeHash);
    expect(resetTwice.transcriptHash).not.toBe(uninterrupted.transcriptHash);
    expect(resetTwice.transcript.ticks.map((tick) => tick.heapReset)).toEqual([false, true, true]);
  });

  it("enforces CPU budgets and runs CPU/tick assertion hooks", () => {
    const assertCpu = vi.fn();
    const assertTick = vi.fn();
    const scenario = defineReplayScenario({
      id: "cpu/within-budget",
      seed: 7,
      initialWorld: { ok: true },
      ticks: [{ gameTime: 1, input: { load: "small" }, cpuBudget: 2 }],
      step: ({ world }) => ({ nextWorld: world, outcome: "ran", cpuUsed: 1.25 }),
      assertCpu,
      assertTick,
    });

    const result = runScenario(scenario);

    expect(assertCpu).toHaveBeenCalledWith(
      expect.objectContaining({ budget: 2, used: 1.25, remaining: 0.75 }),
    );
    expect(assertTick).toHaveBeenCalledWith(result.transcript.ticks[0]);

    const overBudget = defineReplayScenario({
      ...scenario,
      id: "cpu/over-budget",
      step: ({ world }) => ({ nextWorld: world, outcome: "ran", cpuUsed: 2.01 }),
    });

    expect(() => runScenario(overBudget)).toThrow(ScenarioCpuBudgetError);
    expect(() => runScenario(overBudget)).toThrow(/2.01 used, 2 allowed/u);
  });

  it("emits stable one-line CI transcript records", () => {
    const result = runScenario(counterScenario("ci-transcript", [1]));
    const serialized = serializeScenarioTranscript(result.transcript);

    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.split("\n")).toHaveLength(2);
    expect(JSON.parse(serialized)).toEqual(result.transcript);
    expect(serializeScenarioTranscript(result.transcript)).toBe(serialized);
  });

  it("rejects missing ticks, time gaps, and non-canonical inputs before running", () => {
    expect(() =>
      defineReplayScenario({
        id: "invalid/no-ticks",
        seed: 1,
        initialWorld: {},
        ticks: [],
        step: () => ({ nextWorld: {}, outcome: null, cpuUsed: 0 }),
      }),
    ).toThrow(/at least one tick/u);

    expect(() =>
      defineReplayScenario({
        id: "invalid/time-gap",
        seed: 1,
        initialWorld: {},
        ticks: [
          { gameTime: 1, input: null, cpuBudget: 1 },
          { gameTime: 3, input: null, cpuBudget: 1 },
        ],
        step: () => ({ nextWorld: {}, outcome: null, cpuUsed: 0 }),
      }),
    ).toThrow(/consecutively/u);

    expect(() =>
      defineReplayScenario({
        id: "invalid/input",
        seed: 1,
        initialWorld: {},
        ticks: [{ gameTime: 1, input: { callback: () => undefined }, cpuBudget: 1 }],
        step: () => ({ nextWorld: {}, outcome: null, cpuUsed: 0 }),
      }),
    ).toThrow(/unsupported function/u);
  });

  it("rejects asynchronous heaps and accessor-based step results", () => {
    const asyncHeap = defineReplayScenario({
      id: "invalid/async-heap",
      seed: 1,
      initialWorld: {},
      ticks: [{ gameTime: 1, input: null, cpuBudget: 1 }],
      createHeap: () => Promise.resolve({}) as never,
      step: () => ({ nextWorld: {}, outcome: null, cpuUsed: 0 }),
    });
    expect(() => runScenario(asyncHeap)).toThrow(/synchronous/u);

    const accessorResult = defineReplayScenario({
      id: "invalid/accessor-result",
      seed: 1,
      initialWorld: {},
      ticks: [{ gameTime: 1, input: null, cpuBudget: 1 }],
      step: () =>
        Object.defineProperty({ outcome: null, cpuUsed: 0 }, "nextWorld", {
          enumerable: true,
          get: () => ({}),
        }) as never,
    });
    expect(() => runScenario(accessorResult)).toThrow(/data property/u);
  });
});

function counterScenario(
  seed: string,
  resetTickIndexes: readonly number[],
): ReplayScenario<CounterWorld, CounterInput, CounterOutcome, CounterHeap> {
  return defineReplayScenario<CounterWorld, CounterInput, CounterOutcome, CounterHeap>({
    id: "economy/counter-transition",
    seed,
    initialWorld: { total: 10 },
    ticks: [2, 3, -1].map((delta, tickIndex) => ({
      gameTime: 50_000 + tickIndex,
      input: { delta },
      cpuBudget: 5,
      resetHeap: resetTickIndexes.includes(tickIndex),
    })),
    createHeap: ({ world }) => ({ expectedDerivedTotal: world.total * 2 }),
    step: ({ world, input, heap, random }) => {
      if (heap.expectedDerivedTotal !== world.total * 2) {
        throw new Error("Heap was not reconstructed from the current persistent world.");
      }

      const nextTotal = world.total + input.delta;
      heap.expectedDerivedTotal = nextTotal * 2;

      return {
        nextWorld: { total: nextTotal },
        outcome: {
          before: world.total,
          after: nextTotal,
          roll: random.integer(1_000_000),
        },
        cpuUsed: 1 + Math.abs(input.delta) / 10,
      };
    },
    verify: ({ finalWorld }) => {
      if (finalWorld.total !== 14) {
        throw new Error("The scenario did not reach its required outcome.");
      }
    },
  });
}
