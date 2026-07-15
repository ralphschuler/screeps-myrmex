import { describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { TICK_PHASES, type TickPhase } from "../src/runtime/phases";

describe("tick lifecycle", () => {
  it("runs all phases in deterministic order and records bounded telemetry", () => {
    const observed: TickPhase[] = [];
    const getUsed = vi.fn(() => 1.25);
    const memory = {} as Memory;

    runTick({
      game: {
        cpu: { bucket: 9_000, getUsed },
        rooms: {},
        shard: { name: "shard3" },
        time: 42,
      },
      memory,
      onPhase: (phase) => observed.push(phase),
    });

    expect(observed).toEqual(TICK_PHASES);
    expect(memory.myrmex?.telemetry).toEqual({
      cpuUsed: 1.25,
      cpuBucket: 9_000,
      ownedRooms: 0,
    });
    expect(memory.myrmex?.boot.lastTick).toBe(42);
  });
});
