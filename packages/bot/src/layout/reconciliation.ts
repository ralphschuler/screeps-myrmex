import type { ConstructionSiteSnapshot, StructureSnapshot } from "../world/snapshot";
import type {
  ConstructionSiteExecutionResult,
  ConstructionSiteAttemptReceipt,
  LayoutBlocker,
  LayoutStructureRemovalReceipt,
  LayoutsOwnerV25,
  StructureDestroyExecutionResult,
} from "./contracts";
import { deriveConstructionSiteAttemptReceipt } from "./construction-site-arbiter";
import {
  clearStaleLayoutRemovalReceipt,
  persistConstructionSiteReceipt,
  persistLayoutRemovalReceipt,
  persistStaleConstructionSiteReceipts,
} from "./persistence";

export interface ConstructionSiteReconciliationResult {
  readonly owner: LayoutsOwnerV25;
  readonly receipts: readonly ConstructionSiteAttemptReceipt[];
}

export interface StructureDestroyReconciliationResult {
  readonly owner: LayoutsOwnerV25;
  readonly receipts: readonly LayoutStructureRemovalReceipt[];
}

export interface StaleLayoutSiteReceiptReconciliationResult {
  readonly owner: LayoutsOwnerV25;
  readonly settled: ConstructionSiteAttemptReceipt | null;
}

export interface StaleLayoutRemovalReceiptReconciliationResult {
  readonly owner: LayoutsOwnerV25;
  readonly settled: LayoutStructureRemovalReceipt | null;
}

export function reconcileStaleLayoutRemovalReceipt(input: {
  readonly blocker: LayoutBlocker | null;
  readonly observedAt: number;
  readonly owner: LayoutsOwnerV25;
  readonly roomName: string;
  readonly structures: readonly Pick<StructureSnapshot, "id">[] | undefined;
}): StaleLayoutRemovalReceiptReconciliationResult {
  const record = input.owner.staleRecords.find(({ roomName }) => roomName === input.roomName);
  const receipt = record?.removalReceipt;
  if (
    input.blocker !== null ||
    receipt === undefined ||
    input.structures === undefined ||
    input.observedAt <= receipt.observedAt ||
    (receipt.code !== "OK" && receipt.code !== "TARGET_ABSENT") ||
    receipt.targetStructureType === "storage" ||
    input.structures.some(({ id }) => id === receipt.targetId)
  )
    return Object.freeze({ owner: input.owner, settled: null });
  return Object.freeze({
    owner: clearStaleLayoutRemovalReceipt(input.owner, input.roomName),
    settled: receipt,
  });
}

export function reconcileStaleLayoutSiteReceipt(input: {
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly observedAt: number;
  readonly owner: LayoutsOwnerV25;
  readonly roomName: string;
  readonly structures: readonly StructureSnapshot[];
}): StaleLayoutSiteReceiptReconciliationResult {
  const record = input.owner.staleRecords.find(({ roomName }) => roomName === input.roomName);
  if (record === undefined || record.siteReceipts === undefined)
    return Object.freeze({ owner: input.owner, settled: null });
  const observed = new Set(
    [...input.constructionSites, ...input.structures]
      .filter(({ ownership, pos }) => ownership === "owned" && pos.roomName === input.roomName)
      .map(({ pos, structureType }) => targetKey(pos.roomName, structureType, pos.y, pos.x)),
  );
  const settled = record.siteReceipts
    .map((receipt, index) => ({ index, receipt }))
    .sort(
      (left, right) => compareSiteReceipts(left.receipt, right.receipt) || left.index - right.index,
    )
    .find(({ receipt }) => {
      if (
        receipt.code !== "OK" ||
        receipt.layoutFingerprint !== record.fingerprint ||
        input.observedAt <= receipt.observedAt
      )
        return false;
      const identity = parseSiteProposalIdentity(receipt, record.roomName);
      return (
        identity !== null &&
        observed.has(targetKey(record.roomName, identity.structureType, identity.y, identity.x))
      );
    });
  if (settled === undefined) return Object.freeze({ owner: input.owner, settled: null });
  const receipts = record.siteReceipts.filter((_receipt, index) => index !== settled.index);
  return Object.freeze({
    owner: persistStaleConstructionSiteReceipts(input.owner, input.roomName, receipts),
    settled: settled.receipt,
  });
}

export function reconcileStructureDestroyExecution(
  owner: LayoutsOwnerV25,
  execution: readonly StructureDestroyExecutionResult[],
  tick: number,
): StructureDestroyReconciliationResult {
  let next = owner;
  const receipts: LayoutStructureRemovalReceipt[] = [];
  for (const item of [...execution].sort((a, b) =>
    a.intent.stableId.localeCompare(b.intent.stableId),
  )) {
    const record = next.records.find(({ roomName }) => roomName === item.intent.roomName);
    const prior = record?.removalReceipt;
    const matchingPrior =
      prior !== undefined &&
      prior.targetId === item.intent.targetId &&
      prior.replacementId === item.intent.replacementId &&
      prior.targetStructureType === item.intent.targetStructureType
        ? prior
        : null;
    if (
      record?.fingerprint !== item.intent.layoutFingerprint ||
      (matchingPrior !== null && matchingPrior.observedAt >= tick)
    )
      continue;
    const attempt = Math.min(3, (matchingPrior === null ? 0 : matchingPrior.attempt) + 1);
    const terminal = item.code === "OK" || item.code === "TARGET_ABSENT" || attempt >= 3;
    const receipt = Object.freeze({
      attempt,
      code: item.code,
      nextEligibleTick: terminal
        ? Number.MAX_SAFE_INTEGER
        : Math.min(Number.MAX_SAFE_INTEGER, tick + 2 ** attempt),
      observedAt: tick,
      replacementId: item.intent.replacementId,
      targetId: item.intent.targetId,
      targetStructureType: item.intent.targetStructureType,
    });
    next = persistLayoutRemovalReceipt(next, item.intent.roomName, receipt);
    receipts.push(receipt);
  }
  return Object.freeze({ owner: next, receipts: Object.freeze(receipts) });
}

export function reconcileConstructionSiteExecution(
  owner: LayoutsOwnerV25,
  execution: readonly ConstructionSiteExecutionResult[],
  tick: number,
): ConstructionSiteReconciliationResult {
  let next = owner;
  const receipts: ConstructionSiteAttemptReceipt[] = [];
  for (const item of [...execution].sort((a, b) =>
    a.intent.proposalId.localeCompare(b.intent.proposalId),
  )) {
    const record = next.records.find(({ roomName }) => roomName === item.intent.roomName);
    if (record?.fingerprint !== item.intent.layoutFingerprint) continue;
    const proposal = {
      colonyId: item.intent.colonyId,
      layoutFingerprint: item.intent.layoutFingerprint,
      observationFingerprint: item.intent.observationFingerprint,
      placementOrder: 0,
      policyFingerprint: item.intent.policyFingerprint,
      policyPriority: 0,
      pos: { roomName: item.intent.roomName, x: item.intent.x, y: item.intent.y },
      stableId: item.intent.proposalId,
      structureType: item.intent.structureType,
    } as const;
    const receipt = deriveConstructionSiteAttemptReceipt(
      { code: item.code, proposal, tick },
      record.siteReceipts ?? [],
    );
    next = persistConstructionSiteReceipt(next, item.intent.roomName, receipt);
    receipts.push(receipt);
  }
  return Object.freeze({ owner: next, receipts: Object.freeze(receipts) });
}

function parseSiteProposalIdentity(
  receipt: ConstructionSiteAttemptReceipt,
  roomName: string,
): { readonly structureType: string; readonly x: number; readonly y: number } | null {
  const prefix = "site-v1:";
  const marker = `:${roomName}:${receipt.layoutFingerprint}:`;
  const markerAt = receipt.proposalId.indexOf(marker, prefix.length);
  if (
    !receipt.proposalId.startsWith(prefix) ||
    markerAt <= prefix.length ||
    receipt.proposalId.indexOf(marker, markerAt + marker.length) !== -1
  )
    return null;
  const colonyId = receipt.proposalId.slice(prefix.length, markerAt);
  const fields = receipt.proposalId.slice(markerAt + marker.length).split(":");
  if (colonyId.length === 0 || colonyId.includes(":") || fields.length !== 4) return null;
  const [placementOrder, structureType, yValue, xValue] = fields;
  const order = canonicalInteger(placementOrder);
  const x = canonicalInteger(xValue);
  const y = canonicalInteger(yValue);
  if (
    order === null ||
    structureType === undefined ||
    structureType.length === 0 ||
    structureType.length > 64 ||
    x === null ||
    x >= 50 ||
    y === null ||
    y >= 50
  )
    return null;
  return { structureType, x, y };
}

function canonicalInteger(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function targetKey(roomName: string, structureType: string, y: number, x: number): string {
  return `${roomName}:${structureType}:${String(y)}:${String(x)}`;
}

function compareSiteReceipts(
  left: ConstructionSiteAttemptReceipt,
  right: ConstructionSiteAttemptReceipt,
): number {
  return (
    left.proposalId.localeCompare(right.proposalId) ||
    left.code.localeCompare(right.code) ||
    left.observedAt - right.observedAt ||
    left.attempt - right.attempt
  );
}
