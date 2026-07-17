import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  decodeMemoryData,
  readTelemetrySample,
  telemetrySample,
  verifyTelemetryAdvances,
} from "../verify-screeps-runtime.mjs";

const owner = {
  schemaVersion: 4,
  last: { tick: 123, hash: "fnv1a32-utf16:1234abcd", droppedDetails: 0 },
};

describe("Screeps live runtime verification", () => {
  it("reads a narrow compressed telemetry owner without exposing other Memory", async () => {
    const data = `gz:${gzipSync(JSON.stringify(owner)).toString("base64")}`;
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: 1, data }),
      ok: true,
      status: 200,
    }));

    await expect(
      readTelemetrySample({
        apiBaseUrl: "https://screeps.com/api/",
        fetchImpl,
        memoryPath: "myrmex.telemetry",
        shard: "shard2",
        token: "secret",
      }),
    ).resolves.toEqual({ tick: 123, hash: "fnv1a32-utf16:1234abcd" });

    const [url, request] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("path")).toBe("myrmex.telemetry");
    expect(url.searchParams.get("shard")).toBe("shard2");
    expect(request.headers).toEqual({ "X-Token": "secret" });
    expect(decodeMemoryData(JSON.stringify(owner))).toEqual(owner);
  });

  it.each([5, Number.MAX_SAFE_INTEGER])(
    "accepts owner schema %s and additive fields when the stable latest receipt remains valid",
    (schemaVersion) => {
      expect(
        telemetrySample({ ...owner, optionalDomain: { schemaVersion: 1 }, schemaVersion }),
      ).toEqual({
        tick: 123,
        hash: "fnv1a32-utf16:1234abcd",
      });
    },
  );

  it.each([undefined, null, "4", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid owner schema %s",
    (schemaVersion) => {
      expect(() => telemetrySample({ ...owner, schemaVersion })).toThrow(
        "telemetry owner has no valid latest receipt",
      );
    },
  );

  it.each([
    undefined,
    null,
    {},
    { tick: -1, hash: "fnv1a32-utf16:1234abcd" },
    { tick: 1.5, hash: "fnv1a32-utf16:1234abcd" },
    { tick: Number.MAX_SAFE_INTEGER + 1, hash: "fnv1a32-utf16:1234abcd" },
    { tick: 123, hash: "invalid" },
  ])("rejects malformed latest receipt %#", (last) => {
    expect(() => telemetrySample({ ...owner, last })).toThrow(
      "telemetry owner has no valid latest receipt",
    );
  });

  it("accepts only strictly advancing live telemetry", async () => {
    const readSample = vi
      .fn()
      .mockResolvedValueOnce({ tick: 123, hash: "fnv1a32-utf16:1234abcd" })
      .mockResolvedValueOnce({ tick: 123, hash: "fnv1a32-utf16:1234abcd" })
      .mockResolvedValueOnce({ tick: 126, hash: "fnv1a32-utf16:5678abcd" });
    let currentTime = 0;

    await expect(
      verifyTelemetryAdvances({
        now: () => currentTime,
        pollIntervalMs: 10,
        readSample,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
        timeoutMs: 30,
      }),
    ).resolves.toEqual({
      first: { tick: 123, hash: "fnv1a32-utf16:1234abcd" },
      second: { tick: 126, hash: "fnv1a32-utf16:5678abcd" },
      tickDelta: 3,
    });
  });

  it("fails closed when the observed tick regresses", async () => {
    const readSample = vi
      .fn()
      .mockResolvedValueOnce({ tick: 123, hash: "fnv1a32-utf16:1234abcd" })
      .mockResolvedValueOnce({ tick: 122, hash: "fnv1a32-utf16:5678abcd" });

    await expect(
      verifyTelemetryAdvances({
        now: () => 0,
        pollIntervalMs: 10,
        readSample,
        sleep: async () => {},
        timeoutMs: 30,
      }),
    ).rejects.toThrow("live telemetry tick regressed from 123 to 122");
  });
});
