import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = require("../../integration/private-server/fixtures/myrmex-fixture.cjs");

const definition = {
  schemaVersion: 1,
  scenarioId: "hostile-reset-v1",
  target: { room: "W1N1", targetX: 20, targetY: 20, userId: "controlled-user" },
  hostile: { atTick: 7, body: "smallMelee", x: 25, y: 25 },
  heapResetAtTick: 9,
  botExceptionAtTick: null,
};

describe("private-server fixture mod", () => {
  it("latches one post-bootstrap definition and ignores a later replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myrmex-fixture-"));
    const path = join(directory, "definition.json");
    await writeFile(path, JSON.stringify(definition), "utf8");
    const first = fixture.latchDefinition(null, path);
    await writeFile(path, JSON.stringify({ ...definition, scenarioId: "replacement" }), "utf8");
    expect(fixture.latchDefinition(first, path)).toBe(first);
    expect(fixture.latchDefinition(null, join(directory, "missing.json"))).toBeNull();
  });

  it("carries reset scheduling from processor to runner through a shared receipt", async () => {
    const processorEvents = new Map();
    const runnerEvents = new Map();
    const processor = { engine: { on: (name, handler) => processorEvents.set(name, handler) } };
    const runner = { engine: { on: (name, handler) => runnerEvents.set(name, handler) } };
    const receipts = new Map();
    const storage = {
      env: {
        get: async (key) => receipts.get(key),
        set: async (key, value) => receipts.set(key, value),
        keys: { GAMETIME: "gameTime" },
      },
      pubsub: {
        keys: { RUNTIME_RESTART: "runtimeRestart" },
        publish: async (...args) => published.push(args),
      },
    };
    const published = [];
    fixture(processor, fixture.validateDefinition(definition), storage);
    fixture(runner, fixture.validateDefinition(definition), storage);
    const inserted = [];
    const objects = [
      { type: "controller", user: "controlled-user" },
      { type: "creep", user: "controlled-user", x: 20, y: 20 },
    ];
    processorEvents.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 7, {
      insert: (value) => inserted.push(value),
    });
    processorEvents.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 7, {
      insert: (value) => inserted.push(value),
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ type: "creep", user: "2", x: 25, y: 25, room: "W1N1" });
    expect(inserted[0].body).toHaveLength(10);
    await processorEvents.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 9, {
      insert: () => undefined,
    });
    await processorEvents.get("processRoom")("W1N1", {}, objects, "0".repeat(2500), 9, {
      insert: () => undefined,
    });
    expect(published).toEqual([["runtimeRestart", "myrmex-fixture"]]);
    const sandbox = {};
    await runnerEvents.get("playerSandbox")(sandbox, "controlled-user");
    expect(sandbox.__myrmexFixtureGeneration).toBe("hostile-reset-v1");
    expect(JSON.parse(receipts.get("myrmexFixture:hostile-reset-v1:reset"))).toMatchObject({
      phase: "observed",
      resetTick: 9,
    });
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

  it("publishes a bounded bot-exception receipt before the runner-side injection", async () => {
    const events = new Map();
    const receipts = new Map([["gameTime", "11"]]);
    const storage = {
      env: {
        get: async (key) => receipts.get(key),
        keys: { GAMETIME: "gameTime" },
        set: async (key, value) => receipts.set(key, value),
      },
      pubsub: { keys: { RUNTIME_RESTART: "runtimeRestart" }, publish: async () => undefined },
    };
    fixture(
      { engine: { on: (name, handler) => events.set(name, handler) } },
      fixture.validateDefinition({ ...definition, botExceptionAtTick: 11, heapResetAtTick: null }),
      storage,
    );
    await expect(events.get("playerSandbox")({}, "controlled-user")).rejects.toThrow(
      "fixture bot exception",
    );
    expect(JSON.parse(receipts.get("myrmexFixture:hostile-reset-v1:bot-exception"))).toEqual({
      phase: "injected",
      scenarioId: "hostile-reset-v1",
      tick: 11,
    });
  });

  it("acknowledges quiescence only after an idle paused main-loop boundary", async () => {
    const events = new Map();
    const pauseRequestKey = "myrmexFixture:hostile-reset-v1:pause-request";
    const quiescenceKey = "myrmexFixture:hostile-reset-v1:quiescent-main";
    const values = new Map([
      ["mainLoopPaused", "0"],
      [pauseRequestKey, JSON.stringify({ scenarioId: "hostile-reset-v1", sequence: 1 })],
    ]);
    const writes = [];
    const storage = {
      env: {
        get: async (key) => values.get(key),
        keys: { MAIN_LOOP_PAUSED: "mainLoopPaused" },
        set: async (key, value) => {
          writes.push([key, value]);
          values.set(key, value);
        },
      },
      pubsub: { keys: { RUNTIME_RESTART: "runtimeRestart" }, publish: async () => undefined },
    };
    fixture(
      { engine: { on: (name, handler) => events.set(name, handler) } },
      fixture.validateDefinition(definition),
      storage,
    );
    const mainLoopStage = events.get("mainLoopStage");

    await mainLoopStage("start");
    await mainLoopStage("finish");
    expect(writes).toEqual([]);

    values.set("mainLoopPaused", "1");
    values.set(pauseRequestKey, null);
    await mainLoopStage("start");
    await mainLoopStage("finish");
    expect(writes).toEqual([]);

    values.set(pauseRequestKey, JSON.stringify({ scenarioId: "hostile-reset-v1", sequence: 1 }));
    await mainLoopStage("start");
    await mainLoopStage("getUsers");
    await mainLoopStage("finish");
    expect(writes).toEqual([]);

    await mainLoopStage("start");
    await mainLoopStage("finish");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(quiescenceKey);
    expect(JSON.parse(writes[0][1])).toEqual({
      phase: "quiescent",
      scenarioId: "hostile-reset-v1",
      sequence: 1,
    });

    await mainLoopStage("start");
    await mainLoopStage("finish");
    expect(writes).toHaveLength(1);
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
