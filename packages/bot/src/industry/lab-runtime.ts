import type { IntentData, IntentEnvelope } from "../execution";
import type { CreepSnapshot, OwnedLabSnapshot, WorldSnapshot } from "../world/snapshot";
import type { LabClusterAssignment } from "./lab-cluster";
import type { LabPolicyCommitment, LabPolicyDisposition } from "./lab-policy";

export const LAB_RUNTIME_CAPS = Object.freeze({
  maximumBoostParts: 50,
  maximumCandidates: 32,
  maximumCommitments: 64,
  maximumPendingAttempts: 64,
  maximumRetries: 3,
  maximumRooms: 8,
  observationDelay: 1,
  reactionAmount: 5,
  boostMineralPerPart: 30,
  boostEnergyPerPart: 20,
} as const);

interface LabIntentPayloadBase {
  readonly [key: string]: IntentData;
  readonly assignmentFingerprint: string;
  readonly catalogFingerprint: string;
  readonly commitmentFingerprint: string;
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly roomName: string;
}

export type LabRunReactionIntent = IntentEnvelope<
  "lab.run-reaction",
  LabIntentPayloadBase & {
    readonly amount: 5;
    readonly product: string;
    readonly productLabId: string;
    readonly productMineralBefore: number;
    readonly reagentLabIds: readonly [string, string];
    readonly reagentMineralsBefore: readonly [number, number];
    readonly reagents: readonly [string, string];
  }
>;

export type LabBoostCreepIntent = IntentEnvelope<
  "lab.boost-creep",
  LabIntentPayloadBase & {
    readonly bodyPartsCount: number;
    readonly compound: string;
    readonly creepFingerprint: string;
    readonly creepId: string;
    readonly energyBefore: number;
    readonly labId: string;
    readonly mineralBefore: number;
    readonly partType: string;
    readonly targetBoostedPartsBefore: number;
  }
>;

export type LabCommandIntent = LabRunReactionIntent | LabBoostCreepIntent;

export interface PlanLabCommandInput {
  readonly assignments: readonly LabClusterAssignment[];
  readonly commitments: readonly LabPolicyCommitment[];
  readonly creepFingerprints: ReadonlyMap<string, string>;
  readonly dispositions: readonly LabPolicyDisposition[];
  readonly pendingAttempts?: readonly PendingLabAttempt[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}

/**
 * Pure policy-owned arbitration before submission to the shared IntentChannel.
 * The shared arbiter remains final admission authority.
 */
export function arbitrateLabCommands(input: PlanLabCommandInput): readonly LabCommandIntent[] {
  if (!identity(input.snapshotRevision)) return Object.freeze([]);
  const tick = input.snapshot.observation.tick;
  const pending = new Set(
    (input.pendingAttempts ?? [])
      .slice(0, LAB_RUNTIME_CAPS.maximumPendingAttempts)
      .map(commitmentKeyForAttempt),
  );
  const ready = new Set(
    input.dispositions.filter(({ status }) => status === "ready").map(dispositionKey),
  );
  const assignments = new Map(
    [...input.assignments]
      .sort((left, right) => compare(left.roomName, right.roomName))
      .slice(0, LAB_RUNTIME_CAPS.maximumRooms)
      .map((assignment) => [assignment.roomName, assignment] as const),
  );
  const candidates: LabCommandIntent[] = [];
  const seenCommitments = new Set<string>();

  for (const commitment of [...input.commitments]
    .slice(0, LAB_RUNTIME_CAPS.maximumCommitments)
    .sort(compareCommitments)) {
    const key = commitmentKey(commitment);
    if (
      seenCommitments.has(key) ||
      pending.has(key) ||
      !ready.has(dispositionKey(commitment)) ||
      commitment.deadline < tick
    )
      continue;
    seenCommitments.add(key);
    const assignment = assignments.get(commitment.colonyId);
    const room = input.snapshot.ownedRooms.find(({ name }) => name === commitment.colonyId);
    if (
      assignment === undefined ||
      room === undefined ||
      assignment.fingerprint !== commitment.assignmentFingerprint
    )
      continue;
    const intent =
      commitment.kind === "boost"
        ? boostIntent(
            commitment,
            assignment,
            room,
            input.creepFingerprints,
            input.snapshotRevision,
            tick,
          )
        : reactionIntent(commitment, assignment, room, input.snapshotRevision, tick);
    if (intent !== null) candidates.push(intent);
    if (candidates.length >= LAB_RUNTIME_CAPS.maximumCandidates) break;
  }

  const selected: LabCommandIntent[] = [];
  const usedRooms = new Set<string>();
  const usedCreeps = new Set<string>();
  for (const intent of candidates.sort(compareIntents)) {
    if (usedRooms.has(intent.payload.roomName)) continue;
    if (intent.kind === "lab.boost-creep" && usedCreeps.has(intent.payload.creepId)) continue;
    usedRooms.add(intent.payload.roomName);
    if (intent.kind === "lab.boost-creep") usedCreeps.add(intent.payload.creepId);
    selected.push(intent);
    if (selected.length >= LAB_RUNTIME_CAPS.maximumRooms) break;
  }
  return Object.freeze(selected);
}

export const projectLabCommandIntents = arbitrateLabCommands;

interface PendingLabAttemptBase {
  readonly assignmentFingerprint: string;
  readonly attemptId: string;
  readonly catalogFingerprint: string;
  readonly commitmentFingerprint: string;
  readonly issuedAt: number;
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly observeAt: number;
  readonly retry: number;
  readonly roomName: string;
  readonly snapshotRevision: string;
}

export interface PendingReactionAttempt extends PendingLabAttemptBase {
  readonly kind: "reaction";
  readonly product: string;
  readonly productLabId: string;
  readonly productMineralBefore: number;
  readonly reagentLabIds: readonly [string, string];
  readonly reagentMineralsBefore: readonly [number, number];
  readonly reagents: readonly [string, string];
}

export interface PendingBoostAttempt extends PendingLabAttemptBase {
  readonly bodyPartsCount: number;
  readonly compound: string;
  readonly creepFingerprint: string;
  readonly creepId: string;
  readonly energyBefore: number;
  readonly kind: "boost";
  readonly labId: string;
  readonly mineralBefore: number;
  readonly partType: string;
  readonly targetBoostedPartsBefore: number;
}

export type PendingLabAttempt = PendingReactionAttempt | PendingBoostAttempt;

/** OK schedules observation; every other normalized command result creates no attempt. */
export function createPendingLabAttempt(
  intent: LabCommandIntent,
  result: string,
  retry = 0,
): PendingLabAttempt | null {
  if (result !== "OK" || !nonnegativeInteger(retry, LAB_RUNTIME_CAPS.maximumRetries - 1))
    return null;
  const base = {
    assignmentFingerprint: intent.payload.assignmentFingerprint,
    attemptId: intent.id,
    catalogFingerprint: intent.payload.catalogFingerprint,
    commitmentFingerprint: intent.payload.commitmentFingerprint,
    issuedAt: intent.tick,
    objectiveId: intent.payload.objectiveId,
    objectiveRevision: intent.payload.objectiveRevision,
    observeAt: intent.tick + LAB_RUNTIME_CAPS.observationDelay,
    retry,
    roomName: intent.payload.roomName,
    snapshotRevision: intent.snapshotRevision,
  };
  return intent.kind === "lab.run-reaction"
    ? freeze({
        ...base,
        kind: "reaction" as const,
        product: intent.payload.product,
        productLabId: intent.payload.productLabId,
        productMineralBefore: intent.payload.productMineralBefore,
        reagentLabIds: intent.payload.reagentLabIds,
        reagentMineralsBefore: intent.payload.reagentMineralsBefore,
        reagents: intent.payload.reagents,
      })
    : freeze({
        ...base,
        bodyPartsCount: intent.payload.bodyPartsCount,
        compound: intent.payload.compound,
        creepFingerprint: intent.payload.creepFingerprint,
        creepId: intent.payload.creepId,
        energyBefore: intent.payload.energyBefore,
        kind: "boost" as const,
        labId: intent.payload.labId,
        mineralBefore: intent.payload.mineralBefore,
        partType: intent.payload.partType,
        targetBoostedPartsBefore: intent.payload.targetBoostedPartsBefore,
      });
}

export type LabSettlementReason =
  | "exact-effect"
  | "awaiting-observation"
  | "no-effect"
  | "conflicting-effect"
  | "missing-lab"
  | "inactive-lab"
  | "lost-creep"
  | "fingerprint-changed"
  | "commitment-changed"
  | "cluster-changed"
  | "deadline"
  | "observation-timeout"
  | "retry-cap";

export interface LabAttemptSettlement {
  readonly attemptId: string;
  readonly kind: "boost" | "reaction";
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly reason: LabSettlementReason;
  readonly retry: number;
  readonly settledAmount: number;
  readonly status: "cancelled" | "pending" | "retry" | "settled";
}

export function reconcilePendingLabAttempts(input: {
  readonly assignments: readonly LabClusterAssignment[];
  readonly commitments: readonly LabPolicyCommitment[];
  readonly creepFingerprints: ReadonlyMap<string, string>;
  readonly pendingAttempts: readonly PendingLabAttempt[];
  readonly snapshot: WorldSnapshot;
}): readonly LabAttemptSettlement[] {
  const assignments = new Map(input.assignments.map((value) => [value.roomName, value] as const));
  const commitments = new Map(
    input.commitments.map((value) => [commitmentKey(value), value] as const),
  );
  const tick = input.snapshot.observation.tick;
  return Object.freeze(
    [...input.pendingAttempts]
      .slice(0, LAB_RUNTIME_CAPS.maximumPendingAttempts)
      .sort((left, right) => compare(left.attemptId, right.attemptId))
      .map((attempt) => {
        if (tick <= attempt.issuedAt)
          return settlement(attempt, "pending", "awaiting-observation", 0);
        const commitment = commitments.get(commitmentKeyForAttempt(attempt));
        if (
          commitment === undefined ||
          commitment.kind !== attempt.kind ||
          commitment.objectiveFingerprint !== attempt.commitmentFingerprint ||
          commitment.catalogFingerprint !== attempt.catalogFingerprint
        )
          return settlement(attempt, "cancelled", "commitment-changed", 0);
        if (tick > commitment.deadline) return settlement(attempt, "cancelled", "deadline", 0);
        const assignment = assignments.get(attempt.roomName);
        if (assignment?.fingerprint !== attempt.assignmentFingerprint)
          return settlement(attempt, "cancelled", "cluster-changed", 0);
        if (tick < attempt.observeAt)
          return settlement(attempt, "pending", "awaiting-observation", 0);
        if (tick > attempt.observeAt) return retry(attempt, "observation-timeout");
        const room = input.snapshot.ownedRooms.find(({ name }) => name === attempt.roomName);
        if (room === undefined) return settlement(attempt, "cancelled", "missing-lab", 0);
        return attempt.kind === "reaction"
          ? reconcileReaction(attempt, room.ownedLabs ?? [])
          : reconcileBoost(
              attempt,
              room.ownedLabs ?? [],
              room.ownedCreeps,
              input.creepFingerprints,
            );
      }),
  );
}

export function isPendingLabAttempt(value: unknown): value is PendingLabAttempt {
  if (
    !record(value) ||
    !identity(value.assignmentFingerprint) ||
    !identity(value.attemptId) ||
    !identity(value.catalogFingerprint) ||
    !identity(value.commitmentFingerprint) ||
    !nonnegativeInteger(value.issuedAt) ||
    !identity(value.objectiveId) ||
    !positiveInteger(value.objectiveRevision) ||
    value.observeAt !== value.issuedAt + LAB_RUNTIME_CAPS.observationDelay ||
    !nonnegativeInteger(value.retry, LAB_RUNTIME_CAPS.maximumRetries - 1) ||
    !identity(value.roomName, 16) ||
    !identity(value.snapshotRevision)
  )
    return false;
  if (value.kind === "reaction") {
    return (
      identity(value.product, 64) &&
      identity(value.productLabId, 128) &&
      nonnegativeInteger(value.productMineralBefore) &&
      stringPair(value.reagentLabIds, 128) &&
      integerPair(value.reagentMineralsBefore) &&
      stringPair(value.reagents, 64)
    );
  }
  return (
    value.kind === "boost" &&
    positiveInteger(value.bodyPartsCount, LAB_RUNTIME_CAPS.maximumBoostParts) &&
    identity(value.compound, 64) &&
    identity(value.creepFingerprint) &&
    identity(value.creepId, 128) &&
    nonnegativeInteger(value.energyBefore) &&
    identity(value.labId, 128) &&
    nonnegativeInteger(value.mineralBefore) &&
    identity(value.partType, 32) &&
    nonnegativeInteger(value.targetBoostedPartsBefore, LAB_RUNTIME_CAPS.maximumBoostParts)
  );
}

function reactionIntent(
  commitment: Extract<LabPolicyCommitment, { kind: "reaction" }>,
  assignment: LabClusterAssignment,
  room: WorldSnapshot["ownedRooms"][number],
  snapshotRevision: string,
  tick: number,
): LabRunReactionIntent | null {
  const [reagentAId, reagentBId] = assignment.reagentLabIds;
  const productLabId = [...assignment.productLabIds].sort(compare)[0];
  if (productLabId === undefined) return null;
  const labs = room.ownedLabs ?? [];
  const reagentA = labs.find(({ id }) => id === reagentAId);
  const reagentB = labs.find(({ id }) => id === reagentBId);
  const product = labs.find(({ id }) => id === productLabId);
  if (
    !readyReactionLab(reagentA, commitment.reagents[0], LAB_RUNTIME_CAPS.reactionAmount) ||
    !readyReactionLab(reagentB, commitment.reagents[1], LAB_RUNTIME_CAPS.reactionAmount) ||
    product === undefined ||
    !product.active ||
    product.cooldown !== 0 ||
    (product.mineralType !== null && product.mineralType !== commitment.product) ||
    product.mineralCapacity - product.mineralAmount < LAB_RUNTIME_CAPS.reactionAmount ||
    range(product, reagentA) > 2 ||
    range(product, reagentB) > 2
  )
    return null;
  return freeze({
    id: intentId(commitment, tick),
    kind: "lab.run-reaction" as const,
    issuer: `industry/${commitment.colonyId}/labs`,
    tick,
    target: product.id,
    snapshotRevision,
    exclusiveResourceKey: clusterKey(commitment.colonyId, assignment.fingerprint),
    priority: { class: "speculation" as const, value: commitment.priority },
    deadline: Math.min(tick, commitment.deadline),
    budget: { id: commitment.objectiveId, cost: 1 },
    preconditions: [],
    payload: {
      amount: 5 as const,
      assignmentFingerprint: assignment.fingerprint,
      catalogFingerprint: commitment.catalogFingerprint,
      commitmentFingerprint: commitment.objectiveFingerprint,
      objectiveId: commitment.objectiveId,
      objectiveRevision: commitment.objectiveRevision,
      product: commitment.product,
      productLabId: product.id,
      productMineralBefore: product.mineralAmount,
      reagentLabIds: [reagentA.id, reagentB.id] as const,
      reagentMineralsBefore: [reagentA.mineralAmount, reagentB.mineralAmount] as const,
      reagents: commitment.reagents,
      roomName: commitment.colonyId,
    },
  });
}

function boostIntent(
  commitment: Extract<LabPolicyCommitment, { kind: "boost" }>,
  assignment: LabClusterAssignment,
  room: WorldSnapshot["ownedRooms"][number],
  fingerprints: ReadonlyMap<string, string>,
  snapshotRevision: string,
  tick: number,
): LabBoostCreepIntent | null {
  const creep = room.ownedCreeps.find(({ id }) => id === commitment.creepId);
  if (
    creep === undefined ||
    creep.spawning ||
    fingerprints.get(creep.id) !== commitment.creepFingerprint
  )
    return null;
  const remaining = Math.min(
    LAB_RUNTIME_CAPS.maximumBoostParts,
    commitment.partCount - commitment.settledParts,
  );
  const boosted = boostCount(creep, commitment.partType, commitment.compound);
  const unboosted =
    bodyPartCount(creep, commitment.partType) - totalBoostCount(creep, commitment.partType);
  if (remaining <= 0 || unboosted < remaining) return null;
  const lab = (room.ownedLabs ?? [])
    .filter(({ id }) => assignment.boostLabIds.includes(id))
    .sort((left, right) => compare(left.id, right.id))
    .find(
      (value) =>
        value.active &&
        value.mineralType === commitment.compound &&
        value.mineralAmount >= remaining * LAB_RUNTIME_CAPS.boostMineralPerPart &&
        value.energy >= remaining * LAB_RUNTIME_CAPS.boostEnergyPerPart &&
        range(value, creep) <= 1,
    );
  if (lab === undefined) return null;
  return freeze({
    id: intentId(commitment, tick),
    kind: "lab.boost-creep" as const,
    issuer: `industry/${commitment.colonyId}/labs`,
    tick,
    target: creep.id,
    snapshotRevision,
    exclusiveResourceKey: clusterKey(commitment.colonyId, assignment.fingerprint),
    priority: { class: "defense" as const, value: commitment.priority },
    deadline: Math.min(tick, commitment.deadline),
    budget: { id: commitment.objectiveId, cost: 1 },
    preconditions: [],
    payload: {
      assignmentFingerprint: assignment.fingerprint,
      bodyPartsCount: remaining,
      catalogFingerprint: commitment.catalogFingerprint,
      commitmentFingerprint: commitment.objectiveFingerprint,
      compound: commitment.compound,
      creepFingerprint: commitment.creepFingerprint,
      creepId: creep.id,
      energyBefore: lab.energy,
      labId: lab.id,
      mineralBefore: lab.mineralAmount,
      objectiveId: commitment.objectiveId,
      objectiveRevision: commitment.objectiveRevision,
      partType: commitment.partType,
      roomName: commitment.colonyId,
      targetBoostedPartsBefore: boosted,
    },
  });
}

function reconcileReaction(
  attempt: PendingReactionAttempt,
  labs: readonly OwnedLabSnapshot[],
): LabAttemptSettlement {
  const product = labs.find(({ id }) => id === attempt.productLabId);
  const reagentA = labs.find(({ id }) => id === attempt.reagentLabIds[0]);
  const reagentB = labs.find(({ id }) => id === attempt.reagentLabIds[1]);
  if (product === undefined || reagentA === undefined || reagentB === undefined)
    return settlement(attempt, "cancelled", "missing-lab", 0);
  if (!product.active || !reagentA.active || !reagentB.active)
    return settlement(attempt, "cancelled", "inactive-lab", 0);
  const productDelta = product.mineralAmount - attempt.productMineralBefore;
  const reagentADelta = attempt.reagentMineralsBefore[0] - reagentA.mineralAmount;
  const reagentBDelta = attempt.reagentMineralsBefore[1] - reagentB.mineralAmount;
  const typesMatch =
    product.mineralType === attempt.product &&
    reagentTypeAfterConsumption(reagentA, attempt.reagents[0], attempt.reagentMineralsBefore[0]) &&
    reagentTypeAfterConsumption(reagentB, attempt.reagents[1], attempt.reagentMineralsBefore[1]);
  if (
    typesMatch &&
    productDelta === LAB_RUNTIME_CAPS.reactionAmount &&
    reagentADelta === LAB_RUNTIME_CAPS.reactionAmount &&
    reagentBDelta === LAB_RUNTIME_CAPS.reactionAmount
  )
    return settlement(attempt, "settled", "exact-effect", LAB_RUNTIME_CAPS.reactionAmount);
  if (productDelta === 0 && reagentADelta === 0 && reagentBDelta === 0)
    return retry(attempt, "no-effect");
  return settlement(attempt, "cancelled", "conflicting-effect", 0);
}

function reagentTypeAfterConsumption(
  lab: OwnedLabSnapshot,
  expected: string,
  before: number,
): boolean {
  return (
    lab.mineralType === expected ||
    (before === LAB_RUNTIME_CAPS.reactionAmount &&
      lab.mineralAmount === 0 &&
      lab.mineralType === null)
  );
}

function reconcileBoost(
  attempt: PendingBoostAttempt,
  labs: readonly OwnedLabSnapshot[],
  creeps: readonly CreepSnapshot[],
  fingerprints: ReadonlyMap<string, string>,
): LabAttemptSettlement {
  const lab = labs.find(({ id }) => id === attempt.labId);
  if (lab === undefined) return settlement(attempt, "cancelled", "missing-lab", 0);
  if (!lab.active) return settlement(attempt, "cancelled", "inactive-lab", 0);
  const creep = creeps.find(({ id }) => id === attempt.creepId);
  if (creep === undefined) return settlement(attempt, "cancelled", "lost-creep", 0);
  if (fingerprints.get(creep.id) !== attempt.creepFingerprint)
    return settlement(attempt, "cancelled", "fingerprint-changed", 0);
  const partsDelta =
    boostCount(creep, attempt.partType, attempt.compound) - attempt.targetBoostedPartsBefore;
  const mineralDelta = attempt.mineralBefore - lab.mineralAmount;
  const energyDelta = attempt.energyBefore - lab.energy;
  if (
    partsDelta > 0 &&
    partsDelta <= attempt.bodyPartsCount &&
    mineralDelta === partsDelta * LAB_RUNTIME_CAPS.boostMineralPerPart &&
    energyDelta === partsDelta * LAB_RUNTIME_CAPS.boostEnergyPerPart
  )
    return settlement(attempt, "settled", "exact-effect", partsDelta);
  if (partsDelta === 0 && mineralDelta === 0 && energyDelta === 0)
    return retry(attempt, "no-effect");
  return settlement(attempt, "cancelled", "conflicting-effect", 0);
}

function retry(attempt: PendingLabAttempt, reason: "no-effect" | "observation-timeout") {
  return attempt.retry + 1 >= LAB_RUNTIME_CAPS.maximumRetries
    ? settlement(attempt, "cancelled", "retry-cap", 0)
    : settlement(attempt, "retry", reason, 0);
}

function settlement(
  attempt: PendingLabAttempt,
  status: LabAttemptSettlement["status"],
  reason: LabSettlementReason,
  settledAmount: number,
): LabAttemptSettlement {
  return freeze({
    attemptId: attempt.attemptId,
    kind: attempt.kind,
    objectiveId: attempt.objectiveId,
    objectiveRevision: attempt.objectiveRevision,
    reason,
    retry: status === "retry" ? attempt.retry + 1 : attempt.retry,
    settledAmount,
    status,
  });
}

function readyReactionLab(
  lab: OwnedLabSnapshot | undefined,
  mineral: string,
  amount: number,
): lab is OwnedLabSnapshot {
  return (
    lab !== undefined && lab.active && lab.mineralType === mineral && lab.mineralAmount >= amount
  );
}

function bodyPartCount(creep: CreepSnapshot, partType: string): number {
  const key = partType === "ranged_attack" ? "rangedAttack" : partType;
  const value = creep.body[key as keyof CreepSnapshot["body"]];
  return typeof value === "object" && "total" in value ? value.total : 0;
}

function boostCount(creep: CreepSnapshot, partType: string, compound: string): number {
  return (creep.boosts ?? [])
    .filter((value) => value.bodyPart === partType && value.compound === compound)
    .reduce((total, value) => total + value.count, 0);
}

function totalBoostCount(creep: CreepSnapshot, partType: string): number {
  return (creep.boosts ?? [])
    .filter((value) => value.bodyPart === partType)
    .reduce((total, value) => total + value.count, 0);
}

function compareCommitments(left: LabPolicyCommitment, right: LabPolicyCommitment): number {
  return (
    (left.kind === right.kind ? 0 : left.kind === "boost" ? -1 : 1) ||
    right.priority - left.priority ||
    compare(left.colonyId, right.colonyId) ||
    compare(left.objectiveId, right.objectiveId) ||
    left.objectiveRevision - right.objectiveRevision
  );
}

function compareIntents(left: LabCommandIntent, right: LabCommandIntent): number {
  return (
    (left.kind === right.kind ? 0 : left.kind === "lab.boost-creep" ? -1 : 1) ||
    right.priority.value - left.priority.value ||
    compare(left.id, right.id)
  );
}

function intentId(commitment: LabPolicyCommitment, tick: number): string {
  return `lab-runtime/${commitment.colonyId}/${commitment.kind}/${commitment.objectiveId}/${String(commitment.objectiveRevision)}/${String(tick)}`;
}
function clusterKey(roomName: string, fingerprint: string): string {
  return `lab-cluster/${roomName}/${fingerprint}`;
}
function commitmentKey(value: LabPolicyCommitment): string {
  return `${value.kind}:${value.objectiveId}:${String(value.objectiveRevision)}`;
}
function commitmentKeyForAttempt(value: PendingLabAttempt): string {
  return `${value.kind}:${value.objectiveId}:${String(value.objectiveRevision)}`;
}
function dispositionKey(
  value: Pick<LabPolicyDisposition, "kind" | "objectiveId" | "objectiveRevision">,
): string {
  return `${value.kind}:${value.objectiveId}:${String(value.objectiveRevision)}`;
}
function range(
  left: { readonly pos: { readonly x: number; readonly y: number } },
  right: { readonly pos: { readonly x: number; readonly y: number } },
): number {
  return Math.max(Math.abs(left.pos.x - right.pos.x), Math.abs(left.pos.y - right.pos.y));
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}
function nonnegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}
function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return nonnegativeInteger(value, maximum) && value > 0;
}
function stringPair(value: unknown, maximum: number): value is readonly [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((item) => identity(item, maximum))
  );
}
function integerPair(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((item) => nonnegativeInteger(item))
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
