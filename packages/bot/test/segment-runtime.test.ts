import { afterEach, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import type { RuntimeGame } from "../src/runtime/context";
import { projectSegmentTelemetry } from "../src/telemetry/metrics";

class RuntimeSegments {
  readonly data = new Map<number, string>();
  active: readonly number[] = Object.freeze([]);
  nextActive: readonly number[] = Object.freeze([]);
  readonly raw = {
    segments: {} as Record<number, string>,
    setActiveSegments: (ids: number[]) => {
      this.nextActive = Object.freeze([...ids]);
    },
  };

  start(): void {
    this.raw.segments = Object.fromEntries(this.active.map((id) => [id, this.data.get(id) ?? ""]));
    vi.stubGlobal("RawMemory", this.raw);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SegmentManager runtime composition", () => {
  it("initializes the sole segments owner without making segment readiness boot-critical", () => {
    const memory = {} as Memory;
    const segments = new RuntimeSegments();
    segments.start();

    const outcome = runTick({ game: emptyGame(700), memory });

    expect(outcome.segments).toMatchObject({
      ownerStatus: "initialized",
      rawMemoryAvailable: true,
      activatedSegments: 0,
      manifestEntries: 0,
      writes: 0,
    });
    expect(outcome.telemetry?.segments).toEqual(projectSegmentTelemetry(outcome.segments));
    expect(outcome.telemetry?.segments).toHaveLength(20);
    expect(outcome.intel).toMatchObject({
      status: "ready",
      metrics: { visibleRooms: 0, queried: 0, writeOffers: 0 },
    });
    expect(Object.isFrozen(outcome.telemetry?.segments)).toBe(true);
    expect(memory.myrmex?.segments).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      entries: [],
      quarantine: [],
    });
    expect(outcome.kernel.faults).toEqual([]);
    const completed = outcome.kernel.systems
      .filter(({ status }) => status === "completed")
      .map(({ systemId }) => systemId);
    expect(completed).toContain("segments.ingest");
    expect(completed).toContain("world.observe-intel");
    expect(completed).toContain("segments.reconcile");
    expect(completed.indexOf("world.observe")).toBeLessThan(
      completed.indexOf("world.observe-intel"),
    );
    expect(completed.indexOf("world.observe-intel")).toBeLessThan(
      completed.indexOf("colony.director"),
    );
    expect(completed.indexOf("segments.reconcile")).toBeLessThan(
      completed.indexOf("state.reconcile"),
    );
  });

  it("reports intel unavailable when CPU admission skips the optional projection", () => {
    const memory = {} as Memory;
    const segments = new RuntimeSegments();
    segments.start();

    const outcome = runTick({ game: emptyGame(705, 0), memory });

    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "world.observe-intel", status: "skipped" }),
      ]),
    );
    expect(outcome.intel).toMatchObject({ status: "unavailable", rooms: [], routes: [] });
  });

  it("preserves a future segment owner and reports optional service unavailable", () => {
    const memory = {} as Memory;
    const segments = new RuntimeSegments();
    segments.start();
    runTick({ game: emptyGame(710), memory });
    if (memory.myrmex === undefined) throw new Error("expected initialized memory");
    const future = { schemaVersion: 2, opaque: { keep: true } };
    memory.myrmex = { ...memory.myrmex, segments: future };

    const outcome = runTick({ game: emptyGame(711), memory });

    expect(outcome.segments).toMatchObject({
      ownerStatus: "unsupported",
      rawMemoryAvailable: false,
    });
    expect(memory.myrmex.segments).toEqual(future);
    expect(outcome.kernel.faults).toEqual([]);
  });
});

function emptyGame(time: number, bucket = 10_000): RuntimeGame {
  return {
    cpu: { bucket, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard0" },
    time,
  };
}
