import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findArchitectureViolations } from "../lib/architecture-boundaries.mjs";
import { assertDeployableBundle } from "../lib/bundle-boundaries.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const botSourceRoot = join(repositoryRoot, "packages/bot/src");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"))
    .sort();
}

function botSources() {
  return sourceFiles(botSourceRoot).map((path) => ({
    contents: readFileSync(path, "utf8"),
    path: relative(botSourceRoot, path).split(sep).join("/"),
  }));
}

describe("runtime architecture boundaries", () => {
  it("has no deployable source violations", () => {
    expect(findArchitectureViolations(botSources())).toEqual([]);
  });

  it.each([
    [
      "deployable-source-imports-scenario-kit",
      "economy/planner.ts",
      'import "@myrmex/scenario-kit";',
    ],
    ["persistent-root-outside-state", "economy/planner.ts", 'Memory["myrmex"] = {};'],
    ["live-world-read-outside-observer", "colony/planner.ts", 'const rooms = Game["rooms"];'],
    ["cpu-source-outside-runtime", "colony/planner.ts", "const cpu = Game.cpu;"],
    ["game-command-outside-executor", "colony/planner.ts", 'creep["harvest"](source);'],
    ["raw-memory-outside-segment-owner", "world/observe.ts", "RawMemory.setActiveSegments([]);"],
    ["inter-shard-memory-outside-shard-owner", "world/observe.ts", "InterShardMemory.getLocal();"],
  ])("detects %s", (rule, path, contents) => {
    expect(findArchitectureViolations([{ contents, path }])).toEqual([{ path, rule }]);
  });

  it("detects duplicate canonical authority declarations", () => {
    expect(
      findArchitectureViolations([
        { path: "economy/cache.ts", contents: "export class CacheManager {}" },
      ]),
    ).toEqual([{ path: "economy/cache.ts", rule: "duplicate-authority:CacheManager" }]);
  });

  it("rejects command calls from non-executor files inside execution", () => {
    expect(
      findArchitectureViolations([{ path: "execution/arbiter.ts", contents: "creep.move(1);" }]),
    ).toEqual([{ path: "execution/arbiter.ts", rule: "game-command-outside-executor" }]);
  });

  it("detects destructured persistent and live-world authorities", () => {
    expect(
      findArchitectureViolations([
        {
          path: "strategy/bypass.ts",
          contents: "const { myrmex } = Memory; const { rooms } = Game; void myrmex; void rooms;",
        },
      ]),
    ).toEqual([
      { path: "strategy/bypass.ts", rule: "live-world-read-outside-observer" },
      { path: "strategy/bypass.ts", rule: "persistent-root-outside-state" },
    ]);
  });

  it("rejects scenario-kit from the final esbuild input graph", () => {
    expect(() =>
      assertDeployableBundle({
        inputs: {
          "packages/bot/src/main.ts": { bytes: 1, imports: [] },
          "packages/scenario-kit/src/index.ts": { bytes: 1, imports: [] },
        },
        outputs: {},
      }),
    ).toThrow(/development-only/u);
  });
});
