import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScreepsClient } from "./lib/screeps-client.mjs";

const ROOM_SIZE = 50;
const INTERIOR_MIN = 4;
const INTERIOR_MAX = ROOM_SIZE - 5;
const RESPAWN_COOLDOWN_WAIT_MS = 185_000;
const CPU_ALLOCATION_POLLS = 4;
const NEARBY_ROOM_RADIUS = 3;
const DYNAMIC_TARGETS_PER_SHARD = 3;
const RECENT_RESPAWN_CPU_REPAIR_MS = 60 * 60 * 1_000;

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

function ownedShardNames(payload) {
  return Object.entries(payload.shards)
    .filter(([, rooms]) => rooms.length > 0)
    .map(([shard]) => shard)
    .sort((left, right) => left.localeCompare(right));
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

function parseRoomCoordinate(room) {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(room);

  if (match === null) {
    return undefined;
  }

  const horizontal = Number.parseInt(match[2], 10);
  const vertical = Number.parseInt(match[4], 10);

  return {
    x: match[1] === "E" ? horizontal : -horizontal - 1,
    y: match[3] === "S" ? vertical : -vertical - 1,
  };
}

function formatRoomCoordinate({ x, y }) {
  const horizontal = x >= 0 ? `E${x}` : `W${-x - 1}`;
  const vertical = y >= 0 ? `S${y}` : `N${-y - 1}`;
  return `${horizontal}${vertical}`;
}

export function nearbyRoomNames(room, radius = NEARBY_ROOM_RADIUS) {
  const origin = parseRoomCoordinate(room);

  if (origin === undefined || !Number.isInteger(radius) || radius < 0) {
    throw new Error("Screeps returned an invalid start-room coordinate.");
  }

  const rooms = [room];

  for (let distance = 1; distance <= radius; distance += 1) {
    for (let offsetY = -distance; offsetY <= distance; offsetY += 1) {
      for (let offsetX = -distance; offsetX <= distance; offsetX += 1) {
        if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== distance) {
          continue;
        }

        rooms.push(formatRoomCoordinate({ x: origin.x + offsetX, y: origin.y + offsetY }));
      }
    }
  }

  return rooms;
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

function placementErrorCategory(payload) {
  const error = typeof payload?.error === "string" ? payload.error.toLowerCase() : "";
  const known = new Map([
    ["too soon after last respawn", "respawn-cooldown"],
    ["already playing", "already-playing"],
    ["blocked", "account-blocked"],
    ["invalid location", "invalid-location"],
    ["invalid params", "invalid-params"],
    ["name exists", "name-conflict"],
    ["no cpu", "no-cpu"],
  ]);

  return known.get(error) ?? "api-rejected";
}

function validateCpuAccount(payload) {
  const totalCpu = payload?.cpu;
  const cpuShard = payload?.cpuShard;

  if (
    !Number.isFinite(totalCpu) ||
    totalCpu <= 0 ||
    cpuShard === null ||
    typeof cpuShard !== "object" ||
    Array.isArray(cpuShard) ||
    Object.entries(cpuShard).some(
      ([shard, allocation]) => shard.length === 0 || !Number.isFinite(allocation) || allocation < 0,
    )
  ) {
    throw new Error("Screeps did not provide valid shard CPU allocation data.");
  }

  return payload;
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

async function inspectDynamicRoom(client, shard, room) {
  const objectPayload = await client.get("game/room-objects", { room, shard });
  const objects = objectPayload?.objects;

  if (!Array.isArray(objects)) {
    throw new Error("Screeps returned malformed room objects.");
  }

  const sources = objects.filter((object) => object?.type === "source");
  const controllers = objects.filter(
    (object) =>
      object?.type === "controller" &&
      (object.user === undefined || object.user === null || object.user === "") &&
      (object.level === undefined || object.level === 0),
  );

  if (sources.length < 2 || controllers.length !== 1) {
    throw new Error("The selected room is not a neutral two-source room.");
  }

  const terrainPayload = await client.get("game/room-terrain", { encoded: 1, room, shard });
  const terrain = terrainString(terrainPayload);

  if (terrain === undefined) {
    throw new Error("Screeps did not provide encoded terrain for the selected room.");
  }

  const candidate = selectSpawnCandidate(terrain, objects);
  return { room, shard, ...candidate };
}

async function dynamicTargetsForShard(client, shard, prohibited) {
  const start = await client.get("user/world-start-room", { shard });
  const startRooms = Array.isArray(start?.room) ? start.room : [start?.room];

  if (
    startRooms.length === 0 ||
    startRooms.some((room) => typeof room !== "string" || parseRoomCoordinate(room) === undefined)
  ) {
    throw new Error("Screeps did not provide a valid start room.");
  }

  const candidates = [
    ...new Set(startRooms.flatMap((room) => nearbyRoomNames(room, NEARBY_ROOM_RADIUS))),
  ];
  const targets = [];

  for (const room of candidates) {
    if (prohibited.has(respawnRoomKey({ room, shard }))) {
      continue;
    }

    try {
      targets.push(await inspectDynamicRoom(client, shard, room));
    } catch {
      continue;
    }

    if (targets.length >= DYNAMIC_TARGETS_PER_SHARD) {
      break;
    }
  }

  if (targets.length === 0) {
    throw new Error("No valid start-area room was discovered on the shard.");
  }

  return targets;
}

async function discoverDynamicTargets(client, shards, prohibited) {
  const settled = await Promise.allSettled(
    shards.map((shard) => dynamicTargetsForShard(client, shard, prohibited)),
  );

  return settled
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
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

async function readAccountState(client) {
  const [worldStatus, shardsPayload, roomsPayload] = await Promise.all([
    client.get("user/world-status"),
    client.get("game/shards/info"),
    client.get("user/rooms"),
  ]);
  const ownedRooms = roomCount(roomsPayload);

  if (ownedRooms === undefined) {
    throw new Error("Screeps returned a malformed room count; refusing to mutate the account.");
  }

  return {
    ownedRooms,
    roomsPayload,
    shards: parseShards(shardsPayload),
    status: worldStatus?.status,
  };
}

async function ensureCpuAllocation(client, shard, { polls, report, wait }) {
  let account = validateCpuAccount(await client.get("auth/me"));
  const totalCpu = account.cpu;

  if ((account?.cpuShard?.[shard] ?? 0) > 0) {
    return;
  }

  const expression = `Game.cpu.setShardLimits(${JSON.stringify({ [shard]: totalCpu })})`;
  await client.post("user/console", { expression, shard });
  report("Queued CPU allocation for the selected shard.");

  for (let attempt = 0; attempt < polls; attempt += 1) {
    await wait();
    account = validateCpuAccount(await client.get("auth/me"));

    if ((account?.cpuShard?.[shard] ?? 0) > 0) {
      return;
    }
  }

  throw new Error("Spawn placement succeeded but shard CPU allocation could not be verified.");
}

async function repairRecentRespawnCpu(client, accountState, { polls, report, timestamp, wait }) {
  const ownedShards = ownedShardNames(accountState.roomsPayload);

  if (ownedShards.length !== 1) {
    return;
  }

  const account = validateCpuAccount(await client.get("auth/me"));
  const elapsed = timestamp - account.lastRespawnDate;

  if (
    !Number.isFinite(account.lastRespawnDate) ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed > RECENT_RESPAWN_CPU_REPAIR_MS ||
    (account.cpuShard[ownedShards[0]] ?? 0) > 0
  ) {
    return;
  }

  report("A recent respawn has no CPU on its owned shard; retrying CPU allocation.");
  await ensureCpuAllocation(client, ownedShards[0], { polls, report, wait });
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
  waitForRespawnCooldown = () =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, RESPAWN_COOLDOWN_WAIT_MS)),
  allocateCpu = false,
  cpuAllocationPolls = CPU_ALLOCATION_POLLS,
  report = () => {},
}) {
  let accountState = await readAccountState(client);
  let { ownedRooms, shards, status } = accountState;

  const zeroRoomRecovery = status === "normal" && ownedRooms === 0 && respawnOnZeroRooms;

  if (status === "normal" && !zeroRoomRecovery) {
    if (enabled && !dryRun && allocateCpu && ownedRooms > 0) {
      await repairRecentRespawnCpu(client, accountState, {
        polls: cpuAllocationPolls,
        report,
        timestamp: now(),
        wait,
      });
    }

    return { action: "healthy", ownedRooms };
  }

  if ((status === "lost" || status === "empty") && ownedRooms !== 0) {
    throw new Error("Screeps terminal world status conflicts with owned rooms; refusing mutation.");
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
    report("Respawn accepted; waiting for the 180-second placement cooldown.");
    await waitForRespawnCooldown();
    accountState = await readAccountState(client);
    ({ ownedRooms, shards, status } = accountState);

    if (status === "normal" && ownedRooms > 0) {
      return { action: "healthy", ownedRooms };
    }

    if (status !== "empty" || ownedRooms !== 0) {
      throw new Error(
        "Screeps account state changed during the respawn cooldown; refusing placement.",
      );
    }
  }

  const prohibitedPayload = await client.get("user/respawn-prohibited-rooms");
  let prohibited = prohibitedRoomKeys(prohibitedPayload);
  const targets = configuredTargets.filter(
    (target) => shards.includes(target.shard) && !prohibited.has(respawnRoomKey(target)),
  );
  const dynamicTargets = await discoverDynamicTargets(client, shards, prohibited);
  targets.push(...dynamicTargets);

  const uniqueTargets = targets.filter((target, index, allTargets) => {
    const key = `${respawnRoomKey(target)}/${target.x}/${target.y}`;
    return (
      allTargets.findIndex(
        (candidate) => `${respawnRoomKey(candidate)}/${candidate.x}/${candidate.y}` === key,
      ) === index
    );
  });

  if (allocateCpu) {
    const cpuAccount = validateCpuAccount(await client.get("auth/me"));
    const fundedShards = new Set(
      Object.entries(cpuAccount.cpuShard)
        .filter(([, allocation]) => allocation > 0)
        .map(([shard]) => shard),
    );

    uniqueTargets.sort(
      (left, right) => Number(fundedShards.has(right.shard)) - Number(fundedShards.has(left.shard)),
    );
  }

  if (uniqueTargets.length === 0) {
    throw new Error("No permitted respawn target is available.");
  }

  const safePrefix = spawnNamePrefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Myrmex";
  const name = `${safePrefix}-${now().toString(36)}`;
  let cooldownRetried = false;
  const rejectionCategories = new Set();

  for (const target of uniqueTargets) {
    if (!shards.includes(target.shard) || prohibited.has(respawnRoomKey(target))) {
      continue;
    }

    let result = await client.post(
      "game/place-spawn",
      { ...target, name },
      { allowApiError: true },
    );

    let category = placementErrorCategory(result);

    if (result?.ok !== 1 && category === "respawn-cooldown" && !cooldownRetried) {
      cooldownRetried = true;
      report("Screeps still reports the respawn cooldown; waiting before one safe retry.");
      await waitForRespawnCooldown();
      accountState = await readAccountState(client);

      if (accountState.status === "normal" && accountState.ownedRooms > 0) {
        return { action: "healthy", ownedRooms: accountState.ownedRooms };
      }

      if (accountState.status !== "empty" || accountState.ownedRooms !== 0) {
        throw new Error("Screeps account state changed during cooldown retry; refusing placement.");
      }

      prohibited = prohibitedRoomKeys(await client.get("user/respawn-prohibited-rooms"));
      shards = accountState.shards;

      if (!shards.includes(target.shard) || prohibited.has(respawnRoomKey(target))) {
        rejectionCategories.add("became-prohibited");
        continue;
      }

      result = await client.post("game/place-spawn", { ...target, name }, { allowApiError: true });
      category = placementErrorCategory(result);

      if (result?.ok !== 1 && category === "respawn-cooldown") {
        rejectionCategories.add(category);
        report("Respawn cooldown remained active after the guarded retry.");
        break;
      }
    }

    if (result?.ok === 1) {
      const finalStatus = await client.get("user/world-status");

      if (finalStatus?.status !== "normal") {
        throw new Error("Spawn placement was accepted but world-status verification failed.");
      }

      if (allocateCpu) {
        await ensureCpuAllocation(client, target.shard, {
          polls: cpuAllocationPolls,
          report,
          wait,
        });
      }

      return { action: "respawned" };
    }

    rejectionCategories.add(category);
    report(`Spawn placement candidate rejected (${category}).`);
  }

  const categories = [...rejectionCategories].sort().join(", ") || "unknown";
  throw new Error(`Screeps rejected every permitted respawn target (${categories}).`);
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
    allocateCpu: process.env.SCREEPS_AUTO_ALLOCATE_CPU !== "false",
    respawnOnZeroRooms: process.env.SCREEPS_RESPAWN_ON_ZERO_ROOMS === "true",
    report: (message) => console.log(message),
    spawnNamePrefix: process.env.SCREEPS_RESPAWN_NAME || "Myrmex",
  });

  console.log(`Auto-respawn result: ${result.action}.`);
}
