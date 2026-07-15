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

function completeBoundarySources(runtimeContents) {
  return [
    { path: "colony/director.ts", contents: "" },
    { path: "contracts/contract-ledger.ts", contents: "" },
    { path: "execution/command-executor.ts", contents: "" },
    { path: "runtime/tick.ts", contents: runtimeContents },
    { path: "state/manager.ts", contents: "" },
  ];
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
    ["game-command-outside-executor", "colony/planner.ts", 'creep["attack"](source);'],
    ["per-creep-task-memory", "agents/worker.ts", 'creep.memory["task"] = "harvest";'],
    ["raw-memory-outside-segment-owner", "world/observe.ts", "RawMemory.setActiveSegments([]);"],
    ["inter-shard-memory-outside-shard-owner", "world/observe.ts", "InterShardMemory.getLocal();"],
  ])("detects %s", (rule, path, contents) => {
    expect(findArchitectureViolations([{ contents, path }])).toEqual([{ path, rule }]);
  });

  it("restricts movement and primary creep actions to their sole executors through aliases", () => {
    for (const [rule, contents] of [
      [
        "move-command-outside-movement-executor",
        "const move = creep.move; move.call(creep, RIGHT);",
      ],
      ["movement-shortcut-forbidden", "const route = creep.moveTo.bind(creep); route(target);"],
      ["movement-shortcut-forbidden", 'creep["moveByPath"].apply(creep, [path]);'],
      [
        "creep-action-command-outside-action-executor",
        "const { harvest } = creep; harvest.call(creep, source);",
      ],
      [
        "creep-action-command-outside-action-executor",
        "const action = creep.transfer; action.apply(creep, [sink, RESOURCE_ENERGY]);",
      ],
    ]) {
      expect(findArchitectureViolations([{ path: "colony/planner.ts", contents }])).toContainEqual({
        path: "colony/planner.ts",
        rule,
      });
    }
    expect(
      findArchitectureViolations([
        { path: "movement/executor.ts", contents: "creep.move(RIGHT); creep.harvest(source);" },
      ]),
    ).toEqual([]);
  });

  it("rejects direct, transitive, and destructured per-creep task memory aliases", () => {
    for (const contents of [
      'const memory = creep.memory; memory.task = "harvest";',
      'const memory = creep["memory"]; const alias = memory; alias["contractId"] = "c1";',
      "const first = creep.memory; const second = first; const third = second; third.lease = null;",
      "const { task: assignedTask } = creep.memory; void assignedTask;",
      "const memory = creep.memory; const { role } = memory; void role;",
      'const { memory } = creep; memory.task = "harvest";',
      "const { memory: { contractId } } = creep; void contractId;",
      'let memory; memory = creep.memory; const alias = memory; alias.role = "worker";',
      "let task; const memory = creep.memory; ({ task } = memory);",
    ]) {
      expect(findArchitectureViolations([{ path: "agents/worker.ts", contents }])).toEqual([
        { path: "agents/worker.ts", rule: "per-creep-task-memory" },
      ]);
    }
  });

  it("does not treat unrelated task objects or shadowed bindings as creep memory", () => {
    for (const contents of [
      'const details = config.details; const alias = details; alias.task = "harvest";',
      "const { task } = job; void task;",
      "const memory = creep.memory; function inspect(memory) { return memory.task; }",
      'const memory = creep.memory; { const memory = cache; memory.role = "reader"; }',
      'const { memory: metadata } = cache; metadata.label = "snapshot";',
    ]) {
      expect(findArchitectureViolations([{ path: "agents/worker.ts", contents }])).toEqual([]);
    }
  });

  it.each([
    ["CacheManager", "economy/cache.ts"],
    ["ContractLedger", "economy/contracts.ts"],
    ["SpawnBroker", "economy/spawn-broker.ts"],
    ["SpawnExecutor", "execution/spawn-executor.ts"],
    ["WorkforceAllocator", "colony/workforce.ts"],
  ])("detects a duplicate %s authority declaration", (authority, path) => {
    expect(
      findArchitectureViolations([{ path, contents: `export class ${authority} {}` }]),
    ).toEqual([{ path, rule: `duplicate-authority:${authority}` }]);
  });

  it("keeps spawn authorities at their exact canonical paths", () => {
    expect(
      findArchitectureViolations([
        { path: "spawn/spawn-broker.ts", contents: "export class SpawnBroker {}" },
        { path: "spawn/spawn-executor.ts", contents: "export class SpawnExecutor {}" },
      ]),
    ).toEqual([]);
  });

  it("rejects contracts-owner writes outside ContractLedger", () => {
    for (const contents of [
      'manager.transaction("contracts");',
      'manager["transaction"](`contracts`);',
      'const { transaction: edit } = manager; edit("contracts");',
      'const edit = manager.transaction; const alias = edit; alias("contracts");',
      'const edit = manager.transaction.bind(manager); edit("contracts");',
      'manager.transaction.call(manager, "contracts");',
      'manager["transaction"].apply(manager, ["contracts"]);',
      'const edit = manager.transaction; edit.call(manager, "contracts");',
      'let edit; edit = manager.transaction; edit("contracts");',
      'let edit; ({ transaction: edit } = manager); edit("contracts");',
    ]) {
      expect(
        findArchitectureViolations([{ path: "contracts/workforce-allocator.ts", contents }]),
      ).toEqual([
        {
          path: "contracts/workforce-allocator.ts",
          rule: "contracts-state-write-outside-ledger",
        },
      ]);
    }
  });

  it("rejects raw contracts-owner reads outside the runtime adapter", () => {
    for (const contents of [
      'manager.ownerView("contracts");',
      'manager["ownerView"](`contracts`);',
      'const { ownerView: read } = manager; read("contracts");',
      'const read = manager.ownerView; const alias = read; alias("contracts");',
      'const read = manager.ownerView.bind(manager); read("contracts");',
      'manager.ownerView.call(manager, "contracts");',
      'manager["ownerView"].apply(manager, ["contracts"]);',
      'const read = manager.ownerView; read.apply(manager, ["contracts"]);',
      'let read; read = manager.ownerView; read("contracts");',
      'let read; ({ ownerView: read } = manager); read("contracts");',
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([
        { path: "economy/planner.ts", rule: "contracts-owner-read-outside-runtime" },
      ]);
    }
    expect(
      findArchitectureViolations([
        { path: "runtime/tick.ts", contents: 'manager.ownerView("contracts");' },
      ]),
    ).toEqual([]);
  });

  it("respects lexical shadowing for owner method aliases and invocation helpers", () => {
    for (const contents of [
      'const edit = manager.transaction; function run(edit) { edit("contracts"); }',
      'const read = manager.ownerView; function run(read) { read.call(null, "contracts"); }',
      'const edit = manager.transaction.bind(manager); { const edit = callback; edit("contracts"); }',
      'function run(transaction) { transaction("contracts"); }',
      'function run(ownerView) { ownerView.apply(null, ["contracts"]); }',
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([]);
    }
  });

  it("allows the canonical contract authorities and ledger-owned transaction", () => {
    expect(
      findArchitectureViolations([
        {
          path: "contracts/contract-ledger.ts",
          contents:
            'export class ContractLedger { reconcile(manager) { manager.transaction("contracts"); } }',
        },
        {
          path: "contracts/workforce-allocator.ts",
          contents: "export class WorkforceAllocator {}",
        },
      ]),
    ).toEqual([]);
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

  it("constructs BudgetLedger only inside the canonical colony authority boundary", () => {
    expect(
      findArchitectureViolations([
        { path: "colony/director.ts", contents: "const ledger = new BudgetLedger(); void ledger;" },
      ]),
    ).toEqual([]);

    for (const contents of [
      "const ledger = new BudgetLedger(); void ledger;",
      'import { BudgetLedger as Ledger } from "../colony"; new Ledger();',
      "const Ledger = BudgetLedger; new Ledger();",
      "const first = BudgetLedger; const second = first; new second();",
      "const { BudgetLedger: Ledger } = colony; new Ledger();",
      "let Ledger; ({ BudgetLedger: Ledger } = colony); new Ledger();",
      "const BoundLedger = BudgetLedger.bind(null); new BoundLedger();",
      "Reflect.construct(BudgetLedger, []);",
    ]) {
      expect(findArchitectureViolations([{ path: "spawn/spawn-broker.ts", contents }])).toEqual([
        {
          path: "spawn/spawn-broker.ts",
          rule: "budget-ledger-construction-outside-colony-authority",
        },
      ]);
    }
  });

  it("respects lexical shadowing for BudgetLedger constructor aliases", () => {
    for (const contents of [
      "function make(BudgetLedger) { return new BudgetLedger(); }",
      "const Ledger = BudgetLedger; function make(Ledger) { return new Ledger(); }",
    ]) {
      expect(findArchitectureViolations([{ path: "spawn/spawn-broker.ts", contents }])).toEqual([]);
    }
  });

  it.each([
    ["BudgetLedger", "economy/budget.ts", "duplicate-authority:BudgetLedger"],
    ["ColonyDirector", "economy/colony.ts", "duplicate-authority:ColonyDirector"],
  ])("keeps %s at its canonical declaration", (authority, path, rule) => {
    expect(
      findArchitectureViolations([{ path, contents: `export class ${authority} {}` }]),
    ).toEqual([{ path, rule }]);
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
      'manager.ownerView.call(manager, "config");',
      'const editOwner = manager.transaction.bind(manager); editOwner("config");',
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

  it("rejects raw colony-owner access outside the runtime adapter", () => {
    for (const contents of [
      'manager.ownerView("colonies"); manager.transaction("colonies");',
      'const { ownerView } = manager; ownerView("colonies");',
      'context.manager["transaction"](`colonies`);',
      'manager["ownerView"].apply(manager, ["colonies"]);',
      'let edit; edit = manager.transaction; edit("colonies");',
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([
        { path: "economy/planner.ts", rule: "colonies-owner-access-outside-runtime" },
      ]);
    }
    expect(
      findArchitectureViolations([
        {
          path: "runtime/tick.ts",
          contents: 'manager.ownerView("colonies"); manager.transaction("colonies");',
        },
      ]),
    ).toEqual([]);
  });

  it("requires exactly one canonical colonies transaction and one root commit call site", () => {
    expect(
      findArchitectureViolations(
        completeBoundarySources('manager.transaction("colonies"); manager.commitReconciliation();'),
      ),
    ).toEqual([]);

    expect(
      findArchitectureViolations(completeBoundarySources("manager.commitReconciliation();")),
    ).toEqual([{ path: "runtime/tick.ts", rule: "colonies-transaction-callsite-count" }]);

    expect(
      findArchitectureViolations(completeBoundarySources('manager.transaction("colonies");')),
    ).toEqual([{ path: "runtime/tick.ts", rule: "root-commit-callsite-count" }]);

    expect(
      findArchitectureViolations(
        completeBoundarySources(
          'manager.transaction("colonies"); manager.transaction("colonies"); ' +
            "manager.commitReconciliation();",
        ),
      ),
    ).toEqual([{ path: "runtime/tick.ts", rule: "colonies-transaction-callsite-count" }]);

    expect(
      findArchitectureViolations(
        completeBoundarySources(
          'manager.transaction("colonies"); manager.commitReconciliation(); ' +
            "manager.commitReconciliation();",
        ),
      ),
    ).toEqual([{ path: "runtime/tick.ts", rule: "root-commit-callsite-count" }]);
  });

  it("rejects dynamic owner transaction arguments at the static authority boundary", () => {
    expect(
      findArchitectureViolations([
        {
          path: "runtime/tick.ts",
          contents: 'const owner = "colonies"; manager.transaction(owner);',
        },
      ]),
    ).toEqual([
      { path: "runtime/tick.ts", rule: "memory-owner-transaction-requires-static-literal" },
    ]);
  });

  it("rejects direct and aliased root reconciliation commits outside runtime", () => {
    for (const contents of [
      "manager.commitReconciliation();",
      "const commit = manager.commitReconciliation; commit();",
      "const commit = manager.commitReconciliation; const alias = commit; alias();",
      "const commit = manager.commitReconciliation.bind(manager); commit();",
      "manager.commitReconciliation.call(manager);",
      "manager.commitReconciliation.apply(manager, []);",
      "let commit; commit = manager.commitReconciliation; commit();",
      "let commit; ({ commitReconciliation: commit } = manager); commit();",
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([
        { path: "economy/planner.ts", rule: "root-commit-outside-runtime" },
      ]);
    }
  });

  it("respects lexical shadowing for root commit aliases", () => {
    for (const contents of [
      "const commit = manager.commitReconciliation; function run(commit) { commit(); }",
      "function run(commitReconciliation) { commitReconciliation(); }",
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([]);
    }
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
      findArchitectureViolations([
        { path: "execution/arbiter.ts", contents: "creep.attack(target);" },
      ]),
    ).toEqual([{ path: "execution/arbiter.ts", rule: "game-command-outside-executor" }]);
  });

  it("allows spawnCreep only in the exact canonical SpawnExecutor", () => {
    expect(
      findArchitectureViolations([
        {
          path: "spawn/spawn-executor.ts",
          contents:
            "export class SpawnExecutor { run(spawn, body, name) { " +
            "return spawn.spawnCreep(body, name); } }",
        },
      ]),
    ).toEqual([]);

    for (const path of [
      "spawn/fake-executor-helper.ts",
      "spawn/executors/spawn.ts",
      "execution/spawn-executor.ts",
    ]) {
      expect(
        findArchitectureViolations([{ path, contents: "spawn.spawnCreep(body, name);" }]),
      ).toContainEqual({ path, rule: "spawn-command-outside-spawn-executor" });
    }
  });

  it("rejects direct, destructured, transitive, bound, call, and apply spawnCreep aliases", () => {
    for (const contents of [
      'spawn["spawnCreep"](body, name);',
      "const { spawnCreep: issue } = spawn; issue(body, name);",
      "const issue = spawn.spawnCreep; const alias = issue; alias(body, name);",
      "let issue; issue = spawn.spawnCreep; issue(body, name);",
      "let issue; ({ spawnCreep: issue } = spawn); issue(body, name);",
      "const issue = spawn.spawnCreep.bind(spawn); issue(body, name);",
      "spawn.spawnCreep.call(spawn, body, name);",
      "spawn.spawnCreep.apply(spawn, [body, name]);",
      "const issue = spawn.spawnCreep; issue.call(spawn, body, name);",
      "const issue = spawn.spawnCreep; issue.apply(spawn, [body, name]);",
      "function run({ spawnCreep: issue }) { issue(body, name); }",
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([
        { path: "economy/planner.ts", rule: "game-command-outside-executor" },
        { path: "economy/planner.ts", rule: "spawn-command-outside-spawn-executor" },
      ]);
    }
  });

  it("respects lexical shadowing for spawnCreep aliases", () => {
    for (const contents of [
      "const issue = spawn.spawnCreep; function run(issue) { issue(body, name); }",
      "const issue = spawn.spawnCreep; { const issue = callback; issue(body, name); }",
      "function run(spawnCreep) { spawnCreep(body, name); }",
      "function run({ spawnCreep }) { function nested(spawnCreep) { spawnCreep(); } }",
    ]) {
      expect(findArchitectureViolations([{ path: "economy/planner.ts", contents }])).toEqual([]);
    }
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

  it("rejects direct and aliased Game.spawns access outside observation", () => {
    for (const contents of [
      "const spawns = Game.spawns; void spawns;",
      'const spawns = Game["spawns"]; void spawns;',
      "const game = Game; const spawns = game.spawns; void spawns;",
      'const first = Game; const second = first; const spawns = second["spawns"]; void spawns;',
      "const game = Game; const { spawns } = game; void spawns;",
      "let spawns; const game = Game; ({ spawns } = game); void spawns;",
      "const game = Game; const { ...allGameState } = game; void allGameState;",
    ]) {
      expect(findArchitectureViolations([{ path: "spawn/spawn-broker.ts", contents }])).toEqual([
        { path: "spawn/spawn-broker.ts", rule: "live-world-read-outside-observer" },
      ]);
    }
  });

  it("allows observation code to read Game.spawns through a local alias", () => {
    expect(
      findArchitectureViolations([
        {
          path: "world/observe.ts",
          contents: "const game = Game; const { spawns } = game; void spawns;",
        },
      ]),
    ).toEqual([]);
  });

  it("allows only runtime composition to capture the narrow live object resolver", () => {
    expect(
      findArchitectureViolations([
        { path: "runtime/tick.ts", contents: "const resolve = game.getObjectById; void resolve;" },
      ]),
    ).toEqual([]);
    expect(
      findArchitectureViolations([
        {
          path: "spawn/spawn-broker.ts",
          contents: "const resolve = game.getObjectById; void resolve;",
        },
      ]),
    ).toEqual([{ path: "spawn/spawn-broker.ts", rule: "live-world-read-outside-observer" }]);
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
