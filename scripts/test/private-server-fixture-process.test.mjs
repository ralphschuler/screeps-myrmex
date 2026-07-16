import { fork } from "node:child_process";
import { access, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPrivateServerFixtureState,
  preparePrivateServerFixtureModuleState,
  writePrivateServerFixtureDefinition,
} from "../lib/private-server-fixture-state.mjs";

const helper = fileURLToPath(
  new URL("./helpers/private-server-fixture-process.cjs", import.meta.url),
);
const children = [];
const definition = {
  botExceptionAtTick: null,
  heapResetAtTick: 9,
  hostile: { atTick: 7, body: "smallMelee", x: 25, y: 25 },
  scenarioId: "hostile-reset-v1",
  schemaVersion: 1,
  target: { room: "W1N1", targetX: 20, targetY: 20, userId: "controlled-user" },
};

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stop(child)));
});

describe("private-server fixture process acknowledgement", () => {
  it("acknowledges processor and runner from init after post-bootstrap publication", async () => {
    const state = await fixtureState();
    const processor = start("processor", state.definitionPath, definition.scenarioId);
    const runner = start("runner", state.definitionPath, definition.scenarioId);

    const initialized = await Promise.all([
      processor.waitFor(({ type }) => type === "initialized"),
      runner.waitFor(({ type }) => type === "initialized"),
    ]);
    expect(initialized.map(({ processType }) => processType).sort()).toEqual([
      "processor",
      "runner",
    ]);
    expect(processor.child.pid).not.toBe(runner.child.pid);

    await writePrivateServerFixtureDefinition({
      checkout: state.checkout,
      definition,
      stateDirectory: state.stateDirectory,
    });

    const receipts = await Promise.all([
      processor.waitFor(({ type }) => type === "receipt"),
      runner.waitFor(({ type }) => type === "receipt"),
    ]);
    expect(receipts.map(({ key }) => key).sort()).toEqual([
      "myrmexFixture:hostile-reset-v1:ready-processor",
      "myrmexFixture:hostile-reset-v1:ready-runner",
    ]);
    expect(receipts.map(({ value }) => JSON.parse(value))).toEqual([
      { phase: "ready", scenarioId: "hostile-reset-v1" },
      { phase: "ready", scenarioId: "hostile-reset-v1" },
    ]);

    await clearPrivateServerFixtureState({
      checkout: state.checkout,
      stateDirectory: state.stateDirectory,
    });
    await expect(
      access(join(state.checkout, state.stateDirectory, "fixtures")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await delay(100);
    expect(
      [...processor.messages, ...runner.messages].filter(({ type }) => type === "receipt"),
    ).toHaveLength(2);
  });

  it("latches malformed publication as terminal rejection in both processes", async () => {
    const state = await fixtureState();
    const processor = start("processor", state.definitionPath, definition.scenarioId);
    const runner = start("runner", state.definitionPath, definition.scenarioId);
    await Promise.all([
      processor.waitFor(({ type }) => type === "initialized"),
      runner.waitFor(({ type }) => type === "initialized"),
    ]);

    await publishRaw(state.definitionPath, "{");
    const receipts = await Promise.all([
      processor.waitFor(({ type }) => type === "receipt"),
      runner.waitFor(({ type }) => type === "receipt"),
    ]);
    expect(receipts.map(({ value }) => JSON.parse(value).phase)).toEqual(["rejected", "rejected"]);

    await publishRaw(state.definitionPath, JSON.stringify(definition));
    await delay(150);
    expect(
      [...processor.messages, ...runner.messages]
        .filter(({ type }) => type === "receipt")
        .map(({ value }) => JSON.parse(value).phase),
    ).toEqual(["rejected", "rejected"]);
  });
});

async function fixtureState() {
  const checkout = await mkdtemp(join(tmpdir(), "myrmex-fixture-process-"));
  const stateDirectory = ".private-state";
  const paths = await preparePrivateServerFixtureModuleState({ checkout, stateDirectory });
  return {
    checkout,
    definitionPath: join(checkout, paths.definition),
    stateDirectory,
  };
}

function start(processType, definitionPath, scenarioId) {
  const child = fork(helper, [], {
    env: {
      ...process.env,
      MYRMEX_PRIVATE_SERVER_FIXTURE: definitionPath,
      MYRMEX_PRIVATE_SERVER_FIXTURE_ID: scenarioId,
      MYRMEX_TEST_PROCESS_TYPE: processType,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const messages = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("message", (message) => {
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.once("exit", (code) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Fixture child exited with ${code}: ${stderr}`));
    }
    waiters.clear();
  });
  return {
    child,
    messages,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, reject, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${processType} fixture acknowledgement.`));
        }, 5_000);
        waiters.add(waiter);
      });
    },
  };
}

async function publishRaw(definitionPath, contents) {
  const pending = `${definitionPath}.test-pending`;
  await writeFile(pending, contents, "utf8");
  await rename(pending, definitionPath);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
