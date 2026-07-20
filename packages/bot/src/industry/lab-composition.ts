import type { RuntimeConfig } from "../config";
import type { CommandExecutionResult } from "../execution";
import {
  projectLabResourceDemands,
  type LabResourceDemandProjection,
} from "../logistics/resource-demands";
import type {
  CreepSnapshot,
  OwnedLabSnapshot,
  PositionSnapshot,
  RoomSnapshot,
  WorldSnapshot,
} from "../world/snapshot";
import {
  assignLabCluster,
  normalizeReactionCatalog,
  type LabClusterAssignment,
  type LabClusterLimits,
} from "./lab-cluster";
import {
  reconcileLabPolicy,
  type BoostManifest,
  type LabAssignmentHandoff,
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

export type LabMigrationActivity =
  "commitment" | "demand-endpoint" | "intent" | "pending-attempt" | "staging-demand";

export interface CommittedLabLayout {
  readonly labPositions: readonly PositionSnapshot[];
  readonly layoutFingerprint: string;
  readonly roomName: string;
}

interface DerivedLabAssignmentHandoff extends LabAssignmentHandoff {
  readonly blocked?: boolean;
  readonly layoutFingerprint: string | null;
}

export interface LabAssignmentHandoffView extends DerivedLabAssignmentHandoff {
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly status: "blocked" | "pending" | "ready";
}

export interface LabMigrationRoomView {
  readonly activity: readonly LabMigrationActivity[];
  /** Current assignment over every observed lab, retained for independent migration validation. */
  readonly assignment: LabClusterAssignment | null;
  readonly assignmentHandoff?: LabAssignmentHandoffView | null;
  /** Exact active general-purpose destination selected by the industry observation boundary. */
  readonly evacuationStorageId: string | null;
  readonly limits: LabClusterLimits;
  readonly observedAt: number;
  readonly quiescent: boolean;
  readonly roomName: string;
}

export interface LabCompositionProjection {
  readonly assignments: readonly LabClusterAssignment[];
  readonly creepFingerprints: ReadonlyMap<string, string>;
  readonly intents: readonly LabCommandIntent[];
  readonly migrationRooms: readonly LabMigrationRoomView[];
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
  readonly committedLabLayouts?: readonly CommittedLabLayout[];
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
    migrationRooms: [],
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
  const limits = labClusterLimits(input.policy.maximumLabsPerRoom);
  const currentAssignments = input.snapshot.ownedRooms.flatMap((room) => {
    const result = assignLabCluster({
      labs: room.ownedLabs ?? [],
      layoutFingerprint: fingerprintLabLayout(room.name, room.ownedLabs ?? []),
      limits,
      roomName: room.name,
    });
    return result.assignment === null ? [] : [result.assignment];
  });
  const committedLabLayouts = input.committedLabLayouts ?? [];
  const eligibleAssignmentHandoffs = deriveAssignmentHandoffs({
    assignments: currentAssignments,
    layouts: committedLabLayouts,
    limits,
    previousCommitments: input.previousCommitments,
    rooms: input.snapshot.ownedRooms,
  }).filter((handoff) =>
    pendingAttemptsAllowHandoff(handoff, input.pendingAttempts, input.previousCommitments),
  );
  const assignmentHandoffs = freeze(
    [
      ...eligibleAssignmentHandoffs,
      ...deriveAssignmentHandoffHolds({
        assignments: currentAssignments,
        eligibleHandoffs: eligibleAssignmentHandoffs,
        layouts: committedLabLayouts,
        limits,
        previousCommitments: input.previousCommitments,
        rooms: input.snapshot.ownedRooms,
      }),
    ].sort((left, right) => left.assignment.roomName.localeCompare(right.assignment.roomName)),
  );
  const creepFingerprints = new Map(
    input.snapshot.ownedRooms.flatMap((room) =>
      room.ownedCreeps.map((creep) => [creep.id, fingerprintCreepSnapshot(creep)] as const),
    ),
  );
  const rooms = input.snapshot.ownedRooms.flatMap((room): readonly LabPolicyRoomObservation[] => {
    const assignment = currentAssignments.find(({ roomName }) => roomName === room.name) ?? null;
    const assignmentHandoff = assignmentHandoffs.find(
      ({ assignment: value }) => value.roomName === room.name,
    );
    const endpoint = [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    )[0];
    if (endpoint === undefined) return [];
    return [
      {
        assignment,
        ...(assignmentHandoff === undefined ? {} : { assignmentHandoff }),
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
  const firstAssignments = effectiveAssignments(
    currentAssignments,
    assignmentHandoffs,
    first.commitments,
  );
  const demandParts = firstAssignments.map((assignment) =>
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
  const assignments = effectiveAssignments(
    currentAssignments,
    assignmentHandoffs,
    policy.commitments,
  );
  const settlements = reconcilePendingLabAttempts({
    assignments,
    commitments: input.previousCommitments,
    creepFingerprints,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
  });
  const pendingHandoffKeys = pendingAssignmentHandoffKeys(
    input.previousCommitments,
    policy.commitments,
    assignmentHandoffs,
  );
  const intents = arbitrateLabCommands({
    assignments,
    commitments: policy.commitments.filter(
      (commitment) => !pendingHandoffKeys.has(commitmentKey(commitment)),
    ),
    creepFingerprints,
    dispositions: policy.dispositions,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
    snapshotRevision: input.snapshotRevision,
  });
  const handoffViews = projectAssignmentHandoffViews({
    handoffs: assignmentHandoffs,
    previousCommitments: input.previousCommitments,
    projection: policy,
  });
  const migrationRooms = input.snapshot.ownedRooms.map((room): LabMigrationRoomView => {
    const activity: LabMigrationActivity[] = [];
    const activeStorages = (room.ownedStorages ?? []).filter(({ active }) => active);
    if (policy.commitments.some(({ colonyId }) => colonyId === room.name))
      activity.push("commitment");
    if (input.pendingAttempts.some(({ roomName }) => roomName === room.name))
      activity.push("pending-attempt");
    if (intents.some(({ payload }) => payload.roomName === room.name)) activity.push("intent");
    if (policy.demands.some(({ colonyId }) => colonyId === room.name))
      activity.push("staging-demand");
    if (resourceDemands.endpoints.some(({ position }) => position.roomName === room.name))
      activity.push("demand-endpoint");
    activity.sort();
    return {
      activity: freeze(activity),
      assignment: currentAssignments.find(({ roomName }) => roomName === room.name) ?? null,
      assignmentHandoff:
        handoffViews.find(({ assignment }) => assignment.roomName === room.name) ?? null,
      evacuationStorageId: activeStorages.length === 1 ? (activeStorages[0]?.id ?? null) : null,
      limits,
      observedAt: room.observedAt,
      quiescent: activity.length === 0,
      roomName: room.name,
    };
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
    migrationRooms,
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

function deriveAssignmentHandoffs(input: {
  readonly assignments: readonly LabClusterAssignment[];
  readonly layouts: readonly CommittedLabLayout[];
  readonly limits: LabClusterLimits;
  readonly previousCommitments: readonly LabPolicyCommitment[];
  readonly rooms: readonly RoomSnapshot[];
}): readonly DerivedLabAssignmentHandoff[] {
  if (
    input.assignments.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumRooms ||
    input.layouts.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumLayouts ||
    input.previousCommitments.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumCommitments ||
    input.limits.maximumLabsScanned !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance
  )
    return freeze([]);
  const layouts = [...input.layouts].sort((left, right) =>
    left.roomName.localeCompare(right.roomName),
  );
  if (new Set(layouts.map(({ roomName }) => roomName)).size !== layouts.length) return freeze([]);
  const result: DerivedLabAssignmentHandoff[] = [];
  for (const layout of layouts) {
    const room = input.rooms.find(({ name }) => name === layout.roomName);
    const current = input.assignments.find(({ roomName }) => roomName === layout.roomName);
    const labs = room?.ownedLabs ?? [];
    if (
      room === undefined ||
      current === undefined ||
      layout.labPositions.length !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance ||
      labs.length !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance ||
      !validIdentity(layout.layoutFingerprint, 128) ||
      !validCommittedPositions(layout) ||
      new Set(labs.map(({ id }) => id)).size !== labs.length
    )
      continue;
    const positionKeys = new Set(layout.labPositions.map(positionKey));
    const retained = labs
      .filter(({ pos }) => positionKeys.has(positionKey(pos)))
      .sort((left, right) => left.id.localeCompare(right.id));
    const external = labs.filter(({ pos }) => !positionKeys.has(positionKey(pos)));
    const target = external[0];
    if (
      retained.length !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance - 1 ||
      external.length !== 1 ||
      target === undefined ||
      retained.some(({ active }) => !active)
    )
      continue;
    const postRemoval = assignLabCluster({
      labs: retained,
      layoutFingerprint: fingerprintLabLayout(layout.roomName, retained),
      limits: input.limits,
      roomName: layout.roomName,
    }).assignment;
    if (
      postRemoval === null ||
      postRemoval.fingerprint === current.fingerprint ||
      !sameAssignmentRoles(current, postRemoval) ||
      assignmentIds(postRemoval).has(target.id) ||
      (!emptyHandoffTarget(target) &&
        !input.previousCommitments.some(
          (commitment) =>
            commitment.kind === "reaction" &&
            commitment.colonyId === layout.roomName &&
            commitment.assignmentFingerprint === postRemoval.fingerprint,
        ))
    )
      continue;
    result.push(
      freeze({
        assignment: postRemoval,
        blocked: false,
        fromFingerprint: current.fingerprint,
        layoutFingerprint: layout.layoutFingerprint,
        targetLabId: target.id,
      }),
    );
  }
  return freeze(result);
}

function deriveAssignmentHandoffHolds(input: {
  readonly assignments: readonly LabClusterAssignment[];
  readonly eligibleHandoffs: readonly DerivedLabAssignmentHandoff[];
  readonly layouts: readonly CommittedLabLayout[];
  readonly limits: LabClusterLimits;
  readonly previousCommitments: readonly LabPolicyCommitment[];
  readonly rooms: readonly RoomSnapshot[];
}): readonly DerivedLabAssignmentHandoff[] {
  if (
    input.assignments.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumRooms ||
    input.eligibleHandoffs.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumRooms ||
    input.layouts.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumLayouts ||
    input.previousCommitments.length > LAB_COMPOSITION_HANDOFF_CAPS.maximumCommitments ||
    input.limits.maximumLabsScanned !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance
  )
    return freeze([]);
  const result: DerivedLabAssignmentHandoff[] = [];
  for (const current of input.assignments) {
    if (input.eligibleHandoffs.some(({ assignment }) => assignment.roomName === current.roomName))
      continue;
    const room = input.rooms.find(({ name }) => name === current.roomName);
    const labs = room?.ownedLabs ?? [];
    const previous = input.previousCommitments.filter(
      (commitment) =>
        commitment.kind === "reaction" &&
        commitment.colonyId === current.roomName &&
        commitment.assignmentFingerprint !== current.fingerprint,
    );
    const commitment = previous[0];
    if (
      room === undefined ||
      labs.length !== LAB_COMPOSITION_HANDOFF_CAPS.rcl8LabAllowance ||
      new Set(labs.map(({ id }) => id)).size !== labs.length ||
      previous.length !== 1 ||
      commitment === undefined
    )
      continue;
    const candidates = [...labs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((target): readonly { assignment: LabClusterAssignment; targetLabId: string }[] => {
        const retained = labs.filter(({ id }) => id !== target.id);
        const assignment = assignLabCluster({
          labs: retained,
          layoutFingerprint: fingerprintLabLayout(current.roomName, retained),
          limits: input.limits,
          roomName: current.roomName,
        }).assignment;
        return assignment !== null &&
          assignment.fingerprint === commitment.assignmentFingerprint &&
          sameAssignmentRoles(current, assignment) &&
          !assignmentIds(assignment).has(target.id)
          ? [{ assignment, targetLabId: target.id }]
          : [];
      });
    const candidate = candidates[0];
    if (candidates.length !== 1 || candidate === undefined) continue;
    const layouts = input.layouts.filter(({ roomName }) => roomName === current.roomName);
    const layout = layouts[0];
    result.push(
      freeze({
        assignment: candidate.assignment,
        blocked: true,
        fromFingerprint: current.fingerprint,
        layoutFingerprint:
          layouts.length === 1 &&
          layout !== undefined &&
          validIdentity(layout.layoutFingerprint, 128)
            ? layout.layoutFingerprint
            : null,
        targetLabId: candidate.targetLabId,
      }),
    );
  }
  return freeze(result);
}

const LAB_COMPOSITION_HANDOFF_CAPS = Object.freeze({
  maximumCommitments: 64,
  maximumLayouts: 64,
  maximumRooms: 8,
  rcl8LabAllowance: 10,
} as const);

function pendingAttemptsAllowHandoff(
  handoff: DerivedLabAssignmentHandoff,
  attempts: readonly PendingLabAttempt[],
  commitments: readonly LabPolicyCommitment[],
): boolean {
  if (attempts.length > 64) return false;
  const roomAttempts = attempts.filter(({ roomName }) => roomName === handoff.assignment.roomName);
  if (roomAttempts.length === 0) return true;
  const rebound = commitments.filter(
    (commitment) =>
      commitment.kind === "reaction" &&
      commitment.colonyId === handoff.assignment.roomName &&
      commitment.assignmentFingerprint === handoff.assignment.fingerprint,
  );
  const commitment = rebound[0];
  return (
    rebound.length === 1 &&
    commitment !== undefined &&
    roomAttempts.every(
      (attempt) =>
        attempt.assignmentFingerprint === handoff.assignment.fingerprint &&
        attempt.objectiveId === commitment.objectiveId &&
        attempt.objectiveRevision === commitment.objectiveRevision &&
        attempt.commitmentFingerprint === commitment.objectiveFingerprint &&
        attempt.catalogFingerprint === commitment.catalogFingerprint,
    )
  );
}

function validCommittedPositions(layout: CommittedLabLayout): boolean {
  const keys = new Set<string>();
  for (const position of layout.labPositions) {
    if (
      position.roomName !== layout.roomName ||
      !Number.isSafeInteger(position.x) ||
      !Number.isSafeInteger(position.y) ||
      position.x < 0 ||
      position.x > 49 ||
      position.y < 0 ||
      position.y > 49
    )
      return false;
    keys.add(positionKey(position));
  }
  return keys.size === layout.labPositions.length;
}

function emptyHandoffTarget(lab: OwnedLabSnapshot): boolean {
  return (
    lab.active &&
    lab.cooldown === 0 &&
    lab.energyCapacity === 2_000 &&
    lab.mineralCapacity === 3_000 &&
    lab.energy === 0 &&
    lab.mineralAmount === 0 &&
    lab.mineralType === null &&
    lab.store.usedCapacity === 0 &&
    lab.store.resources.length === 0
  );
}

function sameAssignmentRoles(left: LabClusterAssignment, right: LabClusterAssignment): boolean {
  return (
    sameStrings(left.reagentLabIds, right.reagentLabIds) &&
    sameStrings(left.productLabIds, right.productLabIds) &&
    sameStrings(left.boostLabIds, right.boostLabIds)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assignmentIds(assignment: LabClusterAssignment): ReadonlySet<string> {
  return new Set([
    ...assignment.reagentLabIds,
    ...assignment.productLabIds,
    ...assignment.boostLabIds,
  ]);
}

function positionKey(position: PositionSnapshot): string {
  return `${position.roomName}:${String(position.x)}:${String(position.y)}`;
}

function effectiveAssignments(
  current: readonly LabClusterAssignment[],
  handoffs: readonly DerivedLabAssignmentHandoff[],
  commitments: readonly LabPolicyCommitment[],
): readonly LabClusterAssignment[] {
  return freeze(
    current.map((assignment) => {
      const handoff = handoffs.find(
        ({ assignment: value }) => value.roomName === assignment.roomName,
      );
      if (handoff === undefined) return assignment;
      const rebound = commitments.filter(
        (commitment) =>
          commitment.colonyId === assignment.roomName &&
          commitment.kind === "reaction" &&
          commitment.assignmentFingerprint === handoff.assignment.fingerprint,
      );
      return rebound.length === 1 ? handoff.assignment : assignment;
    }),
  );
}

function pendingAssignmentHandoffKeys(
  previous: readonly LabPolicyCommitment[],
  projected: readonly LabPolicyCommitment[],
  handoffs: readonly DerivedLabAssignmentHandoff[],
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const handoff of handoffs) {
    const next = projected.find(
      (commitment) =>
        commitment.kind === "reaction" &&
        commitment.colonyId === handoff.assignment.roomName &&
        commitment.assignmentFingerprint === handoff.assignment.fingerprint,
    );
    if (next === undefined) continue;
    if (handoff.blocked) {
      result.add(commitmentKey(next));
      continue;
    }
    const prior = previous.find(
      (commitment) =>
        commitmentKey(commitment) === commitmentKey(next) &&
        commitment.assignmentFingerprint === handoff.fromFingerprint,
    );
    if (prior !== undefined) result.add(commitmentKey(next));
  }
  return result;
}

function projectAssignmentHandoffViews(input: {
  readonly handoffs: readonly DerivedLabAssignmentHandoff[];
  readonly previousCommitments: readonly LabPolicyCommitment[];
  readonly projection: LabPolicyProjection;
}): readonly LabAssignmentHandoffView[] {
  const result: LabAssignmentHandoffView[] = [];
  for (const handoff of input.handoffs) {
    const projected = input.projection.commitments.filter(
      (commitment) =>
        commitment.kind === "reaction" &&
        commitment.colonyId === handoff.assignment.roomName &&
        commitment.assignmentFingerprint === handoff.assignment.fingerprint,
    );
    const next = projected[0];
    if (projected.length !== 1 || next === undefined) continue;
    const previous = input.previousCommitments.filter(
      (commitment) => commitmentKey(commitment) === commitmentKey(next),
    );
    const prior = previous[0];
    if (previous.length !== 1 || prior?.kind !== "reaction") continue;
    const priorIsSource = prior.assignmentFingerprint === handoff.fromFingerprint;
    const priorIsRebound = prior.assignmentFingerprint === handoff.assignment.fingerprint;
    const executionReady = input.projection.dispositions.some(
      (disposition) =>
        disposition.kind === "reaction" &&
        disposition.objectiveId === next.objectiveId &&
        disposition.objectiveRevision === next.objectiveRevision &&
        disposition.status === "ready",
    );
    const status = handoff.blocked
      ? priorIsSource || priorIsRebound
        ? "blocked"
        : null
      : priorIsSource
        ? "pending"
        : priorIsRebound
          ? executionReady
            ? "ready"
            : "blocked"
          : null;
    if (status === null) continue;
    result.push(
      freeze({
        ...handoff,
        objectiveId: next.objectiveId,
        objectiveRevision: next.objectiveRevision,
        status,
      }),
    );
  }
  return freeze(result);
}

function commitmentKey(commitment: LabPolicyCommitment): string {
  return `${commitment.kind}:${commitment.objectiveId}:${String(commitment.objectiveRevision)}`;
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

export function fingerprintLabLayout(roomName: string, labs: readonly OwnedLabSnapshot[]): string {
  return fingerprint([
    roomName,
    ...[...labs]
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap(({ id, pos }) => [id, String(pos.x), String(pos.y)]),
  ]);
}
function labClusterLimits(maximumLabsPerRoom: number): LabClusterLimits {
  return freeze({
    maximumBoostLabs: Math.min(2, maximumLabsPerRoom - 2),
    maximumLabsScanned: maximumLabsPerRoom,
    maximumOutputLabs: Math.max(1, maximumLabsPerRoom - 2),
  });
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
function validIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
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
