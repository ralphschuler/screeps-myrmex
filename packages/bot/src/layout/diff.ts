import type { ColonyRclUnlockAllowances } from "../colony";
import type { PositionSnapshot } from "../world/snapshot";
import type {
  LayoutDiffDecision,
  LayoutDiffInput,
  LayoutDiffRejectionReason,
  LayoutDiffResult,
  LayoutPlacement,
  LayoutSiteProposal,
} from "./contracts";

const LAYER_PRIORITY = Object.freeze({ primary: 0, rampart: 1, road: 2 });

export function diffOwnedRoomLayout(input: LayoutDiffInput): LayoutDiffResult {
  const proposals: LayoutSiteProposal[] = [],
    rejected: LayoutDiffDecision[] = [],
    suppressed: LayoutDiffDecision[] = [];
  const placements = [...input.placements].sort(placementOrder);
  const globalReason = failClosedReason(input),
    counts = observedCounts(input);
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    if (!placement) continue;
    const stableId = proposalId(input, placement, index);
    if (globalReason) {
      rejected.push(decision(placement, stableId, globalReason, "rejected"));
      continue;
    }
    const structures = input.structures.filter((item) => samePosition(item.pos, placement.pos));
    if (
      placement.adoption !== "planned" ||
      structures.some((s) => s.structureType === placement.structureType)
    ) {
      suppressed.push(decision(placement, stableId, "existing-structure", "suppressed"));
      continue;
    }
    if (structures.length > 0) {
      rejected.push(decision(placement, stableId, "different-structure", "rejected"));
      continue;
    }
    const sites = input.constructionSites.filter((item) => samePosition(item.pos, placement.pos));
    if (sites.some((site) => site.ownership === "foreign")) {
      rejected.push(decision(placement, stableId, "foreign-site", "rejected"));
      continue;
    }
    if (sites.some((site) => site.structureType === placement.structureType)) {
      suppressed.push(decision(placement, stableId, "existing-owned-site", "suppressed"));
      continue;
    }
    if (sites.length > 0) {
      rejected.push(decision(placement, stableId, "different-site", "rejected"));
      continue;
    }
    if (input.policy.level === null || placement.minimumRcl > input.policy.level) {
      rejected.push(decision(placement, stableId, "rcl-locked", "rejected"));
      continue;
    }
    const allowance = structureAllowance(input.policy.unlocks, placement.structureType),
      current = counts.get(placement.structureType) ?? 0;
    if (current >= allowance) {
      rejected.push(decision(placement, stableId, "over-allowance", "rejected"));
      continue;
    }
    counts.set(placement.structureType, current + 1);
    proposals.push({
      colonyId: input.colonyId,
      layoutFingerprint: input.commitment.fingerprint,
      observationFingerprint: input.observationFingerprint,
      placementOrder: index,
      policyFingerprint: input.policyFingerprint,
      policyPriority: placement.minimumRcl * 10 + LAYER_PRIORITY[placement.layer],
      pos: placement.pos,
      stableId,
      structureType: placement.structureType,
    });
  }
  return freeze({
    proposals: proposals.sort(compareProposals),
    rejected: rejected.sort(compareDecisions),
    suppressed: suppressed.sort(compareDecisions),
  });
}
export function compareLayoutSiteProposals(a: LayoutSiteProposal, b: LayoutSiteProposal): number {
  return compareProposals(a, b);
}
function failClosedReason(input: LayoutDiffInput): LayoutDiffRejectionReason | null {
  if (input.roomStatus === "unknown") return "room-unknown";
  if (input.roomStatus === "lost") return "room-lost";
  if (!input.policyEnabled || input.policy.unlocks === null) return "policy-disabled";
  if (input.commitmentConflicted) return "commitment-conflict";
  return null;
}
function observedCounts(input: LayoutDiffInput): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of input.structures)
    counts.set(item.structureType, (counts.get(item.structureType) ?? 0) + 1);
  for (const item of input.constructionSites)
    if (item.ownership === "owned")
      counts.set(item.structureType, (counts.get(item.structureType) ?? 0) + 1);
  return counts;
}
function structureAllowance(unlocks: ColonyRclUnlockAllowances | null, type: string): number {
  if (!unlocks) return 0;
  const counts: Readonly<Record<string, number>> = {
    spawn: unlocks.spawns,
    extension: unlocks.extensions,
    tower: unlocks.towers,
    link: unlocks.links,
    container: unlocks.containers,
    storage: unlocks.storage,
    terminal: unlocks.terminal,
    lab: unlocks.labs,
    extractor: unlocks.extractor,
    factory: unlocks.factory,
    observer: unlocks.observer,
    powerSpawn: unlocks.powerSpawn,
    nuker: unlocks.nuker,
    constructedWall: unlocks.walls ? 2500 : 0,
    rampart: unlocks.ramparts ? 2500 : 0,
    road: 2500,
  };
  return counts[type] ?? 0;
}
function decision(
  placement: LayoutPlacement,
  stableId: string,
  reason: LayoutDiffDecision["reason"],
  status: LayoutDiffDecision["status"],
): LayoutDiffDecision {
  return { placement, reason, stableId, status };
}
function proposalId(input: LayoutDiffInput, p: LayoutPlacement, index: number): string {
  return [
    "site-v1",
    input.colonyId,
    input.roomName,
    input.commitment.fingerprint,
    index,
    p.structureType,
    p.pos.y,
    p.pos.x,
  ].join(":");
}
function placementOrder(a: LayoutPlacement, b: LayoutPlacement): number {
  return (
    a.minimumRcl - b.minimumRcl ||
    LAYER_PRIORITY[a.layer] - LAYER_PRIORITY[b.layer] ||
    structureRank(a.structureType) - structureRank(b.structureType) ||
    a.pos.y - b.pos.y ||
    a.pos.x - b.pos.x ||
    compare(a.structureType, b.structureType)
  );
}
function compareProposals(a: LayoutSiteProposal, b: LayoutSiteProposal): number {
  return (
    a.policyPriority - b.policyPriority ||
    compare(a.colonyId, b.colonyId) ||
    a.placementOrder - b.placementOrder ||
    structureRank(a.structureType) - structureRank(b.structureType) ||
    a.pos.y - b.pos.y ||
    a.pos.x - b.pos.x ||
    compare(a.stableId, b.stableId)
  );
}
function compareDecisions(a: LayoutDiffDecision, b: LayoutDiffDecision): number {
  return compare(a.stableId, b.stableId);
}
function structureRank(type: string): number {
  const rank = [
    "spawn",
    "extension",
    "tower",
    "storage",
    "terminal",
    "container",
    "link",
    "lab",
    "factory",
    "observer",
    "powerSpawn",
    "nuker",
    "extractor",
    "rampart",
    "constructedWall",
    "road",
  ].indexOf(type);
  return rank < 0 ? 1000 : rank;
}
function samePosition(a: PositionSnapshot, b: PositionSnapshot): boolean {
  return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
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
