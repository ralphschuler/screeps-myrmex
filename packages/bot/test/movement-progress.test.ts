import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache";
import {
  getMovementProgressTracker,
  type MovementIntent,
  type MovementRuntimeResult,
} from "../src/movement";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

function intent(overrides: Partial<MovementIntent> = {}): MovementIntent {
  return {
    actorId: "creep-a",
    contractId: "contract-a",
    contractRevision: 2,
    deadline: 30,
    destination: position(11, 10),
    direction: 3,
    goal: position(20, 10),
    id: "move-a",
    priority: 1,
    range: 1,
    stuckAge: 0,
    ...overrides,
  };
}

function result(
  move: MovementIntent,
  reason: "accepted" | "blocked" | "no-path" = "accepted",
): MovementRuntimeResult {
  return {
    actionDecisions: [],
    actionExecution: [],
    actionSubmitted: 0,
    movementDecisions: [],
    movementExecution: [
      {
        intent: move,
        outcome: reason === "accepted" ? { code: 0, name: "OK", state: "scheduled" } : null,
        reason,
        status: reason === "accepted" ? "executed" : "rejected",
      },
    ],
    movementSubmitted: 1,
    status: "executed",
  };
}

function snapshot(actor = position(10, 10), actorId = "creep-a"): WorldSnapshot {
  return {
    rooms: [{ ownedCreeps: [{ id: actorId, pos: actor }] }],
  } as unknown as WorldSnapshot;
}

describe("movement progress", () => {
  it("correlates equivalent lease revisions and resets on movement or semantic goal drift", () => {
    const tracker = getMovementProgressTracker(new CacheManager());
    const move = intent({ episodeKey: "harvest:source-a" });
    tracker.record(result(move), snapshot(), 10);

    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-a",
        contractRevision: 2,
        episodeKey: "harvest:source-a",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(1);
    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(11, 10),
        contractId: "contract-a",
        contractRevision: 2,
        episodeKey: "harvest:source-a",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(0);
    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-a",
        contractRevision: 3,
        episodeKey: "harvest:source-a",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(1);
    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-a",
        contractRevision: 3,
        episodeKey: "harvest:source-a",
        goal: position(21, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(0);
    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-a",
        contractRevision: 3,
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(0);
  });

  it("counts typed blocked/no-path evidence but loses only quality after a heap reset", () => {
    const manager = new CacheManager();
    const tracker = getMovementProgressTracker(manager);
    tracker.record(result(intent(), "blocked"), snapshot(), 10);
    tracker.record(
      result(intent({ destination: position(10, 10), direction: null, stuckAge: 1 }), "no-path"),
      snapshot(),
      11,
    );

    const query = {
      actorId: "creep-a",
      actorPosition: position(10, 10),
      contractId: "contract-a",
      contractRevision: 2,
      goal: position(20, 10),
      range: 1,
      tick: 12,
    } as const;
    expect(tracker.stuckAge(query)).toBe(2);
    expect(getMovementProgressTracker(new CacheManager()).stuckAge(query)).toBe(0);
    expect(manager.registeredNamespaceIds()).toContain("movement.progress.v1");
    expect(() => {
      tracker.record(result(intent({ contractId: "x".repeat(1_024) })), snapshot(), 12);
    }).not.toThrow();
  });

  it("preserves no-progress evidence across an equivalent successor episode", () => {
    const tracker = getMovementProgressTracker(new CacheManager());
    tracker.record(
      result(intent({ contractId: "contract-a", episodeKey: "build:site-a", stuckAge: 4 })),
      snapshot(),
      10,
    );

    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-successor",
        contractRevision: 1,
        episodeKey: "build:site-a",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(5);
    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-successor",
        contractRevision: 1,
        episodeKey: "repair:site-a",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(0);
  });

  it("detects bounded A-B goal oscillation and clears it after stable path recovery", () => {
    const tracker = getMovementProgressTracker(new CacheManager());
    const goals = [
      { contractId: "upgrade-a", episodeKey: "upgrade:controller", goal: position(40, 10) },
      { contractId: "harvest-a", episodeKey: "harvest:source", goal: position(10, 10) },
    ] as const;

    for (let tick = 10; tick < 21; tick += 1) {
      const selected = goals[(tick - 10) % 2];
      if (selected === undefined) throw new Error("missing oscillation fixture");
      const move = intent({
        contractId: selected.contractId,
        contractRevision: tick,
        episodeKey: selected.episodeKey,
        goal: selected.goal,
      });
      const query = {
        actorId: "creep-a",
        actorPosition: position(10 + ((tick - 10) % 3), 11),
        contractId: selected.contractId,
        contractRevision: tick,
        episodeKey: selected.episodeKey,
        goal: selected.goal,
        range: 1,
        tick,
      } as const;
      expect(tracker.goalOscillationAge(query)).toBe(Math.max(0, tick - 11));
      tracker.record(result(move), snapshot(query.actorPosition), tick);
    }

    const recovered = {
      actorId: "creep-a",
      actorPosition: position(12, 11),
      contractId: "harvest-a",
      contractRevision: 22,
      episodeKey: "harvest:source",
      goal: position(10, 10),
      range: 1,
      tick: 21,
    } as const;
    expect(tracker.goalOscillationAge(recovered)).toBe(10);
    tracker.record(
      result(
        intent({
          contractId: recovered.contractId,
          contractRevision: recovered.contractRevision,
          episodeKey: recovered.episodeKey,
          goal: recovered.goal,
        }),
      ),
      snapshot(recovered.actorPosition),
      recovered.tick,
    );
    expect(tracker.goalOscillationAge({ ...recovered, tick: 22 })).toBe(0);
  });

  it("bounds multi-actor episode records and loses only oldest quality on eviction", () => {
    const manager = new CacheManager();
    const tracker = getMovementProgressTracker(manager);

    for (let index = 0; index < 100; index += 1) {
      const actorId = `creep-${String(index)}`;
      tracker.record(
        result(
          intent({
            actorId,
            contractId: `contract-${String(index)}`,
            episodeKey: `build:site-${String(index)}`,
          }),
        ),
        snapshot(position(10, 10), actorId),
        10,
      );
    }

    expect(manager.metrics().namespaces).toEqual([
      expect.objectContaining({
        capacity: 128,
        entries: 128,
        evictions: 72,
        id: "movement.progress.v1",
      }),
    ]);
    expect(
      tracker.stuckAge({
        actorId: "creep-99",
        actorPosition: position(10, 10),
        contractId: "contract-99",
        contractRevision: 2,
        episodeKey: "build:site-99",
        goal: position(20, 10),
        range: 1,
        tick: 11,
      }),
    ).toBe(1);
    expect(() => {
      tracker.record(result(intent({ actorId: "missing" })), snapshot(), 11);
    }).not.toThrow();
  });
});
