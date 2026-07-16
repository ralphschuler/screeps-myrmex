const fs = require("node:fs");
const { Buffer } = require("node:buffer");
const { env } = require("node:process");

const BODY = Object.freeze([
  "tough",
  "tough",
  "move",
  "move",
  "move",
  "move",
  "ranged_attack",
  "work",
  "attack",
  "move",
]);
const MAXIMUM_DEFINITION_BYTES = 4_096;
const RECEIPT_PREFIX = "myrmexFixture:";

module.exports = attachFixture;
module.exports.readDefinition = readDefinition;
module.exports.validateDefinition = validateDefinition;
module.exports.latchDefinition = latchDefinition;

/**
 * Adds the fixture only to standalone-server extension hooks. It deliberately adds no CLI method,
 * HTTP route, or production-bundle capability.
 */
function attachFixture(
  config,
  definition = null,
  storage = loadStorage(),
  fixtureEnvironment = env,
  fileSystem = fs,
) {
  if (!config.engine) return;
  let activeDefinition = definition;
  let definitionState = definition ? "ready" : "waiting";
  const expectedScenarioId =
    definition?.scenarioId ?? fixtureEnvironment.MYRMEX_PRIVATE_SERVER_FIXTURE_ID;
  let processType = null;
  let statusWritten = false;
  let watching = false;
  let mainLoopHadWork = false;
  let acknowledgedPauseSequence = null;
  let acknowledgingPauseSequence = null;
  let hostileInserted = false;
  let resetPublished = false;
  let resetObservationPending = false;
  let botExceptionInjected = false;
  const filename = fixtureEnvironment.MYRMEX_PRIVATE_SERVER_FIXTURE;

  config.engine.on("init", (type) => {
    if (type !== "processor" && type !== "runner") return;
    processType = type;
    if (definitionState === "ready") return writeDefinitionStatus();
    const pending = settleDefinition();
    if (definitionState === "waiting" && typeof filename === "string" && filename.length > 0) {
      watching = true;
      fileSystem.watchFile(filename, { interval: 50, persistent: false }, settleDefinition);
    }
    return pending;
  });

  config.engine.on("mainLoopStage", (stage) => {
    if (stage === "start") {
      mainLoopHadWork = false;
      return;
    }
    if (stage !== "finish") {
      mainLoopHadWork = true;
      return;
    }
    if (mainLoopHadWork || !safeId(expectedScenarioId)) return;
    return Promise.all([
      storage.env.get(storage.env.keys.MAIN_LOOP_PAUSED),
      storage.env.get(`${RECEIPT_PREFIX}${expectedScenarioId}:pause-request`),
    ]).then(([paused, value]) => {
      const request = safePauseRequest(value, expectedScenarioId);
      if (
        +paused !== 1 ||
        request === null ||
        request.sequence === acknowledgedPauseSequence ||
        request.sequence === acknowledgingPauseSequence
      ) {
        return;
      }
      acknowledgingPauseSequence = request.sequence;
      return writeReceiptById(storage, expectedScenarioId, "quiescent-main", {
        phase: "quiescent",
        sequence: request.sequence,
      }).then(
        () => {
          acknowledgedPauseSequence = request.sequence;
          acknowledgingPauseSequence = null;
        },
        (error) => {
          acknowledgingPauseSequence = null;
          throw error;
        },
      );
    });
  });

  config.engine.on("processRoom", (room, _roomInfo, objects, terrain, gameTime, bulk) => {
    if (!activeDefinition) return;
    const definition = activeDefinition;
    if (room !== definition.target.room) return;
    if (!hostileInserted && gameTime === definition.hostile.atTick) {
      const rejection = hostileRejection(definition, objects, terrain);
      if (rejection) {
        hostileInserted = true;
        writeReceipt(storage, definition, "hostile", { phase: rejection, scheduledTick: gameTime });
      } else {
        bulk.insert(invader(definition));
        hostileInserted = true;
        writeReceipt(storage, definition, "hostile", {
          phase: "scheduled",
          scheduledTick: gameTime,
        });
      }
    }
    if (!resetPublished && definition.heapResetAtTick === gameTime) {
      resetPublished = true;
      return writeReceipt(storage, definition, "reset", {
        phase: "scheduled",
        resetTick: gameTime,
      }).then(() => storage.pubsub.publish(storage.pubsub.keys.RUNTIME_RESTART, "myrmex-fixture"));
    }
  });

  config.engine.on("playerSandbox", (sandbox, userId) => {
    if (!activeDefinition) return;
    const definition = activeDefinition;
    if (resetObservationPending || `${userId}` !== definition.target.userId) return;
    return Promise.all([
      storage.env.get(receiptKey(definition, "reset")),
      storage.env.get(storage.env.keys.GAMETIME),
    ]).then(([value, gameTime]) => {
      const receipt = safeReceipt(value, definition);
      if (
        receipt.phase !== "scheduled" ||
        sandbox.__myrmexFixtureGeneration === definition.scenarioId
      ) {
        if (!botExceptionInjected && definition.botExceptionAtTick === +gameTime) {
          botExceptionInjected = true;
          return writeReceipt(storage, definition, "bot-exception", {
            phase: "injected",
            tick: +gameTime,
          }).then(() => {
            throw new Error("myrmex fixture bot exception");
          });
        }
        return;
      }
      resetObservationPending = true;
      sandbox.__myrmexFixtureGeneration = definition.scenarioId;
      return storage.env.set(
        receiptKey(definition, "reset"),
        JSON.stringify({ ...receipt, phase: "observed" }),
      );
    });
  });

  function settleDefinition() {
    if (definitionState !== "waiting") return;
    try {
      const candidate = readDefinition(filename, fileSystem);
      if (!safeId(expectedScenarioId) || candidate.scenarioId !== expectedScenarioId) {
        throw new TypeError("MYRMEX fixture identity does not match the expected scenario.");
      }
      activeDefinition = candidate;
      definitionState = "ready";
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      definitionState = "rejected";
    }
    stopWatching();
    return writeDefinitionStatus();
  }

  function writeDefinitionStatus() {
    if (statusWritten || !safeId(expectedScenarioId) || processType === null) return;
    statusWritten = true;
    return writeReceiptById(storage, expectedScenarioId, `ready-${processType}`, {
      phase: definitionState,
    });
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    fileSystem.unwatchFile(filename, settleDefinition);
  }
}

function readDefinition(filename, fileSystem = fs) {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const contents = fileSystem.readFileSync(filename, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAXIMUM_DEFINITION_BYTES) {
    throw new RangeError("MYRMEX fixture definition exceeds the byte limit.");
  }
  return validateDefinition(JSON.parse(contents));
}

/** Reads a definition only until a valid definition is latched for the current server process. */
function latchDefinition(current, filename, fileSystem = fs) {
  if (current) return current;
  try {
    return readDefinition(filename, fileSystem);
  } catch {
    return null;
  }
}

function validateDefinition(value) {
  const row = exact(value, [
    "botExceptionAtTick",
    "heapResetAtTick",
    "hostile",
    "scenarioId",
    "schemaVersion",
    "target",
  ]);
  if (row.schemaVersion !== 1 || !safeId(row.scenarioId))
    throw new TypeError("MYRMEX fixture identity is invalid.");
  const target = exact(row.target, ["room", "targetX", "targetY", "userId"]);
  const hostile = exact(row.hostile, ["atTick", "body", "x", "y"]);
  if (!roomName(target.room) || !safeId(target.userId) || !cell(target.targetX, target.targetY)) {
    throw new TypeError("MYRMEX fixture target is invalid.");
  }
  if (!cell(hostile.x, hostile.y) || hostile.body !== "smallMelee" || !tick(hostile.atTick)) {
    throw new TypeError("MYRMEX hostile fixture is invalid.");
  }
  if (row.heapResetAtTick !== null && !tick(row.heapResetAtTick)) {
    throw new TypeError("MYRMEX heap-reset fixture is invalid.");
  }
  if (row.botExceptionAtTick !== null && !tick(row.botExceptionAtTick)) {
    throw new TypeError("MYRMEX bot-exception fixture is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    scenarioId: row.scenarioId,
    target: Object.freeze(target),
    hostile: Object.freeze(hostile),
    heapResetAtTick: row.heapResetAtTick,
    botExceptionAtTick: row.botExceptionAtTick,
  });
}

function hostileRejection(definition, objects, terrain) {
  if (
    !Array.isArray(objects) ||
    !objects.some(
      (item) => item.type === "controller" && `${item.user}` === definition.target.userId,
    )
  ) {
    return "target-not-owned";
  }
  if (objects.some((item) => item.x === definition.hostile.x && item.y === definition.hostile.y)) {
    return "hostile-cell-occupied";
  }
  if (
    typeof terrain !== "string" ||
    (parseInt(terrain.charAt(definition.hostile.y * 50 + definition.hostile.x), 10) & 1) > 0
  ) {
    return "hostile-cell-invalid";
  }
  if (
    objects.some(
      (item) =>
        item.x === definition.target.targetX &&
        item.y === definition.target.targetY &&
        item.type === "creep" &&
        `${item.user}` === definition.target.userId,
    )
  ) {
    return null;
  }
  return "target-actor-missing";
}

function invader(definition) {
  return {
    type: "creep",
    user: "2",
    body: BODY.map((type) => ({ type, hits: 100 })),
    hits: BODY.length * 100,
    hitsMax: BODY.length * 100,
    ticksToLive: 1500,
    x: definition.hostile.x,
    y: definition.hostile.y,
    room: definition.target.room,
    fatigue: 0,
    store: {},
    storeCapacity: 0,
    name: `myrmex_fixture_${definition.scenarioId}`,
    userSummoned: definition.target.userId,
  };
}

function writeReceipt(storage, definition, kind, update) {
  return writeReceiptById(storage, definition.scenarioId, kind, update);
}

function writeReceiptById(storage, scenarioId, kind, update) {
  return storage.env.set(
    `${RECEIPT_PREFIX}${scenarioId}:${kind}`,
    JSON.stringify({ scenarioId, ...update }),
  );
}

function receiptKey(definition, kind) {
  return `${RECEIPT_PREFIX}${definition.scenarioId}:${kind}`;
}

function safeReceipt(value, definition) {
  if (typeof value !== "string") return {};
  try {
    const receipt = JSON.parse(value);
    return receipt?.scenarioId === definition.scenarioId && typeof receipt.phase === "string"
      ? receipt
      : {};
  } catch {
    return {};
  }
}

function safePauseRequest(value, scenarioId) {
  if (typeof value !== "string") return null;
  try {
    const request = exact(JSON.parse(value), ["scenarioId", "sequence"]);
    return request.scenarioId === scenarioId && pauseSequence(request.sequence) ? request : null;
  } catch {
    return null;
  }
}

function exact(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected fixture object.");
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError("Fixture object contains missing or unknown fields.");
  }
  return value;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function roomName(value) {
  return typeof value === "string" && /^[WE][0-9]{1,3}[NS][0-9]{1,3}$/.test(value);
}

function cell(x, y) {
  return (
    Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 1 && x <= 48 && y >= 1 && y <= 48
  );
}

function tick(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

function pauseSequence(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 16;
}

function loadStorage() {
  return require("@screeps/common").storage;
}
