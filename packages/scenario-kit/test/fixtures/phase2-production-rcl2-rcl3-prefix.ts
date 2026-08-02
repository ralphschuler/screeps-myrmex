import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { COLONY_RCL_POLICY_TABLE } from "../../../bot/src/colony";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import { SOURCE_DEFAULT_RUNTIME_CONFIG } from "../../../bot/src/config/runtime-config";
import type { TickOutcome } from "../../../bot/src/runtime/tick";
import {
  phase2Rcl2ExitWorld,
  type SpawnOnlyRcl2World,
  type SpawnOnlyUpgradeEffect,
} from "../../../bot/test/support/spawn-only-rcl2-fixture";
import {
  PHASE2_GATE_DECLARATION_SHA256_V1,
  PHASE2_GATE_PREFIX_ARTIFACT_KIND,
  PHASE2_GATE_PREFIX_EXECUTOR,
  PHASE2_GATE_PREFIX_SCHEMA_VERSION,
  PHASE2_RCL2_RCL3_PREFIX_ID,
  PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED,
  PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS,
  canonicalHash,
  canonicalSerialize,
  phase2GateSha256,
  validatePhase2GatePrefixReceipt,
  type Phase2GatePrefixReceipt,
  type Phase2GatePrefixVariantEvidence,
  type Phase2GatePrefixVariantName,
} from "../../src";
import { buildBotBundle } from "../../../../scripts/lib/build-bot.mjs";

const FIRST_TICK = 100;
const MAXIMUM_PROGRESSION_TICKS = 5_000;
const RESET_AFTER_CALLS = 1_000;
const REQUIRED_CONTROLLER_ENERGY = 45_000;
const BUILD_SHA = "phase2-rcl2-rcl3-prefix-v1";
const STATE_LIMITS = Object.freeze({
  maximumPersistentMemoryBytes: 65_536,
  maximumTelemetryOwnerBytes: 8_192,
  maximumTickTelemetryBytes: 8_192,
  maximumCacheEntries: 384,
  maximumCacheNamespaces: 3,
});

interface SuccessfulCall {
  readonly actorId: string;
  readonly kind: "build" | "harvest" | "spawn" | "upgrade";
  readonly targetId: string;
  readonly tick: number;
}

interface ControllerState {
  readonly level: number;
  readonly progress: number;
  readonly progressTotal: number;
}

interface VariantRun {
  readonly evidence: Phase2GatePrefixVariantEvidence;
  readonly summary: unknown;
}

let warmRun: Promise<VariantRun> | null = null;

/**
 * Execute just the warm production prefix. This is exported separately so a regression reports one
 * bounded, useful diagnostic before the more expensive reset/reorder equivalence variants run.
 */
export async function collectWarmPhase2Rcl2Rcl3Prefix(): Promise<VariantRun> {
  warmRun ??= runVariant("warm");
  return warmRun;
}

/** Execute and validate the finite, non-composable current-production prefix for issue #54. */
export async function collectPhase2Rcl2Rcl3PrefixReceipt(): Promise<Phase2GatePrefixReceipt> {
  const warm = await collectWarmPhase2Rcl2Rcl3Prefix();
  const reset = await runVariant("reset");
  const reordered = await runVariant("reordered");
  const variants = [warm, reset, reordered] as const;
  const semanticBytes = variants.map(({ summary }) => canonicalSerialize(summary));
  if (new Set(semanticBytes).size !== 1) {
    throw new Error(
      `Phase 2 RCL2-RCL3 production prefix semantic drift: ${canonicalSerialize({
        reordered: reordered.summary,
        reset: reset.summary,
        warm: warm.summary,
      })}`,
    );
  }

  const [fixtureContents, productionBundle] = await Promise.all([
    readFile(new URL("../../../bot/test/support/spawn-only-rcl2-fixture.ts", import.meta.url)),
    buildBotBundle({ buildSha: BUILD_SHA }),
  ]);
  const receipt = {
    schemaVersion: PHASE2_GATE_PREFIX_SCHEMA_VERSION,
    artifactKind: PHASE2_GATE_PREFIX_ARTIFACT_KIND,
    issue: 54,
    id: PHASE2_RCL2_RCL3_PREFIX_ID,
    gateComplete: false,
    composable: false,
    executor: PHASE2_GATE_PREFIX_EXECUTOR,
    attestation: {
      thresholdManifestSha256: PHASE2_GATE_DECLARATION_SHA256_V1,
      fixtureSha256: `sha256:${createHash("sha256").update(fixtureContents).digest("hex")}`,
      productionBundle: productionBundle.evidence,
      configuration: {
        colonyRclPolicySha256: phase2GateSha256(COLONY_RCL_POLICY_TABLE),
        runtimeConfigSha256: phase2GateSha256(SOURCE_DEFAULT_RUNTIME_CONFIG),
      },
    },
    scope: {
      startRcl: 2,
      destinationRcl: 3,
      progressionLimitId: "progression-rcl3-ticks",
      requiredControllerEnergy: REQUIRED_CONTROLLER_ENERGY,
      maximumProgressionTicks: MAXIMUM_PROGRESSION_TICKS,
      observedLimitIds: PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS,
      notClaimed: PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED,
    },
    variants: variants.map(({ evidence }) => evidence),
  };
  return validatePhase2GatePrefixReceipt(receipt);
}

async function runVariant(kind: Phase2GatePrefixVariantName): Promise<VariantRun> {
  vi.resetModules();
  const world = phase2Rcl2ExitWorld({ reverseCollections: kind === "reordered" });
  vi.stubGlobal("RoomPosition", world.globals.RoomPosition);
  vi.stubGlobal("PathFinder", world.globals.PathFinder);

  const startController = {
    level: world.controllerLevel,
    progress: world.controllerProgress,
    progressTotal: world.controllerProgressTotal,
  };
  if (
    startController.level !== 2 ||
    startController.progress !== 0 ||
    startController.progressTotal !== REQUIRED_CONTROLLER_ENERGY
  ) {
    throw new Error(
      `${kind} production prefix fixture does not begin at the pinned RCL2 exit: ${canonicalSerialize(
        startController,
      )}`,
    );
  }
  let observedController: ControllerState = startController;
  let observedUpgradeEffects = 0;
  let directProgressMutations = 0;
  let memory = {} as Memory;
  let executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
  let lastOutcome: TickOutcome | null = null;
  let maximumPersistentMemoryBytes = 0;
  let maximumTelemetryOwnerBytes = 0;
  let maximumTickTelemetryBytes = 0;
  let maximumTickTelemetryFields: readonly {
    readonly bytes: number;
    readonly field: string;
  }[] = [];
  let maximumCacheEntries = 0;
  let maximumCacheNamespaces = 0;
  let kernelFaults = 0;
  let rclEvidenceInterruptions = 0;
  let forbiddenLaterPhaseActions = 0;
  let progressionTicks = 0;
  let firstFullRcl2CapacityAt: number | null = null;
  const successfulCalls: SuccessfulCall[] = [];

  for (let relativeTick = 1; relativeTick <= MAXIMUM_PROGRESSION_TICKS; relativeTick += 1) {
    const tick = FIRST_TICK + relativeTick - 1;
    const game = world.game(tick);
    const controllerObservation = observeControllerEffects(
      world,
      observedController,
      observedUpgradeEffects,
    );
    observedController = controllerObservation.state;
    observedUpgradeEffects = controllerObservation.effectCount;
    directProgressMutations += controllerObservation.directMutations;
    const outcome = executeTick({ game, memory });
    lastOutcome = outcome;
    progressionTicks = relativeTick;
    if (world.roomEnergyCapacity >= 550) firstFullRcl2CapacityAt ??= tick;
    observeSuccessfulCalls(outcome, tick, successfulCalls);
    kernelFaults += outcome.kernel.faults.length;
    rclEvidenceInterruptions += interruptedControllerEvidence(outcome);
    forbiddenLaterPhaseActions += forbiddenLaterActions(outcome);

    maximumPersistentMemoryBytes = Math.max(
      maximumPersistentMemoryBytes,
      utf8ByteLength(canonicalSerialize(memory)),
    );
    const telemetryOwner = memory.myrmex?.telemetry;
    maximumTelemetryOwnerBytes = Math.max(
      maximumTelemetryOwnerBytes,
      telemetryOwner === undefined ? 0 : utf8ByteLength(canonicalSerialize(telemetryOwner)),
    );
    if (outcome.telemetry === null) {
      throw new Error(`${kind} production prefix lost tick telemetry at tick ${String(tick)}`);
    }
    const tickTelemetryBytes = utf8ByteLength(canonicalSerialize(outcome.telemetry));
    if (tickTelemetryBytes > maximumTickTelemetryBytes) {
      maximumTickTelemetryBytes = tickTelemetryBytes;
      maximumTickTelemetryFields = Object.entries(outcome.telemetry)
        .map(([field, value]) => ({ bytes: utf8ByteLength(canonicalSerialize(value)), field }))
        .sort((left, right) => right.bytes - left.bytes || left.field.localeCompare(right.field));
    }
    maximumCacheEntries = Math.max(maximumCacheEntries, outcome.telemetry.cacheEntries);
    maximumCacheNamespaces = Math.max(maximumCacheNamespaces, outcome.telemetry.cacheNamespaces);

    if (kind === "reset" && relativeTick === RESET_AFTER_CALLS) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
    }
    if (world.controllerLevel === 3) break;
  }

  if (lastOutcome === null) throw new Error(`${kind} production prefix executed no ticks`);
  const state = {
    maximumPersistentMemoryBytes,
    maximumTelemetryOwnerBytes,
    maximumTickTelemetryBytes,
    maximumCacheEntries,
    maximumCacheNamespaces,
  };
  const cacheNamespaceIds = (await import("../../../bot/src/cache"))
    .getRuntimeCacheManager()
    .metrics()
    .namespaces.map(({ id }) => id);
  const finalOwnerBytes = persistentOwnerBytes(memory);
  if (world.controllerLevel !== 3) {
    throw progressionFailure(kind, progressionTicks, world, lastOutcome, {
      forbiddenLaterPhaseActions,
      kernelFaults,
      rclEvidenceInterruptions,
      state,
      directProgressMutations,
      firstFullRcl2CapacityAt,
      finalOwnerBytes,
      cacheNamespaceIds,
      maximumTickTelemetryFields,
    });
  }

  // A command issued by the final observing runTick has no following world tick inside this
  // bounded prefix. Settlement evidence therefore includes exactly the calls that had an observed
  // next tick, while runTickCalls still counts the final RCL3 observation.
  const settledCalls = successfulCalls.filter(
    ({ tick }) => tick < FIRST_TICK + progressionTicks - 1,
  );
  const deferredEffects = deferredEffectEvidence(world, settledCalls);
  const controllerEnergy = summarizeRcl2ControllerEffects(world.upgradeEffects);
  const { observedUpgradeEnergy, totalUpgradeEnergy } = controllerEnergy;
  assertControllerSettlement(
    world,
    observedUpgradeEnergy,
    totalUpgradeEnergy,
    directProgressMutations,
  );
  if (
    kernelFaults !== 0 ||
    rclEvidenceInterruptions !== 0 ||
    forbiddenLaterPhaseActions !== 0 ||
    directProgressMutations !== 0
  ) {
    throw new Error(
      `${kind} production prefix violated a fail-closed invariant: ${canonicalSerialize({
        forbiddenLaterPhaseActions,
        kernelFaults,
        rclEvidenceInterruptions,
        directProgressMutations,
      })}`,
    );
  }
  assertStateLimits(kind, state, {
    cacheNamespaceIds,
    finalOwnerBytes,
    maximumTickTelemetryFields,
  });

  const summary = {
    progressionTicks,
    firstFullRcl2CapacityAt,
    controller: {
      level: world.controllerLevel,
      progress: world.controllerProgress,
      progressTotal: world.controllerProgressTotal,
      rcl2ProgressionEnergy: observedUpgradeEnergy,
      totalUpgradeEnergy,
    },
    world: {
      actors: [...world.actorStates].sort((left, right) => left.id.localeCompare(right.id)),
      extensions: world.extensionCount,
      roomEnergyCapacity: world.roomEnergyCapacity,
      sites: world.siteCount,
    },
    cacheNamespaceIds,
    effects: effectSummary(world),
    // Telemetry is bounded and attested separately below, but cache hit/miss observations are
    // intentionally heap-sensitive and never drive gameplay. A gameplay semantic hash must cover
    // every authoritative owner while excluding that derived observation owner; otherwise a
    // declared heap reset produces a false semantic drift despite byte-identical world effects.
    finalGameplayPersistentHash: canonicalHash(gameplayPersistentOwners(memory)),
  };
  const evidence: Phase2GatePrefixVariantEvidence = {
    name: kind,
    collectionOrder: kind === "reordered" ? "reversed" : "forward",
    resetAtProgressionTicks: kind === "reset" ? [RESET_AFTER_CALLS] : [],
    firstTick: FIRST_TICK,
    progressionTicks,
    runTickCalls: progressionTicks,
    skippedTicks: 0,
    controller: {
      startLevel: startController.level,
      startProgress: startController.progress,
      startProgressTotal: startController.progressTotal,
      finalLevel: world.controllerLevel,
      finalProgress: controllerEnergy.finalProgress,
      observedUpgradeEnergy: observedUpgradeEnergy as 45_000,
      totalUpgradeEnergy,
      sameTickOverflowEnergy: controllerEnergy.sameTickOverflowEnergy,
      directProgressMutations,
    },
    deferredEffects,
    state,
    kernelFaults,
    rclEvidenceInterruptions,
    forbiddenLaterPhaseActions,
    semanticHash: canonicalHash(summary),
  };
  return Object.freeze({ evidence: Object.freeze(evidence), summary: Object.freeze(summary) });
}

function observeSuccessfulCalls(
  outcome: TickOutcome,
  tick: number,
  successfulCalls: SuccessfulCall[],
): void {
  for (const execution of outcome.movement.actionExecution) {
    if (execution.status !== "executed") continue;
    const kind =
      execution.intent.kind === "upgrade-controller"
        ? "upgrade"
        : execution.intent.kind === "build" || execution.intent.kind === "harvest"
          ? execution.intent.kind
          : null;
    if (kind !== null)
      successfulCalls.push({
        actorId: execution.intent.actorId,
        kind,
        targetId: execution.intent.targetId,
        tick,
      });
  }
  for (const execution of outcome.spawn.execution) {
    if (execution.status === "scheduled")
      successfulCalls.push({
        actorId: execution.command.spawnId,
        kind: "spawn",
        targetId: execution.command.name,
        tick,
      });
  }
}

function interruptedControllerEvidence(outcome: TickOutcome): number {
  const room = outcome.snapshot.ownedRooms[0];
  if (outcome.snapshot.ownedRooms.length !== 1 || room === undefined) return 1;
  return room.controller.level === 2 || room.controller.level === 3 ? 0 : 1;
}

function forbiddenLaterActions(outcome: TickOutcome): number {
  const operations = outcome.remoteOperations;
  const industry = outcome.telemetry?.industry;
  return (
    outcome.remotes.objectives.length +
    (operations?.budgetRequests.length ?? 0) +
    (operations?.contractRequests.length ?? 0) +
    (operations?.transitions.length ?? 0) +
    (operations?.siteAuthorizations.length ?? 0) +
    (operations?.siteProposals.length ?? 0) +
    outcome.links.execution.length +
    (industry?.commands.executed ?? 0) +
    (industry?.extractionProposals ?? 0) +
    (industry?.sendProposals ?? 0) +
    (industry?.labs?.commands.executed ?? 0) +
    (industry?.mature?.commands.executed ?? 0) +
    (industry?.observer?.commands.executed ?? 0)
  );
}

function deferredEffectEvidence(
  world: SpawnOnlyRcl2World,
  successfulCalls: readonly SuccessfulCall[],
): Phase2GatePrefixVariantEvidence["deferredEffects"] {
  const effects = {
    harvest: world.harvestEffects,
    build: world.buildEffects,
    spawn: world.spawnEffects,
    upgrade: world.upgradeEffects,
  } as const;
  const allEffects = Object.values(effects).flat();
  const sameTickEffects = allEffects.filter(
    ({ commandTick, visibleAt }) => visibleAt <= commandTick,
  ).length;
  const invalidSettlementDelays = allEffects.filter(
    ({ commandTick, visibleAt }) => visibleAt - commandTick !== 1,
  ).length;
  if (sameTickEffects !== 0 || invalidSettlementDelays !== 0) {
    throw new Error(
      `production effects did not settle exactly one tick later: ${canonicalSerialize({
        invalidSettlementDelays,
        sameTickEffects,
      })}`,
    );
  }
  const evidenceFor = (kind: SuccessfulCall["kind"]) => {
    const calls = successfulCalls.filter((call) => call.kind === kind);
    const settled = effects[kind];
    if (calls.length === 0 || calls.length !== settled.length) {
      throw new Error(
        `${kind} production calls did not all settle on the following observed tick: ${canonicalSerialize(
          { calls: calls.length, effects: settled.length },
        )}`,
      );
    }
    return {
      successfulCalls: calls.length,
      settledEffects: settled.length,
      minimumSettlementDelayTicks: Math.min(
        ...settled.map(({ commandTick, visibleAt }) => visibleAt - commandTick),
      ),
    };
  };
  return {
    harvest: evidenceFor("harvest"),
    build: evidenceFor("build"),
    spawn: evidenceFor("spawn"),
    upgrade: evidenceFor("upgrade"),
    sameTickEffects,
    invalidSettlementDelays,
  };
}

function observeControllerEffects(
  world: SpawnOnlyRcl2World,
  previous: ControllerState,
  effectCursor: number,
): {
  readonly directMutations: number;
  readonly effectCount: number;
  readonly state: ControllerState;
} {
  const allEffects = world.upgradeEffects;
  const effects = allEffects.slice(effectCursor);
  let expected = previous;
  let invalid = 0;
  for (const effect of effects) {
    if (
      effect.levelBefore !== expected.level ||
      effect.progressBefore !== expected.progress ||
      (effect.levelAfter === effect.levelBefore
        ? effect.progressAfter - effect.progressBefore !== effect.energy
        : effect.levelBefore !== 2 ||
          effect.levelAfter !== 3 ||
          effect.progressBefore >= REQUIRED_CONTROLLER_ENERGY ||
          effect.progressBefore + effect.energy < REQUIRED_CONTROLLER_ENERGY ||
          effect.progressAfter !==
            effect.progressBefore + effect.energy - REQUIRED_CONTROLLER_ENERGY)
    ) {
      invalid += 1;
    }
    expected = {
      level: effect.levelAfter,
      progress: effect.progressAfter,
      progressTotal: effect.levelAfter === 2 ? REQUIRED_CONTROLLER_ENERGY : 135_000,
    };
  }
  const actual = {
    level: world.controllerLevel,
    progress: world.controllerProgress,
    progressTotal: world.controllerProgressTotal,
  };
  if (canonicalSerialize(actual) !== canonicalSerialize(expected)) invalid += 1;
  return { directMutations: invalid, effectCount: allEffects.length, state: actual };
}

function assertControllerSettlement(
  world: SpawnOnlyRcl2World,
  observedUpgradeEnergy: number,
  totalUpgradeEnergy: number,
  directProgressMutations: number,
): void {
  let invalidMutations = 0;
  for (const effect of world.upgradeEffects) {
    const settled =
      effect.levelAfter === effect.levelBefore
        ? effect.progressAfter - effect.progressBefore === effect.energy
        : effect.levelBefore === 2 &&
          effect.levelAfter === 3 &&
          effect.progressBefore < REQUIRED_CONTROLLER_ENERGY &&
          effect.progressBefore + effect.energy >= REQUIRED_CONTROLLER_ENERGY &&
          effect.progressAfter ===
            effect.progressBefore + effect.energy - REQUIRED_CONTROLLER_ENERGY;
    if (!settled) invalidMutations += 1;
  }
  if (
    world.controllerLevel !== 3 ||
    world.controllerProgress !== totalUpgradeEnergy - REQUIRED_CONTROLLER_ENERGY ||
    observedUpgradeEnergy !== REQUIRED_CONTROLLER_ENERGY ||
    directProgressMutations !== 0 ||
    invalidMutations !== 0
  ) {
    throw new Error(
      `production controller settlement is incomplete: ${canonicalSerialize({
        invalidMutations,
        directProgressMutations,
        level: world.controllerLevel,
        progress: world.controllerProgress,
        observedUpgradeEnergy,
        totalUpgradeEnergy,
      })}`,
    );
  }
}

export function summarizeRcl2ControllerEffects(effects: readonly SpawnOnlyUpgradeEffect[]): {
  readonly finalProgress: number;
  readonly observedUpgradeEnergy: number;
  readonly sameTickOverflowEnergy: number;
  readonly totalUpgradeEnergy: number;
} {
  const observedUpgradeEnergy = effects.reduce((sum, effect) => {
    if (effect.levelBefore !== 2) return sum;
    return (
      sum +
      (effect.levelAfter === 3 ? REQUIRED_CONTROLLER_ENERGY - effect.progressBefore : effect.energy)
    );
  }, 0);
  const totalUpgradeEnergy = effects.reduce((sum, effect) => sum + effect.energy, 0);
  const finalProgress = Math.max(0, totalUpgradeEnergy - REQUIRED_CONTROLLER_ENERGY);
  return Object.freeze({
    finalProgress,
    observedUpgradeEnergy,
    sameTickOverflowEnergy: finalProgress,
    totalUpgradeEnergy,
  });
}

function assertStateLimits(
  kind: Phase2GatePrefixVariantName,
  state: Readonly<Record<keyof typeof STATE_LIMITS, number>>,
  diagnostics: {
    readonly cacheNamespaceIds: readonly string[];
    readonly finalOwnerBytes: readonly { readonly bytes: number; readonly owner: string }[];
    readonly maximumTickTelemetryFields: readonly {
      readonly bytes: number;
      readonly field: string;
    }[];
  },
): void {
  const violations = Object.entries(STATE_LIMITS).flatMap(([name, limit]) => {
    const value = state[name as keyof typeof STATE_LIMITS];
    return value > limit ? [{ limit, name, value }] : [];
  });
  if (violations.length > 0)
    throw new Error(
      `${kind} production prefix exceeded state limits: ${canonicalSerialize({
        ...diagnostics,
        violations,
      })}`,
    );
}

function effectSummary(world: SpawnOnlyRcl2World) {
  const spawnBodyProfiles = new Map<string, number>();
  for (const { body } of world.spawnEffects) {
    const profile = body.join(",");
    spawnBodyProfiles.set(profile, (spawnBodyProfiles.get(profile) ?? 0) + 1);
  }
  return {
    harvest: {
      calls: world.harvestEffects.length,
      energy: world.harvestEffects.reduce((sum, effect) => sum + effect.energy, 0),
      carried: world.harvestEffects.reduce((sum, effect) => sum + effect.carriedEnergy, 0),
      dropped: world.harvestEffects.reduce((sum, effect) => sum + effect.droppedEnergy, 0),
    },
    pickup: {
      calls: world.pickupEffects.length,
      energy: world.pickupEffects.reduce((sum, effect) => sum + effect.energy, 0),
      remaining: world.droppedEnergy,
    },
    transfer: {
      calls: world.transferEffects.length,
      energy: world.transferEffects.reduce((sum, effect) => sum + effect.energy, 0),
    },
    build: {
      calls: world.buildEffects.length,
      energy: world.buildEffects.reduce((sum, effect) => sum + effect.energy, 0),
      progress: world.buildEffects.reduce((sum, effect) => sum + effect.progressDelta, 0),
    },
    spawn: {
      calls: world.spawnEffects.length,
      energy: world.spawnEffects.reduce((sum, effect) => sum + effect.cost, 0),
      bodyProfiles: [...spawnBodyProfiles]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([body, calls]) => ({ body, calls })),
    },
    upgrade: {
      calls: world.upgradeEffects.length,
      energy: world.upgradeEffects.reduce((sum, effect) => sum + effect.energy, 0),
    },
  };
}

function progressionFailure(
  kind: Phase2GatePrefixVariantName,
  progressionTicks: number,
  world: SpawnOnlyRcl2World,
  outcome: TickOutcome,
  diagnostics: {
    readonly forbiddenLaterPhaseActions: number;
    readonly kernelFaults: number;
    readonly rclEvidenceInterruptions: number;
    readonly state: Readonly<Record<keyof typeof STATE_LIMITS, number>>;
    readonly directProgressMutations: number;
    readonly firstFullRcl2CapacityAt: number | null;
    readonly finalOwnerBytes: readonly { readonly bytes: number; readonly owner: string }[];
    readonly cacheNamespaceIds: readonly string[];
    readonly maximumTickTelemetryFields: readonly {
      readonly bytes: number;
      readonly field: string;
    }[];
  },
): Error {
  const room = outcome.snapshot.ownedRooms[0];
  const colony = outcome.colony.colonies[0];
  return new Error(
    `${kind} production prefix did not reach RCL3: ${canonicalSerialize({
      tick: FIRST_TICK + progressionTicks - 1,
      controller: {
        level: world.controllerLevel,
        progress: world.controllerProgress,
        progressTotal: world.controllerProgressTotal,
      },
      room: {
        energy: room?.energyAvailable ?? null,
        capacity: room?.energyCapacityAvailable ?? world.roomEnergyCapacity,
        extensions: world.extensionCount,
        sites: world.siteCount,
      },
      actors: [...world.actorStates].sort((left, right) => left.id.localeCompare(right.id)),
      effects: effectSummary(world),
      execution: {
        cacheNamespaceIds: diagnostics.cacheNamespaceIds,
        directProgressMutations: diagnostics.directProgressMutations,
        finalOwnerBytes: diagnostics.finalOwnerBytes,
        firstFullRcl2CapacityAt: diagnostics.firstFullRcl2CapacityAt,
        forbiddenLaterPhaseActions: diagnostics.forbiddenLaterPhaseActions,
        kernel: {
          cumulativeFaults: diagnostics.kernelFaults,
          lastFaults: outcome.kernel.faults,
          mode: outcome.kernel.mode,
        },
        memoryStatus: outcome.memoryStatus,
        maximumTickTelemetryFields: diagnostics.maximumTickTelemetryFields,
        rclEvidenceInterruptions: diagnostics.rclEvidenceInterruptions,
        state: diagnostics.state,
      },
      colony:
        colony === undefined
          ? null
          : {
              blocker: colony.domainHealth.blocker,
              population: {
                demands: colony.populationPolicy.demands.length,
                reason: colony.populationPolicy.reasonCode,
                status: colony.populationPolicy.status,
              },
              progression: colony.rclPolicy.progression,
              reason: colony.reasonCode,
              state: colony.state,
            },
      contracts:
        outcome.contracts === null
          ? null
          : {
              assignments: outcome.contracts.allocation.assignments.length,
              fundingDenied: outcome.contracts.funding.filter(
                ({ status }) => status !== "authorized",
              ),
              leases: outcome.contractExecution.leases.map(
                ({ actorId, contractId, execution, targetId }) => ({
                  action: execution.action,
                  actorId,
                  contractId,
                  targetId,
                }),
              ),
              releases: outcome.contracts.releases.slice(-5),
              submissions: outcome.contracts.submissions.slice(-5),
            },
      spawn: {
        broker: outcome.spawn.broker,
        execution: outcome.spawn.execution,
        calls: world.spawnCalls.length,
      },
    })}`,
  );
}

function persistentOwnerBytes(
  memory: Memory,
): readonly { readonly bytes: number; readonly owner: string }[] {
  const root = memory.myrmex;
  if (root === undefined) return [];
  return Object.entries(root)
    .map(([owner, value]) => ({ bytes: utf8ByteLength(canonicalSerialize(value)), owner }))
    .sort((left, right) => right.bytes - left.bytes || left.owner.localeCompare(right.owner));
}

function gameplayPersistentOwners(memory: Memory): Readonly<Record<string, unknown>> {
  const root = memory.myrmex;
  if (root === undefined) return Object.freeze({});
  return Object.freeze(
    Object.fromEntries(
      Object.entries(root)
        .filter(([owner]) => owner !== "telemetry")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}
