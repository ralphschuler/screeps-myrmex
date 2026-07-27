/// <reference types="screeps" />

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEGMENT_MANAGER_LIMITS,
  SegmentManager,
  createJsonSegmentCodec,
  type SegmentManagerMetrics,
  type SegmentOwnerStateV1,
  type SegmentPriority,
  type SegmentReadResult,
} from "../../bot/src/segments";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

interface SegmentWorld {
  readonly owner: SegmentOwnerStateV1 | Record<string, never>;
  readonly data: readonly (readonly [number, string])[];
  readonly active: readonly number[];
}

interface SegmentInput {
  readonly write: "candidate" | "stable" | null;
  readonly read: boolean;
  readonly reverse: boolean;
  readonly interruptOwnerCommit: boolean;
  readonly corruptCurrent: boolean;
}

interface SegmentOutcome {
  readonly metrics: SegmentManagerMetrics;
  readonly read: SegmentReadResult<{ readonly value: string }> | null;
  readonly currentGeneration: number | null;
  readonly previousGeneration: number | null;
}

const codec = createJsonSegmentCodec<{ readonly value: string }>();

const priorities: readonly SegmentPriority[] = [
  "safety-intel",
  "active-operation",
  "active-colony-remote",
  "optional-analysis",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 3 SegmentManager deterministic outcome", () => {
  it("survives reset, interrupted publication, corruption, and reordered consumers", () => {
    const warm = runScenario(segmentScenario(false, false));
    const resetReordered = runScenario(segmentScenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);

    expect(warm.outcomes.map(({ read }) => read?.status ?? null)).toEqual([
      null,
      null,
      "ready",
      null,
      null,
      "loading",
      "ready",
      "loading",
      "ready",
      "ready",
    ]);
    expect(warm.outcomes[2]?.read).toMatchObject({
      status: "ready",
      value: { value: "stable" },
    });
    expect(warm.outcomes[6]?.read).toMatchObject({
      status: "ready",
      value: { value: "candidate" },
    });
    expect(warm.outcomes[9]?.read).toMatchObject({
      status: "ready",
      value: { value: "stable" },
    });
    expect(warm.outcomes[7]?.metrics.quarantined).toBe(1);
    expect(warm.outcomes[8]?.metrics.fallbackReads).toBe(1);

    for (const outcome of warm.outcomes) {
      expect(outcome.metrics.activatedSegments).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumActiveSegments,
      );
      expect(outcome.metrics.writes).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumWritesPerTick,
      );
      expect(outcome.metrics.writeCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumWriteCodeUnitsPerTick,
      );
      expect(outcome.metrics.readCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumReadCodeUnitsPerTick,
      );
      expect(outcome.metrics.verificationCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumVerificationCodeUnitsPerTick,
      );
      expect(outcome.metrics.compactionSteps).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumCompactionStepsPerTick,
      );
      expect(outcome.metrics.manifestCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumManifestCodeUnits,
      );
    }
  });
});

function segmentScenario(
  reset: boolean,
  reverse: boolean,
): ReplayScenario<SegmentWorld, SegmentInput, SegmentOutcome> {
  const inputs: readonly SegmentInput[] = [
    input("stable", false),
    input("stable", false),
    input("stable", true),
    input("candidate", false),
    { ...input("candidate", false), interruptOwnerCommit: true },
    input("candidate", true),
    input(null, true),
    { ...input(null, true), corruptCurrent: true },
    input(null, true),
    input(null, true),
  ].map((value) => ({ ...value, reverse }));

  return defineReplayScenario<SegmentWorld, SegmentInput, SegmentOutcome>({
    id: "phase3/segments/copy-on-write-recovery",
    seed: "phase3-segments-v1",
    initialWorld: {
      owner: {},
      data: Object.freeze([]),
      active: Object.freeze([]),
    },
    ticks: inputs.map((tickInput, index) => ({
      gameTime: 1_000 + index,
      cpuBudget: 1,
      resetHeap: reset && [2, 5, 9].includes(index),
      input: tickInput,
    })),
    step({ gameTime, input: tickInput, world }) {
      const data = new Map(world.data);
      if (tickInput.corruptCurrent) {
        const current = currentReference(world.owner);
        if (current !== null) data.set(current.segmentId, "corrupt");
      }
      let nextActive: readonly number[] = Object.freeze([]);
      const raw = {
        segments: Object.fromEntries(world.active.map((id) => [id, data.get(id) ?? ""])) as Record<
          number,
          string
        >,
        setActiveSegments(ids: number[]) {
          nextActive = Object.freeze([...ids]);
        },
      };
      vi.stubGlobal("RawMemory", raw);

      const opened = SegmentManager.open(world.owner, gameTime);
      if (opened.status === "unsupported") throw new Error("unexpected future owner");
      const manager = opened.manager;
      manager.beginTick();
      const ordered = tickInput.reverse ? [...priorities].reverse() : priorities;
      const stores = new Map<SegmentPriority, ReturnType<typeof registeredStore>>();
      for (const priority of ordered) stores.set(priority, registeredStore(manager, priority));
      const store = stores.get("active-colony-remote");
      if (store === undefined) throw new Error("missing scenario store");
      const read = tickInput.read ? store.read("portfolio") : null;
      if (tickInput.write !== null) {
        const queued = store.write("portfolio", { value: tickInput.write });
        if (!queued.accepted) throw new Error(`scenario write rejected: ${queued.reason}`);
      }
      manager.reconcile();
      for (const [id, value] of Object.entries(raw.segments)) data.set(Number(id), value);
      const view = manager.view();
      const nextOwner = tickInput.interruptOwnerCommit ? world.owner : view;
      const entry = view.entries[0];
      return {
        nextWorld: {
          owner: nextOwner,
          data: [...data.entries()].sort(([left], [right]) => left - right),
          active: nextActive,
        },
        outcome: {
          metrics: manager.metrics(),
          read,
          currentGeneration: entry?.current?.generation ?? null,
          previousGeneration: entry?.previous?.generation ?? null,
        },
        cpuUsed: 0.25,
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== inputs.length) throw new Error("segment outcome count mismatch");
      const entries =
        "schemaVersion" in finalWorld.owner
          ? (finalWorld.owner as SegmentOwnerStateV1).entries
          : [];
      if (entries.length !== 1) {
        throw new Error("segment manifest did not converge to one logical entry");
      }
    },
  });
}

function currentReference(
  owner: SegmentOwnerStateV1 | Record<string, never>,
): SegmentOwnerStateV1["entries"][number]["current"] {
  return "schemaVersion" in owner
    ? ((owner as SegmentOwnerStateV1).entries[0]?.current ?? null)
    : null;
}

function input(write: SegmentInput["write"], read: boolean): SegmentInput {
  return {
    write,
    read,
    reverse: false,
    interruptOwnerCommit: false,
    corruptCurrent: false,
  };
}

function registeredStore(manager: SegmentManager, priority: SegmentPriority) {
  return manager.register({
    codec,
    id: `phase3-${priority}`,
    keyOf: (key: string) => key,
    maximumEncodedLength: 1_024,
    owner: "phase3-segment-scenario",
    priority,
    schemaVersion: 1,
  });
}
