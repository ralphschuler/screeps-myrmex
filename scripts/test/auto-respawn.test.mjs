import { describe, expect, it, vi } from "vitest";
import { ensureRespawn, parseConfiguredTargets, selectSpawnPosition } from "../auto-respawn.mjs";

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
      get: vi.fn(async (endpoint) =>
        endpoint === "user/world-status" ? { ok: 1, status: "normal" } : { ok: 1, rooms: 2 },
      ),
      post: vi.fn(),
    };

    const result = await ensureRespawn({ client, enabled: true, shard: "shard3" });

    expect(result).toEqual({ action: "healthy", ownedRooms: 2 });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("reports a loss without mutation when disabled", async () => {
    const client = {
      get: vi.fn(async (endpoint) =>
        endpoint === "user/world-status" ? { ok: 1, status: "lost" } : { ok: 1, rooms: 0 },
      ),
      post: vi.fn(),
    };

    const result = await ensureRespawn({ client, enabled: false, shard: "shard3" });

    expect(result.action).toBe("would-respawn");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("requires explicit zero-room authorization for a normal account state", async () => {
    const client = {
      get: vi.fn(async (endpoint) =>
        endpoint === "user/world-status" ? { ok: 1, status: "normal" } : { ok: 1, rooms: 0 },
      ),
      post: vi.fn(),
    };

    const ordinary = await ensureRespawn({ client, enabled: true, shard: "shard3" });
    const authorizedDryRun = await ensureRespawn({
      client,
      dryRun: true,
      enabled: true,
      respawnOnZeroRooms: true,
      shard: "shard3",
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
          return { ok: 1, rooms: 0 };
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
      shard: "shard3",
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
          return { ok: 1, rooms: 0 };
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
      shard: "shard3",
    });

    expect(result).toEqual({ action: "respawned" });
    expect(client.post).toHaveBeenCalledWith(
      "game/place-spawn",
      { room: "W1N1", shard: "shard3", x: 20, y: 20, name: "Myrmex-1" },
      { allowApiError: true },
    );
  });

  it("validates configured target JSON", () => {
    expect(parseConfiguredTargets('[{"room":"W1N1","x":20,"y":20}]', "shard3")).toEqual([
      { room: "W1N1", shard: "shard3", x: 20, y: 20 },
    ]);
    expect(() => parseConfiguredTargets('[{"room":"W1N1","x":1,"y":20}]', "shard3")).toThrow(
      "invalid target",
    );
  });
});
