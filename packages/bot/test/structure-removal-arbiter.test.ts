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
  replacementStructureType: "tower",
  stableId: `remove-road/${id}`,
  targetId: id,
  targetStructureType: "road",
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
    const proposals = [proposal("road-b", "W2N2"), proposal("road-a", "W1N1")];
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
      expect.objectContaining({ kind: "destroy-owned-structure", targetId: "road-a" }),
    ]);
    expect(first.deferred).toHaveLength(1);
    expect(first.deferred[0]?.proposal.targetId).toBe("road-b");
  });

  it("rejects duplicate identities and targets without authorizing either duplicate", () => {
    const duplicateTarget = { ...proposal("road-a"), stableId: "remove-road/other" };
    const duplicateIdentity = { ...proposal("road-b"), stableId: "remove-road/road-a" };
    const original = proposal("road-a");
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

  it("rejects a proposal without one exact current authorization", () => {
    const candidate = proposal("road-a");
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
    const proposals = Array.from({ length: 129 }, (_, index) => proposal(`road-${String(index)}`));
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
