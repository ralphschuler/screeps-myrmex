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

const CONFIG_OWNER_METHODS = new Set(["ownerView", "transaction"]);

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
  ["CacheManager", "cache/cache-manager.ts"],
  ["CpuScheduler", "runtime/kernel/cpu-scheduler.ts"],
  ["MemoryManager", "state/manager.ts"],
  ["RuntimeConfigAuthority", "config/authority.ts"],
  ["RuntimeKernel", "runtime/kernel/runtime-kernel.ts"],
]);

export function findArchitectureViolations(sources) {
  const violations = [];

  for (const { contents, path } of sources) {
    const rules = inspectSource(contents, path);
    for (const rule of rules) {
      violations.push({ path, rule });
    }
  }

  return violations.sort((left, right) =>
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
  const configOwnerMethodAliases = collectConfigOwnerMethodAliases(source);

  function addUnlessAllowed(rule, allowed) {
    if (!allowed) {
      rules.add(rule);
    }
  }

  function visit(node) {
    const moduleName = moduleSpecifier(node);
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
      const calledMember = memberAccess(node.expression);
      if (calledMember !== null && COMMAND_METHODS.has(calledMember.member)) {
        addUnlessAllowed("game-command-outside-executor", isExecutorPath(path));
      }
      const calledConfigOwnerMethod = terminalMemberName(node.expression);
      const calledConfigOwnerAlias = ts.isIdentifier(node.expression)
        ? configOwnerMethodAliases.has(node.expression.text)
        : false;
      if (
        ((calledConfigOwnerMethod !== null && CONFIG_OWNER_METHODS.has(calledConfigOwnerMethod)) ||
          calledConfigOwnerAlias) &&
        (stringLiteralValue(node.arguments[0]) === "config" ||
          stringLiteralValue(node.arguments[0]) === null)
      ) {
        addUnlessAllowed("config-owner-access-outside-runtime", path === "runtime/tick.ts");
      }
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
            (member === "creeps" || member === "getObjectById" || member === "rooms")
          ) {
            addUnlessAllowed("live-world-read-outside-observer", path.startsWith("world/"));
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
          access.member === "rooms")
      ) {
        addUnlessAllowed("live-world-read-outside-observer", path.startsWith("world/"));
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

    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const expectedPath = AUTHORITY_DECLARATIONS.get(node.name.text);
      if (expectedPath !== undefined && path !== expectedPath) {
        rules.add(`duplicate-authority:${node.name.text}`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return rules;
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

function collectConfigOwnerMethodAliases(source) {
  const aliases = new Set(CONFIG_OWNER_METHODS);
  const identifierAliases = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const sourceName = element.propertyName ?? element.name;
          const method =
            ts.isIdentifier(sourceName) || ts.isStringLiteralLike(sourceName)
              ? sourceName.text
              : null;
          if (
            method !== null &&
            CONFIG_OWNER_METHODS.has(method) &&
            ts.isIdentifier(element.name)
          ) {
            aliases.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const member = terminalMemberName(node.initializer);
        if (member !== null && CONFIG_OWNER_METHODS.has(member)) {
          aliases.add(node.name.text);
        } else if (ts.isIdentifier(node.initializer)) {
          identifierAliases.push({ alias: node.name.text, source: node.initializer.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of identifierAliases) {
      if (aliases.has(binding.source) && !aliases.has(binding.alias)) {
        aliases.add(binding.alias);
        changed = true;
      }
    }
  }
  return aliases;
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

function isExecutorPath(path) {
  return /(?:^|[/.-])executor(?:s|[/.-])/u.test(path);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
