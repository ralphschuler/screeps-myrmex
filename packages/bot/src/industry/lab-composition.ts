import type { RuntimeConfig } from "../config";
import type { CommandExecutionResult } from "../execution";
import {
  projectLabResourceDemands,
  type LabResourceDemandProjection,
} from "../logistics/resource-demands";
import type { CreepSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";
import {
  assignLabCluster,
  normalizeReactionCatalog,
  type LabClusterAssignment,
} from "./lab-cluster";
import {
  reconcileLabPolicy,
  type BoostManifest,
  type LabPolicyBodyPartObservation,
  type LabPolicyCommitment,
  type LabPolicyProjection,
  type LabPolicyRoomObservation,
  type ReactionObjective,
} from "./lab-policy";
import type { LabCommand } from "./lab-executor";
import {
  hasIndustrySettlementAccounting,
  industrySettlementAccountingRow,
  sumIndustrySettlementAccounting,
  type IndustrySettlementAccountingRow,
} from "./settlement-accounting";
import {
  arbitrateLabCommands,
  createPendingLabAttempt,
  markLabAttemptRetryReady,
  reconcilePendingLabAttempts,
  type LabAttemptSettlement,
  type LabCommandIntent,
  type PendingLabAttempt,
} from "./lab-runtime";

export interface LabCompositionProjection {
  readonly assignments: readonly LabClusterAssignment[];
  readonly creepFingerprints: ReadonlyMap<string, string>;
  readonly intents: readonly LabCommandIntent[];
  readonly objectiveBudgets: readonly {
    readonly colonyId: string;
    readonly deadline: number;
    readonly identity: string;
  }[];
  readonly policy: LabPolicyProjection;
  readonly resourceDemands: LabResourceDemandProjection;
  readonly settlements: readonly LabAttemptSettlement[];
}

export interface LabTelemetry {
  readonly accounting?: IndustrySettlementAccountingRow;
  readonly cancelled: number;
  readonly commands: {
    readonly executed: number;
    readonly failed: number;
    readonly rejected: number;
  };
  readonly commitments: number;
  readonly intents: number;
  readonly readinessBlockers: number;
  readonly resourceDemands: number;
  readonly retries: number;
  readonly settledAmount: number;
}

export interface ComposeLabRuntimeInput {
  readonly boostManifests?: readonly BoostManifest[];
  readonly fundedBudgetIds: ReadonlySet<string>;
  readonly pendingAttempts: readonly PendingLabAttempt[];
  readonly policy: RuntimeConfig["policy"]["industry"];
  readonly previousCommitments: readonly LabPolicyCommitment[];
  readonly reactionObjectives?: readonly ReactionObjective[];
  readonly reactions: unknown;
  readonly reactionTimes: unknown;
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}

export function emptyLabCompositionProjection(): LabCompositionProjection {
  return freeze({
    assignments: [],
    creepFingerprints: new Map<string, string>(),
    intents: [],
    objectiveBudgets: [],
    policy: { blockers: [], budgets: [], commitments: [], demands: [], dispositions: [] },
    resourceDemands: { blockers: [], dispositions: [], edges: [], endpoints: [], nodes: [] },
    settlements: [],
  });
}

/** Pure composition of the existing lab, logistics, and intent authorities. */
export function composeLabRuntime(input: ComposeLabRuntimeInput): LabCompositionProjection {
  const catalogResult = normalizeReactionCatalog({
    maximumReagentsScanned: 64,
    maximumRecipes: input.policy.maximumReactionCatalogRecipes,
    reactionTimes: input.reactionTimes,
    reactions: input.reactions,
  });
  const catalog = catalogResult.catalog;
  const assignments = input.snapshot.ownedRooms.flatMap((room) => {
    const result = assignLabCluster({
      labs: room.ownedLabs ?? [],
      layoutFingerprint: labLayoutFingerprint(room),
      limits: {
        maximumBoostLabs: Math.min(2, input.policy.maximumLabsPerRoom - 2),
        maximumLabsScanned: input.policy.maximumLabsPerRoom,
        maximumOutputLabs: Math.max(1, input.policy.maximumLabsPerRoom - 2),
      },
      roomName: room.name,
    });
    return result.assignment === null ? [] : [result.assignment];
  });
  const creepFingerprints = new Map(
    input.snapshot.ownedRooms.flatMap((room) =>
      room.ownedCreeps.map((creep) => [creep.id, fingerprintCreepSnapshot(creep)] as const),
    ),
  );
  const rooms = input.snapshot.ownedRooms.flatMap((room): readonly LabPolicyRoomObservation[] => {
    const assignment = assignments.find(({ roomName }) => roomName === room.name) ?? null;
    const endpoint = [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    )[0];
    if (endpoint === undefined) return [];
    return [
      {
        assignment,
        catalog,
        colonyId: room.name,
        creeps: room.ownedCreeps.map((creep) => ({
          body: policyBody(creep),
          fingerprint: creepFingerprints.get(creep.id) ?? "",
          id: creep.id,
        })),
        endpointId: endpoint.id,
        labs: (room.ownedLabs ?? []).map(({ active, id, mineralAmount, mineralType }) => ({
          active,
          id,
          mineralAmount,
          mineralType,
        })),
        stocks: roomStocks(room).map(({ amount, resourceType }) => ({
          amount,
          protectedAmount: resourceType === "energy" ? input.policy.protectedTerminalEnergy : 0,
          resourceType,
        })),
      },
    ];
  });
  const reactionObjectives =
    input.reactionObjectives ??
    deriveReactionObjectives(
      rooms,
      input.policy,
      input.fundedBudgetIds,
      input.snapshot.observation.tick,
    );
  const first = reconcileLabPolicy({
    boostManifests: input.boostManifests ?? [],
    commitments: input.previousCommitments,
    reactionObjectives,
    rooms,
    stagingDispositions: [],
    tick: input.snapshot.observation.tick,
  });
  const demandParts = assignments.map((assignment) =>
    projectLabResourceDemands({
      assignment,
      demands: first.demands.filter(({ colonyId }) => colonyId === assignment.roomName),
      limits: {
        maximumAmountPerDemand: input.policy.maximumLabBatchAmount,
        maximumDemands: input.policy.maximumLabResourceDemandsPerTick,
        maximumEdges: input.policy.maximumLabResourceDemandsPerTick,
        maximumLabs: input.policy.maximumLabsPerRoom,
        maximumNodes: input.policy.maximumLabResourceDemandsPerTick * 2,
        maximumSourceStockPerNode: input.policy.stockMaximum,
      },
      world: input.snapshot,
    }),
  );
  const resourceDemands = mergeDemandProjections(demandParts);
  const policy = reconcileLabPolicy({
    boostManifests: input.boostManifests ?? [],
    commitments: input.previousCommitments,
    reactionObjectives,
    rooms,
    stagingDispositions: resourceDemands.dispositions,
    tick: input.snapshot.observation.tick,
  });
  const settlements = reconcilePendingLabAttempts({
    assignments,
    commitments: input.previousCommitments,
    creepFingerprints,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
  });
  const intents = arbitrateLabCommands({
    assignments,
    commitments: policy.commitments,
    creepFingerprints,
    dispositions: policy.dispositions,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
    snapshotRevision: input.snapshotRevision,
  });
  const objectiveBudgets = [
    ...reactionObjectives.map(({ colonyId, deadline, industryBudgetId }) => ({
      colonyId,
      deadline,
      identity: industryBudgetId,
    })),
    ...(input.boostManifests ?? []).map(({ colonyId, deadline, industryBudgetId }) => ({
      colonyId,
      deadline,
      identity: industryBudgetId,
    })),
  ];
  return freeze({
    assignments,
    creepFingerprints,
    intents,
    objectiveBudgets,
    policy,
    resourceDemands,
    settlements,
  });
}

export function settleLabComposition(input: {
  readonly execution: readonly CommandExecutionResult<LabCommand>[];
  readonly projection: LabCompositionProjection;
  readonly previousAttempts: readonly PendingLabAttempt[];
}): {
  readonly attempts: readonly PendingLabAttempt[];
  readonly commitments: readonly LabPolicyCommitment[];
} {
  const settlements = new Map(
    input.projection.settlements.map((value) => [value.attemptId, value]),
  );
  let attempts = input.previousAttempts.flatMap((attempt): readonly PendingLabAttempt[] => {
    const result = settlements.get(attempt.attemptId);
    if (result === undefined || result.status === "pending") return [attempt];
    if (result.status !== "retry") return [];
    const ready = markLabAttemptRetryReady(attempt, result);
    return ready === null ? [] : [ready];
  });
  const commitments = input.projection.policy.commitments.map((commitment) => {
    const settled = input.projection.settlements
      .filter(
        (value) =>
          value.status === "settled" &&
          value.objectiveId === commitment.objectiveId &&
          value.objectiveRevision === commitment.objectiveRevision,
      )
      .reduce((total, value) => total + value.settledAmount, 0);
    if (settled === 0) return commitment;
    return commitment.kind === "boost"
      ? freeze({
          ...commitment,
          settledParts: Math.min(commitment.partCount, commitment.settledParts + settled),
        })
      : freeze({
          ...commitment,
          settledAmount: Math.min(commitment.batchAmount, commitment.settledAmount + settled),
        });
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
    const pending = createPendingLabAttempt(intent, result.reason, retry?.retry ?? 0);
    if (pending === null) continue;
    attempts = attempts.filter((attempt) => attempt !== retry);
    attempts.push(pending);
  }
  return freeze({
    attempts: attempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
    commitments,
  });
}

export function projectLabTelemetry(
  projection: LabCompositionProjection,
  execution: readonly CommandExecutionResult<LabCommand>[],
): LabTelemetry {
  const accounting = sumIndustrySettlementAccounting(
    projection.settlements
      .filter(({ status }) => status === "settled")
      .map(({ accounting: value }) => value),
  );
  return freeze({
    ...(hasIndustrySettlementAccounting(accounting)
      ? { accounting: industrySettlementAccountingRow(accounting) }
      : {}),
    cancelled: projection.settlements.filter(({ status }) => status === "cancelled").length,
    commands: {
      executed: execution.filter(({ status }) => status === "executed").length,
      failed: execution.filter(({ status }) => status === "failed").length,
      rejected: execution.filter(({ status }) => status === "rejected").length,
    },
    commitments: projection.policy.commitments.length,
    intents: projection.intents.length,
    readinessBlockers: projection.policy.dispositions.reduce(
      (total, { blockers }) => total + blockers.length,
      0,
    ),
    resourceDemands: projection.policy.demands.length,
    retries: projection.settlements.filter(({ status }) => status === "retry").length,
    settledAmount: projection.settlements.reduce((total, value) => total + value.settledAmount, 0),
  });
}

function deriveReactionObjectives(
  rooms: readonly LabPolicyRoomObservation[],
  policy: RuntimeConfig["policy"]["industry"],
  funded: ReadonlySet<string>,
  tick: number,
): readonly ReactionObjective[] {
  return rooms.flatMap((room) => {
    const stocks = new Map(room.stocks.map(({ amount, resourceType }) => [resourceType, amount]));
    const recipe = room.catalog?.recipes.find(
      ({ product, reagents }) =>
        (stocks.get(product) ?? 0) < policy.stockMinimum &&
        reagents.every((reagent) => (stocks.get(reagent) ?? 0) >= 5),
    );
    if (recipe === undefined) return [];
    const budgetId = `lab-objective/${room.colonyId}/${recipe.product}/forward`;
    return [
      {
        amount: Math.min(policy.maximumLabBatchAmount, policy.stockTarget),
        colonyId: room.colonyId,
        deadline: safeAdd(tick, policy.maximumLabDeadlineHorizon),
        funded: funded.has(budgetId),
        id: budgetId,
        industryBudgetId: budgetId,
        priority: 100,
        product: recipe.product,
        revision: 1,
      },
    ];
  });
}

function mergeDemandProjections(
  parts: readonly LabResourceDemandProjection[],
): LabResourceDemandProjection {
  return freeze({
    blockers: parts.flatMap(({ blockers }) => blockers),
    dispositions: parts.flatMap(({ dispositions }) => dispositions),
    edges: parts.flatMap(({ edges }) => edges),
    endpoints: parts.flatMap(({ endpoints }) => endpoints),
    nodes: parts.flatMap(({ nodes }) => nodes),
  });
}

function roomStocks(
  room: RoomSnapshot,
): readonly { readonly amount: number; readonly resourceType: string }[] {
  const amounts = new Map<string, number>();
  const stores = [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])];
  for (const structure of new Map(stores.map((value) => [value.id, value])).values())
    for (const { amount, resourceType } of structure.store.resources)
      amounts.set(resourceType, (amounts.get(resourceType) ?? 0) + amount);
  return [...amounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resourceType, amount]) => ({ amount, resourceType }));
}

function policyBody(creep: CreepSnapshot): readonly LabPolicyBodyPartObservation[] {
  const boosts = new Map(
    (creep.boosts ?? []).map(({ bodyPart, compound, count }) => [
      `${bodyPart}\u0000${compound}`,
      count,
    ]),
  );
  const result: LabPolicyBodyPartObservation[] = [];
  for (const [type, count] of bodyCounts(creep)) {
    let remaining = count;
    for (const [key, boosted] of boosts) {
      const [bodyPart, compound] = key.split("\u0000");
      if (bodyPart !== type || compound === undefined) continue;
      for (let index = 0; index < Math.min(remaining, boosted); index += 1)
        result.push({ boost: compound, type });
      remaining -= Math.min(remaining, boosted);
    }
    for (let index = 0; index < remaining; index += 1) result.push({ boost: null, type });
  }
  return result;
}

function bodyCounts(creep: CreepSnapshot): readonly [string, number][] {
  return [
    ["attack", creep.body.attack.total],
    ["carry", creep.body.carry.total],
    ["claim", creep.body.claim.total],
    ["heal", creep.body.heal.total],
    ["move", creep.body.move.total],
    ["ranged_attack", creep.body.rangedAttack.total],
    ["tough", creep.body.tough.total],
    ["work", creep.body.work.total],
  ];
}

export function fingerprintCreepSnapshot(creep: CreepSnapshot): string {
  return fingerprint([
    creep.id,
    creep.name,
    ...bodyCounts(creep).flatMap(([type, count]) => [type, String(count)]),
    ...[...(creep.boosts ?? [])]
      .sort((left, right) =>
        `${left.bodyPart}/${left.compound}`.localeCompare(`${right.bodyPart}/${right.compound}`),
      )
      .flatMap(({ bodyPart, compound, count }) => [bodyPart, compound, String(count)]),
  ]);
}

function labLayoutFingerprint(room: RoomSnapshot): string {
  return fingerprint([
    room.name,
    ...[...(room.ownedLabs ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap(({ id, pos }) => [id, String(pos.x), String(pos.y)]),
  ]);
}

function fingerprint(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts)
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  return `lab-composition-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
