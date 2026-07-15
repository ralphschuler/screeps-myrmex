import { describe, expect, it } from "vitest";
import { canonicalClone, canonicalHash, canonicalSerialize } from "../src/index";

describe("canonical scenario data", () => {
  it("serializes object keys and hashes independent of insertion order", () => {
    const first = { z: 3, nested: { beta: true, alpha: [2, 1] }, a: "start" };
    const second = { a: "start", nested: { alpha: [2, 1], beta: true }, z: 3 };

    expect(canonicalSerialize(first)).toBe(
      '{"a":"start","nested":{"alpha":[2,1],"beta":true},"z":3}',
    );
    expect(canonicalHash(first)).toBe(canonicalHash(second));
    expect(canonicalHash(first)).toMatch(/^fnv1a64-utf16:[0-9a-f]{16}$/u);
  });

  it("creates a detached normalized clone", () => {
    const source = { nested: { value: -0 } };
    const cloned = canonicalClone(source);

    source.nested.value = 7;

    expect(cloned).toEqual({ nested: { value: 0 } });
  });

  it("rejects data that JSON would silently discard or ambiguously normalize", () => {
    expect(() => canonicalSerialize({ value: undefined })).toThrow(/unsupported undefined/u);
    expect(() => canonicalSerialize({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/u);

    const sparse: unknown[] = [];
    sparse.length = 2;
    expect(() => canonicalSerialize(sparse)).toThrow(/sparse slot/u);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalSerialize(cyclic)).toThrow(/cycle/u);

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => canonicalSerialize(accessor)).toThrow(/data property/u);

    const customArray = [1] as number[] & { note?: string };
    customArray.note = "hidden-state";
    expect(() => canonicalSerialize(customArray)).toThrow(/without custom properties/u);
  });
});
