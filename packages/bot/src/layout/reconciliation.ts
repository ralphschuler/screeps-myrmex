import type {
  ConstructionSiteExecutionResult,
  ConstructionSiteAttemptReceipt,
  LayoutStructureRemovalReceipt,
  LayoutsOwnerV10,
  StructureDestroyExecutionResult,
} from "./contracts";
import { deriveConstructionSiteAttemptReceipt } from "./construction-site-arbiter";
import { persistConstructionSiteReceipt, persistLayoutRemovalReceipt } from "./persistence";

export interface ConstructionSiteReconciliationResult {
  readonly owner: LayoutsOwnerV10;
  readonly receipts: readonly ConstructionSiteAttemptReceipt[];
}

export interface StructureDestroyReconciliationResult {
  readonly owner: LayoutsOwnerV10;
  readonly receipts: readonly LayoutStructureRemovalReceipt[];
}

export function reconcileStructureDestroyExecution(
  owner: LayoutsOwnerV10,
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
  owner: LayoutsOwnerV10,
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
