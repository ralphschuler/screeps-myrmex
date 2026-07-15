import { describe, expect, it, vi } from "vitest";
import { bundleDigest, deployBundle } from "../deploy-screeps.mjs";

describe("Screeps deployment", () => {
  it("uploads and verifies the exact built module", async () => {
    const code = "module.exports.loop = () => {};";
    const client = {
      get: vi.fn(async () => ({ modules: { main: code }, ok: 1 })),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    const result = await deployBundle({ branch: "default", client, code });

    expect(client.post).toHaveBeenCalledWith("user/code", {
      branch: "default",
      modules: { main: code },
    });
    expect(client.get).toHaveBeenCalledWith("user/code", { branch: "default" });
    expect(result.digest).toBe(bundleDigest(code));
  });

  it("fails when Screeps returns different code", async () => {
    const client = {
      get: vi.fn(async () => ({ modules: { main: "different" }, ok: 1 })),
      post: vi.fn(async () => ({ ok: 1 })),
    };

    await expect(deployBundle({ branch: "default", client, code: "expected" })).rejects.toThrow(
      "bundle verification failed",
    );
  });
});
