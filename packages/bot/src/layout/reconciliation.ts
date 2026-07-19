import type {
  ConstructionSiteExecutionResult,
  ConstructionSiteAttemptReceipt,
  LayoutContainerRemovalReceipt,
  LayoutsOwnerV3,
  StructureDestroyExecutionResult,
} from "./contracts";
import { deriveConstructionSiteAttemptReceipt } from "./construction-site-arbiter";
import { persistConstructionSiteReceipt, persistLayoutContainerMigration } from "./persistence";

export interface ConstructionSiteReconciliationResult {
  readonly owner: LayoutsOwnerV3;
  readonly receipts: readonly ConstructionSiteAttemptReceipt[];
}

export interface StructureDestroyReconciliationResult {
  readonly owner: LayoutsOwnerV3;
  readonly receipts: readonly LayoutContainerRemovalReceipt[];
}

export function reconcileStructureDestroyExecution(
  owner: LayoutsOwnerV3,
  execution: readonly StructureDestroyExecutionResult[],
  tick: number,
): StructureDestroyReconciliationResult {
  let next = owner;
  const receipts: LayoutContainerRemovalReceipt[] = [];
  for (const item of [...execution].sort((a, b) =>
    a.intent.stableId.localeCompare(b.intent.stableId),
  )) {
    const record = next.records.find(({ roomName }) => roomName === item.intent.roomName);
    const migration = record?.containerMigration;
    if (
      record?.fingerprint !== item.intent.layoutFingerprint ||
      migration?.sourceId === undefined ||
      migration.targetId !== item.intent.targetId ||
      migration.replacementId !== item.intent.replacementId ||
      (migration.removalReceipt?.observedAt ?? -1) >= tick
    )
      continue;
    const attempt = Math.min(3, (migration.removalReceipt?.attempt ?? 0) + 1);
    const terminal = item.code === "OK" || item.code === "TARGET_ABSENT" || attempt >= 3;
    const receipt = Object.freeze({
      attempt,
      code: item.code,
      nextEligibleTick: terminal
        ? migration.expiresAt
        : Math.min(migration.expiresAt, tick + 2 ** attempt),
      observedAt: tick,
    });
    next = persistLayoutContainerMigration(next, item.intent.roomName, {
      ...migration,
      removalReceipt: receipt,
    });
    receipts.push(receipt);
  }
  return Object.freeze({ owner: next, receipts: Object.freeze(receipts) });
}

export function reconcileConstructionSiteExecution(
  owner: LayoutsOwnerV3,
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
