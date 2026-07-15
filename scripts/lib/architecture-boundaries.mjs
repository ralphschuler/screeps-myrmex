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

const AUTHORITY_DECLARATIONS = new Map([
  ["CacheManager", "cache/cache-manager.ts"],
  ["CpuScheduler", "runtime/kernel/cpu-scheduler.ts"],
  ["MemoryManager", "state/manager.ts"],
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

    if (ts.isCallExpression(node)) {
      const calledMember = memberAccess(node.expression);
      if (calledMember !== null && COMMAND_METHODS.has(calledMember.member)) {
        addUnlessAllowed("game-command-outside-executor", isExecutorPath(path));
      }
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

function isExecutorPath(path) {
  return /(?:^|[/.-])executor(?:s|[/.-])/u.test(path);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
