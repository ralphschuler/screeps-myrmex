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

function snapshot(actor = position(10, 10)): WorldSnapshot {
  return {
    rooms: [{ ownedCreeps: [{ id: "creep-a", pos: actor }] }],
  } as unknown as WorldSnapshot;
}

describe("movement progress", () => {
  it("correlates consecutive unchanged scheduled attempts and resets on movement or lease drift", () => {
    const tracker = getMovementProgressTracker(new CacheManager());
    const move = intent();
    tracker.record(result(move), snapshot(), 10);

    expect(
      tracker.stuckAge({
        actorId: "creep-a",
        actorPosition: position(10, 10),
        contractId: "contract-a",
        contractRevision: 2,
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
});
