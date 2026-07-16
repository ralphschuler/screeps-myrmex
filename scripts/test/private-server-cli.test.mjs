import { EventEmitter } from "node:events";
import { createConnection, createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRIVATE_SERVER_CLI_LIMITS,
  bootstrapPrivateServerBot,
  clearPrivateServerFixture,
  deployPrivateServerBundle,
  pausePrivateServerFixture,
  privateServerDeploymentCommand,
  privateServerBundleIdentity,
  privateServerCliCommand,
  probePrivateServerReadiness,
  preparePrivateServerFixtureTarget,
  runPrivateServerCli,
  samplePrivateServerBot,
  samplePrivateServerFixture,
  samplePrivateServerFixtureQuiescence,
} from "../lib/private-server-cli.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("private-server CLI adapter", () => {
  it("maps only source-controlled, bounded operations", () => {
    expect(privateServerCliCommand({ kind: "pause" })).toBe("system.pauseSimulation()");
    expect(privateServerCliCommand({ kind: "reset" })).toBe(
      "system.resetAllData().then(()=> 'OK')",
    );
    const bootstrap = privateServerCliCommand({ kind: "bootstrap-controlled-bot" });
    expect(bootstrap).toContain("find({type:'controller'})");
    expect(bootstrap).toContain("controllers.find(item=>!item.user)");
    expect(bootstrap).not.toContain("'W1N1'");
    expect(privateServerCliCommand({ kind: "set-tick-duration", milliseconds: 1 })).toBe(
      "system.setTickDuration(1)",
    );
    expect(privateServerCliCommand({ kind: "probe-readiness" })).toBe(
      "storage.env.get(storage.env.keys.GAMETIME).then(gameTime=>storage.db.users.count().then(users=>JSON.stringify({ready:gameTime!=null&&gameTime!==''&&Number.isSafeInteger(+gameTime)&&+gameTime>=0&&Number.isSafeInteger(users)&&users>=0})))",
    );
    expect(() => privateServerCliCommand({ kind: "evaluate", source: "process.exit()" })).toThrow(
      "not supported",
    );
    expect(() => privateServerCliCommand({ kind: "set-tick-duration", milliseconds: 0 })).toThrow(
      "bounded",
    );
    const deployment = privateServerDeploymentCommand("module.exports.loop=()=>undefined;");
    expect(deployment).toContain('username:"myrmex-integration"');
    expect(deployment).toContain('modules:{main:"module.exports.loop=()=>undefined;"}');
    expect(deployment).toContain("storage.db.users.update({_id:user._id},{$set:{active:10000}})");
    expect(deployment).toContain("if(!result.modified)");
    expect(deployment).toContain("scrScriptCachedData");
    expect(() => privateServerDeploymentCommand("")).toThrow("non-empty");
  });

  it("proves read-only storage readiness sequentially", async () => {
    const calls = [];
    const storage = {
      db: {
        users: {
          async count() {
            calls.push("users.count");
            return 0;
          },
        },
      },
      env: {
        keys: { GAMETIME: "gameTime" },
        async get(key) {
          calls.push(`env.get:${key}`);
          return "0";
        },
      },
    };

    await expect(
      runInNewContext(privateServerCliCommand({ kind: "probe-readiness" }), {
        JSON,
        Number,
        storage,
      }),
    ).resolves.toBe(JSON.stringify({ ready: true }));
    expect(calls).toEqual(["env.get:gameTime", "users.count"]);
    expect(() => privateServerCliCommand({ kind: "probe-readiness", source: "ignored" })).toThrow(
      "unknown",
    );
  });

  it("returns only closed active-readiness results", async () => {
    const cases = [
      {
        response: `'${JSON.stringify({ ready: true })}'`,
        expected: { ready: true, reason: null },
      },
      {
        response: `'${JSON.stringify({ ready: false })}'`,
        expected: { ready: false, reason: "storage-not-ready" },
      },
      {
        response: `'${JSON.stringify({ ready: true, raw: "forbidden" })}'`,
        expected: { ready: false, reason: "readiness-receipt-invalid" },
      },
      {
        response: "Error: storage rejected",
        expected: { ready: false, reason: "storage-readiness-rejected" },
      },
    ];
    for (const { expected, response } of cases) {
      const server = createServer((socket) => {
        socket.write("< \r\n");
        socket.once("data", () => socket.end(`< ${response}\r\n`));
      });
      servers.push(server);
      const port = await listen(server);
      await expect(probePrivateServerReadiness({ port })).resolves.toEqual(expected);
    }

    const closed = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () => socket.end());
    });
    servers.push(closed);
    await expect(probePrivateServerReadiness({ port: await listen(closed) })).resolves.toEqual({
      ready: false,
      reason: "cli-closed",
    });

    const silent = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () => setTimeout(() => socket.end(), 50));
    });
    servers.push(silent);
    await expect(
      probePrivateServerReadiness({ port: await listen(silent), timeoutMs: 20 }),
    ).resolves.toEqual({ ready: false, reason: "cli-timeout" });

    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await new Promise((resolve) => unavailable.close(resolve));
    await expect(probePrivateServerReadiness({ port: unavailablePort })).resolves.toEqual({
      ready: false,
      reason: "cli-connection-failed",
    });
  });

  it("prepares and publishes a fresh bounded fixture pause through fixed operations", () => {
    const prepare = privateServerCliCommand({
      kind: "prepare-fixture-pause",
      scenarioId: "hostile-reset-v1",
    });
    expect(prepare).toBe(
      'storage.env.set("myrmexFixture:hostile-reset-v1:quiescent-main",null).then(()=>storage.env.set("myrmexFixture:hostile-reset-v1:pause-request",null)).then(()=>storage.env.get("myrmexFixture:hostile-reset-v1:quiescent-main").then(value=>[value]).then(values=>storage.env.get("myrmexFixture:hostile-reset-v1:pause-request").then(value=>values.concat([value])))).then(values=>JSON.stringify({prepared:values.every(value=>value==null)}))',
    );
    expect(prepare).not.toContain("storage.env.del");
    const request = privateServerCliCommand({
      kind: "request-fixture-pause",
      scenarioId: "hostile-reset-v1",
      sequence: 16,
    });
    expect(request).toBe(
      'storage.env.get(storage.env.keys.MAIN_LOOP_PAUSED).then(paused=>{if(+paused!==1)throw new Error(\'simulation is not paused\');return storage.env.set("myrmexFixture:hostile-reset-v1:pause-request","{\\"scenarioId\\":\\"hostile-reset-v1\\",\\"sequence\\":16}")}).then(()=>storage.env.get("myrmexFixture:hostile-reset-v1:pause-request")).then(value=>JSON.stringify({paused:value==="{\\"scenarioId\\":\\"hostile-reset-v1\\",\\"sequence\\":16}"}))',
    );
    expect(() =>
      privateServerCliCommand({
        kind: "request-fixture-pause",
        scenarioId: "hostile-reset-v1",
        sequence: 1,
      }),
    ).not.toThrow();
    for (const sequence of [0, 17, 1.5]) {
      expect(() =>
        privateServerCliCommand({
          kind: "request-fixture-pause",
          scenarioId: "hostile-reset-v1",
          sequence,
        }),
      ).toThrow("bounded");
    }
    expect(() =>
      privateServerCliCommand({
        kind: "request-fixture-pause",
        scenarioId: "../escape",
        sequence: 1,
      }),
    ).toThrow("invalid");
  });

  it("uses loopback, bounds the transcript, and returns only opaque result metadata", async () => {
    const server = createServer((socket) => {
      socket.write("Screeps CLI greeting\r\n< \r\n");
      socket.once("data", () => socket.end("< OK\r\n"));
    });
    servers.push(server);
    const port = await listen(server);
    await expect(runPrivateServerCli({ kind: "resume" }, { port })).resolves.toMatchObject({
      bytes: 2,
      hash: expect.stringMatching(/^sha256:/),
    });
    await expect(
      runPrivateServerCli({ kind: "resume" }, { host: "localhost", port }),
    ).rejects.toThrow("loopback");
  });

  it("drains backend-style terminal responses before closing the CLI connection", async () => {
    const clientSockets = [];
    const peers = [];
    let commands = 0;
    const server = createServer((socket) => {
      let resolveClosed;
      const peer = {
        closed: new Promise((resolve) => {
          resolveClosed = resolve;
        }),
        ended: false,
        errors: [],
      };
      peers.push(peer);
      const lines = createInterface({ input: socket, output: socket });
      lines.once("error", (error) => peer.errors.push(error.code ?? "readline-error"));
      socket.once("error", (error) => peer.errors.push(error.code ?? "socket-error"));
      socket.once("end", () => {
        peer.ended = true;
      });
      socket.once("close", resolveClosed);
      socket.write("Screeps CLI greeting\r\n< \r\n");
      lines.once("line", () => {
        commands += 1;
        socket.write(
          commands === 1
            ? `< ${"x".repeat(PRIVATE_SERVER_CLI_LIMITS.responseBytes * 16)}\r\n`
            : "< OK\r\n",
        );
      });
    });
    servers.push(server);
    const port = await listen(server);
    const connect = (options) => {
      const socket = createConnection(options);
      clientSockets.push(socket);
      return socket;
    };

    await expect(runPrivateServerCli({ kind: "resume" }, { connect, port })).rejects.toThrow(
      "byte limit",
    );
    await expect(runPrivateServerCli({ kind: "resume" }, { connect, port })).resolves.toMatchObject(
      { bytes: 2 },
    );
    await Promise.all(peers.map(({ closed }) => closed));

    expect(peers.map(({ ended, errors }) => ({ ended, errors }))).toEqual([
      { ended: true, errors: [] },
      { ended: true, errors: [] },
    ]);
    expect(
      clientSockets.map(({ destroyed, readableLength }) => ({ destroyed, readableLength })),
    ).toEqual([
      { destroyed: true, readableLength: 0 },
      { destroyed: true, readableLength: 0 },
    ]);
  });

  it("bounds a stalled graceful response-limit close without losing its first failure", async () => {
    const socket = new EventEmitter();
    socket.destroy = vi.fn();
    socket.end = vi.fn();
    socket.resume = vi.fn();
    socket.setEncoding = vi.fn();
    socket.write = vi.fn(() => {
      queueMicrotask(() =>
        socket.emit("data", "x".repeat(PRIVATE_SERVER_CLI_LIMITS.responseBytes + 1)),
      );
    });
    const connect = () => {
      queueMicrotask(() => {
        socket.emit("connect");
        socket.emit("data", "< \r\n");
      });
      return socket;
    };

    await expect(
      runPrivateServerCli({ kind: "resume" }, { connect, port: 21026, timeoutMs: 5 }),
    ).rejects.toThrow("response exceeds the byte limit");
    expect(socket.resume).toHaveBeenCalledOnce();
    expect(socket.end).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("returns only validated transient bootstrap and aggregate sample receipts", async () => {
    const responses = [
      `'${JSON.stringify({ room: "W1N1", spawnX: 20, spawnY: 21, userId: "controlled-user" })}'`,
      `'${JSON.stringify({ hostileCreeps: 1, ownedCreeps: 2, ownedSpawns: 1, tick: 42 })}'`,
      `'${JSON.stringify({ hostileX: 23, hostileY: 24, room: "W1N1", targetX: 20, targetY: 21, userId: "controlled-user" })}'`,
      `'${JSON.stringify({ botException: "injected", processor: "ready", runner: "ready" })}'`,
      `'${JSON.stringify({ prepared: true })}'`,
      "'OK'",
      `'${JSON.stringify({ paused: true })}'`,
      `'${JSON.stringify({ quiescent: "ready" })}'`,
      `'${JSON.stringify({ cleared: true })}'`,
    ];
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.on("data", () => socket.write(`< ${responses.shift()}\r\n`));
    });
    servers.push(server);
    const port = await listen(server);
    await expect(bootstrapPrivateServerBot({ port })).resolves.toMatchObject({
      room: "W1N1",
      spawnX: 20,
      userId: "controlled-user",
      transcript: { hash: expect.stringMatching(/^sha256:/) },
    });
    await expect(samplePrivateServerBot({ port })).resolves.toMatchObject({
      hostileCreeps: 1,
      ownedCreeps: 2,
      ownedSpawns: 1,
      tick: 42,
    });
    await expect(preparePrivateServerFixtureTarget({ port })).resolves.toMatchObject({
      hostileX: 23,
      targetX: 20,
      userId: "controlled-user",
    });
    await expect(samplePrivateServerFixture("hostile-reset-v1", { port })).resolves.toMatchObject({
      botException: "injected",
      processor: "ready",
      runner: "ready",
    });
    await expect(pausePrivateServerFixture("hostile-reset-v1", 2, { port })).resolves.toMatchObject(
      { paused: true },
    );
    await expect(
      samplePrivateServerFixtureQuiescence("hostile-reset-v1", 2, { port }),
    ).resolves.toMatchObject({ quiescent: "ready" });
    await expect(clearPrivateServerFixture("hostile-reset-v1", { port })).resolves.toMatchObject({
      cleared: true,
    });
  });

  it("classifies each independently acknowledged fixture pause boundary", async () => {
    const cases = [
      {
        code: "cli-pause-fixture-clear-operation-rejected",
        responses: ["Error: rejected"],
      },
      {
        code: "cli-pause-fixture-clear-unacknowledged",
        responses: [`'${JSON.stringify({ prepared: false })}'`],
      },
      {
        code: "cli-pause-failed",
        responses: [`'${JSON.stringify({ prepared: true })}'`, "Error: rejected"],
      },
      {
        code: "cli-pause-fixture-request-failed",
        responses: [`'${JSON.stringify({ prepared: true })}'`, "'OK'", "Error: rejected"],
      },
      {
        code: "cli-pause-fixture-request-failed",
        responses: [
          `'${JSON.stringify({ prepared: true })}'`,
          "'OK'",
          `'${JSON.stringify({ paused: false })}'`,
        ],
      },
    ];
    for (const { code, responses } of cases) {
      const expectedConnections = responses.length;
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.write("< \r\n");
        socket.once("data", () => socket.end(`< ${responses.shift()}\r\n`));
      });
      servers.push(server);
      const port = await listen(server);
      await expect(pausePrivateServerFixture("hostile-reset-v1", 2, { port })).rejects.toThrow(
        code,
      );
      expect(connections).toBe(expectedConnections);
      expect(responses).toEqual([]);
    }
  });

  it("classifies quiescence transport, operation, and receipt failures separately", async () => {
    const cases = [
      {
        code: "cli-sample-fixture-quiescence-operation-rejected",
        response: "Error: rejected",
      },
      {
        code: "cli-sample-fixture-quiescence-receipt-invalid",
        response: `'${JSON.stringify({ quiescent: "invalid" })}'`,
      },
    ];
    for (const { code, response } of cases) {
      const server = createServer((socket) => {
        socket.write("< \r\n");
        socket.once("data", () => socket.end(`< ${response}\r\n`));
      });
      servers.push(server);
      const port = await listen(server);
      await expect(
        samplePrivateServerFixtureQuiescence("hostile-reset-v1", 2, { port }),
      ).rejects.toThrow(code);
    }

    const unavailable = createServer();
    const port = await listen(unavailable);
    await new Promise((resolve) => unavailable.close(resolve));
    await expect(
      samplePrivateServerFixtureQuiescence("hostile-reset-v1", 2, { port }),
    ).rejects.toThrow("cli-sample-fixture-quiescence-connection-failed");
  });

  it("validates the complete pause request before opening a CLI connection", async () => {
    let connections = 0;
    await expect(
      pausePrivateServerFixture("hostile-reset-v1", 0, {
        connect() {
          connections += 1;
          throw new Error("unexpected connection");
        },
      }),
    ).rejects.toThrow("bounded");
    expect(connections).toBe(0);
  });

  it("serializes fixture env mutations across pause preparation and cleanup", async () => {
    const values = new Map([
      ["mainLoopPaused", "0"],
      ["myrmexFixture:hostile-reset-v1:quiescent-main", "old"],
      ["myrmexFixture:hostile-reset-v1:pause-request", "old"],
      ["myrmexFixture:hostile-reset-v1:ready-processor", "old"],
      ["myrmexFixture:hostile-reset-v1:ready-runner", ""],
      ["myrmexFixture:hostile-reset-v1:hostile", 0],
      ["myrmexFixture:hostile-reset-v1:reset", "old"],
      ["myrmexFixture:hostile-reset-v1:bot-exception", "old"],
    ]);
    let mutationActive = false;
    const mutate = async (operation) => {
      if (mutationActive) throw new Error("overlapping env mutation");
      mutationActive = true;
      await Promise.resolve();
      operation();
      mutationActive = false;
    };
    const storage = {
      env: {
        keys: { MAIN_LOOP_PAUSED: "mainLoopPaused" },
        async get(key) {
          return values.get(key) ?? null;
        },
        async set(key, value) {
          await mutate(() => values.set(key, value));
          return JSON.parse(JSON.stringify({ result: value })).result;
        },
      },
    };
    const system = {
      pauseSimulation() {
        return storage.env.set(storage.env.keys.MAIN_LOOP_PAUSED, "1").then(() => "OK");
      },
    };
    const context = { Error, JSON, Promise, storage, system };

    await expect(
      runInNewContext(
        privateServerCliCommand({
          kind: "prepare-fixture-pause",
          scenarioId: "hostile-reset-v1",
        }),
        context,
      ),
    ).resolves.toBe(JSON.stringify({ prepared: true }));
    await runInNewContext(privateServerCliCommand({ kind: "pause" }), context);
    await expect(
      runInNewContext(
        privateServerCliCommand({
          kind: "request-fixture-pause",
          scenarioId: "hostile-reset-v1",
          sequence: 2,
        }),
        context,
      ),
    ).resolves.toBe(JSON.stringify({ paused: true }));
    await expect(
      runInNewContext(
        privateServerCliCommand({ kind: "clear-fixture", scenarioId: "hostile-reset-v1" }),
        context,
      ),
    ).resolves.toBe(JSON.stringify({ cleared: true }));
    for (const key of [
      "myrmexFixture:hostile-reset-v1:ready-processor",
      "myrmexFixture:hostile-reset-v1:ready-runner",
      "myrmexFixture:hostile-reset-v1:hostile",
      "myrmexFixture:hostile-reset-v1:reset",
      "myrmexFixture:hostile-reset-v1:bot-exception",
      "myrmexFixture:hostile-reset-v1:pause-request",
      "myrmexFixture:hostile-reset-v1:quiescent-main",
    ]) {
      expect(values.has(key)).toBe(true);
      expect(values.get(key)).toBeNull();
    }
  });

  it("rejects extra operation fields and terminal CLI errors", async () => {
    expect(() => privateServerCliCommand({ kind: "pause", extra: true })).toThrow("unknown");
    expect(() =>
      privateServerCliCommand({ kind: "sample-fixture", scenarioId: "../escape" }),
    ).toThrow("invalid");
    const clearCommand = privateServerCliCommand({
      kind: "clear-fixture",
      scenarioId: "hostile-reset-v1",
    });
    expect(clearCommand).toContain("myrmexFixture:hostile-reset-v1:ready-processor");
    expect(clearCommand).toContain("myrmexFixture:hostile-reset-v1:ready-runner");
    expect(clearCommand).toContain("myrmexFixture:hostile-reset-v1:bot-exception");
    expect(clearCommand).toContain("myrmexFixture:hostile-reset-v1:pause-request");
    expect(clearCommand).toContain("myrmexFixture:hostile-reset-v1:quiescent-main");
    expect(clearCommand).not.toContain("storage.env.del");
    expect(clearCommand).toContain(
      'storage.env.set("myrmexFixture:hostile-reset-v1:ready-processor",null)',
    );
    expect(clearCommand.indexOf("ready-processor")).toBeLessThan(
      clearCommand.indexOf("ready-runner"),
    );
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () => socket.end("< Error: rejected\r\n"));
    });
    servers.push(server);
    const port = await listen(server);
    await expect(runPrivateServerCli({ kind: "pause" }, { port })).rejects.toThrow("failed");
  });

  it("rejects an oversized CLI transcript and fingerprints a bounded exact bundle", async () => {
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () =>
        socket.write("x".repeat(PRIVATE_SERVER_CLI_LIMITS.responseBytes + 1)),
      );
    });
    servers.push(server);
    const port = await listen(server);
    await expect(runPrivateServerCli({ kind: "reset" }, { port })).rejects.toThrow("byte limit");
    const directory = await mkdtemp(join(tmpdir(), "myrmex-private-server-"));
    const bundlePath = join(directory, "main.js");
    await writeFile(bundlePath, "module.exports.loop=()=>undefined;", "utf8");
    await expect(privateServerBundleIdentity(bundlePath)).resolves.toEqual({
      bytes: 34,
      sha256: expect.stringMatching(/^sha256:/),
    });
  });

  it("accepts the backend's prefixed deployment acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myrmex-private-server-"));
    const bundlePath = join(directory, "main.js");
    await writeFile(bundlePath, "module.exports.loop=()=>undefined;", "utf8");
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () => socket.end("< '{\"deployed\":true}'\r\n"));
    });
    servers.push(server);
    const port = await listen(server);
    await expect(deployPrivateServerBundle(bundlePath, { port })).resolves.toMatchObject({
      hash: expect.stringMatching(/^sha256:/),
    });
  });
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
