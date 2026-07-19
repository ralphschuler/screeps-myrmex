import { describe, expect, it } from "vitest";
import {
  STRUCTURE_REMOVAL_LIMITS,
  arbitrateStructureRemovals,
  type LayoutMigrationProposal,
} from "../src/layout";

const proposal = (id: string, roomName = "W1N1"): LayoutMigrationProposal => ({
  colonyId: roomName,
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  pos: { roomName, x: 10, y: 11 },
  replacementId: `${id}-replacement`,
  replacementStructureType: "extension",
  stableId: `remove-extension/${id}`,
  targetId: id,
  targetRequiresEmptyStore: true,
  targetStructureType: "extension",
});
const containerProposal = (): LayoutMigrationProposal => ({
  colonyId: "W1N1",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  pos: { roomName: "W1N1", x: 10, y: 11 },
  replacementId: "container-service",
  replacementStructureType: "container",
  stableId: "remove-container/container-redundant",
  targetId: "container-redundant",
  targetRequiresEmptyStore: true,
  targetStructureType: "container",
});
const authorization = (value: LayoutMigrationProposal) => ({
  colonyId: value.colonyId,
  layoutFingerprint: value.layoutFingerprint,
  observationFingerprint: value.observationFingerprint,
  policyFingerprint: value.policyFingerprint,
  roomName: value.pos.roomName,
});

describe("StructureRemovalArbiter", () => {
  it("accepts at most one canonical target globally under reordered proposals", () => {
    const proposals = [proposal("extension-b", "W2N2"), proposal("extension-a", "W1N1")];
    const authorizations = proposals.map(authorization);
    const first = arbitrateStructureRemovals({
      authorizations,
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals,
    });
    const reordered = arbitrateStructureRemovals({
      authorizations: [...authorizations].reverse(),
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: [...proposals].reverse(),
    });

    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    expect(first.intents).toEqual([
      expect.objectContaining({ kind: "destroy-owned-structure", targetId: "extension-a" }),
    ]);
    expect(first.deferred).toHaveLength(1);
    expect(first.deferred[0]?.proposal.targetId).toBe("extension-b");
  });

  it("rejects duplicate identities and targets without authorizing either duplicate", () => {
    const original = proposal("extension-a");
    const duplicateTarget = { ...original, stableId: "remove-extension/other" };
    const duplicateIdentity = { ...proposal("extension-b"), stableId: original.stableId };
    const result = arbitrateStructureRemovals({
      authorizations: [authorization(original)],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: [original, duplicateTarget, duplicateIdentity],
    });

    expect(result.intents).toEqual([]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual([
      "duplicate-proposal",
      "duplicate-target",
      "duplicate-target",
    ]);
  });

  it("accepts only matching replacement terms and rejects obsolete road destruction", () => {
    const candidate = containerProposal();
    const accepted = arbitrateStructureRemovals({
      authorizations: [authorization(candidate)],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: [candidate],
    });
    expect(accepted.intents).toEqual([
      expect.objectContaining({
        replacementId: "container-service",
        replacementStructureType: "container",
        targetId: "container-redundant",
        targetStructureType: "container",
      }),
    ]);

    const tower = {
      ...proposal("tower-obsolete"),
      replacementId: "tower-replacement",
      replacementStructureType: "tower",
      stableId: "remove-tower/tower-obsolete",
      targetStructureType: "tower",
    } as const satisfies LayoutMigrationProposal;
    expect(
      arbitrateStructureRemovals({
        authorizations: [authorization(tower)],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [tower],
      }).intents,
    ).toEqual([
      expect.objectContaining({
        replacementStructureType: "tower",
        targetStructureType: "tower",
      }),
    ]);

    const mismatched = {
      ...candidate,
      replacementStructureType: "extension",
    } as unknown as LayoutMigrationProposal;
    expect(
      arbitrateStructureRemovals({
        authorizations: [authorization(mismatched)],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [mismatched],
      }).rejected[0]?.reason,
    ).toBe("invalid-proposal");

    const obsoleteRoad = {
      ...candidate,
      replacementId: null,
      replacementStructureType: "tower",
      targetId: "road-compatible",
      targetRequiresEmptyStore: false,
      targetStructureType: "road",
    } as unknown as LayoutMigrationProposal;
    expect(
      arbitrateStructureRemovals({
        authorizations: [authorization(obsoleteRoad)],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [obsoleteRoad],
      }).rejected[0]?.reason,
    ).toBe("invalid-proposal");
  });

  it("preserves typed empty-idle link terms in the sole removal intent", () => {
    const link = {
      ...proposal("link-reserve-external"),
      replacementId: "link-reserve-exact",
      replacementRequiresZeroCooldown: true,
      replacementStructureType: "link",
      stableId: "remove-reserve-link/link-reserve-external",
      targetRequiresZeroCooldown: true,
      targetStructureType: "link",
    } as const satisfies LayoutMigrationProposal;
    const result = arbitrateStructureRemovals({
      authorizations: [authorization(link)],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: [link],
    });
    expect(result.intents).toEqual([
      expect.objectContaining({
        replacementId: "link-reserve-exact",
        replacementRequiresZeroCooldown: true,
        replacementStructureType: "link",
        targetId: "link-reserve-external",
        targetRequiresEmptyStore: true,
        targetRequiresZeroCooldown: true,
        targetStructureType: "link",
      }),
    ]);
    const untyped = {
      ...link,
      replacementRequiresZeroCooldown: false,
    } as unknown as LayoutMigrationProposal;
    expect(
      arbitrateStructureRemovals({
        authorizations: [authorization(untyped)],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [untyped],
      }).rejected[0]?.reason,
    ).toBe("invalid-proposal");
  });

  it("rejects a proposal without one exact current authorization", () => {
    const candidate = proposal("extension-a");
    expect(
      arbitrateStructureRemovals({
        authorizations: [],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [candidate],
      }).rejected[0]?.reason,
    ).toBe("authorization-missing");
    expect(
      arbitrateStructureRemovals({
        authorizations: [{ ...authorization(candidate), observationFingerprint: "stale" }],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [candidate],
      }).intents,
    ).toEqual([]);
  });

  it("rejects an over-cap batch before sorting or traversing candidates", () => {
    const proposals = Array.from({ length: 129 }, (_, index) =>
      proposal(`extension-${String(index)}`),
    );
    const result = arbitrateStructureRemovals({
      authorizations: [],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals,
    });
    expect(result).toMatchObject({
      accepted: [],
      deferred: [],
      intents: [],
      rejected: [],
      truncatedCandidates: 129,
    });
  });
});
