import { describe, expect, it, vi } from "vitest";
import {
  ensureRespawn,
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

  it("requires explicit zero-room authorization for a normal account state", async () => {
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

    const ordinary = await ensureRespawn({ client, enabled: true });
    const authorizedDryRun = await ensureRespawn({
      client,
      dryRun: true,
      enabled: true,
      respawnOnZeroRooms: true,
    });

    expect(ordinary).toEqual({ action: "healthy", ownedRooms: 0 });
    expect(authorizedDryRun.action).toBe("would-respawn");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("moves a lost account through respawn before placement", async () => {
    const statuses = ["lost", "empty", "normal"];
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
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenNthCalledWith(1, "user/respawn", {});
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

  it.each([[null], [["W1N1"]]])("fails closed on malformed prohibited rooms: %j", async (rooms) => {
    const client = {
      get: vi.fn(async (endpoint) => {
        if (endpoint === "user/world-status") return { ok: 1, status: "empty" };
        if (endpoint === "game/shards/info") return shardInfo;
        if (endpoint === "user/rooms") {
          return { ok: 1, reservations: { shard3: [] }, shards: { shard3: [] } };
        }
        if (endpoint === "user/respawn-prohibited-rooms") return { ok: 1, rooms };
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
      post: vi.fn(),
    };

    await expect(
      ensureRespawn({
        client,
        configuredTargets: [{ room: "W1N1", shard: "shard3", x: 20, y: 20 }],
        enabled: true,
      }),
    ).rejects.toThrow("malformed prohibited rooms");
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
          return { ok: 1, rooms: ["shard3/W1N1"] };
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
