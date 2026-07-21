import type {
  DestroyOwnedStructureIntent,
  LayoutMigrationAuthorization,
  LayoutMigrationProposal,
  StructureRemovalArbitrationInput,
  StructureRemovalArbitrationReason,
  StructureRemovalArbitrationRecord,
  StructureRemovalArbitrationResult,
} from "./contracts";

/** Sole final authority for irreversible owned-structure removal intents. */
export function arbitrateStructureRemovals(
  input: StructureRemovalArbitrationInput,
): StructureRemovalArbitrationResult {
  const accepted: StructureRemovalArbitrationRecord[] = [];
  const deferred: StructureRemovalArbitrationRecord[] = [];
  const rejected: StructureRemovalArbitrationRecord[] = [];
  const intents: DestroyOwnedStructureIntent[] = [];
  const inspectedLimit = Math.min(
    128,
    Math.max(0, Math.floor(input.limits.inspectedCandidatesPerTick)),
  );
  const acceptedLimit = Math.min(1, Math.max(0, Math.floor(input.limits.acceptedGloballyPerTick)));
  if (input.proposals.length > inspectedLimit || input.authorizations.length > 128)
    return freeze({
      accepted,
      deferred,
      intents,
      rejected,
      truncatedCandidates: input.proposals.length,
    });
  const proposals = [...input.proposals].sort(compareProposal);
  const stableCounts = count(proposals, ({ stableId }) => stableId);
  const targetCounts = count(proposals, ({ targetId }) => targetId);
  const authorizationCounts = countAuthorizations(input.authorizations);

  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    if (!proposal) continue;
    const duplicateReason =
      (targetCounts.get(proposal.targetId) ?? 0) > 1
        ? "duplicate-target"
        : (stableCounts.get(proposal.stableId) ?? 0) > 1
          ? "duplicate-proposal"
          : null;
    if (duplicateReason !== null) {
      rejected.push(record(proposal, "rejected", duplicateReason));
      continue;
    }
    if (!validProposal(proposal)) {
      rejected.push(record(proposal, "rejected", "invalid-proposal"));
      continue;
    }
    if ((authorizationCounts.get(authorizationKey(proposal)) ?? 0) !== 1) {
      rejected.push(record(proposal, "rejected", "authorization-missing"));
      continue;
    }
    if (accepted.length >= acceptedLimit) {
      deferred.push(record(proposal, "deferred", "global-tick-limit"));
      continue;
    }
    accepted.push(record(proposal, "accepted"));
    intents.push(intent(proposal));
  }

  return freeze({
    accepted,
    deferred: deferred.sort(compareRecord),
    intents,
    rejected: rejected.sort(compareRecordByReason),
    truncatedCandidates: 0,
  });
}

function validProposal(proposal: LayoutMigrationProposal): boolean {
  const terms: {
    readonly replacementExpectedEnergy?: number;
    readonly replacementId: string | null;
    readonly replacementMinimumEnergy?: number;
    readonly replacementRequiresIdle?: boolean;
    readonly replacementStructureType: string;
    readonly replacementRequiresZeroCooldown?: boolean;
    readonly targetRequiresEmptyStore: boolean;
    readonly targetRequiresIdle?: boolean;
    readonly targetRequiresZeroCooldown?: boolean;
    readonly targetStructureType: string;
  } = proposal;
  const validMigrationTerms =
    ["container", "extension", "lab", "link", "spawn", "tower"].includes(
      terms.targetStructureType,
    ) &&
    terms.replacementStructureType === terms.targetStructureType &&
    typeof terms.replacementId === "string" &&
    terms.replacementId.length > 0 &&
    terms.targetRequiresEmptyStore &&
    (terms.targetStructureType !== "spawn" ||
      (terms.targetRequiresIdle === true &&
        terms.replacementRequiresIdle === true &&
        (terms.replacementMinimumEnergy === undefined ||
          (Number.isSafeInteger(terms.replacementMinimumEnergy) &&
            terms.replacementMinimumEnergy > 0 &&
            terms.replacementMinimumEnergy <= 300)))) &&
    (terms.targetStructureType !== "lab" || terms.targetRequiresZeroCooldown === true) &&
    (terms.targetStructureType !== "link" ||
      (Number.isSafeInteger(terms.replacementExpectedEnergy) &&
        (terms.replacementExpectedEnergy ?? -1) >= 0 &&
        (terms.replacementExpectedEnergy ?? 801) <= 800 &&
        terms.targetRequiresZeroCooldown === true &&
        terms.replacementRequiresZeroCooldown === true));
  return (
    validMigrationTerms &&
    proposal.pos.roomName.length > 0 &&
    proposal.pos.x >= 0 &&
    proposal.pos.x < 50 &&
    proposal.pos.y >= 0 &&
    proposal.pos.y < 50 &&
    proposal.stableId.length > 0 &&
    proposal.targetId.length > 0 &&
    proposal.targetId !== proposal.replacementId
  );
}
function intent(proposal: LayoutMigrationProposal): DestroyOwnedStructureIntent {
  const envelope = {
    colonyId: proposal.colonyId,
    kind: "destroy-owned-structure" as const,
    layoutFingerprint: proposal.layoutFingerprint,
    observationFingerprint: proposal.observationFingerprint,
    policyFingerprint: proposal.policyFingerprint,
    roomName: proposal.pos.roomName,
    stableId: proposal.stableId,
    targetId: proposal.targetId,
    x: proposal.pos.x,
    y: proposal.pos.y,
  };
  if (proposal.targetStructureType === "container")
    return {
      ...envelope,
      replacementId: proposal.replacementId,
      replacementStructureType: "container",
      targetRequiresEmptyStore: true,
      targetStructureType: "container",
    };
  if (proposal.targetStructureType === "extension")
    return {
      ...envelope,
      replacementId: proposal.replacementId,
      replacementStructureType: "extension",
      targetRequiresEmptyStore: true,
      targetStructureType: "extension",
    };
  if (proposal.targetStructureType === "spawn")
    return {
      ...envelope,
      replacementId: proposal.replacementId,
      ...(proposal.replacementMinimumEnergy === undefined
        ? {}
        : { replacementMinimumEnergy: proposal.replacementMinimumEnergy }),
      replacementRequiresIdle: true,
      replacementStructureType: "spawn",
      targetRequiresEmptyStore: true,
      targetRequiresIdle: true,
      targetStructureType: "spawn",
    };
  if (proposal.targetStructureType === "tower")
    return {
      ...envelope,
      replacementId: proposal.replacementId,
      replacementStructureType: "tower",
      targetRequiresEmptyStore: true,
      targetStructureType: "tower",
    };
  if (proposal.targetStructureType === "lab")
    return {
      ...envelope,
      replacementId: proposal.replacementId,
      replacementStructureType: "lab",
      targetRequiresEmptyStore: true,
      targetRequiresZeroCooldown: true,
      targetStructureType: "lab",
    };
  return {
    ...envelope,
    replacementExpectedEnergy: proposal.replacementExpectedEnergy,
    replacementId: proposal.replacementId,
    replacementRequiresZeroCooldown: true,
    replacementStructureType: "link",
    targetRequiresEmptyStore: true,
    targetRequiresZeroCooldown: true,
    targetStructureType: "link",
  };
}
function record(
  proposal: LayoutMigrationProposal,
  status: StructureRemovalArbitrationRecord["status"],
  reason?: StructureRemovalArbitrationReason,
): StructureRemovalArbitrationRecord {
  return reason === undefined ? { proposal, status } : { proposal, reason, status };
}
function count(
  proposals: readonly LayoutMigrationProposal[],
  keyOf: (proposal: LayoutMigrationProposal) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const proposal of proposals) {
    const key = keyOf(proposal);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function countAuthorizations(
  authorizations: readonly LayoutMigrationAuthorization[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const authorization of authorizations) {
    const key = authorizationKey(authorization);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function authorizationKey(value: LayoutMigrationAuthorization | LayoutMigrationProposal): string {
  return JSON.stringify([
    value.colonyId,
    "roomName" in value ? value.roomName : value.pos.roomName,
    value.layoutFingerprint,
    value.observationFingerprint,
    value.policyFingerprint,
  ]);
}
function compareProposal(a: LayoutMigrationProposal, b: LayoutMigrationProposal): number {
  return (
    compare(a.colonyId, b.colonyId) ||
    compare(a.pos.roomName, b.pos.roomName) ||
    a.pos.y - b.pos.y ||
    a.pos.x - b.pos.x ||
    compare(a.stableId, b.stableId) ||
    compare(a.targetId, b.targetId)
  );
}
function compareRecord(
  a: StructureRemovalArbitrationRecord,
  b: StructureRemovalArbitrationRecord,
): number {
  return compareProposal(a.proposal, b.proposal);
}
function compareRecordByReason(
  a: StructureRemovalArbitrationRecord,
  b: StructureRemovalArbitrationRecord,
): number {
  return compare(a.reason ?? "", b.reason ?? "") || compareRecord(a, b);
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
