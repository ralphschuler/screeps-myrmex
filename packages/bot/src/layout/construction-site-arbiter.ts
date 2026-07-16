import {
  MAX_CONSTRUCTION_SITE_RECEIPTS_PER_ROOM,
  type ConstructionSiteArbitrationInput,
  type ConstructionSiteArbitrationRecord,
  type ConstructionSiteArbitrationResult,
  type ConstructionSiteAttemptReceipt,
  type ConstructionSiteAttemptResult,
  type ConstructionSiteDeferredReason,
  type ConstructionSiteLimits,
  type CreateConstructionSiteIntent,
  type LayoutSiteProposal,
} from "./contracts";
import { compareLayoutSiteProposals } from "./diff";

export function arbitrateConstructionSites(
  input: ConstructionSiteArbitrationInput,
): ConstructionSiteArbitrationResult {
  const limits = safeLimits(input.limits),
    accepted: ConstructionSiteArbitrationRecord[] = [],
    deferred: ConstructionSiteArbitrationRecord[] = [],
    rejected: ConstructionSiteArbitrationRecord[] = [],
    intents: CreateConstructionSiteIntent[] = [];
  const roomAccepted = new Map<string, number>(),
    roomInspected = new Map<string, number>();
  const roomCounts = new Map(input.perRoomSiteCounts.map((item) => [item.roomName, item.count]));
  const authorization = new Map(
    input.progressionAuthorizations.map((item) => [
      `${item.colonyId}:${item.roomName}`,
      item.authorized,
    ]),
  );
  const receipts = applicableReceiptMap(input.priorReceipts),
    ceiling = limits.officialHardCap - limits.reservedGlobalHeadroom;
  for (const proposal of [...input.proposals].sort(compareLayoutSiteProposals)) {
    const room = proposal.pos.roomName,
      inspected = roomInspected.get(room) ?? 0;
    if (inspected >= limits.inspectedProposalsPerRoom) {
      deferred.push(record(proposal, "deferred", "inspection-limit"));
      continue;
    }
    roomInspected.set(room, inspected + 1);
    if (authorization.get(`${proposal.colonyId}:${room}`) !== true) {
      rejected.push(record(proposal, "rejected", "progression-not-authorized"));
      continue;
    }
    const receipt = receipts.get(proposal.stableId),
      receiptDecision = receipt ? decideReceipt(proposal, receipt, input.tick) : null;
    if (receiptDecision?.status === "rejected") {
      rejected.push(record(proposal, "rejected", "receipt-invalid-args"));
      continue;
    }
    if (receiptDecision?.status === "deferred") {
      deferred.push(record(proposal, "deferred", receiptDecision.reason));
      continue;
    }
    if ((roomCounts.get(room) ?? 0) >= limits.activeSitesPerRoom) {
      deferred.push(record(proposal, "deferred", "room-active-limit"));
      continue;
    }
    if (input.globalOwnedSiteCount + accepted.length >= ceiling) {
      deferred.push(record(proposal, "deferred", "global-headroom"));
      continue;
    }
    if (accepted.length >= limits.acceptedGloballyPerTick) {
      deferred.push(record(proposal, "deferred", "global-tick-limit"));
      continue;
    }
    if ((roomAccepted.get(room) ?? 0) >= limits.acceptedPerRoomPerTick) {
      deferred.push(record(proposal, "deferred", "room-tick-limit"));
      continue;
    }
    roomAccepted.set(room, (roomAccepted.get(room) ?? 0) + 1);
    accepted.push(record(proposal, "accepted"));
    intents.push(intent(proposal));
  }
  return freeze({ accepted, deferred, intents, rejected });
}
export function deriveConstructionSiteAttemptReceipt(
  result: ConstructionSiteAttemptResult,
  prior: readonly ConstructionSiteAttemptReceipt[],
): ConstructionSiteAttemptReceipt {
  const previous = prior
      .filter((item) => item.proposalId === result.proposal.stableId && item.code === result.code)
      .reduce((max, item) => Math.max(max, item.attempt), 0),
    attempt = Math.min(previous + 1, 16);
  return freeze({
    attempt,
    code: result.code,
    layoutFingerprint: result.proposal.layoutFingerprint,
    nextEligibleTick: result.tick + retryDelay(result.code, attempt),
    observationFingerprint: result.proposal.observationFingerprint,
    observedAt: result.tick,
    policyFingerprint: result.proposal.policyFingerprint,
    proposalId: result.proposal.stableId,
    roomName: result.proposal.pos.roomName,
  });
}
export function normalizeConstructionSiteReceipts(
  receipts: readonly ConstructionSiteAttemptReceipt[],
): readonly ConstructionSiteAttemptReceipt[] {
  const byRoom = new Map<string, ConstructionSiteAttemptReceipt[]>();
  for (const receipt of receipts) {
    const list = byRoom.get(receipt.roomName) ?? [];
    list.push(receipt);
    byRoom.set(receipt.roomName, list);
  }
  const normalized: ConstructionSiteAttemptReceipt[] = [];
  for (const room of [...byRoom.keys()].sort()) {
    const unique = new Map<string, ConstructionSiteAttemptReceipt>();
    for (const receipt of (byRoom.get(room) ?? []).sort(newest)) {
      const key = `${receipt.proposalId}:${receipt.code}`;
      if (!unique.has(key)) unique.set(key, receipt);
    }
    normalized.push(
      ...[...unique.values()].sort(newest).slice(0, MAX_CONSTRUCTION_SITE_RECEIPTS_PER_ROOM),
    );
  }
  return freeze(normalized.sort(canonical));
}
function decideReceipt(
  p: LayoutSiteProposal,
  r: ConstructionSiteAttemptReceipt,
  tick: number,
): { status: "rejected" } | { status: "deferred"; reason: ConstructionSiteDeferredReason } | null {
  if (r.layoutFingerprint !== p.layoutFingerprint) return null;
  if (r.code === "ERR_INVALID_ARGS") return { status: "rejected" };
  if (r.code === "ERR_RCL_NOT_ENOUGH")
    return r.policyFingerprint === p.policyFingerprint
      ? { status: "deferred", reason: "receipt-rcl-policy" }
      : null;
  if (r.code === "ERR_INVALID_TARGET")
    return r.observationFingerprint === p.observationFingerprint
      ? { status: "deferred", reason: "receipt-invalid-target" }
      : null;
  if (r.code === "ERR_NOT_OWNER")
    return r.observationFingerprint === p.observationFingerprint
      ? { status: "deferred", reason: "receipt-not-owner" }
      : null;
  if (
    r.observationFingerprint !== p.observationFingerprint ||
    r.policyFingerprint !== p.policyFingerprint
  )
    return null;
  if (r.code === "OK") return { status: "deferred", reason: "receipt-ok-expectation" };
  if (tick < r.nextEligibleTick)
    return {
      status: "deferred",
      reason: r.code === "ERR_FULL" ? "receipt-full-backoff" : "receipt-unexpected-backoff",
    };
  return null;
}
function applicableReceiptMap(
  receipts: readonly ConstructionSiteAttemptReceipt[],
): Map<string, ConstructionSiteAttemptReceipt> {
  const map = new Map<string, ConstructionSiteAttemptReceipt>();
  for (const r of [...normalizeConstructionSiteReceipts(receipts)].sort(newest))
    if (!map.has(r.proposalId)) map.set(r.proposalId, r);
  return map;
}
function retryDelay(code: ConstructionSiteAttemptReceipt["code"], attempt: number): number {
  if (code === "ERR_FULL") return Math.min(100, 5 * 2 ** Math.min(attempt - 1, 5));
  if (code === "UNEXPECTED") return Math.min(64, 2 ** Math.min(attempt, 6));
  return 1;
}
function safeLimits(l: ConstructionSiteLimits): ConstructionSiteLimits {
  return {
    officialHardCap: Math.min(100, Math.max(1, Math.floor(l.officialHardCap))),
    reservedGlobalHeadroom: Math.max(1, Math.floor(l.reservedGlobalHeadroom)),
    acceptedGloballyPerTick: Math.min(2, Math.max(0, Math.floor(l.acceptedGloballyPerTick))),
    acceptedPerRoomPerTick: Math.min(1, Math.max(0, Math.floor(l.acceptedPerRoomPerTick))),
    inspectedProposalsPerRoom: Math.min(64, Math.max(0, Math.floor(l.inspectedProposalsPerRoom))),
    activeSitesPerRoom: Math.max(1, Math.floor(l.activeSitesPerRoom)),
  };
}
function intent(p: LayoutSiteProposal): CreateConstructionSiteIntent {
  return {
    colonyId: p.colonyId,
    kind: "create-construction-site",
    layoutFingerprint: p.layoutFingerprint,
    observationFingerprint: p.observationFingerprint,
    policyFingerprint: p.policyFingerprint,
    proposalId: p.stableId,
    roomName: p.pos.roomName,
    structureType: p.structureType,
    x: p.pos.x,
    y: p.pos.y,
  };
}
function record(
  proposal: LayoutSiteProposal,
  status: ConstructionSiteArbitrationRecord["status"],
  reason?: ConstructionSiteArbitrationRecord["reason"],
): ConstructionSiteArbitrationRecord {
  return reason === undefined ? { proposal, status } : { proposal, reason, status };
}
function newest(a: ConstructionSiteAttemptReceipt, b: ConstructionSiteAttemptReceipt): number {
  return (
    b.observedAt - a.observedAt ||
    b.attempt - a.attempt ||
    compare(a.proposalId, b.proposalId) ||
    compare(a.code, b.code)
  );
}
function canonical(a: ConstructionSiteAttemptReceipt, b: ConstructionSiteAttemptReceipt): number {
  return (
    compare(a.roomName, b.roomName) ||
    compare(a.proposalId, b.proposalId) ||
    compare(a.code, b.code)
  );
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
