import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScreepsClient } from "./lib/screeps-client.mjs";

const ROOM_SIZE = 50;
const INTERIOR_MIN = 4;
const INTERIOR_MAX = ROOM_SIZE - 5;

function roomCount(payload) {
  const shards = payload?.shards;

  if (shards === null || typeof shards !== "object" || Array.isArray(shards)) {
    return undefined;
  }

  let count = 0;

  for (const [shard, rooms] of Object.entries(shards)) {
    if (
      shard.length === 0 ||
      !Array.isArray(rooms) ||
      rooms.some((room) => typeof room !== "string" || room.length === 0)
    ) {
      return undefined;
    }

    count += rooms.length;
  }

  return count;
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

function respawnRoomKey(target) {
  return `${target.shard}/${target.room}`;
}

function prohibitedRoomKeys(payload) {
  const rooms = payload?.rooms;

  if (
    !Array.isArray(rooms) ||
    rooms.some((key) => {
      if (typeof key !== "string") return true;
      const parts = key.split("/");
      return parts.length !== 2 || parts.some((part) => part.length === 0);
    })
  ) {
    throw new Error("Screeps returned malformed prohibited rooms; refusing spawn placement.");
  }

  return new Set(rooms);
}

function chebyshev(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function manhattan(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function selectSpawnCandidate(terrain, objects = []) {
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

  return best;
}

export function selectSpawnPosition(terrain, objects = []) {
  const { x, y } = selectSpawnCandidate(terrain, objects);
  return { x, y };
}

export function parseConfiguredTargets(value) {
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
    if (
      typeof target?.room !== "string" ||
      !Number.isInteger(target.x) ||
      !Number.isInteger(target.y) ||
      target.x < INTERIOR_MIN ||
      target.x > INTERIOR_MAX ||
      target.y < INTERIOR_MIN ||
      target.y > INTERIOR_MAX ||
      typeof target.shard !== "string" ||
      target.shard.length === 0
    ) {
      throw new Error("SCREEPS_RESPAWN_TARGETS contains an invalid target.");
    }

    return { room: target.room, shard: target.shard, x: target.x, y: target.y };
  });
}

export function parseShards(payload) {
  if (!Array.isArray(payload?.shards)) {
    throw new Error("Screeps did not provide a shard list.");
  }

  const shards = [
    ...new Set(
      payload.shards
        .map((shard) => shard?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));

  if (shards.length === 0) {
    throw new Error("Screeps did not provide any available shards.");
  }

  return shards;
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

  const candidate = selectSpawnCandidate(terrain, objects);
  return { room, shard, ...candidate };
}

async function discoverDynamicTargets(client, shards) {
  const settled = await Promise.allSettled(shards.map((shard) => dynamicTarget(client, shard)));

  return settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.shard.localeCompare(right.shard) ||
        left.room.localeCompare(right.room),
    )
    .map(({ room, shard, x, y }) => ({ room, shard, x, y }));
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
  enabled,
  dryRun = false,
  respawnOnZeroRooms = false,
  configuredTargets = [],
  spawnNamePrefix = "Myrmex",
  now = () => Date.now(),
  polls = 24,
  wait = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000)),
}) {
  const [worldStatus, shardsPayload, roomsPayload] = await Promise.all([
    client.get("user/world-status"),
    client.get("game/shards/info"),
    client.get("user/rooms"),
  ]);
  const shards = parseShards(shardsPayload);
  const status = worldStatus?.status;
  const ownedRooms = roomCount(roomsPayload);

  if (ownedRooms === undefined) {
    throw new Error("Screeps returned a malformed room count; refusing to mutate the account.");
  }

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
  const prohibited = prohibitedRoomKeys(prohibitedPayload);
  const targets = configuredTargets.filter(
    (target) => shards.includes(target.shard) && !prohibited.has(respawnRoomKey(target)),
  );
  const dynamicTargets = await discoverDynamicTargets(client, shards);
  targets.push(...dynamicTargets.filter((target) => !prohibited.has(respawnRoomKey(target))));

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
  const configuredTargets = parseConfiguredTargets(process.env.SCREEPS_RESPAWN_TARGETS);
  const result = await ensureRespawn({
    client,
    configuredTargets,
    dryRun: process.env.SCREEPS_RESPAWN_DRY_RUN === "true",
    enabled: process.env.SCREEPS_AUTO_RESPAWN_ENABLED === "true",
    respawnOnZeroRooms: process.env.SCREEPS_RESPAWN_ON_ZERO_ROOMS === "true",
    spawnNamePrefix: process.env.SCREEPS_RESPAWN_NAME || "Myrmex",
  });

  console.log(`Auto-respawn result: ${result.action}.`);
}
