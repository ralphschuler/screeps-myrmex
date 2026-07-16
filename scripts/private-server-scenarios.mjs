import { spawn } from "node:child_process";
import { cwd } from "node:process";
import {
  deployPrivateServerBundle,
  preparePrivateServerFixtureTarget,
  privateServerBundleIdentity,
  runPrivateServerCli,
  samplePrivateServerBot,
  samplePrivateServerFixture,
} from "./lib/private-server-cli.mjs";
import { preparePrivateServerFixtureState } from "./lib/private-server-fixture-state.mjs";
import {
  privateServerScenarioMatrix,
  runPrivateServerScenario,
} from "./lib/private-server-scenario-runner.mjs";

const checkout = cwd();
const bundlePath = `${checkout}/dist/main.js`;
const stateDirectory = ".myrmex-private-server/scenarios";
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
    failure: result.evidence.failure,
    id: manifest.id,
  });
  process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
  if (!result.ok) process.exitCode = 1;
}

function scenarioDriver(options) {
  let fixtureTarget = null;
  let fixtureState = null;
  return {
    async start() {
      await lifecycle("start", options.stateDirectory);
    },
    async pause() {
      await runPrivateServerCli({ kind: "pause" });
    },
    async reset() {
      await runPrivateServerCli({ kind: "reset" });
    },
    async bootstrap() {
      await runPrivateServerCli({ kind: "bootstrap-controlled-bot" });
    },
    async deploy() {
      await deployPrivateServerBundle(options.bundlePath);
    },
    async resume() {
      await runPrivateServerCli({ kind: "resume" });
    },
    async prepareFixture() {
      fixtureTarget = await waitForFixtureTarget();
      return fixtureTarget;
    },
    async configureFixture(manifest, target) {
      await lifecycle("stop", options.stateDirectory);
      fixtureState = await preparePrivateServerFixtureState({
        checkout: options.checkout,
        definition: fixtureDefinition(manifest, target),
        stateDirectory: options.stateDirectory,
      });
      await lifecycle("start", options.stateDirectory, fixtureState.definition);
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
    async clearFixture() {
      fixtureTarget = null;
      fixtureState = null;
    },
    async stop() {
      await lifecycle("stop", options.stateDirectory);
    },
  };
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
  const started = Date.now();
  let previousTick = -1;
  while (Date.now() - started < 30_000) {
    const sample = await samplePrivateServerBot();
    if (sample.tick > previousTick && sample.tick >= manifest.tickDeadline) return sample;
    previousTick = sample.tick;
    await delay(250);
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
    if ((await samplePrivateServerFixture(scenarioId)).botException === "injected") return;
    await delay(250);
  }
  throw namedError("ScenarioTimeoutError", "Timed out waiting for the fixture bot exception.");
}

async function lifecycle(command, state, fixtureDefinition = null) {
  const args = ["scripts/private-server.mjs", command, "--state-directory", state];
  if (fixtureDefinition !== null) args.push("--fixture-definition", fixtureDefinition);
  const output = await execute(process.execPath, args);
  const record = JSON.parse(output.trim());
  if (!new Set(["started", "already-running", "stopped"]).has(record.kind)) {
    throw new Error(`Private-server lifecycle ${command} did not complete.`);
  }
}

function execute(command, args) {
  return new Promise((resolveResult, rejectResult) => {
    let output = "";
    const child = spawn(command, args, { cwd: checkout, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.once("error", rejectResult);
    child.once("exit", (code) => {
      if (code === 0) resolveResult(output);
      else rejectResult(new Error("Private-server lifecycle command failed."));
    });
  });
}

function selectScenario(argv, matrix) {
  if (argv.length === 0) return matrix;
  if (argv.length !== 2 || argv[0] !== "--scenario")
    throw new Error("Use --scenario <scenario-id>.");
  const selected = matrix.find(({ id }) => id === argv[1]);
  if (!selected) throw new Error("Unknown private-server scenario.");
  return [selected];
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
