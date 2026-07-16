import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_SERVER_CLI_LIMITS,
  bootstrapPrivateServerBot,
  privateServerDeploymentCommand,
  privateServerBundleIdentity,
  privateServerCliCommand,
  preparePrivateServerFixtureTarget,
  runPrivateServerCli,
  samplePrivateServerBot,
  samplePrivateServerFixture,
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
    expect(privateServerCliCommand({ kind: "set-tick-duration", milliseconds: 1 })).toBe(
      "system.setTickDuration(1)",
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

  it("uses loopback, bounds the transcript, and returns only opaque result metadata", async () => {
    const server = createServer((socket) => {
      socket.write("Screeps CLI greeting\r\n< \r\n");
      socket.once("data", () => socket.end("OK\r\n< \r\n"));
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

  it("returns only validated transient bootstrap and aggregate sample receipts", async () => {
    const responses = [
      `'${JSON.stringify({ room: "W1N1", spawnX: 20, spawnY: 21, userId: "controlled-user" })}'`,
      `'${JSON.stringify({ hostileCreeps: 1, ownedCreeps: 2, ownedSpawns: 1, tick: 42 })}'`,
      `'${JSON.stringify({ hostileX: 23, hostileY: 24, room: "W1N1", targetX: 20, targetY: 21, userId: "controlled-user" })}'`,
      `'${JSON.stringify({ botException: "injected" })}'`,
    ];
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.on("data", () => socket.write(`${responses.shift()}\r\n< \r\n`));
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
    });
  });

  it("rejects extra operation fields and terminal CLI errors", async () => {
    expect(() => privateServerCliCommand({ kind: "pause", extra: true })).toThrow("unknown");
    const server = createServer((socket) => {
      socket.write("< \r\n");
      socket.once("data", () => socket.end("Error: rejected\r\n< \r\n"));
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
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
