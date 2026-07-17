import type { IntentData } from "../execution";

export const MATURE_ATTEMPT_CAPS = Object.freeze({
  maximumFactoryStoreResources: 64,
  maximumRetries: 3,
  observationDelay: 1,
} as const);

export interface MatureResourceAmountData {
  readonly [key: string]: IntentData;
  readonly amount: number;
  readonly resourceType: string;
}

interface PendingMatureAttemptBase {
  readonly attemptId: string;
  readonly capabilityFingerprint: string;
  readonly commitmentFingerprint: string;
  readonly issuedAt: number;
  readonly mechanicsFingerprint: string;
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly observeAt: number;
  readonly retry: number;
  readonly retryReady?: true;
  readonly roomName: string;
  readonly snapshotRevision: string;
  readonly structureId: string;
}

export interface PendingFactoryAttempt extends PendingMatureAttemptBase {
  readonly batchAmount: number;
  readonly components: readonly MatureResourceAmountData[];
  readonly cooldown: number;
  readonly kind: "factory";
  readonly product: string;
  readonly resourcesBefore: readonly MatureResourceAmountData[];
  readonly storeCapacity: number;
  readonly storeUsedBefore: number;
}

export interface PendingPowerAttempt extends PendingMatureAttemptBase {
  readonly energyBefore: number;
  readonly energyPerPower: number;
  readonly kind: "power-processing";
  readonly powerBefore: number;
  readonly units: number;
}

export type PendingMatureAttempt = PendingFactoryAttempt | PendingPowerAttempt;

export function isPendingMatureAttempt(value: unknown): value is PendingMatureAttempt {
  if (
    !record(value) ||
    !identity(value.attemptId) ||
    !identity(value.capabilityFingerprint) ||
    !identity(value.commitmentFingerprint) ||
    !nonnegativeInteger(value.issuedAt) ||
    !identity(value.mechanicsFingerprint) ||
    !identity(value.objectiveId) ||
    !positiveInteger(value.objectiveRevision) ||
    value.observeAt !== value.issuedAt + MATURE_ATTEMPT_CAPS.observationDelay ||
    !nonnegativeInteger(value.retry) ||
    value.retry >= MATURE_ATTEMPT_CAPS.maximumRetries ||
    (value.retryReady !== undefined && value.retryReady !== true) ||
    !identity(value.roomName, 16) ||
    !identity(value.snapshotRevision) ||
    !identity(value.structureId, 128)
  )
    return false;
  if (value.kind === "factory") return validFactoryAttempt(value);
  return (
    value.kind === "power-processing" &&
    nonnegativeInteger(value.energyBefore) &&
    positiveInteger(value.energyPerPower) &&
    nonnegativeInteger(value.powerBefore) &&
    positiveInteger(value.units, 6) &&
    value.powerBefore >= value.units &&
    value.energyBefore >= value.units * value.energyPerPower
  );
}

function validFactoryAttempt(value: Record<string, unknown>): boolean {
  if (
    !positiveInteger(value.batchAmount) ||
    !resourceAmounts(value.components) ||
    !positiveInteger(value.cooldown) ||
    !identity(value.product, 64) ||
    !resourceAmounts(value.resourcesBefore) ||
    !nonnegativeInteger(value.storeCapacity) ||
    !nonnegativeInteger(value.storeUsedBefore) ||
    value.storeUsedBefore > value.storeCapacity
  )
    return false;
  const before = new Map(
    value.resourcesBefore.map(({ amount, resourceType }) => [resourceType, amount] as const),
  );
  const used = value.resourcesBefore.reduce((total, { amount }) => total + amount, 0);
  const consumed = value.components.reduce((total, { amount }) => total + amount, 0);
  return (
    before.has(value.product) &&
    used === value.storeUsedBefore &&
    value.components.every(
      ({ amount, resourceType }) => (before.get(resourceType) ?? -1) >= amount,
    ) &&
    value.storeUsedBefore - consumed + value.batchAmount <= value.storeCapacity
  );
}

function resourceAmounts(value: unknown): value is readonly MatureResourceAmountData[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MATURE_ATTEMPT_CAPS.maximumFactoryStoreResources &&
    value.every(
      (entry) =>
        record(entry) && nonnegativeInteger(entry.amount) && identity(entry.resourceType, 64),
    ) &&
    new Set(value.map((entry) => (entry as MatureResourceAmountData).resourceType)).size ===
      value.length
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}
function positiveInteger(value: unknown, maximum = 1_000_000): value is number {
  return nonnegativeInteger(value) && value > 0 && value <= maximum;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
