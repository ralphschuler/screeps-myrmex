import { createHash } from "node:crypto";

export const PRIVATE_SERVER_EVIDENCE_SCHEMA_VERSION = 1;
export const PRIVATE_SERVER_EVIDENCE_LIMITS = Object.freeze({
  maximumArtifactBytes: 65_536,
  maximumAssertions: 32,
  maximumLogBytes: 512,
  maximumLogs: 64,
  maximumTicks: 10_000,
});

const FAILURE_KINDS = new Set([
  "assertion-failed",
  "bot-exception",
  "cli-operation-failed",
  "cleanup-failed",
  "scenario-timeout",
  "startup-failed",
]);
const INJECTIONS = new Set(["bot-exception", "heap-reset", "hostile-pressure", "none", "timeout"]);

/** Validates the small, secret-free manifest used by every private-server scenario. */
export function definePrivateServerManifest(value) {
  const row = exactRecord(value, [
    "assertions",
    "buildId",
    "id",
    "injection",
    "seed",
    "tickDeadline",
  ]);
  if (!isSafeId(row.id) || !isSafeId(row.buildId) || !isSafeId(row.seed)) {
    throw new TypeError("Manifest id, buildId, and seed must be safe bounded identifiers.");
  }
  if (!INJECTIONS.has(row.injection)) throw new TypeError("Manifest injection is not supported.");
  if (
    !Number.isSafeInteger(row.tickDeadline) ||
    row.tickDeadline < 1 ||
    row.tickDeadline > PRIVATE_SERVER_EVIDENCE_LIMITS.maximumTicks
  ) {
    throw new RangeError("Manifest tickDeadline is outside the bounded private-server range.");
  }
  if (
    !Array.isArray(row.assertions) ||
    row.assertions.length > PRIVATE_SERVER_EVIDENCE_LIMITS.maximumAssertions
  ) {
    throw new RangeError("Manifest assertions exceed the bounded private-server limit.");
  }
  const assertions = row.assertions.map((assertion) => {
    const item = exactRecord(assertion, ["id", "maximum", "minimum"]);
    if (
      !isSafeId(item.id) ||
      !Number.isFinite(item.minimum) ||
      !Number.isFinite(item.maximum) ||
      item.minimum > item.maximum
    ) {
      throw new TypeError("Manifest assertion is invalid.");
    }
    return { id: item.id, minimum: item.minimum, maximum: item.maximum };
  });
  if (new Set(assertions.map(({ id }) => id)).size !== assertions.length) {
    throw new TypeError("Manifest assertion ids must be unique.");
  }
  return Object.freeze({
    schemaVersion: PRIVATE_SERVER_EVIDENCE_SCHEMA_VERSION,
    id: row.id,
    buildId: row.buildId,
    seed: row.seed,
    tickDeadline: row.tickDeadline,
    injection: row.injection,
    assertions: Object.freeze(assertions.sort((left, right) => left.id.localeCompare(right.id))),
  });
}

/** Produces a bounded canonical artifact without retaining raw game state, credentials, or logs. */
export function createPrivateServerEvidence(value) {
  const row = exactRecord(value, ["cleanup", "failure", "logs", "manifest", "outcomes", "state"]);
  const manifest = definePrivateServerManifest(row.manifest);
  const outcomes = summarizeRecords(row.outcomes, "outcomes");
  const state = summarizeRecords(row.state, "state");
  const logs = summarizeLogs(row.logs);
  const cleanup = row.cleanup === "complete" ? "complete" : "incomplete";
  const failure = row.failure === null ? null : safeFailure(row.failure);
  const artifact = {
    schemaVersion: PRIVATE_SERVER_EVIDENCE_SCHEMA_VERSION,
    manifest,
    cleanup,
    failure,
    outcomes,
    state,
    logs,
  };
  const serialized = canonicalSerialize(artifact);
  if (byteLength(serialized) > PRIVATE_SERVER_EVIDENCE_LIMITS.maximumArtifactBytes) {
    throw new RangeError("Private-server evidence exceeds the artifact byte cap.");
  }
  return Object.freeze({
    ...artifact,
    artifactHash: sha256(serialized),
    bytes: byteLength(serialized),
  });
}

function summarizeRecords(value, label) {
  if (!Array.isArray(value) || value.length > PRIVATE_SERVER_EVIDENCE_LIMITS.maximumAssertions) {
    throw new RangeError(`${label} exceed the bounded evidence limit.`);
  }
  return Object.freeze(
    value.map((entry) => ({ hash: sha256(canonicalSerialize(entry)) })).sort(compareHashes),
  );
}

function summarizeLogs(value) {
  if (!Array.isArray(value) || value.length > PRIVATE_SERVER_EVIDENCE_LIMITS.maximumLogs) {
    throw new RangeError("Logs exceed the bounded evidence limit.");
  }
  return Object.freeze(
    value
      .map((line) => ({ hash: sha256(sanitizeLog(line)), bytes: byteLength(sanitizeLog(line)) }))
      .sort(compareHashes),
  );
}

function safeFailure(value) {
  const row = exactRecord(value, ["kind"]);
  if (typeof row.kind !== "string" || !FAILURE_KINDS.has(row.kind)) {
    throw new TypeError("Evidence failure kind is not supported.");
  }
  return { kind: row.kind };
}

function sanitizeLog(value) {
  if (typeof value !== "string") throw new TypeError("Evidence logs must be strings.");
  const sanitized = value
    .replace(/(token|password|key|secret)=\S+/gi, "$1=[redacted]")
    .replace(/\b[WE][0-9]{1,3}[NS][0-9]{1,3}\b/gi, "[room]")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("");
  return truncateUtf8(sanitized, PRIVATE_SERVER_EVIDENCE_LIMITS.maximumLogBytes);
}

function exactRecord(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected a plain object.");
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys.slice().sort()[index])
  ) {
    throw new TypeError("Object contains missing or unknown evidence fields.");
  }
  return value;
}

function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function canonicalSerialize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new TypeError("Evidence contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Evidence contains an unsupported value.");
  const row = value;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(row[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maximumBytes) {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const code = value.codePointAt(end);
    if (code === undefined) break;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > maximumBytes) break;
    bytes += width;
    end += code > 0xffff ? 2 : 1;
  }
  return value.slice(0, end);
}

function compareHashes(left, right) {
  return left.hash.localeCompare(right.hash);
}
