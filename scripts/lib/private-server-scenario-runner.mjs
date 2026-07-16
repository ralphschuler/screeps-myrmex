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

/** Establishes quiescence, removes fixture publication, then clears exact receipts in that order. */
export async function clearPrivateServerScenarioFixture({
  active,
  clearReceipts,
  pause,
  removePublication,
}) {
  let failure = null;
  if (active) {
    try {
      await pause();
    } catch (error) {
      failure = error;
    }
  }
  try {
    await removePublication();
  } catch (error) {
    failure ??= error;
  }
  if (active) {
    try {
      await clearReceipts();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/**
 * Runs one bounded scenario through a deliberately small driver interface. The driver owns all
 * process, CLI, and fixture I/O; this module owns the terminal evidence and failure contract.
 */
export async function runPrivateServerScenario({ driver, manifest }) {
  const normalizedManifest = definePrivateServerManifest(authoringManifest(manifest));
  let failure = null;
  let primaryFailureCode = null;
  let cleanupFailureCode = null;
  let cleanup;
  let outcomes = [];
  let state = [];
  let logs = [];

  try {
    await driver.start(normalizedManifest);
    await driver.pause(normalizedManifest);
    await driver.reset(normalizedManifest);
    await driver.pause(normalizedManifest);
    await driver.bootstrap(normalizedManifest);
    await driver.deploy(normalizedManifest);
    await driver.resume(normalizedManifest);
    const fixtureTarget = await driver.prepareFixture(normalizedManifest);
    await driver.pause(normalizedManifest);
    await driver.configureFixture(normalizedManifest, fixtureTarget);
    await driver.awaitFixtureReady(normalizedManifest);
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
    primaryFailureCode = scenarioFailureCode(error);
    logs = [safeError(error)];
  } finally {
    const cleanupErrors = [];
    try {
      await driver.clearFixture(normalizedManifest);
    } catch (error) {
      cleanupErrors.push(error);
      cleanupFailureCode ??= scenarioFailureCode(error);
    }
    try {
      await driver.stop(normalizedManifest);
    } catch (error) {
      cleanupErrors.push(error);
      cleanupFailureCode ??= scenarioFailureCode(error);
    }
    if (cleanupErrors.length === 0) {
      cleanup = "complete";
    } else {
      cleanup = "incomplete";
      failure = { kind: "cleanup-failed" };
      logs = [...logs, ...cleanupErrors.map(safeError)];
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
  return Object.freeze({
    cleanupFailureCode,
    evidence,
    ok: failure === null && cleanup === "complete",
    primaryFailureCode,
  });
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
  if (kind === "BundleDeploymentFailure") return "bundle-deployment-failed";
  if (kind === "CliOperationFailure") return "cli-operation-failed";
  if (kind === "ScenarioTimeoutError") return "scenario-timeout";
  if (kind === "BotExceptionError") return "bot-exception";
  return "startup-failed";
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function scenarioFailureCode(error) {
  if (!(error instanceof Error)) return null;
  if (error.name === "BundleDeploymentFailure") {
    return ["bundle-deployment-command-failed", "bundle-deployment-unacknowledged"].includes(
      error.message,
    )
      ? error.message
      : null;
  }
  if (error.name === "CliOperationFailure") {
    return [
      "cli-bootstrap-controlled-bot-failed",
      "cli-clear-fixture-failed",
      "cli-pause-failed",
      "cli-pause-fixture-clear-command-failed",
      "cli-pause-fixture-clear-unacknowledged",
      "cli-pause-fixture-failed",
      "cli-pause-fixture-request-failed",
      "cli-reset-failed",
      "cli-resume-failed",
      "cli-sample-fixture-failed",
      "cli-sample-fixture-quiescence-failed",
      "cli-sample-controlled-not-ready",
    ].includes(error.message)
      ? error.message
      : null;
  }
  if (!new Set(["CleanupFailure", "StartupFailure"]).has(error.name)) return null;
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
  ].includes(error.message)
    ? error.message
    : null;
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
