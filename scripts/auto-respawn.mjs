import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScreepsClient } from "./lib/screeps-client.mjs";

const ROOM_SIZE = 50;
const INTERIOR_MIN = 4;
const INTERIOR_MAX = ROOM_SIZE - 5;

function roomCount(payload) {
  const rooms = payload?.rooms;

  if (typeof rooms === "number") {
    return rooms;
  }

  if (Array.isArray(rooms)) {
    return rooms.length;
  }

  if (rooms !== null && typeof rooms === "object") {
    return Object.keys(rooms).length;
  }

  return undefined;
}

function terrainString(payload) {
  const records = payload?.terrain;

  if (!Array.isArray(records)) {
    return undefined;
  }

  return records.find((record) => typeof record?.terrain === "string")?.terrain;
}

function terrainAt(terrain, x, y) {
  return terrain[y * ROOM_SIZE + x];
}

function isWall(terrain, x, y) {
  const value = terrainAt(terrain, x, y);
  return value === "1" || value === "3";
}

function positionKey(x, y) {
  return `${x}:${y}`;
}

function chebyshev(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function manhattan(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

export function selectSpawnPosition(terrain, objects = []) {
  if (typeof terrain !== "string" || terrain.length !== ROOM_SIZE * ROOM_SIZE) {
    throw new Error("Screeps returned malformed room terrain.");
  }

  const occupied = new Set(
    objects
      .filter((object) => Number.isInteger(object?.x) && Number.isInteger(object?.y))
      .map((object) => positionKey(object.x, object.y)),
  );
  const anchors = objects.filter(
    (object) =>
      (object?.type === "source" || object?.type === "controller") &&
      Number.isInteger(object.x) &&
      Number.isInteger(object.y),
  );
  let best;

  for (let y = INTERIOR_MIN; y <= INTERIOR_MAX; y += 1) {
    for (let x = INTERIOR_MIN; x <= INTERIOR_MAX; x += 1) {
      if (isWall(terrain, x, y) || occupied.has(positionKey(x, y))) {
        continue;
      }

      let openTiles = 0;
      let nearbySwamps = 0;
      let clearance = 6;

      for (let offsetY = -5; offsetY <= 5; offsetY += 1) {
        for (let offsetX = -5; offsetX <= 5; offsetX += 1) {
          const targetX = x + offsetX;
          const targetY = y + offsetY;

          if (targetX < 0 || targetX >= ROOM_SIZE || targetY < 0 || targetY >= ROOM_SIZE) {
            clearance = 0;
            continue;
          }

          const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));

          if (isWall(terrain, targetX, targetY)) {
            clearance = Math.min(clearance, distance);
          } else if (distance <= 4) {
            openTiles += 1;

            if (terrainAt(terrain, targetX, targetY) === "2") {
              nearbySwamps += 1;
            }
          }
        }
      }

      if (clearance < 2) {
        continue;
      }

      const position = { x, y };
      const anchorDistance = anchors.reduce((sum, anchor) => sum + manhattan(position, anchor), 0);
      const nearestAnchor = anchors.reduce(
        (nearest, anchor) => Math.min(nearest, chebyshev(position, anchor)),
        Number.POSITIVE_INFINITY,
      );
      const score =
        clearance * 1_000 +
        openTiles * 10 -
        nearbySwamps * 3 -
        anchorDistance -
        (nearestAnchor < 2 ? 1_000 : 0);

      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && (y < best.y || (y === best.y && x < best.x)))
      ) {
        best = { score, x, y };
      }
    }
  }

  if (best === undefined) {
    throw new Error("No safe spawn position was found in the selected room.");
  }

  return { x: best.x, y: best.y };
}

export function parseConfiguredTargets(value, defaultShard) {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SCREEPS_RESPAWN_TARGETS must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SCREEPS_RESPAWN_TARGETS must be a JSON array.");
  }

  return parsed.map((target) => {
    const shard = target?.shard ?? defaultShard;

    if (
      typeof target?.room !== "string" ||
      !Number.isInteger(target.x) ||
      !Number.isInteger(target.y) ||
      target.x < INTERIOR_MIN ||
      target.x > INTERIOR_MAX ||
      target.y < INTERIOR_MIN ||
      target.y > INTERIOR_MAX ||
      typeof shard !== "string" ||
      shard.length === 0
    ) {
      throw new Error("SCREEPS_RESPAWN_TARGETS contains an invalid target.");
    }

    return { room: target.room, shard, x: target.x, y: target.y };
  });
}

async function dynamicTarget(client, shard) {
  const start = await client.get("user/world-start-room", { shard });
  const room = Array.isArray(start?.room) ? start.room[0] : start?.room;

  if (typeof room !== "string" || room.length === 0) {
    throw new Error("Screeps did not provide a valid start room.");
  }

  const [terrainPayload, objectPayload] = await Promise.all([
    client.get("game/room-terrain", { encoded: 1, room, shard }),
    client.get("game/room-objects", { room, shard }),
  ]);
  const terrain = terrainString(terrainPayload);

  if (terrain === undefined) {
    throw new Error("Screeps did not provide encoded terrain for the start room.");
  }

  const objects = Array.isArray(objectPayload?.objects) ? objectPayload.objects : [];
  const sources = objects.filter((object) => object?.type === "source");

  if (sources.length < 2) {
    throw new Error("The selected start room does not expose two sources.");
  }

  return { room, shard, ...selectSpawnPosition(terrain, objects) };
}

async function waitForEmptyStatus(client, { polls, wait }) {
  for (let attempt = 0; attempt < polls; attempt += 1) {
    const status = await client.get("user/world-status");

    if (status?.status === "empty") {
      return;
    }

    if (status?.status === "normal") {
      throw new Error("Screeps returned to normal state before spawn placement.");
    }

    await wait();
  }

  throw new Error("Screeps did not enter empty respawn state before the timeout.");
}

export async function ensureRespawn({
  client,
  shard,
  enabled,
  dryRun = false,
  respawnOnZeroRooms = false,
  configuredTargets = [],
  spawnNamePrefix = "Myrmex",
  now = () => Date.now(),
  polls = 24,
  wait = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000)),
}) {
  if (typeof shard !== "string" || shard.length === 0) {
    throw new Error("SCREEPS_SHARD is required.");
  }

  const [worldStatus, roomsPayload] = await Promise.all([
    client.get("user/world-status"),
    client.get("user/rooms", { interval: 8, shard }),
  ]);
  const status = worldStatus?.status;
  const ownedRooms = roomCount(roomsPayload);
  const zeroRoomRecovery = status === "normal" && ownedRooms === 0 && respawnOnZeroRooms;

  if (status === "normal" && !zeroRoomRecovery) {
    return { action: "healthy", ownedRooms };
  }

  if (status !== "lost" && status !== "empty" && !zeroRoomRecovery) {
    throw new Error("Screeps returned an unknown world status; refusing to mutate the account.");
  }

  if (!enabled || dryRun) {
    return { action: "would-respawn", ownedRooms, status };
  }

  if (status !== "empty") {
    await client.post("user/respawn", {});
    await waitForEmptyStatus(client, { polls, wait });
  }

  const prohibitedPayload = await client.get("user/respawn-prohibited-rooms");
  const prohibited = new Set(
    Array.isArray(prohibitedPayload?.rooms) ? prohibitedPayload.rooms : [],
  );
  const targets = configuredTargets.filter((target) => !prohibited.has(target.room));

  try {
    const candidate = await dynamicTarget(client, shard);

    if (!prohibited.has(candidate.room)) {
      targets.push(candidate);
    }
  } catch (error) {
    if (targets.length === 0) {
      throw error;
    }
  }

  if (targets.length === 0) {
    throw new Error("No permitted respawn target is available.");
  }

  const safePrefix = spawnNamePrefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Myrmex";
  const name = `${safePrefix}-${now().toString(36)}`;

  for (const target of targets) {
    const result = await client.post(
      "game/place-spawn",
      { ...target, name },
      { allowApiError: true },
    );

    if (result?.ok === 1) {
      const finalStatus = await client.get("user/world-status");

      if (finalStatus?.status !== "normal") {
        throw new Error("Spawn placement was accepted but world-status verification failed.");
      }

      return { action: "respawned" };
    }
  }

  throw new Error("Screeps rejected every permitted respawn target.");
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const client = new ScreepsClient({
    baseUrl: process.env.SCREEPS_API_BASE_URL,
    token: process.env.SCREEPS_TOKEN,
  });
  const configuredTargets = parseConfiguredTargets(
    process.env.SCREEPS_RESPAWN_TARGETS,
    process.env.SCREEPS_SHARD,
  );
  const result = await ensureRespawn({
    client,
    configuredTargets,
    dryRun: process.env.SCREEPS_RESPAWN_DRY_RUN === "true",
    enabled: process.env.SCREEPS_AUTO_RESPAWN_ENABLED === "true",
    respawnOnZeroRooms: process.env.SCREEPS_RESPAWN_ON_ZERO_ROOMS === "true",
    shard: process.env.SCREEPS_SHARD,
    spawnNamePrefix: process.env.SCREEPS_RESPAWN_NAME || "Myrmex",
  });

  console.log(`Auto-respawn result: ${result.action}.`);
}
