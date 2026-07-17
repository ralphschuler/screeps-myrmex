import type { RuntimeConfig } from "../config";
import type { CommandExecutionResult } from "../execution";
import {
  projectMatureResourceDemands,
  type MatureResourceDemandProjection,
} from "../logistics/mature-resource-demands";
import type { LabResourceDemand } from "../logistics/resource-demands";
import type { WorldSnapshot } from "../world/snapshot";
import {
  deriveMatureCapabilities,
  normalizeMatureMechanics,
  type MatureMechanicsCatalog,
  type MatureStructureCapability,
} from "./mature-capabilities";
import {
  reconcileMaturePolicy,
  type MatureFactoryCandidate,
  type MaturePolicyCommitment,
  type MaturePolicyProjection,
  type MatureProtectedStock,
} from "./mature-policy";
import type { MatureCommand } from "./mature-executor";
import {
  createPendingMatureAttempt,
  markMatureAttemptRetryReady,
  projectMatureCommandIntents,
  reconcilePendingMatureAttempts,
  type MatureAttemptSettlement,
  type MatureCommandIntent,
  type PendingMatureAttempt,
} from "./mature-runtime";

export interface MatureMechanicsInput {
  readonly commodities: unknown;
  readonly constants: unknown;
  readonly resourceTypes: readonly unknown[];
}

export interface MatureInfrastructureProjection {
  readonly capabilities: readonly MatureStructureCapability[];
  readonly catalog: MatureMechanicsCatalog | null;
  readonly intents: readonly MatureCommandIntent[];
  readonly policy: MaturePolicyProjection;
  readonly reason: "invalid-input" | "limit-exceeded" | null;
  readonly resourceDemands: MatureResourceDemandProjection;
  readonly settlements: readonly MatureAttemptSettlement[];
  readonly status: "deferred" | "ready";
}

export function emptyMatureInfrastructureProjection(
  reason: MatureInfrastructureProjection["reason"] = null,
): MatureInfrastructureProjection {
  return freeze({
    capabilities: [],
    catalog: null,
    intents: [],
    policy: { blockers: [], budgets: [], commitments: [], objectives: [] },
    reason,
    resourceDemands: { blockers: [], dispositions: [], edges: [], endpoints: [], nodes: [] },
    settlements: [],
    status: reason === null ? "ready" : "deferred",
  });
}

/** Pure composition of mature observation, funding, logistics, command, and settlement contracts. */
export function composeMatureInfrastructure(input: {
  readonly fundedBudgetIds: ReadonlySet<string>;
  readonly labDemands?: readonly LabResourceDemand[];
  readonly mechanics: MatureMechanicsInput;
  readonly pendingAttempts: readonly PendingMatureAttempt[];
  readonly policy: RuntimeConfig["policy"]["industry"];
  readonly previousCommitments: readonly MaturePolicyCommitment[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}): MatureInfrastructureProjection {
  const limits = input.policy.mature;
  const mechanics = normalizeMatureMechanics({
    commodities: input.mechanics.commodities,
    constants: input.mechanics.constants,
    limits: {
      maximumCommodities: limits.maximumCommodities,
      maximumComponentsPerCommodity: limits.maximumComponentsPerCommodity,
      maximumResourceTypes: limits.maximumResourceTypes,
      maximumStringLength: limits.maximumStringLength,
    },
    resourceTypes: input.mechanics.resourceTypes,
  });
  if (mechanics.status !== "ready") return emptyMatureInfrastructureProjection(mechanics.reason);
  const catalog = mechanics.catalog;
  const capabilities: MatureStructureCapability[] = [];
  for (const room of [...input.snapshot.ownedRooms].sort((a, b) => compare(a.name, b.name))) {
    const derived = deriveMatureCapabilities({
      catalog,
      factories: room.ownedFactories ?? [],
      limits: {
        maximumEffectsPerStructure: limits.maximumEffectsPerStructure,
        maximumStructures: limits.maximumStructuresPerRoom,
      },
      nukers: room.ownedNukers ?? [],
      observers: room.ownedObservers ?? [],
      powerSpawns: room.ownedPowerSpawns ?? [],
      roomName: room.name,
    });
    if (derived.status !== "ready") return emptyMatureInfrastructureProjection(derived.reason);
    capabilities.push(...derived.capabilities);
  }
  capabilities.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  const factoryCandidates = deriveFactoryCandidates(
    input.snapshot,
    capabilities,
    catalog,
    input.policy,
  );
  const protectedStocks = deriveProtectedStocks(
    input.snapshot,
    catalog,
    input.policy,
    input.labDemands ?? [],
  );
  const policyInput = {
    capabilities,
    catalog,
    factoryCandidates,
    fundedBudgetIds: input.fundedBudgetIds,
    limits: {
      maximumBatchesPerObjective: limits.maximumBatchesPerObjective,
      maximumCandidates: limits.maximumCandidates,
      maximumDeadlineHorizon: limits.maximumDeadlineHorizon,
      maximumNukerEnergyTarget: limits.maximumNukerEnergyTarget,
      maximumNukerGhodiumTarget: limits.maximumNukerGhodiumTarget,
      maximumObjectives: limits.maximumObjectives,
      maximumPowerProcessingUnits: limits.maximumPowerProcessingUnits,
      maximumRooms: limits.maximumRooms,
    },
    nukerEnergyTarget: limits.maximumNukerEnergyTarget,
    nukerGhodiumTarget: limits.maximumNukerGhodiumTarget,
    previousCommitments: input.previousCommitments,
    protectedStocks,
    tick: input.snapshot.observation.tick,
    world: input.snapshot,
  } as const;
  const preliminary = reconcileMaturePolicy({ ...policyInput, logisticsDispositions: [] });
  const resourceDemands = projectMatureResourceDemands({
    catalog,
    limits: {
      maximumAmountPerTransfer: limits.maximumAmountPerTransfer,
      maximumBatches: limits.maximumBatchesPerObjective,
      maximumEdges: limits.maximumEdges,
      maximumNodes: limits.maximumNodes,
      maximumObjectives: limits.maximumObjectives,
      maximumTransfersPerObjective: limits.maximumTransfersPerObjective,
    },
    objectives: preliminary.objectives,
    world: input.snapshot,
  });
  const policy = reconcileMaturePolicy({
    ...policyInput,
    logisticsDispositions: resourceDemands.dispositions,
  });
  const settlements = reconcilePendingMatureAttempts({
    catalog,
    commitments: policy.commitments,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
  });
  const intents = projectMatureCommandIntents({
    capabilities,
    catalog,
    commitments: policy.commitments,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
    snapshotRevision: input.snapshotRevision,
  });
  return freeze({
    capabilities,
    catalog,
    intents,
    policy,
    reason: null,
    resourceDemands,
    settlements,
    status: "ready" as const,
  });
}

export function settleMatureInfrastructure(input: {
  readonly execution: readonly CommandExecutionResult<MatureCommand>[];
  readonly previousAttempts: readonly PendingMatureAttempt[];
  readonly projection: MatureInfrastructureProjection;
}): {
  readonly attempts: readonly PendingMatureAttempt[];
  readonly commitments: readonly MaturePolicyCommitment[];
} {
  const settlements = new Map(
    input.projection.settlements.map((settlement) => [settlement.attemptId, settlement]),
  );
  let attempts = input.previousAttempts.flatMap((attempt): readonly PendingMatureAttempt[] => {
    const settlement = settlements.get(attempt.attemptId);
    if (settlement === undefined || settlement.status === "pending") return [attempt];
    if (settlement.status !== "retry") return [];
    const ready = markMatureAttemptRetryReady(attempt, settlement);
    return ready === null ? [] : [ready];
  });
  for (const result of input.execution) {
    const intent = input.projection.intents.find(({ id }) => id === result.intentId);
    if (intent === undefined) continue;
    const retry = attempts.find(
      (attempt) =>
        attempt.retryReady === true &&
        attempt.objectiveId === intent.payload.objectiveId &&
        attempt.objectiveRevision === intent.payload.objectiveRevision,
    );
    const pending = createPendingMatureAttempt(intent, result.reason, retry?.retry ?? 0);
    if (pending === null) continue;
    attempts = attempts.filter((attempt) => attempt !== retry);
    attempts.push(pending);
  }
  return freeze({
    attempts: attempts.sort((a, b) => compare(a.attemptId, b.attemptId)),
    commitments: input.projection.policy.commitments.filter(({ status }) => status !== "retired"),
  });
}

function deriveFactoryCandidates(
  snapshot: WorldSnapshot,
  capabilities: readonly MatureStructureCapability[],
  catalog: MatureMechanicsCatalog,
  policy: RuntimeConfig["policy"]["industry"],
): readonly MatureFactoryCandidate[] {
  const candidates: MatureFactoryCandidate[] = [];
  for (const room of [...snapshot.ownedRooms].sort((a, b) => compare(a.name, b.name))) {
    const stocks = roomStocks(room);
    const products = new Set(
      capabilities
        .filter(
          ({ active, kind, roomName }) => active && kind === "factory" && roomName === room.name,
        )
        .flatMap(({ availableProducts }) => availableProducts),
    );
    for (const recipe of catalog.recipes) {
      const deficit = Math.max(0, policy.stockMinimum - (stocks.get(recipe.product) ?? 0));
      if (deficit <= 0 || !products.has(recipe.product)) continue;
      candidates.push(
        freeze({
          maximumBatches: policy.mature.maximumBatchesPerObjective,
          product: recipe.product,
          roomName: room.name,
          targetStock: policy.stockMinimum,
          valuePerBatch: deficit,
        }),
      );
    }
  }
  return freeze(
    candidates
      .sort(
        (a, b) =>
          compare(a.roomName, b.roomName) ||
          b.valuePerBatch - a.valuePerBatch ||
          compare(a.product, b.product),
      )
      .slice(0, policy.mature.maximumCandidates),
  );
}

function deriveProtectedStocks(
  snapshot: WorldSnapshot,
  catalog: MatureMechanicsCatalog,
  policy: RuntimeConfig["policy"]["industry"],
  labDemands: readonly LabResourceDemand[],
): readonly MatureProtectedStock[] {
  const values: MatureProtectedStock[] = [];
  for (const room of [...snapshot.ownedRooms].sort((a, b) => compare(a.name, b.name))) {
    for (const resourceType of catalog.resources) {
      const labProtection = labDemands
        .filter(
          (demand) =>
            demand.colonyId === room.name &&
            demand.mode === "fill" &&
            demand.resourceType === resourceType,
        )
        .reduce((total, { amount }) => total + amount, 0);
      const base =
        resourceType === "energy"
          ? Math.max(policy.stockMinimum, policy.protectedTerminalEnergy)
          : policy.stockMinimum;
      values.push(
        freeze({
          amount: Math.min(Number.MAX_SAFE_INTEGER, base + labProtection),
          resourceType,
          roomName: room.name,
        }),
      );
    }
  }
  return freeze(values);
}

function roomStocks(room: WorldSnapshot["ownedRooms"][number]): Map<string, number> {
  const result = new Map<string, number>();
  for (const structure of [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])]) {
    if (!structure.active) continue;
    for (const { amount, resourceType } of structure.store.resources)
      result.set(resourceType, (result.get(resourceType) ?? 0) + amount);
  }
  return result;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
