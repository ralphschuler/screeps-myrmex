import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

export const PRIVATE_SERVER_CLI_LIMITS = Object.freeze({
  commandBytes: 5 * 1024 * 1024,
  responseBytes: 16 * 1024,
  timeoutMs: 5_000,
});

const OPERATIONS = new Set([
  "bootstrap-controlled-bot",
  "clear-fixture",
  "pause",
  "pause-fixture",
  "prepare-fixture-target",
  "reset",
  "resume",
  "sample-controlled",
  "sample-fixture",
  "sample-fixture-quiescence",
  "set-tick-duration",
]);
const CONTROLLED_USERNAME = "myrmex-integration";

/** Maps a closed operation vocabulary to the pinned server's administrative CLI commands. */
export function privateServerCliCommand(operation) {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    throw new TypeError("Private-server CLI operation must be an object.");
  }
  const { kind } = operation;
  if (!OPERATIONS.has(kind)) throw new TypeError("Private-server CLI operation is not supported.");
  if (kind === "pause" || kind === "resume") {
    exactOperation(operation, ["kind"]);
    return `system.${kind === "pause" ? "pauseSimulation" : "resumeSimulation"}()`;
  }
  if (kind === "pause-fixture") {
    exactOperation(operation, ["kind", "scenarioId", "sequence"]);
    if (!safeId(operation.scenarioId)) throw new TypeError("Fixture scenario id is invalid.");
    if (!pauseSequence(operation.sequence)) {
      throw new RangeError("Fixture pause sequence is outside the bounded range.");
    }
    const acknowledgementKey = JSON.stringify(
      `myrmexFixture:${operation.scenarioId}:quiescent-main`,
    );
    const requestKey = JSON.stringify(`myrmexFixture:${operation.scenarioId}:pause-request`);
    const request = JSON.stringify(
      JSON.stringify({
        scenarioId: operation.scenarioId,
        sequence: operation.sequence,
      }),
    );
    return `Promise.all([storage.env.del(${acknowledgementKey}),storage.env.del(${requestKey})]).then(()=>system.pauseSimulation()).then(()=>storage.env.set(${requestKey},${request})).then(()=>JSON.stringify({paused:true}))`;
  }
  if (kind === "reset") {
    exactOperation(operation, ["kind"]);
    return "system.resetAllData().then(()=> 'OK')";
  }
  if (kind === "bootstrap-controlled-bot") {
    exactOperation(operation, ["kind"]);
    return `storage.db['rooms.objects'].find({type:'controller'}).then(controllers=>{const controller=controllers.find(item=>!item.user);if(!controller)throw new Error('unowned integration controller is missing');return bots.spawn('simplebot',controller.room,{username:'${CONTROLLED_USERNAME}',cpu:100,gcl:1})}).then(()=>storage.db.users.findOne({username:'${CONTROLLED_USERNAME}'})).then(user=>{if(!user)throw new Error('controlled integration user is missing');return storage.db['rooms.objects'].findOne({$and:[{user:user._id},{type:'spawn'}]}).then(spawn=>{if(!spawn)throw new Error('controlled integration spawn is missing');return JSON.stringify({room:spawn.room,spawnX:spawn.x,spawnY:spawn.y,userId:''+user._id})})})`;
  }
  if (kind === "sample-controlled") {
    exactOperation(operation, ["kind"]);
    return `storage.db.users.findOne({username:'${CONTROLLED_USERNAME}'}).then(user=>{if(!user)throw new Error('controlled integration user is missing');return storage.db['rooms.objects'].find({user:user._id}).then(objects=>{const spawn=objects.find(item=>item.type==='spawn');if(!spawn)throw new Error('controlled integration spawn is missing');return Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({room:spawn.room})]).then(([gameTime,roomObjects])=>JSON.stringify({hostileCreeps:roomObjects.filter(item=>item.type==='creep'&&''+item.user==='2').length,ownedCreeps:objects.filter(item=>item.type==='creep').length,ownedSpawns:objects.filter(item=>item.type==='spawn').length,tick:+gameTime}))})})`;
  }
  if (kind === "prepare-fixture-target") {
    exactOperation(operation, ["kind"]);
    return `storage.db.users.findOne({username:'${CONTROLLED_USERNAME}'}).then(user=>{if(!user)throw new Error('controlled integration user is missing');return storage.db['rooms.objects'].find({user:user._id,type:'creep'}).then(creeps=>{const creep=creeps[0];if(!creep)throw new Error('controlled integration creep is missing');return Promise.all([storage.db['rooms.objects'].find({room:creep.room}),storage.db['rooms.terrain'].findOne({room:creep.room})]).then(([objects,terrain])=>{const candidate=[];for(let y=1;y<=48;y+=1)for(let x=1;x<=48;x+=1)if(Math.max(Math.abs(x-creep.x),Math.abs(y-creep.y))>=3&&Math.max(Math.abs(x-creep.x),Math.abs(y-creep.y))<=6&&!objects.some(item=>item.x===x&&item.y===y)&&(parseInt(terrain.terrain.charAt(y*50+x),10)&1)===0)candidate.push({x,y});const hostile=candidate[0];if(!hostile)throw new Error('safe hostile fixture cell is missing');return JSON.stringify({room:creep.room,targetX:creep.x,targetY:creep.y,userId:''+user._id,hostileX:hostile.x,hostileY:hostile.y})})})})`;
  }
  if (kind === "sample-fixture") {
    exactOperation(operation, ["kind", "scenarioId"]);
    if (!safeId(operation.scenarioId)) throw new TypeError("Fixture scenario id is invalid.");
    const scenarioId = JSON.stringify(operation.scenarioId);
    const keys = fixtureReceiptKeys(operation.scenarioId, [
      "ready-processor",
      "ready-runner",
      "bot-exception",
    ]);
    return `Promise.all(${JSON.stringify(keys)}.map(key=>storage.env.get(key))).then(values=>{const status=value=>{if(!value)return'absent';try{const receipt=JSON.parse(value);return receipt.scenarioId===${scenarioId}&&(receipt.phase==='ready'||receipt.phase==='rejected')?receipt.phase:'rejected'}catch{return'rejected'}};let bot={};try{bot=JSON.parse(values[2]||'{}')}catch{};return JSON.stringify({botException:bot.scenarioId===${scenarioId}&&bot.phase==='injected'?'injected':'absent',processor:status(values[0]),runner:status(values[1])})})`;
  }
  if (kind === "sample-fixture-quiescence") {
    exactOperation(operation, ["kind", "scenarioId", "sequence"]);
    if (!safeId(operation.scenarioId)) throw new TypeError("Fixture scenario id is invalid.");
    if (!pauseSequence(operation.sequence)) {
      throw new RangeError("Fixture pause sequence is outside the bounded range.");
    }
    const scenarioId = JSON.stringify(operation.scenarioId);
    const sequence = operation.sequence;
    const key = JSON.stringify(`myrmexFixture:${operation.scenarioId}:quiescent-main`);
    return `storage.env.get(${key}).then(value=>{if(!value)return JSON.stringify({quiescent:'absent'});try{const receipt=JSON.parse(value);const exact=Object.keys(receipt).sort().join(',')==='phase,scenarioId,sequence';return JSON.stringify({quiescent:exact&&receipt.scenarioId===${scenarioId}&&receipt.sequence===${sequence}&&receipt.phase==='quiescent'?'ready':'rejected'})}catch{return JSON.stringify({quiescent:'rejected'})}})`;
  }
  if (kind === "clear-fixture") {
    exactOperation(operation, ["kind", "scenarioId"]);
    if (!safeId(operation.scenarioId)) throw new TypeError("Fixture scenario id is invalid.");
    const keys = fixtureReceiptKeys(operation.scenarioId, [
      "ready-processor",
      "ready-runner",
      "hostile",
      "reset",
      "bot-exception",
      "pause-request",
      "quiescent-main",
    ]);
    return `Promise.all(${JSON.stringify(keys)}.map(key=>storage.env.del(key))).then(()=>Promise.all(${JSON.stringify(keys)}.map(key=>storage.env.get(key)))).then(values=>JSON.stringify({cleared:values.every(value=>value==null)}))`;
  }
  if (!Number.isSafeInteger(operation.milliseconds)) {
    throw new TypeError("Tick duration must be a safe integer.");
  }
  exactOperation(operation, ["kind", "milliseconds"]);
  if (operation.milliseconds < 1 || operation.milliseconds > 10_000) {
    throw new RangeError("Tick duration is outside the bounded private-server range.");
  }
  return `system.setTickDuration(${operation.milliseconds})`;
}

/** Runs one bounded, source-controlled administrative operation against loopback CLI only. */
export async function runPrivateServerCli(operation, options = {}) {
  const command = privateServerCliCommand(operation);
  return opaqueResult(await runPrivateServerCommand(command, options));
}

/** Creates the controlled test bot and returns its transient, validated fixture coordinates. */
export async function bootstrapPrivateServerBot(options = {}) {
  return parseBootstrap(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "bootstrap-controlled-bot" }),
      options,
    ),
  );
}

/** Samples only bounded aggregate outcomes for the controlled test bot. */
export async function samplePrivateServerBot(options = {}) {
  return parseSample(
    await runPrivateServerCommand(privateServerCliCommand({ kind: "sample-controlled" }), options),
  );
}

/** Identifies the one receipt failure that can occur while the controlled sample becomes ready. */
export function isTransientPrivateServerSampleError(error) {
  return error instanceof Error && error.message === "Private-server sample receipt is invalid.";
}

/** Selects transient, engine-validated fixture coordinates without exposing room state. */
export async function preparePrivateServerFixtureTarget(options = {}) {
  return parseFixtureTarget(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "prepare-fixture-target" }),
      options,
    ),
  );
}

/** Samples only the namespaced, fixed bot-exception receipt for one declared scenario. */
export async function samplePrivateServerFixture(scenarioId, options = {}) {
  return parseFixtureSample(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "sample-fixture", scenarioId }),
      options,
    ),
  );
}

/** Requests a fresh main-loop pause boundary for one declared fixture scenario. */
export async function pausePrivateServerFixture(scenarioId, sequence, options = {}) {
  return parseFixturePause(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "pause-fixture", scenarioId, sequence }),
      options,
    ),
  );
}

/** Samples only whether the main loop acknowledged the requested paused boundary. */
export async function samplePrivateServerFixtureQuiescence(scenarioId, sequence, options = {}) {
  return parseFixtureQuiescence(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "sample-fixture-quiescence", scenarioId, sequence }),
      options,
    ),
  );
}

/** Deletes and verifies only the fixed namespaced receipts for one declared scenario. */
export async function clearPrivateServerFixture(scenarioId, options = {}) {
  return parseFixtureClearance(
    await runPrivateServerCommand(
      privateServerCliCommand({ kind: "clear-fixture", scenarioId }),
      options,
    ),
  );
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
  return `storage.db.users.findOne({username:${username}}).then(user=>{if(!user)throw new Error('controlled integration user is missing');const query={$and:[{user:user._id},{activeWorld:true}]};return storage.db.users.update({_id:user._id},{$set:{active:10000}}).then(()=>storage.db['users.code'].update(query,{$set:{modules:{main:${source}},timestamp:Date.now()}})).then(result=>{if(!result.modified)throw new Error('controlled integration branch is missing');return storage.env.del('scrScriptCachedData:'+user._id)}).then(()=>storage.db['users.code'].findOne(query)).then(code=>{if(!code)throw new Error('controlled integration branch is missing');return storage.pubsub.publish('user:'+user._id+'/code',JSON.stringify({id:''+code._id,hash:${JSON.stringify(hash(bundle))}}))}).then(()=>JSON.stringify({deployed:true}))})`;
}

/** Deploys a built bundle only to the fixed controlled test account on loopback. */
export async function deployPrivateServerBundle(bundlePath, options = {}) {
  const bundle = await readFile(bundlePath, "utf8");
  const command = privateServerDeploymentCommand(bundle);
  let result;
  try {
    result = await runPrivateServerCommand(command, options);
  } catch {
    throw new Error("bundle-deployment-command-failed");
  }
  if (parseJson(result) === null || parseJson(result).deployed !== true) {
    throw new Error("bundle-deployment-unacknowledged");
  }
  return opaqueResult(result);
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
    let connected = false;
    let sent = false;
    let settled = false;
    const socket = connect({ host, port });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectResult(error);
      else resolveResult(result);
    };
    const timer = setTimeout(() => finish(new Error("Private-server CLI timed out.")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk) => {
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > PRIVATE_SERVER_CLI_LIMITS.responseBytes) {
        finish(new RangeError("Private-server CLI response exceeds the byte limit."));
        return;
      }
      const greetingPrompt = received.indexOf("< ");
      if (connected && !sent && greetingPrompt >= 0) {
        sent = true;
        received = received.slice(greetingPrompt + 2).replace(/^\r?\n/, "");
        socket.write(`${command}\r\n`, "utf8");
      }
      const resultPrefix = received.indexOf("< ");
      const resultEnd = received.indexOf("\n", resultPrefix);
      if (sent && resultPrefix >= 0 && resultEnd >= 0) {
        const result = received.slice(resultPrefix + 2, resultEnd).trim();
        if (/(?:^|\s)(?:[A-Za-z]*Error):/i.test(result)) {
          finish(new Error("Private-server CLI operation failed."));
        } else finish(null, result);
      }
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

function opaqueResult(value) {
  return Object.freeze({ bytes: Buffer.byteLength(value, "utf8"), hash: hash(value) });
}

function parseBootstrap(value) {
  const row = parseJson(value);
  if (
    row === null ||
    !safeId(row.userId) ||
    !roomName(row.room) ||
    !cell(row.spawnX) ||
    !cell(row.spawnY)
  ) {
    throw new Error("Private-server bootstrap receipt is invalid.");
  }
  return Object.freeze({
    userId: row.userId,
    room: row.room,
    spawnX: row.spawnX,
    spawnY: row.spawnY,
    transcript: opaqueResult(value),
  });
}

function parseSample(value) {
  const row = parseJson(value);
  if (
    row === null ||
    !count(row.hostileCreeps) ||
    !count(row.ownedCreeps) ||
    !count(row.ownedSpawns) ||
    !Number.isSafeInteger(row.tick) ||
    row.tick < 0
  ) {
    throw new Error("Private-server sample receipt is invalid.");
  }
  return Object.freeze({
    hostileCreeps: row.hostileCreeps,
    ownedCreeps: row.ownedCreeps,
    ownedSpawns: row.ownedSpawns,
    tick: row.tick,
    transcript: opaqueResult(value),
  });
}

function parseFixtureTarget(value) {
  const row = parseJson(value);
  if (
    row === null ||
    !safeId(row.userId) ||
    !roomName(row.room) ||
    !cell(row.targetX) ||
    !cell(row.targetY) ||
    !cell(row.hostileX) ||
    !cell(row.hostileY)
  ) {
    throw new Error("Private-server fixture target receipt is invalid.");
  }
  return Object.freeze({
    hostileX: row.hostileX,
    hostileY: row.hostileY,
    room: row.room,
    targetX: row.targetX,
    targetY: row.targetY,
    userId: row.userId,
    transcript: opaqueResult(value),
  });
}

function parseFixtureSample(value) {
  const row = parseJson(value);
  if (
    row === null ||
    !exactKeys(row, ["botException", "processor", "runner"]) ||
    !["absent", "injected"].includes(row.botException) ||
    !["absent", "ready", "rejected"].includes(row.processor) ||
    !["absent", "ready", "rejected"].includes(row.runner)
  ) {
    throw new Error("Private-server fixture sample receipt is invalid.");
  }
  return Object.freeze({
    botException: row.botException,
    processor: row.processor,
    runner: row.runner,
    transcript: opaqueResult(value),
  });
}

function parseFixtureClearance(value) {
  const row = parseJson(value);
  if (row === null || !exactKeys(row, ["cleared"]) || row.cleared !== true) {
    throw new Error("Private-server fixture cleanup was not acknowledged.");
  }
  return Object.freeze({ cleared: true, transcript: opaqueResult(value) });
}

function parseFixturePause(value) {
  const row = parseJson(value);
  if (row === null || !exactKeys(row, ["paused"]) || row.paused !== true) {
    throw new Error("Private-server fixture pause was not acknowledged.");
  }
  return Object.freeze({ paused: true, transcript: opaqueResult(value) });
}

function parseFixtureQuiescence(value) {
  const row = parseJson(value);
  if (
    row === null ||
    !exactKeys(row, ["quiescent"]) ||
    !["absent", "ready", "rejected"].includes(row.quiescent)
  ) {
    throw new Error("Private-server fixture quiescence receipt is invalid.");
  }
  return Object.freeze({ quiescent: row.quiescent, transcript: opaqueResult(value) });
}

function parseJson(value) {
  const source = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
  try {
    const row = JSON.parse(source);
    return typeof row === "object" && row !== null && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

function exactOperation(value, keys) {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError("Private-server CLI operation contains missing or unknown fields.");
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function fixtureReceiptKeys(scenarioId, kinds) {
  return kinds.map((kind) => `myrmexFixture:${scenarioId}:${kind}`);
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function roomName(value) {
  return typeof value === "string" && /^[WE][0-9]{1,3}[NS][0-9]{1,3}$/.test(value);
}

function cell(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 48;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}

function pauseSequence(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 16;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
