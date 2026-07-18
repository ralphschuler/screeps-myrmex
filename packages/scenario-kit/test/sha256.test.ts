import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "../src/sha256";

describe("bounded SHA-256 evidence hashing", () => {
  it("matches standard empty, ASCII, and Unicode vectors", () => {
    expect(sha256Utf8("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Utf8("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Utf8("😀")).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );
  });
});
