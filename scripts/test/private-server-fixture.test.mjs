import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = require("../../integration/private-server/fixtures/myrmex-fixture.cjs");

const definition = {
  schemaVersion: 1,
  scenarioId: "hostile-reset-v1",
  target: { room: "W1N1", targetX: 20, targetY: 20, userId: "controlled-user" },
  hostile: { atTick: 7, body: "smallMelee", x: 25, y: 25 },
  heapResetAtTick: 9,
};

describe("private-server fixture mod", () => {
  it("inserts one real invader through the processor bulk and schedules one runtime reset", () => {
    const events = new Map();
    const config = { engine: { on: (name, handler) => events.set(name, handler) } };
    const receipts = new Map();
    const storage = {
      env: {
        get: async (key) => receipts.get(key),
        set: async (key, value) => receipts.set(key, value),
      },
      pubsub: {
        keys: { RUNTIME_RESTART: "runtimeRestart" },
        publish: async (...args) => published.push(args),
      },
    };
    const published = [];
    fixture(config, fixture.validateDefinition(definition), storage);
    const inserted = [];
    const objects = [
      { type: "controller", user: "controlled-user" },
      { type: "creep", user: "controlled-user", x: 20, y: 20 },
    ];
    events.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 7, {
      insert: (value) => inserted.push(value),
    });
    events.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 7, {
      insert: (value) => inserted.push(value),
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ type: "creep", user: "2", x: 25, y: 25, room: "W1N1" });
    expect(inserted[0].body).toHaveLength(10);
    events.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 9, {
      insert: () => undefined,
    });
    events.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 9, {
      insert: () => undefined,
    });
    expect(published).toEqual([["runtimeRestart", "myrmex-fixture"]]);
    const sandbox = {};
    events.get("playerSandbox")(sandbox, "controlled-user");
    expect(sandbox.__myrmexFixtureGeneration).toBe("hostile-reset-v1");
  });

  it("fails closed for an occupied or invalid hostile cell", () => {
    const events = new Map();
    const config = { engine: { on: (name, handler) => events.set(name, handler) } };
    const storage = {
      env: { get: async () => null, set: async () => undefined },
      pubsub: { keys: { RUNTIME_RESTART: "runtimeRestart" }, publish: async () => undefined },
    };
    fixture(config, fixture.validateDefinition({ ...definition, heapResetAtTick: null }), storage);
    const inserted = [];
    events.get("processRoom")(
      "W1N1",
      {},
      [
        { type: "controller", user: "controlled-user" },
        { type: "creep", user: "controlled-user", x: 20, y: 20 },
        { type: "road", x: 25, y: 25 },
      ],
      "0".repeat(2500),
      7,
      { insert: (value) => inserted.push(value) },
    );
    expect(inserted).toEqual([]);
  });

  it("rejects unsupported input before it can register a fixture", () => {
    expect(() => fixture.validateDefinition({ ...definition, extra: true })).toThrow("unknown");
    expect(() =>
      fixture.validateDefinition({
        ...definition,
        hostile: { ...definition.hostile, body: "arbitrary" },
      }),
    ).toThrow("hostile");
    expect(() => fixture.validateDefinition({ ...definition, heapResetAtTick: 10_001 })).toThrow(
      "heap-reset",
    );
  });
});
