import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

export const PRIVATE_SERVER_CLI_LIMITS = Object.freeze({
  commandBytes: 5 * 1024 * 1024,
  responseBytes: 16 * 1024,
  timeoutMs: 5_000,
});

const OPERATIONS = new Set(["pause", "reset", "resume", "sample", "set-tick-duration"]);
const CONTROLLED_USERNAME = "myrmex-integration";

/** Maps a closed operation vocabulary to the pinned server's administrative CLI commands. */
export function privateServerCliCommand(operation) {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    throw new TypeError("Private-server CLI operation must be an object.");
  }
  const { kind } = operation;
  if (!OPERATIONS.has(kind)) throw new TypeError("Private-server CLI operation is not supported.");
  if (kind === "pause") return "system.pauseSimulation()";
  if (kind === "reset") return "system.resetAllData()";
  if (kind === "resume") return "system.resumeSimulation()";
  if (kind === "sample") {
    return "Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].count({type:'creep'}),storage.db['rooms.objects'].count({type:'spawn'})]).then(([gameTime,creeps,spawns])=>JSON.stringify({creeps,gameTime,spawns}))";
  }
  if (Object.keys(operation).length !== 2 || !Number.isSafeInteger(operation.milliseconds)) {
    throw new TypeError("Tick duration must be a safe integer.");
  }
  if (operation.milliseconds < 1 || operation.milliseconds > 10_000) {
    throw new RangeError("Tick duration is outside the bounded private-server range.");
  }
  return `system.setTickDuration(${operation.milliseconds})`;
}

/** Runs one bounded, source-controlled administrative operation against loopback CLI only. */
export async function runPrivateServerCli(operation, options = {}) {
  const command = privateServerCliCommand(operation);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 21026;
  const timeoutMs = options.timeoutMs ?? PRIVATE_SERVER_CLI_LIMITS.timeoutMs;
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Private-server CLI is restricted to a loopback TCP port.");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PRIVATE_SERVER_CLI_LIMITS.timeoutMs
  ) {
    throw new RangeError("Private-server CLI timeout is outside the bounded range.");
  }
  return exchange({ command, host, port, timeoutMs, connect: options.connect ?? createConnection });
}

/**
 * Builds the one permitted bundle-upload expression for the controlled test user.
 * The bundle is serialized as data, never interpreted while this adapter builds the command.
 */
export function privateServerDeploymentCommand(bundle) {
  if (typeof bundle !== "string" || Buffer.byteLength(bundle, "utf8") === 0) {
    throw new TypeError("Private-server deployment requires non-empty bundle source.");
  }
  if (Buffer.byteLength(bundle, "utf8") > PRIVATE_SERVER_CLI_LIMITS.commandBytes) {
    throw new RangeError("Production bundle is outside the private-server CLI byte limit.");
  }
  const source = JSON.stringify(bundle);
  const username = JSON.stringify(CONTROLLED_USERNAME);
  return `storage.db.users.findOne({username:${username}}).then(user=>{if(!user)throw new Error('controlled integration user is missing');return storage.db['users.code'].findOne({$and:[{user:user._id},{activeWorld:true}]}).then(code=>{if(!code)throw new Error('controlled integration branch is missing');return storage.db['users.code'].update({_id:code._id},{$set:{modules:{main:${source}},timestamp:Date.now()}}).then(()=>storage.env.del('scrScriptCachedData:'+user._id)).then(()=>storage.pubsub.publish('user:'+user._id+'/code',JSON.stringify({id:''+code._id,hash:${JSON.stringify(hash(bundle))}}))).then(()=>JSON.stringify({deployed:true}))})})`;
}

/** Deploys a built bundle only to the fixed controlled test account on loopback. */
export async function deployPrivateServerBundle(bundlePath, options = {}) {
  const bundle = await readFile(bundlePath, "utf8");
  const command = privateServerDeploymentCommand(bundle);
  return runPrivateServerCommand(command, options);
}

/** Reads and fingerprints the exact deployable bundle without retaining source in evidence. */
export async function privateServerBundleIdentity(bundlePath) {
  const bundle = await readFile(bundlePath);
  if (bundle.byteLength === 0 || bundle.byteLength > PRIVATE_SERVER_CLI_LIMITS.commandBytes) {
    throw new RangeError("Production bundle is outside the private-server CLI byte limit.");
  }
  return Object.freeze({
    bytes: bundle.byteLength,
    sha256: hash(bundle),
  });
}

function exchange({ command, connect, host, port, timeoutMs }) {
  if (Buffer.byteLength(command, "utf8") > PRIVATE_SERVER_CLI_LIMITS.commandBytes) {
    return Promise.reject(new RangeError("Private-server CLI command exceeds the byte limit."));
  }
  return new Promise((resolveResult, rejectResult) => {
    let received = "";
    let sent = false;
    let settled = false;
    const socket = connect({ host, port });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectResult(error);
      else
        resolveResult(
          Object.freeze({ bytes: Buffer.byteLength(result, "utf8"), hash: hash(result) }),
        );
    };
    const timer = setTimeout(() => finish(new Error("Private-server CLI timed out.")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${command}\r\n`, "utf8"));
    socket.on("data", (chunk) => {
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > PRIVATE_SERVER_CLI_LIMITS.responseBytes) {
        finish(new RangeError("Private-server CLI response exceeds the byte limit."));
        return;
      }
      const greetingPrompt = received.indexOf("< ");
      if (!sent && greetingPrompt >= 0) {
        sent = true;
        received = received.slice(greetingPrompt + 2);
      }
      const resultPrompt = received.indexOf("< ");
      if (sent && resultPrompt >= 0) finish(null, received.slice(0, resultPrompt).trim());
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Private-server CLI closed before a result.")));
  });
}

function runPrivateServerCommand(command, options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 21026;
  const timeoutMs = options.timeoutMs ?? PRIVATE_SERVER_CLI_LIMITS.timeoutMs;
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Private-server CLI is restricted to a loopback TCP port.");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PRIVATE_SERVER_CLI_LIMITS.timeoutMs
  ) {
    throw new RangeError("Private-server CLI timeout is outside the bounded range.");
  }
  return exchange({ command, host, port, timeoutMs, connect: options.connect ?? createConnection });
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
