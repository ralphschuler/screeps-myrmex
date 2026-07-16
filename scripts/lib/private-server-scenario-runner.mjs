import {
  createPrivateServerEvidence,
  definePrivateServerManifest,
} from "./private-server-evidence.mjs";

export const PRIVATE_SERVER_SCENARIOS = Object.freeze([
  {
    id: "cold-boot",
    injection: "none",
    tickDeadline: 80,
    assertions: [{ id: "owned-spawns", minimum: 1, maximum: 1 }],
  },
  {
    id: "zero-creep-recovery",
    injection: "none",
    tickDeadline: 160,
    assertions: [{ id: "owned-creeps", minimum: 1, maximum: 100_000 }],
  },
  {
    id: "hostile-pressure",
    injection: "hostile-pressure",
    tickDeadline: 160,
    assertions: [{ id: "hostile-creeps", minimum: 1, maximum: 100_000 }],
  },
  {
    id: "supported-reset",
    injection: "heap-reset",
    tickDeadline: 160,
    assertions: [{ id: "owned-spawns", minimum: 1, maximum: 1 }],
  },
  {
    id: "bot-exception",
    injection: "bot-exception",
    tickDeadline: 80,
    assertions: [],
  },
]);

/**
 * Runs one bounded scenario through a deliberately small driver interface. The driver owns all
 * process, CLI, and fixture I/O; this module owns the terminal evidence and failure contract.
 */
export async function runPrivateServerScenario({ driver, manifest }) {
  const normalizedManifest = definePrivateServerManifest(authoringManifest(manifest));
  let failure = null;
  let cleanup;
  let outcomes = [];
  let state = [];
  let logs = [];

  try {
    await driver.start(normalizedManifest);
    await driver.pause(normalizedManifest);
    await driver.reset(normalizedManifest);
    await driver.bootstrap(normalizedManifest);
    await driver.deploy(normalizedManifest);
    await driver.resume(normalizedManifest);
    const fixtureTarget = await driver.prepareFixture(normalizedManifest);
    await driver.pause(normalizedManifest);
    await driver.configureFixture(normalizedManifest, fixtureTarget);
    await driver.resume(normalizedManifest);
    const observed = await driver.observe(normalizedManifest);
    outcomes = boundedRecords(observed.outcomes, "outcomes");
    state = boundedRecords(observed.state, "state");
    logs = boundedLogs(observed.logs);
    failure = observed.failure === null ? null : { kind: observed.failure };
    if (failure === null && !assertionsHold(normalizedManifest, observed.metrics)) {
      failure = { kind: "assertion-failed" };
    }
  } catch (error) {
    failure ??= { kind: classifyScenarioError(error) };
    logs = [safeError(error)];
  } finally {
    try {
      await driver.clearFixture(normalizedManifest);
      await driver.stop(normalizedManifest);
      cleanup = "complete";
    } catch (error) {
      cleanup = "incomplete";
      failure = { kind: "cleanup-failed" };
      logs = [...logs, safeError(error)];
    }
  }

  const evidence = createPrivateServerEvidence({
    cleanup,
    failure,
    logs,
    manifest: authoringManifest(normalizedManifest),
    outcomes,
    state,
  });
  return Object.freeze({ evidence, ok: failure === null && cleanup === "complete" });
}

/** Constructs the fixed Phase 1 matrix with deterministic manifest values. */
export function privateServerScenarioMatrix({ buildId, seed = "phase1-v1" }) {
  return Object.freeze(
    PRIVATE_SERVER_SCENARIOS.map((scenario) =>
      definePrivateServerManifest({ ...scenario, buildId, seed }),
    ),
  );
}

function assertionsHold(manifest, metrics) {
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return false;
  return manifest.assertions.every(({ id, minimum, maximum }) => {
    const value = metrics[id];
    return Number.isFinite(value) && value >= minimum && value <= maximum;
  });
}

function boundedRecords(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError(`${label} are invalid.`);
  return value;
}

function boundedLogs(value) {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((line) => typeof line !== "string")
  ) {
    throw new TypeError("Scenario logs are invalid.");
  }
  return value;
}

function classifyScenarioError(error) {
  const kind = error instanceof Error ? error.name : "";
  if (kind === "ScenarioTimeoutError") return "scenario-timeout";
  if (kind === "BotExceptionError") return "bot-exception";
  return "startup-failed";
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function authoringManifest(manifest) {
  return {
    assertions: manifest.assertions,
    buildId: manifest.buildId,
    id: manifest.id,
    injection: manifest.injection,
    seed: manifest.seed,
    tickDeadline: manifest.tickDeadline,
  };
}
