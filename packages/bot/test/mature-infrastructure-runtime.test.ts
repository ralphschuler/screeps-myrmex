import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { installMatureRuntimeGlobals, matureRuntimeWorld } from "./support/mature-runtime-fixture";

describe("mature infrastructure static tick composition", () => {
  beforeAll(() => {
    installMatureRuntimeGlobals();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("funds, executes once, and settles exact factory and power deltas after a memory reset", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;

    const first = runTick({ game: world.game(100), memory });
    expect(first.config.features.gates["phase2.mature"]).toMatchObject({ enabled: true });
    expect(first.colony.colonies[0]).toMatchObject({
      state: "developing",
      domainHealth: { blocker: { domain: "layout", reasonCode: "failed" } },
    });
    expect(world.produce).not.toHaveBeenCalled();
    expect(world.processPower).not.toHaveBeenCalled();

    const scheduled = runTick({ game: world.game(101), memory });
    expect(scheduled.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledOnce();
    expect(world.produce).toHaveBeenCalledWith("wire");
    expect(world.processPower).toHaveBeenCalledOnce();
    expect(memory.myrmex?.industry).toMatchObject({
      schemaVersion: 5,
      matureAttempts: [
        { kind: "factory", observeAt: 102 },
        { kind: "power-processing", observeAt: 102 },
      ],
    });

    world.applyScheduledEffects();
    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const settled = runTick({ game: world.game(102), memory: resetMemory });
    expect(settled.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(1);
    expect(world.processPower).toHaveBeenCalledTimes(1);
    expect(resetMemory.myrmex?.industry).toMatchObject({
      schemaVersion: 5,
      matureAttempts: [],
    });
    expect(settled.telemetry?.industry.mature).toMatchObject({
      accounting: {
        factory: [40, 100, 20],
        powerProcessing: [50, 1, 1],
      },
    });
  });

  it("marks a no-effect receipt retry-ready and retries without changing its objective", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    runTick({ game: world.game(300), memory });
    runTick({ game: world.game(301), memory });

    const noEffect = runTick({ game: world.game(302), memory });
    expect(noEffect.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(1);
    expect(world.processPower).toHaveBeenCalledTimes(1);
    expect(memory.myrmex?.industry).toMatchObject({
      matureAttempts: [
        { kind: "factory", retry: 1, retryReady: true },
        { kind: "power-processing", retry: 1, retryReady: true },
      ],
    });

    const retried = runTick({ game: world.game(303), memory });
    expect(retried.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(2);
    expect(world.processPower).toHaveBeenCalledTimes(2);
    expect(memory.myrmex?.industry).toMatchObject({
      matureAttempts: [
        { kind: "factory", retry: 1, observeAt: 304 },
        { kind: "power-processing", retry: 1, observeAt: 304 },
      ],
    });
  });

  it("sheds optional mature planning under constrained CPU without losing durable state", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    runTick({ game: world.game(200), memory });
    const before = JSON.stringify(memory.myrmex?.industry);

    const constrained = runTick({ game: world.game(201, 4_000), memory });

    expect(constrained.kernel.mode).toBe("constrained");
    expect(world.produce).not.toHaveBeenCalled();
    expect(world.processPower).not.toHaveBeenCalled();
    expect(JSON.stringify(memory.myrmex?.industry)).toBe(before);
  });
});
