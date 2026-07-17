import type { IntentData, IntentEnvelope } from "../execution";
import type {
  FactoryBatchObjective,
  PowerProcessingObjective,
} from "../logistics/mature-resource-demands";
import type {
  OwnedFactorySnapshot,
  OwnedPowerSpawnSnapshot,
  StoreSnapshot,
  WorldSnapshot,
} from "../world/snapshot";
import {
  MATURE_ATTEMPT_CAPS,
  type MatureResourceAmountData,
  type PendingFactoryAttempt,
  type PendingMatureAttempt,
  type PendingPowerAttempt,
} from "./mature-attempt";
import type { MatureMechanicsCatalog, MatureStructureCapability } from "./mature-capabilities";
import type { MaturePolicyCommitment } from "./mature-policy";

export {
  isPendingMatureAttempt,
  type PendingFactoryAttempt,
  type PendingMatureAttempt,
  type PendingPowerAttempt,
} from "./mature-attempt";

export const MATURE_RUNTIME_CAPS = Object.freeze({
  maximumCandidates: 32,
  maximumCapabilities: 32,
  maximumCommitments: 64,
  maximumFactoryStoreResources: MATURE_ATTEMPT_CAPS.maximumFactoryStoreResources,
  maximumPendingAttempts: 64,
  maximumRetries: MATURE_ATTEMPT_CAPS.maximumRetries,
  observationDelay: MATURE_ATTEMPT_CAPS.observationDelay,
} as const);

interface MatureIntentPayloadBase {
  readonly [key: string]: IntentData;
  readonly capabilityFingerprint: string;
  readonly commitmentFingerprint: string;
  readonly mechanicsFingerprint: string;
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly roomName: string;
  readonly structureId: string;
}

export type MatureFactoryProduceIntent = IntentEnvelope<
  "factory.produce",
  MatureIntentPayloadBase & {
    readonly batchAmount: number;
    readonly components: readonly MatureResourceAmountData[];
    readonly cooldown: number;
    readonly factoryLevel: number | null;
    readonly operateFactoryPower: number;
    readonly product: string;
    readonly productBefore: number;
    readonly resourcesBefore: readonly MatureResourceAmountData[];
    readonly storeCapacity: number;
    readonly storeUsedBefore: number;
  }
>;

export type MaturePowerProcessIntent = IntentEnvelope<
  "power-spawn.process-power",
  MatureIntentPayloadBase & {
    readonly energyBefore: number;
    readonly energyPerPower: number;
    readonly operatePowerEffect: number;
    readonly operatePowerLevel: number;
    readonly operatePowerPower: number;
    readonly powerBefore: number;
    readonly units: number;
  }
>;

export type MatureCommandIntent = MatureFactoryProduceIntent | MaturePowerProcessIntent;

export interface ProjectMatureCommandInput {
  readonly capabilities: readonly MatureStructureCapability[];
  readonly catalog: MatureMechanicsCatalog;
  readonly commitments: readonly MaturePolicyCommitment[];
  readonly pendingAttempts?: readonly PendingMatureAttempt[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}

/** Pure domain arbitration. The shared IntentChannel remains final admission authority. */
export function projectMatureCommandIntents(
  input: ProjectMatureCommandInput,
): readonly MatureCommandIntent[] {
  if (
    !identity(input.snapshotRevision) ||
    input.capabilities.length > MATURE_RUNTIME_CAPS.maximumCapabilities ||
    input.commitments.length > MATURE_RUNTIME_CAPS.maximumCommitments ||
    (input.pendingAttempts?.length ?? 0) > MATURE_RUNTIME_CAPS.maximumPendingAttempts
  )
    return freeze([]);
  const tick = input.snapshot.observation.tick;
  const pending = new Set(
    [...(input.pendingAttempts ?? [])]
      .sort((a, b) => compare(a.attemptId, b.attemptId))
      .filter(({ retryReady }) => retryReady !== true)
      .map(attemptCommitmentKey),
  );
  const candidates: MatureCommandIntent[] = [];
  const commitmentCounts = new Map<string, number>();
  for (const { objective } of input.commitments) {
    const key = commitmentKey(objective.id, objective.revision);
    commitmentCounts.set(key, (commitmentCounts.get(key) ?? 0) + 1);
  }

  for (const commitment of [...input.commitments].sort(compareCommitments)) {
    const objective = commitment.objective;
    const key = commitmentKey(objective.id, objective.revision);
    if (
      commitmentCounts.get(key) !== 1 ||
      pending.has(key) ||
      commitment.status !== "ready" ||
      !objective.funded ||
      objective.deadline < tick ||
      objective.mechanicsFingerprint !== input.catalog.fingerprint ||
      objective.kind === "nuker-stock"
    )
      continue;
    const room = input.snapshot.ownedRooms.find(({ name }) => name === objective.colonyId);
    if (room === undefined) continue;
    const matchingCapabilities = input.capabilities.filter(
      ({ active, id, roomName }) =>
        active && id === objective.structureId && roomName === objective.colonyId,
    );
    if (matchingCapabilities.length !== 1) continue;
    const capability = matchingCapabilities[0];
    if (capability === undefined) continue;
    const intent =
      objective.kind === "factory-batch"
        ? factoryIntent(
            objective,
            capability,
            room.ownedFactories ?? [],
            input.catalog,
            tick,
            input.snapshotRevision,
          )
        : powerIntent(
            objective,
            capability,
            room.ownedPowerSpawns ?? [],
            input.catalog,
            tick,
            input.snapshotRevision,
          );
    if (intent !== null) candidates.push(intent);
    if (candidates.length >= MATURE_RUNTIME_CAPS.maximumCandidates) break;
  }

  const selected: MatureCommandIntent[] = [];
  const usedStructures = new Set<string>();
  for (const intent of candidates.sort(compareIntents)) {
    if (usedStructures.has(intent.payload.structureId)) continue;
    usedStructures.add(intent.payload.structureId);
    selected.push(intent);
  }
  return freeze(selected);
}

export const arbitrateMatureCommands = projectMatureCommandIntents;

function factoryIntent(
  objective: FactoryBatchObjective,
  capability: MatureStructureCapability,
  factories: readonly OwnedFactorySnapshot[],
  catalog: MatureMechanicsCatalog,
  tick: number,
  snapshotRevision: string,
): MatureFactoryProduceIntent | null {
  const factory = factories.find(({ id }) => id === objective.structureId);
  const recipe = catalog.recipes.find(({ product }) => product === objective.product);
  if (
    capability.kind !== "factory" ||
    factory === undefined ||
    recipe === undefined ||
    !factory.active ||
    factory.cooldown !== 0 ||
    objective.batches <= 0 ||
    !capability.availableProducts.includes(objective.product) ||
    factory.store.capacity === null ||
    factory.store.usedCapacity < 0
  )
    return null;
  const operated = factory.effects.filter(
    ({ effect, ticksRemaining }) =>
      effect === catalog.constants.operateFactoryPower && ticksRemaining > 0,
  );
  if (
    recipe.level !== null &&
    (factory.level !== recipe.level || operated.length !== 1 || operated[0]?.level !== recipe.level)
  )
    return null;
  const components = recipe.components.map(({ amount, resourceType }) =>
    freeze({ amount, resourceType }),
  );
  if (
    components.some(({ amount, resourceType }) => storeAmount(factory.store, resourceType) < amount)
  )
    return null;
  const componentsTotal = components.reduce((total, { amount }) => total + amount, 0);
  if (factory.store.usedCapacity - componentsTotal + recipe.amount > factory.store.capacity)
    return null;
  const affected = new Set([
    ...factory.store.resources.map(({ resourceType }) => resourceType),
    objective.product,
    ...components.map(({ resourceType }) => resourceType),
  ]);
  if (affected.size > MATURE_RUNTIME_CAPS.maximumFactoryStoreResources) return null;
  const resourcesBefore = [...affected]
    .sort(compare)
    .map((resourceType) =>
      freeze({ amount: storeAmount(factory.store, resourceType), resourceType }),
    );
  const commitmentFingerprint = fingerprintMatureObjective(objective);
  return freeze({
    id: intentId(objective.id, objective.revision, tick),
    kind: "factory.produce" as const,
    issuer: `industry/${objective.colonyId}/mature`,
    tick,
    target: factory.id,
    snapshotRevision,
    exclusiveResourceKey: structureKey(factory.id),
    priority: { class: "speculation" as const, value: 20 },
    deadline: Math.min(tick, objective.deadline),
    budget: { id: objective.industryBudgetId, cost: 1 },
    preconditions: [],
    payload: {
      batchAmount: recipe.amount,
      capabilityFingerprint: capability.fingerprint,
      commitmentFingerprint,
      components,
      cooldown: recipe.cooldown,
      factoryLevel: factory.level,
      mechanicsFingerprint: catalog.fingerprint,
      objectiveId: objective.id,
      objectiveRevision: objective.revision,
      operateFactoryPower: catalog.constants.operateFactoryPower,
      product: objective.product,
      productBefore: storeAmount(factory.store, objective.product),
      resourcesBefore,
      roomName: objective.colonyId,
      storeCapacity: factory.store.capacity,
      storeUsedBefore: factory.store.usedCapacity,
      structureId: factory.id,
    },
  });
}

function powerIntent(
  objective: PowerProcessingObjective,
  capability: MatureStructureCapability,
  powerSpawns: readonly OwnedPowerSpawnSnapshot[],
  catalog: MatureMechanicsCatalog,
  tick: number,
  snapshotRevision: string,
): MaturePowerProcessIntent | null {
  const powerSpawn = powerSpawns.find(({ id }) => id === objective.structureId);
  if (
    capability.kind !== "power-spawn" ||
    powerSpawn === undefined ||
    !powerSpawn.active ||
    objective.units <= 0
  )
    return null;
  const activeEffects = powerSpawn.effects.filter(
    ({ effect, ticksRemaining }) =>
      effect === catalog.constants.operatePowerPower && ticksRemaining > 0,
  );
  if (activeEffects.length > 1) return null;
  const operatePowerLevel = activeEffects[0]?.level ?? 0;
  if (!nonnegativeInteger(operatePowerLevel) || operatePowerLevel > 5) return null;
  const operatePowerEffect =
    operatePowerLevel === 0 ? 0 : catalog.constants.operatePowerEffects[operatePowerLevel - 1];
  if (operatePowerEffect === undefined) return null;
  const units = 1 + operatePowerEffect;
  const powerBefore = storeAmount(powerSpawn.store, "power");
  const energyBefore = storeAmount(powerSpawn.store, "energy");
  if (
    units <= 0 ||
    objective.units < units ||
    powerBefore < units ||
    energyBefore < units * catalog.constants.powerSpawnEnergyPerPower
  )
    return null;
  return freeze({
    id: intentId(objective.id, objective.revision, tick),
    kind: "power-spawn.process-power" as const,
    issuer: `industry/${objective.colonyId}/mature`,
    tick,
    target: powerSpawn.id,
    snapshotRevision,
    exclusiveResourceKey: structureKey(powerSpawn.id),
    priority: { class: "speculation" as const, value: 10 },
    deadline: Math.min(tick, objective.deadline),
    budget: { id: objective.industryBudgetId, cost: 1 },
    preconditions: [],
    payload: {
      capabilityFingerprint: capability.fingerprint,
      commitmentFingerprint: fingerprintMatureObjective(objective),
      energyBefore,
      energyPerPower: catalog.constants.powerSpawnEnergyPerPower,
      mechanicsFingerprint: catalog.fingerprint,
      objectiveId: objective.id,
      objectiveRevision: objective.revision,
      operatePowerEffect,
      operatePowerLevel,
      operatePowerPower: catalog.constants.operatePowerPower,
      powerBefore,
      roomName: objective.colonyId,
      structureId: powerSpawn.id,
      units,
    },
  });
}

export function createPendingMatureAttempt(
  intent: MatureCommandIntent,
  result: string,
  retry = 0,
): PendingMatureAttempt | null {
  if (result !== "OK" || !nonnegativeInteger(retry) || retry >= MATURE_RUNTIME_CAPS.maximumRetries)
    return null;
  const base = {
    attemptId: intent.id,
    capabilityFingerprint: intent.payload.capabilityFingerprint,
    commitmentFingerprint: intent.payload.commitmentFingerprint,
    issuedAt: intent.tick,
    mechanicsFingerprint: intent.payload.mechanicsFingerprint,
    objectiveId: intent.payload.objectiveId,
    objectiveRevision: intent.payload.objectiveRevision,
    observeAt: intent.tick + MATURE_RUNTIME_CAPS.observationDelay,
    retry,
    roomName: intent.payload.roomName,
    snapshotRevision: intent.snapshotRevision,
    structureId: intent.payload.structureId,
  };
  return intent.kind === "factory.produce"
    ? freeze({
        ...base,
        batchAmount: intent.payload.batchAmount,
        components: intent.payload.components,
        cooldown: intent.payload.cooldown,
        kind: "factory" as const,
        product: intent.payload.product,
        resourcesBefore: intent.payload.resourcesBefore,
        storeCapacity: intent.payload.storeCapacity,
        storeUsedBefore: intent.payload.storeUsedBefore,
      })
    : freeze({
        ...base,
        energyBefore: intent.payload.energyBefore,
        energyPerPower: intent.payload.energyPerPower,
        kind: "power-processing" as const,
        powerBefore: intent.payload.powerBefore,
        units: intent.payload.units,
      });
}

export type MatureSettlementReason =
  | "awaiting-observation"
  | "awaiting-retry"
  | "commitment-changed"
  | "conflicting-effect"
  | "deadline"
  | "exact-effect"
  | "inactive-structure"
  | "mechanics-changed"
  | "missing-structure"
  | "no-effect"
  | "observation-timeout"
  | "retry-cap";

export interface MatureAttemptSettlement {
  readonly attemptId: string;
  readonly kind: PendingMatureAttempt["kind"];
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly reason: MatureSettlementReason;
  readonly retry: number;
  readonly settledAmount: number;
  readonly status: "cancelled" | "pending" | "retry" | "settled";
}

export function reconcilePendingMatureAttempts(input: {
  readonly catalog: MatureMechanicsCatalog;
  readonly commitments: readonly MaturePolicyCommitment[];
  readonly pendingAttempts: readonly PendingMatureAttempt[];
  readonly snapshot: WorldSnapshot;
}): readonly MatureAttemptSettlement[] {
  const tick = input.snapshot.observation.tick;
  if (input.pendingAttempts.length > MATURE_RUNTIME_CAPS.maximumPendingAttempts) return freeze([]);
  return freeze(
    [...input.pendingAttempts]
      .sort((a, b) => compare(a.attemptId, b.attemptId))
      .map((attempt) => {
        if (attempt.retryReady === true) {
          const blocker = retryBlocker(attempt, input, tick);
          return blocker === null
            ? settlement(attempt, "pending", "awaiting-retry", 0)
            : settlement(attempt, "cancelled", blocker, 0);
        }
        if (tick <= attempt.issuedAt)
          return settlement(attempt, "pending", "awaiting-observation", 0);
        if (input.catalog.fingerprint !== attempt.mechanicsFingerprint)
          return settlement(attempt, "cancelled", "mechanics-changed", 0);
        if (tick < attempt.observeAt)
          return settlement(attempt, "pending", "awaiting-observation", 0);
        if (tick > attempt.observeAt)
          return settlement(attempt, "cancelled", "observation-timeout", 0);
        const room = input.snapshot.ownedRooms.find(({ name }) => name === attempt.roomName);
        if (room === undefined) return settlement(attempt, "cancelled", "missing-structure", 0);
        const observed =
          attempt.kind === "factory"
            ? reconcileFactoryAttempt(attempt, room.ownedFactories ?? [])
            : reconcilePowerAttempt(attempt, room.ownedPowerSpawns ?? []);
        if (observed.status !== "retry") return observed;
        const blocker = retryBlocker(attempt, input, tick);
        return blocker === null ? observed : settlement(attempt, "cancelled", blocker, 0);
      }),
  );
}

function retryBlocker(
  attempt: PendingMatureAttempt,
  input: Parameters<typeof reconcilePendingMatureAttempts>[0],
  tick: number,
): Extract<MatureSettlementReason, "commitment-changed" | "deadline" | "mechanics-changed"> | null {
  const matches = input.commitments.filter(
    ({ objective }) =>
      objective.id === attempt.objectiveId && objective.revision === attempt.objectiveRevision,
  );
  const commitment = matches.length === 1 ? matches[0] : undefined;
  if (
    commitment === undefined ||
    commitment.status !== "ready" ||
    !commitment.objective.funded ||
    commitment.objective.kind === "nuker-stock" ||
    fingerprintMatureObjective(commitment.objective) !== attempt.commitmentFingerprint
  )
    return "commitment-changed";
  if (
    input.catalog.fingerprint !== attempt.mechanicsFingerprint ||
    commitment.objective.mechanicsFingerprint !== attempt.mechanicsFingerprint
  )
    return "mechanics-changed";
  return tick > commitment.objective.deadline ? "deadline" : null;
}

export function markMatureAttemptRetryReady(
  attempt: PendingMatureAttempt,
  result: MatureAttemptSettlement,
): PendingMatureAttempt | null {
  if (
    result.attemptId !== attempt.attemptId ||
    result.status !== "retry" ||
    result.retry >= MATURE_RUNTIME_CAPS.maximumRetries
  )
    return null;
  return freeze({ ...attempt, retry: result.retry, retryReady: true as const });
}

export function fingerprintMatureObjective(
  objective: FactoryBatchObjective | PowerProcessingObjective,
): string {
  const parts = [
    objective.kind,
    objective.id,
    String(objective.revision),
    objective.colonyId,
    objective.structureId,
    objective.endpointId,
    objective.industryBudgetId,
    objective.mechanicsFingerprint,
    objective.priority,
    String(objective.deadline),
    String(objective.funded),
    ...(objective.kind === "factory-batch"
      ? [objective.product, String(objective.batches)]
      : [String(objective.units)]),
  ];
  return fingerprint(parts);
}

function reconcileFactoryAttempt(
  attempt: PendingFactoryAttempt,
  factories: readonly OwnedFactorySnapshot[],
): MatureAttemptSettlement {
  const factory = factories.find(({ id }) => id === attempt.structureId);
  if (factory === undefined) return settlement(attempt, "cancelled", "missing-structure", 0);
  if (!factory.active) return settlement(attempt, "cancelled", "inactive-structure", 0);
  const expected = expectedFactoryResources(attempt);
  const exactResources = expected.every(
    ({ amount, resourceType }) => storeAmount(factory.store, resourceType) === amount,
  );
  const componentsTotal = attempt.components.reduce((total, { amount }) => total + amount, 0);
  const expectedUsed = attempt.storeUsedBefore - componentsTotal + attempt.batchAmount;
  const expectedCooldown = Math.max(0, attempt.cooldown - 1);
  if (
    exactResources &&
    factory.store.capacity === attempt.storeCapacity &&
    factory.store.usedCapacity === expectedUsed &&
    factory.cooldown === expectedCooldown
  )
    return settlement(attempt, "settled", "exact-effect", attempt.batchAmount);
  const unchanged = attempt.resourcesBefore.every(
    ({ amount, resourceType }) => storeAmount(factory.store, resourceType) === amount,
  );
  if (
    unchanged &&
    factory.store.capacity === attempt.storeCapacity &&
    factory.store.usedCapacity === attempt.storeUsedBefore &&
    factory.cooldown === 0
  )
    return retry(attempt, "no-effect");
  return settlement(attempt, "cancelled", "conflicting-effect", 0);
}

function expectedFactoryResources(
  attempt: PendingFactoryAttempt,
): readonly MatureResourceAmountData[] {
  const deltas = new Map<string, number>([[attempt.product, attempt.batchAmount]]);
  for (const component of attempt.components)
    deltas.set(
      component.resourceType,
      (deltas.get(component.resourceType) ?? 0) - component.amount,
    );
  return attempt.resourcesBefore.map(({ amount, resourceType }) =>
    freeze({ amount: amount + (deltas.get(resourceType) ?? 0), resourceType }),
  );
}

function reconcilePowerAttempt(
  attempt: PendingPowerAttempt,
  powerSpawns: readonly OwnedPowerSpawnSnapshot[],
): MatureAttemptSettlement {
  const powerSpawn = powerSpawns.find(({ id }) => id === attempt.structureId);
  if (powerSpawn === undefined) return settlement(attempt, "cancelled", "missing-structure", 0);
  if (!powerSpawn.active) return settlement(attempt, "cancelled", "inactive-structure", 0);
  const power = storeAmount(powerSpawn.store, "power");
  const energy = storeAmount(powerSpawn.store, "energy");
  if (
    power === attempt.powerBefore - attempt.units &&
    energy === attempt.energyBefore - attempt.units * attempt.energyPerPower
  )
    return settlement(attempt, "settled", "exact-effect", attempt.units);
  if (power === attempt.powerBefore && energy === attempt.energyBefore)
    return retry(attempt, "no-effect");
  return settlement(attempt, "cancelled", "conflicting-effect", 0);
}

function retry(
  attempt: PendingMatureAttempt,
  reason: Extract<MatureSettlementReason, "no-effect">,
): MatureAttemptSettlement {
  return attempt.retry + 1 >= MATURE_RUNTIME_CAPS.maximumRetries
    ? settlement(attempt, "cancelled", "retry-cap", 0)
    : settlement(attempt, "retry", reason, 0);
}

function settlement(
  attempt: PendingMatureAttempt,
  status: MatureAttemptSettlement["status"],
  reason: MatureSettlementReason,
  settledAmount: number,
): MatureAttemptSettlement {
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

function compareCommitments(left: MaturePolicyCommitment, right: MaturePolicyCommitment): number {
  const leftRank =
    left.objective.kind === "factory-batch"
      ? 0
      : left.objective.kind === "power-processing"
        ? 1
        : 2;
  const rightRank =
    right.objective.kind === "factory-batch"
      ? 0
      : right.objective.kind === "power-processing"
        ? 1
        : 2;
  return (
    leftRank - rightRank ||
    left.objective.deadline - right.objective.deadline ||
    compare(left.objective.id, right.objective.id) ||
    left.objective.revision - right.objective.revision
  );
}

function compareIntents(left: MatureCommandIntent, right: MatureCommandIntent): number {
  return (
    (left.kind === "factory.produce" ? 0 : 1) - (right.kind === "factory.produce" ? 0 : 1) ||
    left.deadline - right.deadline ||
    compare(left.id, right.id)
  );
}

function intentId(objectiveId: string, revision: number, tick: number): string {
  return `mature-command/${objectiveId}/${String(revision)}/${String(tick)}`;
}
function structureKey(structureId: string): string {
  return `mature-structure/${structureId}`;
}
function commitmentKey(objectiveId: string, revision: number): string {
  return `${objectiveId}\u0000${String(revision)}`;
}
function attemptCommitmentKey(attempt: PendingMatureAttempt): string {
  return commitmentKey(attempt.objectiveId, attempt.objectiveRevision);
}
function storeAmount(store: StoreSnapshot, resourceType: string): number {
  return store.resources.find((value) => value.resourceType === resourceType)?.amount ?? 0;
}
function fingerprint(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16_777_619);
  }
  return `mature-command-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function identity(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
