import { INTENT_PRIORITY_CLASSES, type IntentPriorityClass } from "../execution";
import {
  LINK_TRANSFER_LOSS_RATIO,
  MAX_LINK_ARBITRATION_LINKS,
  MAX_LINK_TRANSFER_PROPOSALS,
  type ClassifiedLink,
  type LinkArbitrationResult,
  type LinkClassificationBlocker,
  type LinkClassificationResult,
  type LinkLayoutEvidence,
  type LinkRoleAnchor,
  type LinkTransferDeferralReason,
  type LinkTransferProposal,
  type ObservedLink,
} from "./contracts";

const PRIORITY_ORDER = new Map(
  INTENT_PRIORITY_CLASSES.map((priorityClass, index) => [priorityClass, index] as const),
);

/** Derives ephemeral exact-position role anchors from one versioned room layout. */
export function deriveLinkRoleAnchors(layout: LinkLayoutEvidence): readonly LinkRoleAnchor[] {
  const dependency = `${layout.algorithmRevision}:${layout.fingerprint}`;
  const available = [...layout.linkPlacements]
    .map((pos) => ({ pos, key: positionKey(pos) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const roles = new Map<
    string,
    { readonly role: LinkRoleAnchor["role"]; readonly sourceId?: string }
  >();

  for (const service of [...layout.sourceServices].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) || positionKey(a.pos).localeCompare(positionKey(b.pos)),
  )) {
    const candidate = nearestUnused(available, roles, service.pos, 2);
    if (candidate !== undefined)
      roles.set(candidate.key, { role: "source", sourceId: service.sourceId });
  }
  const controller = nearestUnused(available, roles, layout.controller, 2);
  if (controller !== undefined) roles.set(controller.key, { role: "controller" });
  if (layout.storage !== null) {
    const hub = nearestUnused(available, roles, layout.storage, 2);
    if (hub !== undefined) roles.set(hub.key, { role: "hub" });
  }
  return freeze(
    available.map(({ key, pos }) => {
      const assignment = roles.get(key) ?? { role: "reserve" as const };
      return {
        id: `link-role/${layout.fingerprint}/${assignment.role}/${assignment.sourceId ?? "room"}/${key}`,
        layoutRevision: dependency,
        pos: { roomName: pos.roomName, x: pos.x, y: pos.y },
        role: assignment.role,
        sourceId: assignment.sourceId ?? null,
      };
    }),
  );
}

export function classifyLinks(input: {
  readonly anchors: readonly LinkRoleAnchor[];
  readonly layoutRevision: string;
  readonly links: readonly ObservedLink[];
  readonly tick: number;
}): LinkClassificationResult {
  const blockers: LinkClassificationBlocker[] = [];
  const anchors = [...input.anchors].sort(compareAnchor);
  const links = [...input.links].sort((a, b) => a.id.localeCompare(b.id));
  const anchorByPosition = new Map<string, LinkRoleAnchor>();
  for (const anchor of anchors) {
    if (anchor.layoutRevision !== input.layoutRevision) {
      blockers.push({ id: anchor.id, reason: "layout-revision-mismatch" });
      continue;
    }
    const key = positionKey(anchor.pos);
    if (anchorByPosition.has(key)) blockers.push({ id: anchor.id, reason: "duplicate-anchor" });
    else anchorByPosition.set(key, anchor);
  }

  const classified: ClassifiedLink[] = [];
  const seen = new Set<string>();
  for (const link of links.slice(0, MAX_LINK_ARBITRATION_LINKS)) {
    if (seen.has(link.id)) {
      blockers.push({ id: link.id, reason: "duplicate-link" });
      continue;
    }
    seen.add(link.id);
    const key = positionKey(link.pos);
    const anchor = anchorByPosition.get(key);
    if (anchor === undefined) {
      blockers.push({ id: link.id, reason: "unclassified-link" });
      continue;
    }
    anchorByPosition.delete(key);
    if (!link.owned) blockers.push({ id: link.id, reason: "foreign-link" });
    else if (!link.active) blockers.push({ id: link.id, reason: "inactive-link" });
    else if (link.observedAt !== input.tick) blockers.push({ id: link.id, reason: "stale-link" });
    else
      classified.push({
        ...link,
        anchorId: anchor.id,
        layoutRevision: input.layoutRevision,
        role: anchor.role,
        sourceId: anchor.sourceId,
      });
  }
  for (const anchor of anchorByPosition.values())
    blockers.push({ id: anchor.id, reason: "missing-link" });
  for (const link of links.slice(MAX_LINK_ARBITRATION_LINKS))
    blockers.push({ id: link.id, reason: "link-cap" });
  return freeze({
    blockers: blockers.sort(compareBlocker),
    links: classified.sort((a, b) => a.id.localeCompare(b.id)),
    truncatedLinks: Math.max(0, links.length - MAX_LINK_ARBITRATION_LINKS),
  });
}

export function arbitrateLinkTransfers(input: {
  readonly layoutRevision: string;
  readonly links: readonly ClassifiedLink[];
  readonly proposals: readonly LinkTransferProposal[];
  readonly tick: number;
}): LinkArbitrationResult {
  const links = new Map(input.links.map((link) => [link.id, link]));
  const sourceRemaining = new Map(input.links.map((link) => [link.id, link.energy]));
  const targetRemaining = new Map(input.links.map((link) => [link.id, link.freeCapacity]));
  const usedSources = new Set<string>();
  const accepted: LinkArbitrationResult["accepted"][number][] = [];
  const deferred: LinkArbitrationResult["deferred"][number][] = [];
  const proposals = [...input.proposals].sort(compareProposal);
  const considered = proposals.slice(0, MAX_LINK_TRANSFER_PROPOSALS);

  for (const proposal of considered) {
    const source = links.get(proposal.sourceLinkId);
    const target = links.get(proposal.targetLinkId);
    const reason = proposalBlocker(proposal, source, target, input, usedSources);
    if (reason !== null) {
      deferred.push({ proposalId: proposal.id, reason });
      continue;
    }
    const available = sourceRemaining.get(proposal.sourceLinkId) ?? 0;
    const capacity = targetRemaining.get(proposal.targetLinkId) ?? 0;
    const sentAmount = maximumSent(Math.min(proposal.amount, available), capacity);
    const lostAmount = transferLoss(sentAmount);
    const deliveredAmount = sentAmount - lostAmount;
    if (sentAmount <= 0)
      deferred.push({
        proposalId: proposal.id,
        reason: available <= 0 ? "insufficient-source" : "target-full",
      });
    else if (deliveredAmount <= 0)
      deferred.push({ proposalId: proposal.id, reason: "zero-delivery" });
    else {
      accepted.push({
        budget: proposal.budget,
        deliveredAmount,
        flowId: proposal.flowId,
        lostAmount,
        layoutRevision: proposal.layoutRevision,
        proposalId: proposal.id,
        sentAmount,
        sourceLinkId: proposal.sourceLinkId,
        targetLinkId: proposal.targetLinkId,
      });
      usedSources.add(proposal.sourceLinkId);
      sourceRemaining.set(proposal.sourceLinkId, available - sentAmount);
      targetRemaining.set(proposal.targetLinkId, capacity - deliveredAmount);
    }
  }
  for (const proposal of proposals.slice(MAX_LINK_TRANSFER_PROPOSALS))
    deferred.push({ proposalId: proposal.id, reason: "proposal-cap" });
  return freeze({
    accepted,
    deferred: deferred.sort(
      (a, b) => a.proposalId.localeCompare(b.proposalId) || a.reason.localeCompare(b.reason),
    ),
    evaluatedProposals: considered.length,
    truncatedProposals: Math.max(0, proposals.length - MAX_LINK_TRANSFER_PROPOSALS),
  });
}

function proposalBlocker(
  proposal: LinkTransferProposal,
  source: ClassifiedLink | undefined,
  target: ClassifiedLink | undefined,
  input: { readonly layoutRevision: string; readonly tick: number },
  usedSources: ReadonlySet<string>,
): LinkTransferDeferralReason | null {
  if (!validProposal(proposal)) return "invalid-proposal";
  if (proposal.fundingStatus !== "active") return "budget-unavailable";
  if (proposal.deadline < input.tick) return "expired";
  if (proposal.layoutRevision !== input.layoutRevision) return "layout-revision-mismatch";
  if (proposal.sourceLinkId === proposal.targetLinkId) return "same-link";
  if (source === undefined || target === undefined) return "unknown-link";
  if (
    source.layoutRevision !== input.layoutRevision ||
    target.layoutRevision !== input.layoutRevision
  )
    return "layout-revision-mismatch";
  if (!source.owned || !source.active || !target.owned || !target.active)
    return "foreign-or-inactive";
  if (source.observedAt !== input.tick || target.observedAt !== input.tick) return "stale-link";
  if (source.pos.roomName !== target.pos.roomName) return "wrong-room";
  if (source.role === "controller" || target.role === "source") return "invalid-role";
  if (source.cooldown > 0) return "cooldown";
  if (usedSources.has(source.id)) return "source-already-used";
  if (source.energy <= 0) return "insufficient-source";
  if (target.freeCapacity <= 0) return "target-full";
  return null;
}

function maximumSent(maximum: number, capacity: number): number {
  let low = 0;
  let high = Math.max(0, Math.floor(maximum));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (middle - transferLoss(middle) <= capacity) low = middle;
    else high = middle - 1;
  }
  return low;
}

function transferLoss(amount: number): number {
  return Math.ceil(amount * LINK_TRANSFER_LOSS_RATIO);
}

function validProposal(value: LinkTransferProposal): boolean {
  return (
    value.id.length > 0 &&
    value.flowId.length > 0 &&
    value.sourceLinkId.length > 0 &&
    value.targetLinkId.length > 0 &&
    Number.isSafeInteger(value.amount) &&
    value.amount > 0 &&
    Number.isSafeInteger(value.deadline) &&
    value.deadline >= 0 &&
    Number.isSafeInteger(value.priority.value) &&
    value.budget.id.length > 0 &&
    Number.isFinite(value.budget.cost) &&
    value.budget.cost >= 0
  );
}

function compareProposal(a: LinkTransferProposal, b: LinkTransferProposal): number {
  return (
    priorityRank(a.priority.class) - priorityRank(b.priority.class) ||
    a.deadline - b.deadline ||
    b.priority.value - a.priority.value ||
    a.sourceLinkId.localeCompare(b.sourceLinkId) ||
    a.targetLinkId.localeCompare(b.targetLinkId) ||
    a.flowId.localeCompare(b.flowId) ||
    a.id.localeCompare(b.id)
  );
}

function priorityRank(value: IntentPriorityClass): number {
  return PRIORITY_ORDER.get(value) ?? Number.MAX_SAFE_INTEGER;
}

function compareAnchor(a: LinkRoleAnchor, b: LinkRoleAnchor): number {
  return (
    positionKey(a.pos).localeCompare(positionKey(b.pos)) ||
    a.role.localeCompare(b.role) ||
    a.id.localeCompare(b.id)
  );
}

function compareBlocker(a: LinkClassificationBlocker, b: LinkClassificationBlocker): number {
  return a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason);
}

function nearestUnused(
  candidates: readonly { readonly key: string; readonly pos: LinkRoleAnchor["pos"] }[],
  roles: ReadonlyMap<string, unknown>,
  landmark: LinkRoleAnchor["pos"],
  maximumRange: number,
): { readonly key: string; readonly pos: LinkRoleAnchor["pos"] } | undefined {
  return candidates
    .filter(({ key, pos }) => !roles.has(key) && pos.roomName === landmark.roomName)
    .map((candidate) => ({
      candidate,
      range: Math.max(
        Math.abs(candidate.pos.x - landmark.x),
        Math.abs(candidate.pos.y - landmark.y),
      ),
    }))
    .filter(({ range }) => range <= maximumRange)
    .sort((a, b) => a.range - b.range || a.candidate.key.localeCompare(b.candidate.key))[0]
    ?.candidate;
}

function positionKey(pos: {
  readonly roomName: string;
  readonly x: number;
  readonly y: number;
}): string {
  return `${pos.roomName}\u0000${String(pos.y).padStart(2, "0")}\u0000${String(pos.x).padStart(2, "0")}`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
