import { describe, expect, it, vi } from "vitest";
import {
  ConstructionSiteExecutor,
  emptyLayoutsOwner,
  persistLayoutCommitment,
  reconcileConstructionSiteExecution,
  type CreateConstructionSiteIntent,
} from "../src/layout";

const intent: CreateConstructionSiteIntent = {
  colonyId: "W1N1",
  kind: "create-construction-site",
  layoutFingerprint: "layout-a",
  observationFingerprint: "obs-a",
  policyFingerprint: "policy-a",
  proposalId: "proposal-a",
  roomName: "W1N1",
  structureType: "extension",
  x: 10,
  y: 11,
};
const executor = new ConstructionSiteExecutor();
function adapter(code: number, owned = true) {
  const createConstructionSite = vi.fn(() => code);
  return {
    createConstructionSite,
    value: {
      isCurrentCommitment: () => true,
      resolveRoom: () => ({ controller: { my: owned }, createConstructionSite }) as unknown as Room,
    },
  };
}
describe("ConstructionSiteExecutor", () => {
  it.each([
    [0, "OK"],
    [-8, "ERR_FULL"],
    [-14, "ERR_RCL_NOT_ENOUGH"],
    [-7, "ERR_INVALID_TARGET"],
    [-10, "ERR_INVALID_ARGS"],
    [-1, "ERR_NOT_OWNER"],
    [-99, "UNEXPECTED"],
  ] as const)("normalizes %s as %s after one call", (code, expected) => {
    const fixture = adapter(code),
      result = executor.execute([intent], fixture.value);
    expect(fixture.createConstructionSite).toHaveBeenCalledOnce();
    expect(fixture.createConstructionSite).toHaveBeenCalledWith(10, 11, "extension");
    expect(result[0]).toMatchObject({ called: true, code: expected, intent });
  });
  it("does not call stale, unavailable, or unowned rooms and isolates faults", () => {
    const stale = adapter(0),
      unavailable = adapter(0),
      lost = adapter(0, false);
    expect(
      executor.execute([intent], { ...stale.value, isCurrentCommitment: () => false })[0],
    ).toMatchObject({ called: false, fault: "stale-commitment" });
    expect(
      executor.execute([intent], { ...unavailable.value, resolveRoom: () => null })[0],
    ).toMatchObject({ called: false, fault: "room-unavailable" });
    expect(executor.execute([intent], lost.value)[0]).toMatchObject({
      called: false,
      fault: "room-not-owned",
    });
    expect(
      executor.execute([intent], {
        isCurrentCommitment: () => true,
        resolveRoom: () => {
          throw new Error("fault");
        },
      })[0],
    ).toMatchObject({ called: false, code: "UNEXPECTED", fault: "adapter-fault" });
    expect(stale.createConstructionSite).not.toHaveBeenCalled();
    expect(unavailable.createConstructionSite).not.toHaveBeenCalled();
    expect(lost.createConstructionSite).not.toHaveBeenCalled();
  });
  it("reconciles exact receipts only for the current commitment", () => {
    const commitment = {
      algorithmRevision: "owned-room-layout-v1",
      anchor: { roomName: "W1N1", x: 25, y: 25 },
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-a",
      transform: 0,
    } as const;
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const execution = executor.execute([intent], adapter(-8).value);
    const reconciled = reconcileConstructionSiteExecution(owner, execution, 100);
    expect(reconciled.receipts).toEqual([
      expect.objectContaining({
        code: "ERR_FULL",
        nextEligibleTick: 105,
        proposalId: "proposal-a",
      }),
    ]);
    expect(reconciled.owner.records[0]?.siteReceipts).toHaveLength(1);
    expect(
      reconcileConstructionSiteExecution(
        persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-b" }),
        execution,
        101,
      ).receipts,
    ).toEqual([]);
  });
});
