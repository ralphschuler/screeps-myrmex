import { afterEach, describe, expect, it, vi } from "vitest";
import { createScreepsLocalPathSearch } from "../src/runtime/local-path-adapter";

class FakePosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}
}

describe("runtime local path adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes only the supplied local static matrix and configured search bounds to PathFinder", () => {
    const set = vi.fn();
    const callbackResults: unknown[] = [];
    const search = vi.fn(
      (
        _origin: unknown,
        _goal: unknown,
        options: { roomCallback?: (roomName: string) => unknown },
      ) => {
        callbackResults.push(options.roomCallback?.("W1N1"), options.roomCallback?.("W2N1"));
        return {
          cost: 2,
          incomplete: false,
          ops: 7,
          path: [new FakePosition(11, 10, "W1N1"), new FakePosition(12, 10, "W1N1")],
        };
      },
    );
    vi.stubGlobal("RoomPosition", FakePosition);
    vi.stubGlobal("PathFinder", {
      CostMatrix: class {
        public set = set;
      },
      search,
    });

    const adapter = createScreepsLocalPathSearch();
    if (adapter === null) throw new Error("expected Screeps path adapter");
    expect(
      adapter.search({
        goal: { roomName: "W1N1", x: 12, y: 10 },
        maxCost: 200,
        maxOps: 2_000,
        origin: { roomName: "W1N1", x: 10, y: 10 },
        range: 1,
        staticMatrix: {
          roomName: "W1N1",
          revision: "terrain:1",
          walkability: `#${".".repeat(2_499)}`,
        },
      }),
    ).toEqual({ cost: 2, directions: [3, 3], incomplete: false });
    expect(set).toHaveBeenCalledWith(0, 0, 255);
    expect(search).toHaveBeenCalledWith(
      expect.any(FakePosition),
      expect.objectContaining({ range: 1 }),
      expect.objectContaining({ maxCost: 200, maxOps: 2_000 }),
    );
    expect(callbackResults[0]).toBeDefined();
    expect(callbackResults[1]).toBe(false);
  });

  it("does not create an adapter outside Screeps", () => {
    expect(createScreepsLocalPathSearch()).toBeNull();
  });
});
