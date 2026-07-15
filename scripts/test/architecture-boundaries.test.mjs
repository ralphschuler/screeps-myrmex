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

  it("keeps RuntimeConfigAuthority at its canonical declaration", () => {
    expect(
      findArchitectureViolations([
        {
          path: "economy/config.ts",
          contents: "export class RuntimeConfigAuthority {}",
        },
      ]),
    ).toEqual([{ path: "economy/config.ts", rule: "duplicate-authority:RuntimeConfigAuthority" }]);
  });

  it.each([
    [
      "config-internal-import-outside-config",
      "economy/planner.ts",
      'import { validateOverrides } from "../config/validation";',
    ],
    [
      "config-internal-import-outside-config",
      "telemetry/metrics.ts",
      'import { RuntimeConfigAuthority } from "../config/authority";',
    ],
    [
      "config-forbidden-dependency",
      "config/authority.ts",
      'import type { StateView } from "../state/schema";',
    ],
    [
      "config-forbidden-dependency",
      "config/bypass.ts",
      'import type { StateView } from "./../state/schema";',
    ],
    [
      "config-public-api-exposes-internal",
      "config/index.ts",
      'export { RuntimeConfigAuthority } from "./authority";',
    ],
    [
      "config-public-api-exposes-internal",
      "config/index.ts",
      'import { validateOverrides } from "./validation"; void validateOverrides;',
    ],
  ])("enforces %s", (rule, path, contents) => {
    expect(findArchitectureViolations([{ contents, path }])).toEqual([{ path, rule }]);
  });

  it("allows only the typed config barrel and the runtime authority adapter", () => {
    expect(
      findArchitectureViolations([
        {
          path: "config/authority.ts",
          contents:
            'import type { RuntimeConfig } from "./contracts"; ' +
            "export class RuntimeConfigAuthority { value!: RuntimeConfig; }",
        },
        {
          path: "config/index.ts",
          contents:
            'export type { RuntimeConfigResolutionMetadata } from "./authority-contracts"; ' +
            'export type { RuntimeConfig } from "./contracts"; ' +
            'export { isFeatureEnabled } from "./gates"; ' +
            'export { classifyPlayerRelation } from "./relations";',
        },
        {
          path: "economy/planner.ts",
          contents: 'import type { RuntimeConfig } from "../config"; void 0;',
        },
        {
          path: "runtime/tick.ts",
          contents:
            'import { RuntimeConfigAuthority } from "../config/authority"; ' +
            'manager.ownerView("config"); manager["transaction"](`config`); ' +
            "void RuntimeConfigAuthority;",
        },
      ]),
    ).toEqual([]);
  });

  it("rejects raw config-owner access outside the runtime adapter", () => {
    expect(
      findArchitectureViolations([
        {
          path: "economy/planner.ts",
          contents: 'manager.ownerView("config"); manager["transaction"](`config`);',
        },
      ]),
    ).toEqual([{ path: "economy/planner.ts", rule: "config-owner-access-outside-runtime" }]);

    expect(
      findArchitectureViolations([
        {
          path: "economy/planner.ts",
          contents: 'const owner = "config"; manager.ownerView(owner);',
        },
      ]),
    ).toEqual([{ path: "economy/planner.ts", rule: "config-owner-access-outside-runtime" }]);

    for (const contents of [
      'const { ownerView } = manager; ownerView("config");',
      'const { transaction: editOwner } = manager; editOwner("config");',
      'const readOwner = context.manager.ownerView; const alias = readOwner; alias("config");',
      'context.manager.ownerView("config");',
    ]) {
      expect(findArchitectureViolations([{ path: "defense/planner.ts", contents }])).toEqual([
        { path: "defense/planner.ts", rule: "config-owner-access-outside-runtime" },
      ]);
    }

    expect(
      findArchitectureViolations([
        { path: "economy/planner.ts", contents: 'database.transaction("orders");' },
      ]),
    ).toEqual([]);
  });

  it("allowlists public config symbols rather than whole internal modules", () => {
    for (const contents of [
      'export type { RuntimeConfigCandidate } from "./authority-contracts";',
      'export { SOURCE_FEATURE_GATES } from "./gates";',
      'export { resolveFeatureGates } from "./gates";',
      'import type { RuntimeConfigCandidate } from "./authority-contracts"; export type { RuntimeConfigCandidate };',
    ]) {
      expect(findArchitectureViolations([{ path: "config/index.ts", contents }])).toEqual([
        { path: "config/index.ts", rule: "config-public-api-exposes-internal" },
      ]);
    }
  });

  it("rejects numeric survival policy declarations outside canonical defaults", () => {
    expect(
      findArchitectureViolations([
        {
          path: "defense/policy.ts",
          contents:
            "const retryDelayTicks = 25; " +
            "export const policy = { tower: { emergencyReserveEnergy: 500 }, retryDelayTicks };",
        },
      ]),
    ).toEqual([{ path: "defense/policy.ts", rule: "policy-threshold-outside-config-defaults" }]);

    expect(
      findArchitectureViolations([
        {
          path: "config/defaults.ts",
          contents:
            "export const defaults = { tower: { emergencyReserveEnergy: 500 }, " +
            "safeMode: { retryDelayTicks: 25 } };",
        },
      ]),
    ).toEqual([]);

    expect(
      findArchitectureViolations([
        {
          path: "defense/planner.ts",
          contents:
            "const retryDelayTicks = config.policy.safeMode.retryDelayTicks; " +
            "export const decision = { retryDelayTicks };",
        },
      ]),
    ).toEqual([]);

    expect(
      findArchitectureViolations([
        {
          path: "defense/planner.ts",
          contents:
            "const bodyCap = 300; " + "export const decision = { maximumBodyEnergy: bodyCap };",
        },
      ]),
    ).toEqual([{ path: "defense/planner.ts", rule: "policy-threshold-outside-config-defaults" }]);
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
