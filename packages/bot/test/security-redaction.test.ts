import { describe, expect, it } from "vitest";
import { opaqueId, redactUntrusted, safeCode } from "../src/security";

describe("security redaction", () => {
  it("never returns hostile source bytes and remains deterministic under hostile text", () => {
    const hostile = "<script>steal('token-123')</script>\u001b[2J\u202EW1N1\ud800";
    const first = opaqueId("creep", hostile);
    const second = opaqueId("creep", hostile);
    expect(first).toBe(second);
    expect(first).toMatch(/^creep:[0-9a-f]{8}$/);
    expect(first).not.toContain("token");
    expect(redactUntrusted("creep", hostile)).toBe(`redacted:${first}`);
    expect(redactUntrusted("creep", hostile)).not.toContain(hostile);
  });

  it("caps huge values and fails closed for unreadable values and unsafe codes", () => {
    const huge = `secret-${"x".repeat(10_000)}`;
    expect(opaqueId("error", huge)).toHaveLength("error:00000000".length);
    expect(
      opaqueId(
        "error",
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("leak");
            },
          },
        ),
      ),
    ).toBe("error:414bc9ea");
    expect(safeCode("valid-code")).toBe("valid-code");
    expect(safeCode("<img src=x>")).toBe("invalid-code");
  });
});
