import type {
  ConstructionSiteExecutionResult,
  ConstructionSiteAttemptReceipt,
  LayoutsOwnerV1,
} from "./contracts";
import { deriveConstructionSiteAttemptReceipt } from "./construction-site-arbiter";
import { persistConstructionSiteReceipt } from "./persistence";

export interface ConstructionSiteReconciliationResult {
  readonly owner: LayoutsOwnerV1;
  readonly receipts: readonly ConstructionSiteAttemptReceipt[];
}

export function reconcileConstructionSiteExecution(
  owner: LayoutsOwnerV1,
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
