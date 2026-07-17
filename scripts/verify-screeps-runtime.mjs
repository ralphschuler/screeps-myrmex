import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const HASH_PATTERN = /^fnv1a32-utf16:[0-9a-f]{8}$/;

export function decodeMemoryData(data) {
  if (typeof data !== "string") throw new Error("Screeps Memory response data is not a string");
  const serialized = data.startsWith("gz:")
    ? gunzipSync(Buffer.from(data.slice(3), "base64")).toString("utf8")
    : data;
  return JSON.parse(serialized);
}

export function telemetrySample(owner) {
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
    throw new Error("telemetry owner is unavailable");
  }
  const last = owner.last;
  if (
    !Number.isSafeInteger(owner.schemaVersion) ||
    owner.schemaVersion < 1 ||
    typeof last !== "object" ||
    last === null ||
    Array.isArray(last) ||
    !Number.isSafeInteger(last.tick) ||
    last.tick < 0 ||
    typeof last.hash !== "string" ||
    !HASH_PATTERN.test(last.hash)
  ) {
    throw new Error("telemetry owner has no valid latest receipt");
  }
  return Object.freeze({ tick: last.tick, hash: last.hash });
}

export async function readTelemetrySample({
  apiBaseUrl,
  fetchImpl = fetch,
  memoryPath,
  shard,
  token,
}) {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, "")}/user/memory`);
  url.searchParams.set("path", memoryPath);
  url.searchParams.set("shard", shard);
  const response = await fetchImpl(url, {
    headers: { "X-Token": token },
  });
  if (!response.ok) throw new Error(`Screeps Memory request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.ok !== 1) throw new Error("Screeps Memory request was rejected");
  return telemetrySample(decodeMemoryData(payload.data));
}

export async function verifyTelemetryAdvances({
  now = Date.now,
  pollIntervalMs,
  readSample,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs,
}) {
  const first = await readSample();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const second = await readSample();
    if (second.tick < first.tick) {
      throw new Error(`live telemetry tick regressed from ${first.tick} to ${second.tick}`);
    }
    if (second.tick > first.tick) {
      return Object.freeze({ first, second, tickDelta: second.tick - first.tick });
    }
  }
  throw new Error(`live telemetry did not advance beyond tick ${first.tick} before timeout`);
}

async function main() {
  const apiBaseUrl = process.env.SCREEPS_API_BASE_URL ?? "https://screeps.com/api";
  const memoryPath = process.env.SCREEPS_TELEMETRY_PATH ?? "myrmex.telemetry";
  const shard = process.env.SCREEPS_SHARD ?? "shard2";
  const token = process.env.SCREEPS_TOKEN;
  if (token === undefined || token.length === 0) throw new Error("SCREEPS_TOKEN is required");
  const pollIntervalMs = Number(process.env.SCREEPS_RUNTIME_POLL_INTERVAL_MS ?? "10000");
  const timeoutMs = Number(process.env.SCREEPS_RUNTIME_TIMEOUT_MS ?? "120000");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("SCREEPS_RUNTIME_POLL_INTERVAL_MS must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < pollIntervalMs) {
    throw new Error(
      "SCREEPS_RUNTIME_TIMEOUT_MS must be an integer at least as large as the poll interval",
    );
  }
  const receipt = await verifyTelemetryAdvances({
    pollIntervalMs,
    timeoutMs,
    readSample: () => readTelemetrySample({ apiBaseUrl, memoryPath, shard, token }),
  });
  process.stdout.write(
    `${JSON.stringify({
      kind: "screeps-live-telemetry-advancement",
      memoryPath,
      shard,
      ...receipt,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
