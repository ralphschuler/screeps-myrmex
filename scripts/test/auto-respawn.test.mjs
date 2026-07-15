import { describe, expect, it, vi } from "vitest";
import {
  ensureRespawn,
  nearbyRoomNames,
  parseConfiguredTargets,
  parseShards,
  selectSpawnPosition,
} from "../auto-respawn.mjs";

const shardInfo = { ok: 1, shards: [{ name: "shard3" }] };

describe("Screeps auto-respawn", () => {
  it("selects a deterministic open interior tile", () => {
    const terrain = "0".repeat(2_500);
    const objects = [
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 },
      { type: "controller", x: 25, y: 25 },
    ];

    const first = selectSpawnPosition(terrain, objects);
    const second = selectSpawnPosition(terrain, objects);

    expect(first).toEqual(second);
    expect(first.x).toBeGreaterThanOrEqual(4);
    expect(first.x).toBeLessThanOrEqual(45);
    expect(first.y).toBeGreaterThanOrEqual(4);
    expect(first.y).toBeLessThanOrEqual(45);
    expect(objects.some((object) => object.x === first.x && object.y === first.y)).toBe(false);
  });

  it("enumerates nearby rooms deterministically across world-axis boundaries", () => {
    expect(nearbyRoomNames("W0N0", 1)).toEqual([
      "W0N0",
      "W1N1",
      "W0N1",
      "E0N1",
      "W1N0",
      "E0N0",
      "W1S0",
      "W0S0",
      "E0S0",
    ]);
  });

  it("does nothing while the account owns rooms", async () => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "normal" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return {
            ok: 1,
            reservations: { shard0: [], shard3: [], shardX: [] },
            shards: { shard0: ["W1N1"], shard3: ["W2N2"], shardX: [] },
          };
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    const result = await ensureRespawn({ client, enabled: true });

    expect(result).toEqual({ action: "healthy", ownedRooms: 2 });
    expect(client.get.mock.calls.filter(([endpoint]) => endpoint === "user/rooms")).toEqual([
      ["user/rooms"],
    ]);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("reports a loss without mutation when disabled", async () => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "lost" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    const result = await ensureRespawn({ client, enabled: false });

    expect(result).toEqual({ action: "would-respawn", ownedRooms: 0, status: "lost" });
    expect(client.get.mock.calls.filter(([endpoint]) => endpoint === "user/rooms")).toEqual([
      ["user/rooms"],
    ]);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("treats normal world status as authoritative even when the room list is temporarily empty", async () => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "normal" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    const result = await ensureRespawn({ client, enabled: true });

    expect(result).toEqual({ action: "healthy", ownedRooms: 0 });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("moves a lost account through respawn before placement", async () => {
    const statuses = ["lost", "lost", "empty", "empty", "normal"];
    const waitForRespawnCooldown = vi.fn();
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }

        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }

        if (endpoint === "game/shards/info") {
          return shardInfo;
        }

        if (endpoint === "user/respawn-prohibited-rooms") {
          return { ok: 1, rooms: [] };
        }

        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await ensureRespawn({
      client,
      configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
      enabled: true,
      wait: vi.fn(),
      waitForRespawnCooldown,
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenNthCalledWith(1, "user/respawn", {});
    expect(waitForRespawnCooldown).toHaveBeenCalledTimes(1);
  });

  it("stops before destructive mutation when a valid spawn appears during preflight", async () => {
    const statuses = ["lost", "normal"];
    const rooms = [[], ["W1N1"]];
    const report = vi.fn();
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, shards: { shard3: rooms.shift() } };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    const wait = vi.fn();
    const result = await ensureRespawn({ client, enabled: true, report, wait });

    expect(result).toEqual({ action: "healthy", ownedRooms: 1 });
    expect(client.post).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "A valid spawn appeared before respawn mutation; leaving the account unchanged.",
    );
  });

  it("waits and retries the same target once when placement reports the global cooldown", async () => {
    const statuses = ["empty", "empty", "normal"];
    const waitForRespawnCooldown = vi.fn();
    const report = vi.fn();
    let placementAttempts = 0;
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async (endpoint) => {
        if (endpoint !== "game/place-spawn") return { ok: 1 };
        placementAttempts += 1;
        return placementAttempts === 1
          ? { ok: 0, error: "too soon after last respawn" }
          : { ok: 1 };
      }),
    };
    const target = { room: "W1N1", shard: "shard3", x: 20, y: 20 };

    const result = await ensureRespawn({
      client,
      configuredTargets: [target],
      enabled: true,
      now: () => 1,
      report,
      waitForRespawnCooldown,
    });

    expect(result).toEqual({ action: "respawned" });
    expect(waitForRespawnCooldown).toHaveBeenCalledTimes(1);
    expect(client.post.mock.calls.filter(([endpoint]) => endpoint === "game/place-spawn")).toEqual([
      ["game/place-spawn", { ...target, name: "Myrmex-1" }, { allowApiError: true }],
      ["game/place-spawn", { ...target, name: "Myrmex-1" }, { allowApiError: true }],
    ]);
    expect(report.mock.calls.flat().join(" ")).not.toContain("W1N1");
    expect(report.mock.calls.flat().join(" ")).toContain("cooldown");
  });

  it("does not consume additional targets while a global cooldown remains active", async () => {
    const statuses = ["empty", "empty"];
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 0, error: "too soon after last respawn" })),
    };

    await expect(
      ensureRespawn({
        client,
        configuredTargets: [
          { room: "W1N1", shard: "shard3", x: 20, y: 20 },
          { room: "W2N2", shard: "shard3", x: 21, y: 21 },
        ],
        enabled: true,
        waitForRespawnCooldown: vi.fn(),
      }),
    ).rejects.toThrow("respawn-cooldown");

    const placementCalls = client.post.mock.calls.filter(
      ([endpoint]) => endpoint === "game/place-spawn",
    );
    expect(placementCalls).toHaveLength(2);
    expect(placementCalls.every(([, body]) => body.room === "W1N1")).toBe(true);
  });

  it("allocates and verifies CPU on the automatically selected shard", async () => {
    const statuses = ["empty", "normal"];
    const cpuStates = [
      { ok: 1, cpu: 20, cpuShard: { shard3: 0 } },
      { ok: 1, cpu: 20, cpuShard: { shard3: 0 } },
      { ok: 1, cpu: 20, cpuShard: { shard3: 20 } },
    ];
    const wait = vi.fn();
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        if (endpoint === "auth/me") return cpuStates.shift();
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await ensureRespawn({
      allocateCpu: true,
      client,
      configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
      cpuAllocationPolls: 1,
      enabled: true,
      now: () => 1,
      wait,
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenCalledWith("user/console", {
      expression: 'Game.cpu.setShardLimits({"shard3":20})',
      shard: "shard3",
    });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("prefers an already funded shard before attempting a CPU-limit change", async () => {
    const statuses = ["empty", "normal"];
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") {
          return { ok: 1, shards: [{ name: "shard1" }, { name: "shard3" }] };
        }
        if (endpoint === "user/rooms") {
          return { ok: 1, shards: { shard1: [], shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        if (endpoint === "auth/me") {
          return { ok: 1, cpu: 20, cpuShard: { shard1: 0, shard3: 20 } };
        }
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    await ensureRespawn({
      allocateCpu: true,
      client,
      configuredTargets: [
        { room: "W1N1", shard: "shard1", x: 20, y: 20 },
        { room: "W3N3", shard: "shard3", x: 20, y: 20 },
      ],
      enabled: true,
      now: () => 1,
    });

    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      expect.objectContaining({ room: "W3N3", shard: "shard3" }),
      { allowApiError: true },
    );
    expect(client.post.mock.calls.some(([endpoint]) => endpoint === "user/console")).toBe(false);
  });

  it("repairs missing CPU on a recently respawned healthy account", async () => {
    const cpuStates = [
      { cpu: 20, cpuShard: { shard3: 0 }, lastRespawnDate: 999_000, ok: 1 },
      { cpu: 20, cpuShard: { shard3: 0 }, lastRespawnDate: 999_000, ok: 1 },
      { cpu: 20, cpuShard: { shard3: 20 }, lastRespawnDate: 999_000, ok: 1 },
    ];
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "normal" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return {
            ok: 1,
            reservations: { shard3: [] },
            shards: { shard3: ["W1N1"] },
          };
        }
        if (endpoint === "auth/me") return cpuStates.shift();
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await ensureRespawn({
      allocateCpu: true,
      client,
      cpuAllocationPolls: 1,
      enabled: true,
      now: () => 1_000_000,
      wait: vi.fn(),
    });

    expect(result).toEqual({ action: "healthy", ownedRooms: 1 });
    expect(client.post).toHaveBeenCalledWith("user/console", {
      expression: 'Game.cpu.setShardLimits({"shard3":20})',
      shard: "shard3",
    });
  });

  it("places and verifies a spawn from empty state without exposing target data", async () => {
    let statusCalls = 0;
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          statusCalls += 1;
          return { ok: 1, status: statusCalls === 1 ? "empty" : "normal" };
        }

        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }

        if (endpoint === "game/shards/info") {
          return shardInfo;
        }

        if (endpoint === "user/respawn-prohibited-rooms") {
          return { ok: 1, rooms: [] };
        }

        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async (endpoint) => (endpoint === "game/place-spawn" ? { ok: 1 } : { ok: 0 })),
    };

    const result = await ensureRespawn({
      client,
      configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
      enabled: true,
      now: () => 1,
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      { room: "W1N1", shard: "shard3", x: 20, y: 20, name: "Myrmex-1" },
      { allowApiError: true },
    );
  });

  it("retries malformed prohibited-room data before placement", async () => {
    const statuses = ["empty", "normal"];
    const prohibitedResponses = [
      { ok: 1, rooms: null },
      { ok: 1, rooms: [] },
    ];
    const wait = vi.fn();
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") {
          return prohibitedResponses.shift();
        }
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await ensureRespawn({
      client,
      configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
      enabled: true,
      wait,
    });

    expect(result).toEqual({ action: "respawned" });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("uses server-side placement validation when prohibited-room data stays malformed", async () => {
    const wait = vi.fn();
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "empty" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: null };
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 0, error: "invalid location" })),
    };

    await expect(
      ensureRespawn({
        client,
        configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
        enabled: true,
        wait,
      }),
    ).rejects.toThrow("invalid-location");
    expect(wait).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("treats an unqualified legacy prohibited room as prohibited on every shard", async () => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "empty" };
        if (endpoint === "game/shards/info") {
          return { ok: 1, shards: [{ name: "shard1" }, { name: "shard3" }] };
        }
        if (endpoint === "user/rooms") {
          return { ok: 1, shards: { shard1: [], shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") {
          return { ok: 1, rooms: ["W1N1"] };
        }
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(),
    };

    await expect(
      ensureRespawn({
        client,
        configuredTargets: [
          { room: "W1N1", shard: "shard1", x: 20, y: 20 },
          { room: "W1N1", shard: "shard3", x: 20, y: 20 },
        ],
        enabled: true,
      }),
    ).rejects.toThrow("No permitted respawn target");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("keeps identical room names distinct when one shard target is prohibited", async () => {
    let statusCalls = 0;
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          statusCalls += 1;
          return { ok: 1, status: statusCalls === 1 ? "empty" : "normal" };
        }
        if (endpoint === "game/shards/info") {
          return { ok: 1, shards: [{ name: "shard1" }, { name: "shard3" }] };
        }
        if (endpoint === "user/rooms") {
          return {
            ok: 1,
            reservations: { shard1: [], shard3: [] },
            shards: { shard1: [], shard3: [] },
          };
        }
        if (endpoint === "user/respawn-prohibited-rooms") {
          return { ok: 1, rooms: ["shard3/W1N1"] };
        }

        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    await ensureRespawn({
      client,
      configuredTargets: [
        { room: "W1N1", shard: "shard3", x: 20, y: 20 },
        { room: "W1N1", shard: "shard1", x: 20, y: 20 },
      ],
      enabled: true,
      now: () => 1,
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      { room: "W1N1", shard: "shard1", x: 20, y: 20, name: "Myrmex-1" },
      { allowApiError: true },
    );
  });

  it("fails before placement when every discovered target is prohibited", async () => {
    const objects = [
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 },
      { type: "controller", x: 25, y: 25 },
    ];
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "empty" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") {
          return {
            ok: 1,
            rooms: nearbyRoomNames("W1N1").map((room) => `shard3/${room}`),
          };
        }
        if (endpoint === "user/world-start-room") return { ok: 1, room: "W1N1" };
        if (endpoint === "game/room-terrain") {
          return { ok: 1, terrain: [{ terrain: "0".repeat(2_500) }] };
        }
        if (endpoint === "game/room-objects") return { ok: 1, objects };
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    await expect(ensureRespawn({ client, enabled: true })).rejects.toThrow(
      "No permitted respawn target is available.",
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("falls back from an invalid start anchor to a valid nearby room", async () => {
    let statusCalls = 0;
    const validObjects = [
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 },
      { type: "controller", x: 25, y: 25 },
    ];
    const client = {
      get: vi.fn(async (endpoint, query) => {
        if (endpoint === "user/world-status") {
          statusCalls += 1;
          return { ok: 1, status: statusCalls === 1 ? "empty" : "normal" };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        if (endpoint === "user/world-start-room") return { ok: 1, room: "W0N0" };
        if (endpoint === "game/room-objects") {
          return {
            ok: 1,
            objects: query.room === "W1N1" ? validObjects : [{ type: "source", x: 10, y: 10 }],
          };
        }
        if (endpoint === "game/room-terrain") {
          return { ok: 1, terrain: [{ terrain: "0".repeat(2_500) }] };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    await ensureRespawn({ client, enabled: true, now: () => 1 });

    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      expect.objectContaining({ room: "W1N1", shard: "shard3" }),
      { allowApiError: true },
    );
  });

  it("recovers a lost account that still owns a room but has no valid spawn", async () => {
    const statuses = ["lost", "lost", "empty", "empty", "normal"];
    const roomLists = [["W1N1"], ["W1N1"], []];
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") {
          return { ok: 1, status: statuses.shift() };
        }
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, shards: { shard3: roomLists.shift() } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        throw new Error("dynamic target unavailable");
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await ensureRespawn({
      client,
      configuredTargets: [{ room: "W2N2", shard: "shard3", x: 20, y: 20 }],
      enabled: true,
      wait: vi.fn(),
      waitForRespawnCooldown: vi.fn(),
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenNthCalledWith(1, "user/respawn", {});
  });

  it("refuses placement when empty world status conflicts with owned rooms", async () => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "empty" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, shards: { shard3: ["W1N1"] } };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    await expect(ensureRespawn({ client, enabled: true })).rejects.toThrow(
      "empty world status conflicts with owned rooms",
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("validates shard discovery and configured target JSON", () => {
    expect(
      parseShards({ shards: [{ name: "shard3" }, { name: "shard1" }, { name: "shard3" }] }),
    ).toEqual(["shard1", "shard3"]);
    expect(parseConfiguredTargets('[{"room":"W1N1","x":20,"y":20,"shard":"shard3"}]')).toEqual([
      { room: "W1N1", shard: "shard3", x: 20, y: 20 },
    ]);
    expect(() => parseConfiguredTargets('[{"room":"W1N1","x":20,"y":20}]')).toThrow(
      "invalid target",
    );
    expect(() => parseConfiguredTargets('[{"room":"W1N1","x":1,"y":20,"shard":"shard3"}]')).toThrow(
      "invalid target",
    );
  });

  it.each([
    ["missing shard map", { ok: 1, rooms: 0 }],
    ["non-array shard rooms", { ok: 1, shards: { shard3: null } }],
    ["non-string room name", { ok: 1, shards: { shard3: [null] } }],
  ])("fails closed on %s", async (_description, roomsPayload) => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "lost" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") return roomsPayload;

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    await expect(ensureRespawn({ client, enabled: true })).rejects.toThrow("malformed room count");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("discovers shards and deterministically selects the best available start", async () => {
    let statusCalls = 0;
    const objects = [
      { type: "source", x: 10, y: 10 },
      { type: "source", x: 40, y: 40 },
      { type: "controller", x: 25, y: 25 },
    ];
    const client = {
      get: vi.fn(async (endpoint, query) => {
        if (endpoint === "user/world-status") {
          statusCalls += 1;
          return { ok: 1, status: statusCalls === 1 ? "empty" : "normal" };
        }
        if (endpoint === "game/shards/info") {
          return { ok: 1, shards: [{ name: "shard3" }, { name: "shard1" }] };
        }
        if (endpoint === "user/rooms") {
          return {
            ok: 1,
            reservations: { shard1: [], shard3: [] },
            shards: { shard1: [], shard3: [] },
          };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms: [] };
        if (endpoint === "user/world-start-room")
          return { ok: 1, room: `W${query.shard.at(-1)}N1` };
        if (endpoint === "game/room-terrain")
          return { ok: 1, terrain: [{ terrain: "0".repeat(2_500) }] };
        if (endpoint === "game/room-objects") return { ok: 1, objects };
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    await ensureRespawn({ client, enabled: true, now: () => 1 });

    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      expect.objectContaining({ room: "W1N1", shard: "shard1" }),
      { allowApiError: true },
    );
  });
});
