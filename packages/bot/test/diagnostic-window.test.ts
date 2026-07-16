import { describe, expect, it } from "vitest";
import { resolveDiagnosticWindow } from "../src/telemetry/reporter-state";

describe("diagnostic windows", () => {
  it("allows only fixed categories inside the exact bounded expiry window", () => {
    expect(
      resolveDiagnosticWindow(
        { level: "debug", categories: ["faults", "recovery"], expiresAtTick: 110 },
        100,
        10,
      ),
    ).toEqual({ level: "debug", categories: ["faults", "recovery"], expiresAtTick: 110 });
    expect(
      resolveDiagnosticWindow(
        { level: "trace", categories: ["faults"], expiresAtTick: 100 },
        100,
        10,
      ),
    ).toBeNull();
    expect(
      resolveDiagnosticWindow(
        { level: "trace", categories: ["token"], expiresAtTick: 101 },
        100,
        10,
      ),
    ).toBeNull();
    expect(
      resolveDiagnosticWindow(
        { level: "trace", categories: ["faults"], expiresAtTick: 111 },
        100,
        10,
      ),
    ).toBeNull();
  });
});
