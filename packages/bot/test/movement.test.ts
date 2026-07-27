import { describe, expect, it } from "vitest";
import {
  CreepActionArbiter,
  CreepActionExecutor,
  MovementArbiter,
  MovementExecutor,
  type CreepActionIntent,
  type MovementIntent,
} from "../src/movement";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

function moveIntent(overrides: Partial<MovementIntent> = {}): MovementIntent {
  return {
    actorId: "creep-a",
    contractId: null,
    contractRevision: null,
    deadline: 10,
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

function actionIntent(overrides: Partial<CreepActionIntent> = {}): CreepActionIntent {
  return {
    actorId: "creep-a",
    amount: null,
    contractId: null,
    contractRevision: null,
    deadline: 10,
    id: "action-a",
    kind: "harvest",
    priority: 1,
    resourceType: null,
    targetId: "source-a",
    ...overrides,
  };
}

describe("MovementArbiter", () => {
  it("chooses a stable winner for a contested destination and never gives an actor two moves", () => {
    const arbiter = new MovementArbiter();
    const actors = [
      { fatigue: 0, id: "creep-a", pos: position(10, 10) },
      { fatigue: 0, id: "creep-b", pos: position(12, 10) },
    ];
    const first = moveIntent();
    const second = moveIntent({ actorId: "creep-b", id: "move-b", priority: 1 });

    const ordered = arbiter.arbitrate(1, actors, [second, first]);
    const reordered = arbiter.arbitrate(1, actors, [first, second]);

    expect(ordered).toEqual(reordered);
    expect(ordered.map(({ status }) => status)).toEqual(["accepted", "rejected"]);
    expect(ordered[1]?.reason).toBe("blocked");
  });

  it("accepts a reciprocal move swap and turns fatigue and no-path into results", () => {
    const arbiter = new MovementArbiter();
    const actors = [
      { fatigue: 0, id: "creep-a", pos: position(10, 10) },
      { fatigue: 0, id: "creep-b", pos: position(11, 10) },
      { fatigue: 1, id: "creep-c", pos: position(13, 10) },
    ];
    const results = arbiter.arbitrate(1, actors, [
      moveIntent(),
      moveIntent({ actorId: "creep-b", destination: position(10, 10), id: "move-b" }),
      moveIntent({ actorId: "creep-c", destination: position(14, 10), id: "move-c" }),
      moveIntent({
        actorId: "creep-c",
        destination: position(14, 10),
        direction: null,
        id: "move-d",
      }),
    ]);

    expect(results.map(({ reason }) => reason)).toEqual([
      "accepted",
      "accepted",
      "fatigued",
      "no-path",
    ]);
  });

  it("admits only an exact cardinal room-boundary crossing", () => {
    const actor = { fatigue: 0, id: "creep-a", pos: { roomName: "W1N1", x: 49, y: 10 } };
    const crossing = moveIntent({
      destination: { roomName: "W0N1", x: 0, y: 10 },
      direction: 3,
      goal: { roomName: "W0N1", x: 0, y: 10 },
      range: 0,
      roomTransition: true,
    });
    const accepted = new MovementArbiter().arbitrate(1, [actor], [crossing]);
    const rejected = new MovementArbiter().arbitrate(
      1,
      [{ ...actor, pos: { roomName: "W1N1", x: 48, y: 10 } }],
      [crossing],
    );

    expect(accepted[0]).toMatchObject({ status: "accepted", reason: "accepted" });
    expect(rejected[0]).toMatchObject({ status: "rejected", reason: "invalid-goal" });
  });

  it("issues the accepted direction once and isolates adapter faults", () => {
    const decision = new MovementArbiter().arbitrate(
      1,
      [{ fatigue: 0, id: "creep-a", pos: position(10, 10) }],
      [moveIntent()],
    );
    let calls = 0;
    const executed = new MovementExecutor().execute(decision, () => ({
      move: () => {
        calls += 1;
        return 0;
      },
    }));
    const faulted = new MovementExecutor().execute(decision, () => ({
      move: () => {
        throw new Error("broken adapter");
      },
    }));

    expect(calls).toBe(1);
    expect(executed[0]).toMatchObject({ status: "executed", reason: "accepted" });
    expect(faulted[0]).toMatchObject({ status: "failed", reason: "adapter-fault" });
  });

  it("converts a live-actor resolver fault into a stale actor result", () => {
    const decision = new MovementArbiter().arbitrate(
      1,
      [{ fatigue: 0, id: "creep-a", pos: position(10, 10) }],
      [moveIntent()],
    );

    expect(
      new MovementExecutor().execute(decision, () => {
        throw new Error("lookup failed");
      })[0],
    ).toMatchObject({
      status: "rejected",
      reason: "stale-actor",
    });
  });
});

describe("CreepActionArbiter", () => {
  it("admits only the deterministic highest-priority primary action for an actor", () => {
    const intents = [
      actionIntent({ id: "low", priority: 1 }),
      actionIntent({ id: "high", kind: "repair", priority: 2, targetId: "road-a" }),
    ];
    const decisions = new CreepActionArbiter().arbitrate(
      1,
      new Set(["creep-a"]),
      new Set(["source-a", "road-a"]),
      intents,
    );

    expect(decisions.map(({ status }) => status)).toEqual(["accepted", "rejected"]);
    expect(decisions[1]?.reason).toBe("actor-conflict");
  });

  it("normalizes an expected out-of-range action result without throwing", () => {
    const decisions = new CreepActionArbiter().arbitrate(
      1,
      new Set(["creep-a"]),
      new Set(["source-a"]),
      [actionIntent()],
    );
    const result = new CreepActionExecutor().execute(
      decisions,
      () => ({
        build: () => -7,
        harvest: () => -9,
        pickup: () => -7,
        repair: () => -7,
        reserveController: () => -7,
        signController: () => -7,
        transfer: () => -7,
        upgradeController: () => -7,
        withdraw: () => -7,
      }),
      () => ({}),
    );

    expect(result[0]).toMatchObject({ status: "rejected", reason: "out-of-range" });
  });

  it("routes reservation and bounded signing through the sole creep action executor", () => {
    const reserve = actionIntent({
      id: "reserve",
      kind: "reserve-controller",
      targetId: "controller-a",
    });
    const sign = actionIntent({
      id: "sign",
      kind: "sign-controller",
      targetId: "controller-a",
      text: "MYRMEX",
    });
    const decisions = new CreepActionArbiter().arbitrate(
      1,
      new Set(["creep-a", "creep-b"]),
      new Set(["controller-a"]),
      [reserve, { ...sign, actorId: "creep-b" }],
    );
    const calls: string[] = [];
    const result = new CreepActionExecutor().execute(
      decisions,
      (actorId) => ({
        build: () => -7,
        harvest: () => -7,
        pickup: () => -7,
        repair: () => -7,
        reserveController: () => {
          calls.push(`${actorId}:reserve`);
          return 0;
        },
        signController: (_target, text) => {
          calls.push(`${actorId}:sign:${text}`);
          return 0;
        },
        transfer: () => -7,
        upgradeController: () => -7,
        withdraw: () => -7,
      }),
      () => ({}),
    );

    expect(calls).toEqual(["creep-a:reserve", "creep-b:sign:MYRMEX"]);
    expect(result.map(({ status }) => status)).toEqual(["executed", "executed"]);
  });
});
