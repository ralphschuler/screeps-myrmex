import { describe, expect, it, vi } from "vitest";
import {
  MAX_CREEP_NAME_LENGTH,
  MAX_SPAWN_BODY_PARTS,
  MAX_SPAWN_COMMANDS_PER_BATCH,
  SpawnExecutor,
  type SpawnCommandIntent,
  type SpawnExecutionReason,
} from "../src/spawn/spawn-executor";

describe("SpawnExecutor", () => {
  it.each([
    [0, "scheduled", "scheduled"],
    [-1, "rejected", "non-owner"],
    [-3, "rejected", "name-collision"],
    [-4, "rejected", "busy"],
    [-6, "rejected", "insufficient-energy"],
    [-10, "rejected", "invalid-arguments"],
    [-14, "rejected", "inactive"],
  ] as const)("normalizes spawnCreep return code %s", (code, status, reason) => {
    const issue = vi.fn(() => code);
    const [result] = new SpawnExecutor().execute([command()], () => liveSpawn(issue));

    expect(issue).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      intentId: "intent:1",
      status,
      reason,
      returnCode: code,
      outcome: { code, reason },
    });
  });

  it.each([
    [-9, "unknown-code", -9],
    [Number.NaN, "invalid-return-code", null],
    [Number.POSITIVE_INFINITY, "invalid-return-code", null],
    [Number.NEGATIVE_INFINITY, "invalid-return-code", null],
  ] as const)(
    "fails closed for unsupported spawnCreep return value %s",
    (code, reason, storedCode) => {
      const issue = vi.fn(() => code);
      const [result] = new SpawnExecutor().execute([command()], () => liveSpawn(issue));

      expect(issue).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "failed",
        reason,
        returnCode: storedCode,
        outcome: {
          state: "invalid-return-code",
          reason,
          code: storedCode,
        },
      });
    },
  );

  it.each([
    ["missing", () => undefined, "spawn-missing"],
    ["foreign", () => liveSpawn(vi.fn(), { my: false }), "non-owner"],
    [
      "wrong structure type",
      () => liveSpawn(vi.fn(), { structureType: "extension" }),
      "wrong-structure-type",
    ],
    ["wrong id", () => liveSpawn(vi.fn(), { id: "spawn:other" }), "spawn-id-mismatch"],
    ["wrong name", () => liveSpawn(vi.fn(), { name: "SpawnOther" }), "spawn-name-mismatch"],
    ["wrong room", () => liveSpawn(vi.fn(), { room: { name: "W9N9" } }), "room-mismatch"],
    ["busy", () => liveSpawn(vi.fn(), { spawning: { name: "existing" } }), "busy"],
    ["inactive", () => liveSpawn(vi.fn(), { isActive: () => false }), "inactive"],
  ] satisfies readonly [string, () => unknown, SpawnExecutionReason][])(
    "rejects a %s resolved spawn without issuing a command",
    (_label, resolve, reason) => {
      const resolved = resolve();
      const [result] = new SpawnExecutor().execute([command()], () => resolved);

      expect(result).toMatchObject({
        status: "rejected",
        reason,
        returnCode: null,
        outcome: { state: "live-spawn-rejected", reason, code: null },
      });
      if (typeof resolved === "object" && "spawnCreep" in resolved) {
        expect(resolved.spawnCreep).not.toHaveBeenCalled();
      }
    },
  );

  it("passes the intended body and name exactly once with the live spawn as this", () => {
    const calls: { body: unknown; name: unknown; receiver: unknown }[] = [];
    const spawn = liveSpawn(function (this: unknown, body: unknown, name: unknown) {
      calls.push({ body, name, receiver: this });
      return 0;
    });

    const results = new SpawnExecutor().execute([command()], () => spawn);

    expect(calls).toEqual([
      { body: ["work", "carry", "move"], name: "recovery-1", receiver: spawn },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("scheduled");
  });

  it.each([
    ["resolver", () => () => undefined],
    [
      "property getter",
      () => () => {
        const spawn = liveSpawn(vi.fn());
        Object.defineProperty(spawn, "id", {
          get() {
            throw new Error("id unavailable");
          },
        });
        return spawn;
      },
    ],
    ["isActive", () => () => liveSpawn(vi.fn(), { isActive: () => fail("active failed") })],
    ["spawnCreep", () => () => liveSpawn(() => fail("spawn failed"))],
  ] as const)("normalizes a thrown %s adapter boundary", (_label, makeResolver) => {
    const resolver =
      _label === "resolver"
        ? () => {
            throw new Error("resolver failed");
          }
        : makeResolver();
    const [result] = new SpawnExecutor().execute([command()], resolver);

    expect(result).toMatchObject({
      status: "failed",
      reason: "adapter-fault",
      returnCode: null,
      outcome: { state: "adapter-fault", code: null },
    });
    expect(result?.outcome).toHaveProperty("error");
  });

  it("continues after an adapter fault and preserves deterministic intent order", () => {
    const issued: string[] = [];
    const inputs = [
      command({ intentId: "intent:b", spawnId: "spawn:b", spawnName: "SpawnB", name: "worker-b" }),
      command({ intentId: "intent:a", spawnId: "spawn:a", spawnName: "SpawnA", name: "worker-a" }),
    ];

    const results = new SpawnExecutor().execute(inputs, (spawnId) => {
      if (spawnId === "spawn:a") {
        throw new Error("a unavailable");
      }
      return liveSpawn(
        (_body, name) => {
          issued.push(name);
          return 0;
        },
        { id: "spawn:b", name: "SpawnB" },
      );
    });

    expect(results.map(({ intentId, status }) => [intentId, status])).toEqual([
      ["intent:a", "failed"],
      ["intent:b", "scheduled"],
    ]);
    expect(issued).toEqual(["worker-b"]);
  });

  it("sorts by intent id before resolution and includes a non-negative CPU delta", () => {
    const resolved: string[] = [];
    const cpuReadings = [4, 4.75, 10, 9];
    const results = new SpawnExecutor().execute(
      [
        command({ intentId: "z", spawnId: "spawn:z", spawnName: "SpawnZ" }),
        command({ intentId: "a", spawnId: "spawn:a", spawnName: "SpawnA" }),
      ],
      (spawnId) => {
        resolved.push(spawnId);
        return liveSpawn(
          vi.fn(() => 0),
          {
            id: spawnId,
            name: spawnId === "spawn:a" ? "SpawnA" : "SpawnZ",
          },
        );
      },
      { getUsed: () => cpuReadings.shift() ?? Number.NaN },
    );

    expect(resolved).toEqual(["spawn:a", "spawn:z"]);
    expect(results.map(({ intentId, cpuUsed }) => [intentId, cpuUsed])).toEqual([
      ["a", 0.75],
      ["z", 0],
    ]);
  });

  it("rejects duplicate spawn slots deterministically before resolving or issuing commands", () => {
    const inputs = [
      command({ intentId: "intent:b", name: "worker-b" }),
      command({ intentId: "intent:a", demandId: "demand:2", name: "worker-a" }),
    ];

    for (const commands of [inputs, [...inputs].reverse()]) {
      const issue = vi.fn(() => 0);
      const resolveSpawn = vi.fn(() => liveSpawn(issue));

      expect(() => new SpawnExecutor().execute(commands, resolveSpawn)).toThrow(
        "spawn command batch targets spawn spawn:1 more than once: intent:a, intent:b",
      );
      expect(resolveSpawn).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["energy cost", { energyCost: 199 }, "must equal body energy cost 200"],
    ["spawn duration", { spawnTicks: 8 }, "must equal body spawn duration 9"],
  ] as const)("rejects an inconsistent %s before resolving a spawn", (_label, override, reason) => {
    const resolveSpawn = vi.fn();

    expect(() => new SpawnExecutor().execute([command(override)], resolveSpawn)).toThrow(reason);
    expect(resolveSpawn).not.toHaveBeenCalled();
  });

  it("enforces batch, intent-id, body, and name bounds before resolving a spawn", () => {
    const resolveSpawn = vi.fn();
    const duplicate = [command(), command({ name: "recovery-2" })];
    expect(() => new SpawnExecutor().execute(duplicate, resolveSpawn)).toThrow(
      "duplicate spawn command intent id",
    );

    const oversizedBatch = Array.from({ length: MAX_SPAWN_COMMANDS_PER_BATCH + 1 }, (_, index) =>
      command({ intentId: `intent:${String(index)}` }),
    );
    expect(() => new SpawnExecutor().execute(oversizedBatch, resolveSpawn)).toThrow(
      "spawn command batch exceeds",
    );
    expect(() =>
      new SpawnExecutor().execute(
        [command({ body: Array(MAX_SPAWN_BODY_PARTS + 1).fill("move") })],
        resolveSpawn,
      ),
    ).toThrow("must contain 1-50 parts");
    expect(() =>
      new SpawnExecutor().execute(
        [command({ name: "n".repeat(MAX_CREEP_NAME_LENGTH + 1) })],
        resolveSpawn,
      ),
    ).toThrow("must contain 1-100 characters");
    expect(() =>
      new SpawnExecutor().execute([command({ intentId: " intent:1" })], resolveSpawn),
    ).toThrow("spawn command intentId");
    expect(() => new SpawnExecutor().execute([command({ revision: -1 })], resolveSpawn)).toThrow(
      "spawn command revision",
    );
    expect(resolveSpawn).not.toHaveBeenCalled();
  });

  it("returns a deeply frozen clone and exactly one result per input", () => {
    const input = command();
    const results = new SpawnExecutor().execute([input], () => liveSpawn(vi.fn(() => 0)));
    const [result] = results;

    expect(results).toHaveLength(1);
    expect(result?.command).not.toBe(input);
    expect(result?.command.body).not.toBe(input.body);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.command)).toBe(true);
    expect(Object.isFrozen(result?.command.body)).toBe(true);
    expect(Object.isFrozen(result?.outcome)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.body)).toBe(false);
  });
});

function command(overrides: Partial<SpawnCommandIntent> = {}): SpawnCommandIntent {
  return {
    intentId: "intent:1",
    demandId: "demand:1",
    colonyId: "colony:W0N0",
    issuer: "test.spawn-broker",
    revision: 1,
    reservationId: "reservation:1",
    spawnId: "spawn:1",
    spawnName: "Spawn1",
    roomName: "W0N0",
    body: ["work", "carry", "move"],
    name: "recovery-1",
    energyCost: 200,
    spawnTicks: 9,
    scheduledTick: 100,
    ...overrides,
  };
}

function liveSpawn(
  spawnCreep: (body: readonly unknown[], name: string) => unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    structureType: "spawn",
    id: "spawn:1",
    name: "Spawn1",
    room: { name: "W0N0" },
    my: true,
    spawning: null,
    isActive: () => true,
    spawnCreep,
    ...overrides,
  };
}

function fail(message: string): never {
  throw new Error(message);
}
