import { posix } from "node:path";
import ts from "typescript";

const COMMAND_METHODS = new Set([
  "activateSafeMode",
  "attack",
  "attackController",
  "boostCreep",
  "build",
  "cancelOrder",
  "changeOrderPrice",
  "claimController",
  "createConstructionSite",
  "createOrder",
  "deal",
  "destroy",
  "dismantle",
  "drop",
  "generateSafeMode",
  "harvest",
  "heal",
  "launchNuke",
  "move",
  "moveByPath",
  "moveTo",
  "notifyWhenAttacked",
  "observeRoom",
  "pickup",
  "processPower",
  "produce",
  "rangedAttack",
  "rangedHeal",
  "rangedMassAttack",
  "recycleCreep",
  "renewCreep",
  "repair",
  "reserveController",
  "runReaction",
  "send",
  "setPublic",
  "signController",
  "spawnCreep",
  "suicide",
  "transfer",
  "upgradeController",
  "withdraw",
]);

const RAW_MEMORY_SEGMENT_MEMBERS = new Set([
  "foreignSegment",
  "segments",
  "setActiveForeignSegment",
  "setActiveSegments",
  "setDefaultPublicSegment",
  "setPublicSegments",
]);

const PER_CREEP_TASK_MEMORY_MEMBERS = new Set(["contractId", "lease", "role", "task"]);

const CONFIG_OWNER_METHODS = new Set(["ownerView", "transaction"]);

const ROOT_COMMIT_METHODS = new Set(["commitReconciliation"]);

const SPAWN_BROKER_PATH = "spawn/spawn-broker.ts";
const SPAWN_EXECUTOR_PATH = "spawn/spawn-executor.ts";
const OBSERVER_EXECUTOR_PATH = "observer/executor.ts";
const MATURE_EXECUTOR_PATH = "industry/mature-executor.ts";
const MOVEMENT_EXECUTOR_PATH = "movement/executor.ts";
const CREEP_ACTION_EXECUTOR_PATH = "movement/executor.ts";
const DEFENSE_EXECUTOR_PATH = "defense/defense-executor.ts";
const COLONY_AUTHORITY_PATH = "colony/director.ts";
const RUNTIME_COMPOSITION_PATH = "runtime/tick.ts";
const LOCAL_PATH_ADAPTER_PATH = "runtime/local-path-adapter.ts";
const CONSOLE_REPORTER_PATH = "telemetry/console-reporter.ts";

const COMPLETE_SOURCE_SENTINELS = new Set([
  "colony/director.ts",
  "contracts/contract-ledger.ts",
  "execution/command-executor.ts",
  "runtime/tick.ts",
  "state/manager.ts",
]);

const CONFIG_PUBLIC_MODULES = new Set(["", "index"]);

const CONFIG_PUBLIC_EXPORTS = new Map([
  [
    "authority-contracts",
    new Set([
      "RuntimeConfigResolutionMetadata",
      "RuntimeConfigResolutionReason",
      "RuntimeConfigResolutionStatus",
    ]),
  ],
  [
    "contracts",
    new Set([
      "ConfiguredRelations",
      "CriticalRepairPolicy",
      "FEATURE_GATE_IDS",
      "FeatureGateDecision",
      "FeatureGateId",
      "FeatureGateReason",
      "LeasePolicy",
      "MovementPolicy",
      "PLAYER_RELATIONS",
      "PlayerRelation",
      "RUNTIME_CONFIG_SCHEMA_VERSION",
      "RecoveryPolicy",
      "RelationDecision",
      "RelationDecisionReason",
      "RelationDecisionRequest",
      "ReputationStatus",
      "RetryPolicy",
      "RuntimeConfig",
      "RuntimeFeatureGates",
      "SafeModePolicy",
      "SpawnPolicy",
      "SurvivalPolicy",
      "TARGETING_CEILINGS",
      "TargetingCeiling",
      "TowerPolicy",
    ]),
  ],
  ["gates", new Set(["isFeatureEnabled"])],
  ["relations", new Set(["classifyPlayerRelation"])],
]);

/**
 * These are policy values, not observed game data. A consumer may read them from RuntimeConfig,
 * but it must not recreate a numeric threshold object beside a planner or executor.
 */
const RUNTIME_POLICY_FIELDS = new Set([
  "blockedReleaseTicks",
  "completionHitsBasisPoints",
  "controllerRiskWindowTicks",
  "criticalAssetHitsBasisPoints",
  "criticalHitsBasisPoints",
  "durationTicks",
  "emergencyReserveEnergy",
  "emergencyWorkerEnergyBudget",
  "initialDelayTicks",
  "lossPredictionHorizonTicks",
  "maximumActiveContractsPerRoom",
  "maximumAttempts",
  "maximumBodyEnergy",
  "maximumBodyParts",
  "maximumDelayTicks",
  "maximumEnergyPerTick",
  "maximumNonMovePartsPerMovePart",
  "maximumPathCost",
  "maximumSearchOperations",
  "minimumHostileOffenseParts",
  "nameCollisionRetryLimit",
  "protectedSpawnEnergy",
  "renewalWindowTicks",
  "repairMinimumEnergy",
  "replacementSafetyMarginTicks",
  "retryDelayTicks",
  "stuckReplanTicks",
]);

const AUTHORITY_DECLARATIONS = new Map([
  ["BudgetLedger", "colony/budget-ledger.ts"],
  ["CacheManager", "cache/cache-manager.ts"],
  ["ColonyDirector", "colony/director.ts"],
  ["ContractLedger", "contracts/contract-ledger.ts"],
  ["CpuScheduler", "runtime/kernel/cpu-scheduler.ts"],
  ["MemoryManager", "state/manager.ts"],
  ["RuntimeConfigAuthority", "config/authority.ts"],
  ["RuntimeKernel", "runtime/kernel/runtime-kernel.ts"],
  ["SpawnBroker", SPAWN_BROKER_PATH],
  ["SpawnExecutor", SPAWN_EXECUTOR_PATH],
  ["WorkforceAllocator", "contracts/workforce-allocator.ts"],
]);

export function findArchitectureViolations(sources) {
  const violations = [];
  let coloniesTransactionCalls = 0;
  let rootCommitCalls = 0;

  for (const { contents, path } of sources) {
    const inspection = inspectSource(contents, path);
    coloniesTransactionCalls += inspection.coloniesTransactionCalls;
    rootCommitCalls += inspection.rootCommitCalls;
    for (const rule of inspection.rules) {
      violations.push({ path, rule });
    }
  }

  const paths = new Set(sources.map(({ path }) => path));
  if ([...COMPLETE_SOURCE_SENTINELS].every((path) => paths.has(path))) {
    if (coloniesTransactionCalls !== 1) {
      violations.push({
        path: RUNTIME_COMPOSITION_PATH,
        rule: "colonies-transaction-callsite-count",
      });
    }
    if (rootCommitCalls !== 1) {
      violations.push({ path: RUNTIME_COMPOSITION_PATH, rule: "root-commit-callsite-count" });
    }
  }

  const uniqueViolations = [
    ...new Map(
      violations.map((violation) => [`${violation.path}\u0000${violation.rule}`, violation]),
    ).values(),
  ];
  return uniqueViolations.sort((left, right) =>
    left.path === right.path
      ? compareStrings(left.rule, right.rule)
      : compareStrings(left.path, right.path),
  );
}

function inspectSource(contents, path) {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rules = new Set();
  const numericLiteralBindings = collectNumericLiteralBindings(source);
  const ownerMethodCalls = collectMethodCallAnalysis(source, CONFIG_OWNER_METHODS);
  const commandMethodCalls = collectMethodCallAnalysis(source, COMMAND_METHODS);
  const rootCommitMethodCalls = collectMethodCallAnalysis(source, ROOT_COMMIT_METHODS);
  const gameAccess = collectGlobalObjectAccessAnalysis(source, "Game");
  const budgetLedgerConstructions = collectConstructorAnalysis(source, "BudgetLedger");
  const perCreepTaskMemory = collectPerCreepTaskMemoryAnalysis(source);
  let coloniesTransactionCalls = 0;
  let rootCommitCalls = 0;

  function addUnlessAllowed(rule, allowed) {
    if (!allowed) {
      rules.add(rule);
    }
  }

  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      rules.add("unsafe-dynamic-or-console-primitive");
    }

    const moduleName = moduleSpecifier(node);
    if (
      ts.isIdentifier(node) &&
      ((node.text === "PathFinder" && path !== LOCAL_PATH_ADAPTER_PATH) ||
        (node.text === "RoomPosition" &&
          path !== LOCAL_PATH_ADAPTER_PATH &&
          path !== "world/observe.ts"))
    ) {
      rules.add("pathfinder-engine-access-outside-runtime-adapter");
    }
    if (moduleName?.includes("scenario-kit") === true) {
      rules.add("deployable-source-imports-scenario-kit");
    }
    if (moduleName !== null && moduleName !== undefined) {
      if (isConfigPath(path) && isForbiddenConfigDependency(moduleName, path)) {
        rules.add("config-forbidden-dependency");
      }

      const configModule = configModuleEntry(moduleName);
      if (
        configModule !== null &&
        !isConfigPath(path) &&
        !CONFIG_PUBLIC_MODULES.has(configModule) &&
        !(path === "runtime/tick.ts" && configModule === "authority")
      ) {
        rules.add("config-internal-import-outside-config");
      }
    }

    if (path === "config/index.ts") {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportAssignment(node) ||
        (ts.isExportDeclaration(node) && !isAllowedConfigPublicExport(node, path)) ||
        (!ts.isExportDeclaration(node) && hasExportModifier(node))
      ) {
        rules.add("config-public-api-exposes-internal");
      }
    }

    if (ts.isCallExpression(node)) {
      const called = node.expression;
      if (
        ts.isPropertyAccessExpression(called) &&
        ts.isIdentifier(called.expression) &&
        called.expression.text === "console"
      ) {
        addUnlessAllowed(
          "production-console-output-outside-console-adapter",
          path === CONSOLE_REPORTER_PATH,
        );
      }
      if (
        (ts.isIdentifier(called) && (called.text === "eval" || called.text === "Function")) ||
        (ts.isPropertyAccessExpression(called) &&
          ts.isIdentifier(called.expression) &&
          called.expression.text === "console" &&
          called.name.text === "logUnsafe")
      ) {
        rules.add("unsafe-dynamic-or-console-primitive");
      }
      const commandMethodCall = commandMethodCalls.resolve(node);
      if (commandMethodCall !== null) {
        addUnlessAllowed("game-command-outside-executor", isExecutorPath(path));
        if (commandMethodCall.methods.has("spawnCreep")) {
          addUnlessAllowed("spawn-command-outside-spawn-executor", path === SPAWN_EXECUTOR_PATH);
        }
        if (commandMethodCall.methods.has("observeRoom")) {
          addUnlessAllowed(
            "observer-command-outside-observer-executor",
            path === OBSERVER_EXECUTOR_PATH,
          );
        }
        if (commandMethodCall.methods.has("produce")) {
          addUnlessAllowed(
            "factory-command-outside-mature-executor",
            path === MATURE_EXECUTOR_PATH,
          );
        }
        if (commandMethodCall.methods.has("processPower")) {
          addUnlessAllowed(
            "power-process-command-outside-mature-executor",
            path === MATURE_EXECUTOR_PATH,
          );
        }
        if (commandMethodCall.methods.has("launchNuke")) {
          rules.add("nuke-launch-before-operations-forbidden");
        }
        if (commandMethodCall.methods.has("move")) {
          addUnlessAllowed(
            "move-command-outside-movement-executor",
            path === MOVEMENT_EXECUTOR_PATH,
          );
        }
        if (
          commandMethodCall.methods.has("moveTo") ||
          commandMethodCall.methods.has("moveByPath")
        ) {
          rules.add("movement-shortcut-forbidden");
        }
        if (
          [
            "harvest",
            "transfer",
            "withdraw",
            "pickup",
            "upgradeController",
            "build",
            "repair",
          ].some((method) => commandMethodCall.methods.has(method))
        ) {
          addUnlessAllowed(
            "creep-action-command-outside-action-executor",
            path === CREEP_ACTION_EXECUTOR_PATH ||
              (path === DEFENSE_EXECUTOR_PATH &&
                [...commandMethodCall.methods].every((method) =>
                  ["attack", "heal", "repair", "activateSafeMode"].includes(method),
                )),
          );
        }
      }
      const ownerMethodCall = ownerMethodCalls.resolve(node);
      const calledOwnerView = ownerMethodCall?.methods.has("ownerView") === true;
      const calledTransaction = ownerMethodCall?.methods.has("transaction") === true;
      const ownerArgument = ownerMethodCall?.ownerArgument;
      if (
        ownerMethodCall !== null &&
        (stringLiteralValue(ownerArgument) === "config" ||
          stringLiteralValue(ownerArgument) === null)
      ) {
        addUnlessAllowed("config-owner-access-outside-runtime", path === "runtime/tick.ts");
      }
      if (ownerMethodCall !== null && stringLiteralValue(ownerArgument) === "colonies") {
        addUnlessAllowed("colonies-owner-access-outside-runtime", path === "runtime/tick.ts");
        if (calledTransaction) {
          coloniesTransactionCalls += 1;
        }
      }
      if (calledTransaction && stringLiteralValue(ownerArgument) === null) {
        rules.add("memory-owner-transaction-requires-static-literal");
      }
      if (calledOwnerView && stringLiteralValue(ownerArgument) === "contracts") {
        addUnlessAllowed("contracts-owner-read-outside-runtime", path === "runtime/tick.ts");
      }
      if (calledTransaction && stringLiteralValue(ownerArgument) === "contracts") {
        addUnlessAllowed(
          "contracts-state-write-outside-ledger",
          path === "contracts/contract-ledger.ts",
        );
      }

      const rootCommitMethodCall = rootCommitMethodCalls.resolve(node);
      if (rootCommitMethodCall?.methods.has("commitReconciliation") === true) {
        rootCommitCalls += 1;
        addUnlessAllowed("root-commit-outside-runtime", path === RUNTIME_COMPOSITION_PATH);
      }
    }

    if (budgetLedgerConstructions.isConstruction(node)) {
      addUnlessAllowed(
        "budget-ledger-construction-outside-colony-authority",
        path === COLONY_AUTHORITY_PATH,
      );
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (
        name !== null &&
        RUNTIME_POLICY_FIELDS.has(name) &&
        (isNumericPolicyLiteral(node.initializer) ||
          (ts.isIdentifier(node.initializer) && numericLiteralBindings.has(node.initializer.text)))
      ) {
        addUnlessAllowed("policy-threshold-outside-config-defaults", path === "config/defaults.ts");
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      RUNTIME_POLICY_FIELDS.has(node.name.text) &&
      node.initializer !== undefined &&
      isNumericPolicyLiteral(node.initializer)
    ) {
      addUnlessAllowed("policy-threshold-outside-config-defaults", path === "config/defaults.ts");
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isIdentifier(initializer)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          const member =
            ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : null;
          if (initializer.text === "Memory" && member === "myrmex") {
            addUnlessAllowed("persistent-root-outside-state", path.startsWith("state/"));
          }
          if (
            initializer.text === "Game" &&
            (member === "creeps" ||
              member === "getObjectById" ||
              member === "rooms" ||
              member === "spawns")
          ) {
            addUnlessAllowed(
              "live-world-read-outside-observer",
              isLiveWorldReadAllowed(path, member),
            );
          }
          if (initializer.text === "Game" && member === "cpu") {
            addUnlessAllowed("cpu-source-outside-runtime", path.startsWith("runtime/"));
          }
        }
      }
    }

    const access = memberAccess(node);
    if (access !== null) {
      if ((access.owner === "Memory" || access.owner === "memory") && access.member === "myrmex") {
        addUnlessAllowed("persistent-root-outside-state", path.startsWith("state/"));
      }
      if (
        (access.owner === "Game" || access.owner === "game") &&
        (access.member === "creeps" ||
          access.member === "getObjectById" ||
          access.member === "rooms" ||
          access.member === "spawns")
      ) {
        addUnlessAllowed(
          "live-world-read-outside-observer",
          isLiveWorldReadAllowed(path, access.member),
        );
      }
      if ((access.owner === "Game" || access.owner === "game") && access.member === "cpu") {
        addUnlessAllowed("cpu-source-outside-runtime", path.startsWith("runtime/"));
      }
      if (access.owner === "RawMemory" && RAW_MEMORY_SEGMENT_MEMBERS.has(access.member)) {
        addUnlessAllowed("raw-memory-outside-segment-owner", path.startsWith("segments/"));
      }
      if (access.owner === "InterShardMemory") {
        addUnlessAllowed(
          "inter-shard-memory-outside-shard-owner",
          path.startsWith("intershard/") || path.startsWith("shards/"),
        );
      }
    }
    if (accessesGlobalMember(node, gameAccess, "spawns")) {
      addUnlessAllowed("live-world-read-outside-observer", path.startsWith("world/"));
    }
    if (isPerCreepTaskMemoryAccess(node, perCreepTaskMemory)) {
      rules.add("per-creep-task-memory");
    }

    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const expectedPath = AUTHORITY_DECLARATIONS.get(node.name.text);
      if (expectedPath !== undefined && path !== expectedPath) {
        rules.add(`duplicate-authority:${node.name.text}`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  if (path === RUNTIME_COMPOSITION_PATH && coloniesTransactionCalls > 1) {
    rules.add("colonies-transaction-callsite-count");
  }
  if (path === RUNTIME_COMPOSITION_PATH && rootCommitCalls > 1) {
    rules.add("root-commit-callsite-count");
  }
  return { rules, coloniesTransactionCalls, rootCommitCalls };
}

function isLiveWorldReadAllowed(path, member) {
  return (
    path.startsWith("world/") || (path === RUNTIME_COMPOSITION_PATH && member === "getObjectById")
  );
}

function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }

  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }

  return null;
}

function isConfigPath(path) {
  return path.startsWith("config/");
}

function isForbiddenConfigDependency(moduleName, sourcePath) {
  const normalized = stripModuleExtension(moduleName.replaceAll("\\", "/"));
  if (normalized.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), normalized));
    return !(
      resolved === "config" ||
      resolved.startsWith("config/") ||
      resolved === "core" ||
      resolved.startsWith("core/")
    );
  }
  return normalized !== "@myrmex/core";
}

function isAllowedConfigPublicExport(node, sourcePath) {
  if (
    node.moduleSpecifier === undefined ||
    !ts.isStringLiteralLike(node.moduleSpecifier) ||
    node.exportClause === undefined ||
    !ts.isNamedExports(node.exportClause)
  ) {
    return false;
  }

  const moduleName = stripModuleExtension(node.moduleSpecifier.text.replaceAll("\\", "/"));
  const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), moduleName));
  const entry = resolved.startsWith("config/") ? resolved.slice("config/".length) : null;
  const allowed = entry === null ? undefined : CONFIG_PUBLIC_EXPORTS.get(entry);
  return (
    allowed !== undefined &&
    node.exportClause.elements.every((element) => {
      const importedName = (element.propertyName ?? element.name).text;
      return importedName === element.name.text && allowed.has(importedName);
    })
  );
}

function hasExportModifier(node) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function collectNumericLiteralBindings(source) {
  const bindings = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isNumericPolicyLiteral(node.initializer)
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function collectMethodCallAnalysis(source, trackedMethods) {
  const resolveBinding = createBindingResolver(source);
  const methodsByBinding = new Map();
  const aliasEdges = [];

  const addMethod = (binding, method) => {
    let methods = methodsByBinding.get(binding);
    if (methods === undefined) {
      methods = new Set();
      methodsByBinding.set(binding, methods);
    }
    methods.add(method);
  };

  const addSource = (target, expression) => {
    const sourceValue = trackedMethodSource(expression, resolveBinding, trackedMethods);
    if (sourceValue?.method !== undefined) {
      addMethod(target, sourceValue.method);
    } else if (sourceValue?.binding !== undefined) {
      aliasEdges.push({ source: sourceValue.binding, target });
    }
  };

  const addBindingPattern = (pattern) => {
    for (const element of pattern.elements) {
      const method = propertyName(element.propertyName ?? element.name);
      if (method !== null && trackedMethods.has(method) && ts.isIdentifier(element.name)) {
        addMethod(element.name, method);
      }
    }
  };

  const addAssignmentPattern = (pattern) => {
    for (const property of pattern.properties) {
      if (ts.isSpreadAssignment(property)) {
        continue;
      }
      const method = propertyName(property.name);
      const target = assignmentTarget(property);
      if (method !== null && trackedMethods.has(method) && target !== null) {
        const binding = resolveBinding(target);
        if (binding !== null) {
          addMethod(binding, method);
        }
      }
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        addSource(node.name, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        addBindingPattern(node.name);
      }
    }
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      addBindingPattern(node.name);
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = identifierExpression(node.left);
      if (target !== null) {
        const targetBinding = resolveBinding(target);
        if (targetBinding !== null) {
          addSource(targetBinding, node.right);
        }
      } else {
        const pattern = objectAssignmentPattern(node.left);
        if (pattern !== null) {
          addAssignmentPattern(pattern);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of aliasEdges) {
      const sourceMethods = methodsByBinding.get(edge.source);
      if (sourceMethods === undefined) {
        continue;
      }
      for (const method of sourceMethods) {
        const targetMethods = methodsByBinding.get(edge.target);
        if (targetMethods?.has(method) === true) {
          continue;
        }
        addMethod(edge.target, method);
        changed = true;
      }
    }
  }

  const callableMethods = (expression) => {
    const sourceValue = trackedMethodSource(expression, resolveBinding, trackedMethods);
    if (sourceValue?.method !== undefined) {
      return new Set([sourceValue.method]);
    }
    if (sourceValue?.binding !== undefined) {
      return new Set(methodsByBinding.get(sourceValue.binding) ?? []);
    }
    return new Set();
  };

  return {
    resolve(call) {
      const calledExpression = unwrapExpression(call.expression);
      if (
        ts.isPropertyAccessExpression(calledExpression) ||
        ts.isElementAccessExpression(calledExpression)
      ) {
        const helper = terminalMemberName(calledExpression);
        if (helper === "bind") {
          return null;
        }
        if (helper === "call" || helper === "apply") {
          const methods = callableMethods(calledExpression.expression);
          if (methods.size === 0) {
            return null;
          }
          return {
            methods,
            ownerArgument:
              helper === "call"
                ? call.arguments[1]
                : firstStaticallyAppliedArgument(call.arguments[1]),
          };
        }
      }

      const methods = callableMethods(calledExpression);
      return methods.size === 0 ? null : { methods, ownerArgument: call.arguments[0] };
    },
  };
}

function trackedMethodSource(node, resolveBinding, trackedMethods) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const method = terminalMemberName(expression);
    return method !== null && trackedMethods.has(method) ? { method } : null;
  }
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression);
    if (binding !== null) {
      return { binding };
    }
    return trackedMethods.has(expression.text) ? { method: expression.text } : null;
  }
  if (ts.isCallExpression(expression)) {
    const calledExpression = unwrapExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(calledExpression) ||
        ts.isElementAccessExpression(calledExpression)) &&
      terminalMemberName(calledExpression) === "bind"
    ) {
      return trackedMethodSource(calledExpression.expression, resolveBinding, trackedMethods);
    }
  }
  return null;
}

function collectGlobalObjectAccessAnalysis(source, globalName) {
  const resolveBinding = createBindingResolver(source);
  const aliases = new Set();
  const aliasEdges = [];

  const addSource = (target, expression) => {
    const sourceValue = globalObjectSource(expression, resolveBinding, aliases, globalName);
    if (sourceValue?.global === true) {
      aliases.add(target);
    } else if (sourceValue?.binding !== undefined) {
      aliasEdges.push({ source: sourceValue.binding, target });
    }
  };

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      addSource(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = identifierExpression(node.left);
      if (target !== null) {
        const binding = resolveBinding(target);
        if (binding !== null) {
          addSource(binding, node.right);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of aliasEdges) {
      if (aliases.has(edge.source) && !aliases.has(edge.target)) {
        aliases.add(edge.target);
        changed = true;
      }
    }
  }

  return { aliases, globalName, resolveBinding };
}

function globalObjectSource(node, resolveBinding, aliases, globalName) {
  const identifier = identifierExpression(node);
  if (identifier === null) {
    return null;
  }
  const binding = resolveBinding(identifier);
  if (binding === null) {
    return identifier.text === globalName ? { global: true } : null;
  }
  return aliases.has(binding) ? { global: true } : { binding };
}

function accessesGlobalMember(node, analysis, member) {
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    terminalMemberName(node) === member
  ) {
    return isGlobalObjectExpression(node.expression, analysis);
  }

  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
    return (
      node.initializer !== undefined &&
      isGlobalObjectExpression(node.initializer, analysis) &&
      bindingPatternAccessesMember(node.name, member)
    );
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const pattern = objectAssignmentPattern(node.left);
    return (
      pattern !== null &&
      isGlobalObjectExpression(node.right, analysis) &&
      assignmentPatternAccessesMember(pattern, member)
    );
  }

  return false;
}

function isGlobalObjectExpression(node, analysis) {
  const identifier = identifierExpression(node);
  if (identifier === null) {
    return false;
  }
  const binding = analysis.resolveBinding(identifier);
  return binding === null ? identifier.text === analysis.globalName : analysis.aliases.has(binding);
}

function bindingPatternAccessesMember(pattern, member) {
  return pattern.elements.some(
    (element) =>
      element.dotDotDotToken !== undefined ||
      propertyName(element.propertyName ?? element.name) === member,
  );
}

function assignmentPatternAccessesMember(pattern, member) {
  return pattern.properties.some(
    (property) => ts.isSpreadAssignment(property) || propertyName(property.name) === member,
  );
}

function collectConstructorAnalysis(source, constructorName) {
  const resolveBinding = createBindingResolver(source);
  const constructorBindings = new Set();
  const aliases = new Set();
  const aliasEdges = [];

  const collectCanonicalBinding = (node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === constructorName) {
      constructorBindings.add(node.name);
    } else if (
      ts.isImportClause(node) &&
      node.name !== undefined &&
      node.name.text === constructorName
    ) {
      constructorBindings.add(node.name);
    } else if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.name?.text === constructorName
    ) {
      constructorBindings.add(node.name);
    }
    ts.forEachChild(node, collectCanonicalBinding);
  };
  collectCanonicalBinding(source);

  const addAlias = (target, expression) => {
    const sourceValue = constructorSource(
      expression,
      resolveBinding,
      constructorBindings,
      aliases,
      constructorName,
    );
    if (sourceValue?.constructor === true) {
      aliases.add(target);
    } else if (sourceValue?.binding !== undefined) {
      aliasEdges.push({ source: sourceValue.binding, target });
    }
  };

  const addBindingPattern = (pattern) => {
    for (const element of pattern.elements) {
      if (
        propertyName(element.propertyName ?? element.name) === constructorName &&
        ts.isIdentifier(element.name)
      ) {
        aliases.add(element.name);
      }
    }
  };

  const addAssignmentPattern = (pattern) => {
    for (const property of pattern.properties) {
      if (ts.isSpreadAssignment(property) || propertyName(property.name) !== constructorName) {
        continue;
      }
      const target = assignmentTarget(property);
      if (target !== null) {
        const binding = resolveBinding(target);
        if (binding !== null) {
          aliases.add(binding);
        }
      }
    }
  };

  const collectAliases = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        addAlias(node.name, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        addBindingPattern(node.name);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = identifierExpression(node.left);
      if (target !== null) {
        const binding = resolveBinding(target);
        if (binding !== null) {
          addAlias(binding, node.right);
        }
      } else {
        const pattern = objectAssignmentPattern(node.left);
        if (pattern !== null) {
          addAssignmentPattern(pattern);
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of aliasEdges) {
      if (
        (constructorBindings.has(edge.source) || aliases.has(edge.source)) &&
        !aliases.has(edge.target)
      ) {
        aliases.add(edge.target);
        changed = true;
      }
    }
  }

  const isConstructorExpression = (node) => {
    const sourceValue = constructorSource(
      node,
      resolveBinding,
      constructorBindings,
      aliases,
      constructorName,
    );
    return sourceValue?.constructor === true;
  };

  return {
    isConstruction(node) {
      if (ts.isNewExpression(node)) {
        return isConstructorExpression(node.expression);
      }
      return (
        ts.isCallExpression(node) &&
        isReflectConstruct(node.expression) &&
        node.arguments[0] !== undefined &&
        isConstructorExpression(node.arguments[0])
      );
    },
  };
}

function constructorSource(node, resolveBinding, constructorBindings, aliases, constructorName) {
  const expression = unwrapExpression(node);
  if (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    terminalMemberName(expression) === constructorName
  ) {
    return { constructor: true };
  }
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression);
    if (binding === null) {
      return expression.text === constructorName ? { constructor: true } : null;
    }
    return constructorBindings.has(binding) || aliases.has(binding)
      ? { constructor: true }
      : { binding };
  }
  if (ts.isCallExpression(expression)) {
    const calledExpression = unwrapExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(calledExpression) ||
        ts.isElementAccessExpression(calledExpression)) &&
      terminalMemberName(calledExpression) === "bind"
    ) {
      return constructorSource(
        calledExpression.expression,
        resolveBinding,
        constructorBindings,
        aliases,
        constructorName,
      );
    }
  }
  return null;
}

function isReflectConstruct(node) {
  const expression = unwrapExpression(node);
  return (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Reflect" &&
    terminalMemberName(expression) === "construct"
  );
}

function firstStaticallyAppliedArgument(node) {
  if (node === undefined) {
    return undefined;
  }
  const expression = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(expression) || expression.elements.length === 0) {
    return undefined;
  }
  const first = expression.elements[0];
  return ts.isSpreadElement(first) || ts.isOmittedExpression(first) ? undefined : first;
}

function configModuleEntry(moduleName) {
  const normalized = stripModuleExtension(moduleName.replaceAll("\\", "/"));
  const segments = normalized.split("/");
  const configIndex = segments.lastIndexOf("config");
  if (configIndex === -1) {
    return null;
  }
  return segments.slice(configIndex + 1).join("/");
}

function stripModuleExtension(moduleName) {
  return moduleName.replace(/\.(?:[cm]?js|tsx?)$/u, "");
}

function stringLiteralValue(node) {
  return node !== undefined &&
    (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return stringLiteralValue(node.expression);
  }
  return null;
}

function isNumericPolicyLiteral(node) {
  if (ts.isNumericLiteral(node)) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)
  ) {
    return ts.isNumericLiteral(node.operand);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isNumericPolicyLiteral(node.expression);
  }
  return false;
}

function memberAccess(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return { owner: node.expression.text, member: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { owner: node.expression.text, member: node.argumentExpression.text };
  }
  if (ts.isPropertyAccessExpression(node)) {
    return { owner: null, member: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { owner: null, member: node.argumentExpression.text };
  }
  return null;
}

function terminalMemberName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    return stringLiteralValue(node.argumentExpression);
  }
  return null;
}

function collectPerCreepTaskMemoryAnalysis(source) {
  const resolveBinding = createBindingResolver(source);
  const aliases = new Set();
  const aliasEdges = [];

  const addAliasEdge = (target, initializer) => {
    const sourceIdentifier = identifierExpression(initializer);
    const sourceBinding = sourceIdentifier === null ? null : resolveBinding(sourceIdentifier);
    if (sourceBinding !== null) {
      aliasEdges.push({ source: sourceBinding, target });
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (isDirectMemoryExpression(node.initializer)) {
          aliases.add(node.name);
        } else {
          addAliasEdge(node.name, node.initializer);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        collectDestructuredMemoryBindings(node.name, aliases);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const targetIdentifier = identifierExpression(node.left);
      if (targetIdentifier !== null) {
        const targetBinding = resolveBinding(targetIdentifier);
        if (targetBinding !== null) {
          if (isDirectMemoryExpression(node.right)) {
            aliases.add(targetBinding);
          } else {
            addAliasEdge(targetBinding, node.right);
          }
        }
      } else {
        const assignmentPattern = objectAssignmentPattern(node.left);
        if (assignmentPattern !== null) {
          collectAssignedMemoryBindings(assignmentPattern, aliases, resolveBinding);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of aliasEdges) {
      if (aliases.has(edge.source) && !aliases.has(edge.target)) {
        aliases.add(edge.target);
        changed = true;
      }
    }
  }

  return { aliases, resolveBinding };
}

function createBindingResolver(source) {
  const bindingsByScope = new WeakMap();

  const register = (scope, name) => {
    if (scope === null) {
      return;
    }
    let bindings = bindingsByScope.get(scope);
    if (bindings === undefined) {
      bindings = new Map();
      bindingsByScope.set(scope, bindings);
    }
    bindings.set(name.text, name);
  };

  const registerPattern = (scope, pattern) => {
    if (ts.isIdentifier(pattern)) {
      register(scope, pattern);
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isOmittedExpression(element)) {
        registerPattern(scope, element.name);
      }
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      registerPattern(variableBindingScope(node, source), node.name);
    } else if (ts.isParameter(node)) {
      registerPattern(nearestFunctionScope(node, source), node.name);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      register(nearestLexicalScope(node, source), node.name);
    } else if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      register(node, node.name);
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      register(source, node.name);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      register(source, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return (identifier) => {
    let current = identifier.parent;
    while (current !== undefined) {
      const binding = bindingsByScope.get(current)?.get(identifier.text);
      if (binding !== undefined) {
        return binding;
      }
      current = current.parent;
    }
    return null;
  };
}

function variableBindingScope(declaration, source) {
  if (ts.isCatchClause(declaration.parent)) {
    return declaration.parent;
  }
  const declarationList = declaration.parent;
  if (
    ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
  ) {
    return nearestFunctionScope(declaration, source);
  }
  return nearestLexicalScope(declaration, source);
}

function nearestFunctionScope(node, source) {
  let current = node.parent;
  while (current !== undefined) {
    if (isFunctionScope(current) || ts.isSourceFile(current)) {
      return current;
    }
    current = current.parent;
  }
  return source;
}

function nearestLexicalScope(node, source) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return source;
}

function isFunctionScope(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function collectDestructuredMemoryBindings(pattern, aliases) {
  for (const element of pattern.elements) {
    const member = propertyName(element.propertyName ?? element.name);
    if (member === "memory" && ts.isIdentifier(element.name)) {
      aliases.add(element.name);
    }
    if (ts.isObjectBindingPattern(element.name)) {
      collectDestructuredMemoryBindings(element.name, aliases);
    }
  }
}

function collectAssignedMemoryBindings(pattern, aliases, resolveBinding) {
  for (const property of pattern.properties) {
    if (ts.isSpreadAssignment(property)) {
      continue;
    }
    const member = propertyName(property.name);
    const target = assignmentTarget(property);
    if (member === "memory" && target !== null) {
      const binding = resolveBinding(target);
      if (binding !== null) {
        aliases.add(binding);
      }
    }
    const nested = ts.isPropertyAssignment(property)
      ? objectAssignmentPattern(property.initializer)
      : null;
    if (nested !== null) {
      collectAssignedMemoryBindings(nested, aliases, resolveBinding);
    }
  }
}

function isPerCreepTaskMemoryAccess(node, analysis) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const member = terminalMemberName(node);
    return (
      member !== null &&
      PER_CREEP_TASK_MEMORY_MEMBERS.has(member) &&
      isMemoryExpression(node.expression, analysis)
    );
  }

  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
    return bindingPatternAccessesTaskMemory(
      node.name,
      node.initializer !== undefined && isMemoryExpression(node.initializer, analysis),
    );
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const pattern = objectAssignmentPattern(node.left);
    return (
      pattern !== null &&
      assignmentPatternAccessesTaskMemory(pattern, isMemoryExpression(node.right, analysis))
    );
  }

  return false;
}

function isMemoryExpression(node, analysis) {
  if (isDirectMemoryExpression(node)) {
    return true;
  }
  const identifier = identifierExpression(node);
  if (identifier === null) {
    return false;
  }
  const binding = analysis.resolveBinding(identifier);
  return binding !== null && analysis.aliases.has(binding);
}

function isDirectMemoryExpression(node) {
  const expression = unwrapExpression(node);
  return (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    terminalMemberName(expression) === "memory"
  );
}

function bindingPatternAccessesTaskMemory(pattern, sourceIsMemory) {
  for (const element of pattern.elements) {
    const member = propertyName(element.propertyName ?? element.name);
    if (sourceIsMemory && member !== null && PER_CREEP_TASK_MEMORY_MEMBERS.has(member)) {
      return true;
    }
    if (
      ts.isObjectBindingPattern(element.name) &&
      bindingPatternAccessesTaskMemory(element.name, member === "memory")
    ) {
      return true;
    }
  }
  return false;
}

function assignmentPatternAccessesTaskMemory(pattern, sourceIsMemory) {
  for (const property of pattern.properties) {
    if (ts.isSpreadAssignment(property)) {
      continue;
    }
    const member = propertyName(property.name);
    if (sourceIsMemory && member !== null && PER_CREEP_TASK_MEMORY_MEMBERS.has(member)) {
      return true;
    }
    const nested = ts.isPropertyAssignment(property)
      ? objectAssignmentPattern(property.initializer)
      : null;
    if (nested !== null && assignmentPatternAccessesTaskMemory(nested, member === "memory")) {
      return true;
    }
  }
  return false;
}

function assignmentTarget(property) {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return ts.isPropertyAssignment(property) ? identifierExpression(property.initializer) : null;
}

function objectAssignmentPattern(node) {
  const expression = unwrapExpression(node);
  return ts.isObjectLiteralExpression(expression) ? expression : null;
}

function identifierExpression(node) {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression) ? expression : null;
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function isExecutorPath(path) {
  return /(?:^|[/.-])executor(?:s|[/.-])/u.test(path);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
