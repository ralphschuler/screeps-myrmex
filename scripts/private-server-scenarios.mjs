import { spawn } from "node:child_process";
import { cwd } from "node:process";
import {
  clearPrivateServerFixture,
  deployPrivateServerBundle,
  isTransientPrivateServerSampleError,
  pausePrivateServerFixture,
  preparePrivateServerFixtureTarget,
  privateServerBundleIdentity,
  runPrivateServerCli,
  samplePrivateServerBot,
  samplePrivateServerFixture,
  samplePrivateServerFixtureQuiescence,
} from "./lib/private-server-cli.mjs";
import { waitForPrivateServerSample } from "./lib/private-server-sample-polling.mjs";
import {
  clearPrivateServerFixtureState,
  writePrivateServerFixtureDefinition,
} from "./lib/private-server-fixture-state.mjs";
import {
  clearPrivateServerScenarioFixture,
  privateServerScenarioMatrix,
  runPrivateServerScenario,
} from "./lib/private-server-scenario-runner.mjs";

const checkout = cwd();
const bundlePath = `${checkout}/dist/main.js`;
const stateDirectory = ".myrmex-private-server";
const identity = await privateServerBundleIdentity(bundlePath);
const buildId = `bundle-${identity.sha256.slice("sha256:".length, "sha256:".length + 24)}`;
const matrix = privateServerScenarioMatrix({ buildId });
const selected = selectScenario(process.argv.slice(2), matrix);
const results = [];

for (const manifest of selected) {
  const result = await runPrivateServerScenario({
    driver: scenarioDriver({ bundlePath, checkout, stateDirectory }),
    manifest,
  });
  results.push({
    artifactHash: result.evidence.artifactHash,
    buildId,
    failure: result.evidence.failure,
    failureCode: result.failureCode,
    id: manifest.id,
  });
  process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
  if (!result.ok) process.exitCode = 1;
}

function scenarioDriver(options) {
  let fixtureTarget = null;
  let pauseSequence = 0;
  let started = false;
  let startupCleanupFailure = null;
  return {
    async start(manifest) {
      try {
        await lifecycle("start", options.stateDirectory, manifest.id);
      } catch (error) {
        if (error instanceof Error && error.name === "CleanupFailure") {
          startupCleanupFailure = error;
        }
        throw error;
      }
      started = true;
    },
    async pause(manifest) {
      pauseSequence += 1;
      await pauseFixtureBoundary(manifest.id, pauseSequence);
    },
    async reset() {
      await cliOperation("reset");
    },
    async bootstrap() {
      await cliOperation("bootstrap-controlled-bot");
    },
    async deploy() {
      try {
        await deployPrivateServerBundle(options.bundlePath);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        throw namedError(
          "BundleDeploymentFailure",
          ["bundle-deployment-command-failed", "bundle-deployment-unacknowledged"].includes(code)
            ? code
            : "bundle-deployment-failed",
        );
      }
    },
    async resume() {
      await cliOperation("resume");
    },
    async prepareFixture() {
      fixtureTarget = await waitForFixtureTarget();
      return fixtureTarget;
    },
    async configureFixture(manifest, target) {
      await clearFixtureReceipts(manifest.id);
      await writePrivateServerFixtureDefinition({
        checkout: options.checkout,
        definition: fixtureDefinition(manifest, target),
        stateDirectory: options.stateDirectory,
      });
    },
    async awaitFixtureReady(manifest) {
      await waitForFixtureReady(manifest.id);
    },
    async observe(manifest) {
      if (manifest.injection === "bot-exception") {
        await waitForBotException(manifest.id);
        throw namedError("BotExceptionError", "Fixture injected the bounded bot exception.");
      }
      const sample = await waitForTerminalSample(manifest);
      return {
        failure: null,
        logs: [],
        metrics: {
          "hostile-creeps": sample.hostileCreeps,
          "owned-creeps": sample.ownedCreeps,
          "owned-spawns": sample.ownedSpawns,
        },
        outcomes: [{ tick: sample.tick }],
        state: [{ hostileCreeps: sample.hostileCreeps, ownedCreeps: sample.ownedCreeps }],
      };
    },
    async clearFixture(manifest) {
      try {
        await clearPrivateServerScenarioFixture({
          active: started,
          async clearReceipts() {
            await clearFixtureReceipts(manifest.id);
          },
          async pause() {
            pauseSequence += 1;
            await pauseFixtureBoundary(manifest.id, pauseSequence);
          },
          async removePublication() {
            await clearPrivateServerFixtureState({
              checkout: options.checkout,
              stateDirectory: options.stateDirectory,
            });
          },
        });
      } finally {
        fixtureTarget = null;
      }
    },
    async stop() {
      if (startupCleanupFailure !== null) {
        const failure = startupCleanupFailure;
        startupCleanupFailure = null;
        throw failure;
      }
      if (!started) return;
      await lifecycle("stop", options.stateDirectory);
      started = false;
    },
  };
}

async function clearFixtureReceipts(scenarioId) {
  try {
    await clearPrivateServerFixture(scenarioId);
  } catch {
    throw namedError("CliOperationFailure", "cli-clear-fixture-failed");
  }
}

async function pauseFixtureBoundary(scenarioId, sequence) {
  try {
    await pausePrivateServerFixture(scenarioId, sequence);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw namedError(
      "CliOperationFailure",
      [
        "cli-pause-failed",
        "cli-pause-fixture-clear-failed",
        "cli-pause-fixture-request-failed",
      ].includes(code)
        ? code
        : "cli-pause-fixture-failed",
    );
  }
  await waitForFixtureQuiescence(scenarioId, sequence);
}

async function cliOperation(kind) {
  try {
    await runPrivateServerCli({ kind });
  } catch {
    throw namedError("CliOperationFailure", `cli-${kind}-failed`);
  }
}

async function waitForFixtureTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return await preparePrivateServerFixtureTarget();
    } catch {
      await delay(250);
    }
  }
  throw namedError("ScenarioTimeoutError", "Timed out waiting for the controlled worker.");
}

async function waitForTerminalSample(manifest) {
  const result = await waitForPrivateServerSample({
    delay,
    isTransientError: isTransientPrivateServerSampleError,
    sample: samplePrivateServerBot,
    tickDeadline: manifest.tickDeadline,
  });
  if (result.kind === "sample") return result.result;
  if (result.kind === "not-ready") {
    throw namedError("CliOperationFailure", "cli-sample-controlled-not-ready");
  }
  throw namedError("ScenarioTimeoutError", "Timed out waiting for the scenario tick deadline.");
}

function fixtureDefinition(manifest, target) {
  return {
    heapResetAtTick: manifest.injection === "heap-reset" ? manifest.tickDeadline - 2 : null,
    botExceptionAtTick: manifest.injection === "bot-exception" ? manifest.tickDeadline - 2 : null,
    hostile: {
      atTick: manifest.injection === "hostile-pressure" ? manifest.tickDeadline - 2 : 10_000,
      body: "smallMelee",
      x: target.hostileX,
      y: target.hostileY,
    },
    scenarioId: manifest.id,
    schemaVersion: 1,
    target: {
      room: target.room,
      targetX: target.targetX,
      targetY: target.targetY,
      userId: target.userId,
    },
  };
}

async function waitForBotException(scenarioId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let sample;
    try {
      sample = await samplePrivateServerFixture(scenarioId);
    } catch {
      throw namedError("CliOperationFailure", "cli-sample-fixture-failed");
    }
    if (sample.botException === "injected") return;
    await delay(250);
  }
  throw namedError("ScenarioTimeoutError", "Timed out waiting for the fixture bot exception.");
}

async function waitForFixtureReady(scenarioId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let sample;
    try {
      sample = await samplePrivateServerFixture(scenarioId);
    } catch {
      throw namedError("CliOperationFailure", "cli-sample-fixture-failed");
    }
    if (sample.processor === "rejected" || sample.runner === "rejected") {
      throw namedError("StartupFailure", "fixture-definition-rejected");
    }
    if (sample.processor === "ready" && sample.runner === "ready") return;
    await delay(250);
  }
  throw namedError("StartupFailure", "fixture-ready-timeout");
}

async function waitForFixtureQuiescence(scenarioId, sequence) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let sample;
    try {
      sample = await samplePrivateServerFixtureQuiescence(scenarioId, sequence);
    } catch {
      throw namedError("CliOperationFailure", "cli-sample-fixture-quiescence-failed");
    }
    if (sample.quiescent === "rejected") {
      throw namedError("StartupFailure", "fixture-quiescence-rejected");
    }
    if (sample.quiescent === "ready") return;
    await delay(250);
  }
  throw namedError("StartupFailure", "fixture-quiescence-timeout");
}

async function lifecycle(command, state, fixtureScenarioId = null) {
  const args = ["scripts/private-server.mjs", command, "--state-directory", state];
  if (fixtureScenarioId !== null) args.push("--fixture-scenario", fixtureScenarioId);
  const record = await execute(process.execPath, args);
  if (!new Set(["started", "stopped"]).has(record.kind)) {
    throw namedError(
      record.kind === "cleanup-failed" ? "CleanupFailure" : "StartupFailure",
      safeLifecycleReason(record),
    );
  }
}

function execute(command, args) {
  return new Promise((resolveResult, rejectResult) => {
    let output = "";
    const child = spawn(command, args, { cwd: checkout, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.once("error", rejectResult);
    child.once("exit", () => {
      try {
        const record = JSON.parse(output.trim());
        if (typeof record !== "object" || record === null || Array.isArray(record))
          throw new Error();
        resolveResult(record);
      } catch {
        rejectResult(namedError("StartupFailure", "launcher-exited"));
      }
    });
  });
}

function safeLifecycleReason(record) {
  if (typeof record.reason !== "string") return "health-timeout";
  return [
    "asset-directory-unavailable",
    "cli-closed",
    "cli-connection-failed",
    "cli-port-unavailable",
    "cli-timeout",
    "configuration-file-unavailable",
    "existing-process-unverified",
    "health-timeout",
    "fixture-definition-rejected",
    "fixture-module-state-invalid",
    "fixture-ready-timeout",
    "fixture-quiescence-rejected",
    "fixture-quiescence-timeout",
    "game-port-unavailable",
    "launcher-exited",
    "port-unavailable",
    "readiness-receipt-invalid",
    "required-launch-option-missing",
    "shutdown-timeout",
    "steam-authentication",
    "storage-not-ready",
    "storage-readiness-rejected",
    "unsupported-node-runtime",
  ].includes(record.reason)
    ? record.reason
    : "launcher-exited";
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function selectScenario(argv, matrix) {
  if (argv.length === 0) return matrix;
  if (argv.length !== 2 || argv[0] !== "--scenario")
    throw new Error("Use --scenario <scenario-id>.");
  const selected = matrix.find(({ id }) => id === argv[1]);
  if (!selected) throw new Error("Unknown private-server scenario.");
  return [selected];
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
