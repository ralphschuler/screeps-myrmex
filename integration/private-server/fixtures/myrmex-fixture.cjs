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

/**
 * Adds the fixture only to standalone-server extension hooks. It deliberately adds no CLI method,
 * HTTP route, or production-bundle capability.
 */
function attachFixture(
  config,
  definition = readDefinition(env.MYRMEX_PRIVATE_SERVER_FIXTURE),
  storage = loadStorage(),
) {
  if (!config.engine || !definition) return;
  let hostileInserted = false;
  let resetPublished = false;
  let resetObservationPending = false;

  config.engine.on("processRoom", (room, _roomInfo, objects, terrain, gameTime, bulk) => {
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
    if (resetObservationPending || `${userId}` !== definition.target.userId) return;
    return storage.env.get(receiptKey(definition, "reset")).then((value) => {
      const receipt = safeReceipt(value, definition);
      if (
        receipt.phase !== "scheduled" ||
        sandbox.__myrmexFixtureGeneration === definition.scenarioId
      )
        return;
      resetObservationPending = true;
      sandbox.__myrmexFixtureGeneration = definition.scenarioId;
      return storage.env.set(
        receiptKey(definition, "reset"),
        JSON.stringify({ ...receipt, phase: "observed" }),
      );
    });
  });
}

function readDefinition(filename) {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const contents = fs.readFileSync(filename, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAXIMUM_DEFINITION_BYTES) {
    throw new RangeError("MYRMEX fixture definition exceeds the byte limit.");
  }
  return validateDefinition(JSON.parse(contents));
}

function validateDefinition(value) {
  const row = exact(value, ["heapResetAtTick", "hostile", "scenarioId", "schemaVersion", "target"]);
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
  return Object.freeze({
    schemaVersion: 1,
    scenarioId: row.scenarioId,
    target: Object.freeze(target),
    hostile: Object.freeze(hostile),
    heapResetAtTick: row.heapResetAtTick,
  });
}

function hostileRejection(definition, objects, terrain) {
  if (
    !Array.isArray(objects) ||
    !objects.some((item) => item.type === "controller" && item.user === definition.target.userId)
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
        item.user === definition.target.userId,
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
  return storage.env.set(
    receiptKey(definition, kind),
    JSON.stringify({ scenarioId: definition.scenarioId, ...update }),
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

function loadStorage() {
  return require("@screeps/common").storage;
}
