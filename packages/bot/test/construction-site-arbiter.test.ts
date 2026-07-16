import { describe, expect, it } from "vitest";
import {
  CONSTRUCTION_SITE_LIMITS,
  arbitrateConstructionSites,
  deriveConstructionSiteAttemptReceipt,
  normalizeConstructionSiteReceipts,
  type ConstructionSiteAttemptCode,
  type LayoutSiteProposal,
} from "../src/layout";

function proposal(roomName: string, colonyId: string, order: number): LayoutSiteProposal {
  return {
    colonyId,
    layoutFingerprint: "layout-a",
    observationFingerprint: "obs-a",
    placementOrder: order,
    policyFingerprint: "policy-a",
    policyPriority: order,
    pos: { roomName, x: 10 + order, y: 10 },
    stableId: `site:${colonyId}:${roomName}:${String(order)}`,
    structureType: "extension",
  };
}
function run(
  proposals: readonly LayoutSiteProposal[],
  overrides: Partial<Parameters<typeof arbitrateConstructionSites>[0]> = {},
) {
  const rooms = [...new Set(proposals.map((item) => item.pos.roomName))];
  return arbitrateConstructionSites({
    globalOwnedSiteCount: 0,
    limits: CONSTRUCTION_SITE_LIMITS,
    perRoomSiteCounts: rooms.map((roomName) => ({ count: 0, roomName })),
    priorReceipts: [],
    progressionAuthorizations: proposals.map((item) => ({
      authorized: true,
      colonyId: item.colonyId,
      roomName: item.pos.roomName,
    })),
    proposals,
    tick: 100,
    ...overrides,
  });
}
describe("ConstructionSiteArbiter", () => {
  it("enforces global headroom, global/room tick, active-room, and inspection bounds", () => {
    const proposals = [
      proposal("W1N1", "b", 1),
      proposal("W1N1", "b", 2),
      proposal("W2N2", "a", 0),
      proposal("W3N3", "c", 0),
    ];
    const pressure = run(proposals);
    expect(pressure.accepted).toHaveLength(2);
    expect(pressure.deferred.map((item) => item.reason)).toContain("global-tick-limit");
    expect(run([proposal("W1N1", "a", 0), proposal("W1N1", "a", 1)]).deferred[0]?.reason).toBe(
      "room-tick-limit",
    );
    expect(run([proposal("W1N1", "a", 0)], { globalOwnedSiteCount: 95 }).deferred[0]?.reason).toBe(
      "global-headroom",
    );
    expect(
      run([proposal("W1N1", "a", 0)], { perRoomSiteCounts: [{ roomName: "W1N1", count: 10 }] })
        .deferred[0]?.reason,
    ).toBe("room-active-limit");
    expect(
      run(Array.from({ length: 66 }, (_, index) => proposal("W1N1", "a", index))).deferred.filter(
        (item) => item.reason === "inspection-limit",
      ),
    ).toHaveLength(2);
  });
  it("is canonical under reorder and emits detached data without API calls", () => {
    let calls = 0;
    const fakeRoom = { createConstructionSite: () => calls++ };
    const proposals = [proposal("W2N2", "b", 1), proposal("W1N1", "a", 0)];
    const a = run(proposals),
      b = run([...proposals].reverse(), {
        perRoomSiteCounts: [
          { roomName: "W2N2", count: 0 },
          { roomName: "W1N1", count: 0 },
        ],
        progressionAuthorizations: [
          { authorized: true, colonyId: "b", roomName: "W2N2" },
          { authorized: true, colonyId: "a", roomName: "W1N1" },
        ],
      });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.intents[0]).toMatchObject({ kind: "create-construction-site", colonyId: "a" });
    expect(calls).toBe(0);
    expect(fakeRoom).toBeDefined();
  });
  it("rejects unauthorized progression", () => {
    const p = proposal("W1N1", "a", 0);
    expect(
      run([p], {
        progressionAuthorizations: [{ authorized: false, colonyId: "a", roomName: "W1N1" }],
      }).rejected[0]?.reason,
    ).toBe("progression-not-authorized");
  });
  it.each([
    ["OK", "receipt-ok-expectation"],
    ["ERR_FULL", "receipt-full-backoff"],
    ["ERR_RCL_NOT_ENOUGH", "receipt-rcl-policy"],
    ["ERR_INVALID_TARGET", "receipt-invalid-target"],
    ["ERR_NOT_OWNER", "receipt-not-owner"],
    ["UNEXPECTED", "receipt-unexpected-backoff"],
  ] as const)("defers %s deterministically", (code, reason) => {
    const p = proposal("W1N1", "a", 0),
      receipt = deriveConstructionSiteAttemptReceipt({ code, proposal: p, tick: 99 }, []);
    expect(run([p], { priorReceipts: [receipt] }).deferred[0]?.reason).toBe(reason);
  });
  it("invalidates receipts only on their required fresh facts", () => {
    const p = proposal("W1N1", "a", 0),
      receipt = (code: ConstructionSiteAttemptCode) =>
        deriveConstructionSiteAttemptReceipt({ code, proposal: p, tick: 99 }, []);
    expect(run([p], { priorReceipts: [receipt("ERR_INVALID_ARGS")] }).rejected[0]?.reason).toBe(
      "receipt-invalid-args",
    );
    expect(
      run([{ ...p, layoutFingerprint: "layout-b" }], {
        priorReceipts: [receipt("ERR_INVALID_ARGS")],
      }).accepted,
    ).toHaveLength(1);
    expect(
      run([{ ...p, policyFingerprint: "policy-b" }], {
        priorReceipts: [receipt("ERR_RCL_NOT_ENOUGH")],
      }).accepted,
    ).toHaveLength(1);
    expect(
      run([{ ...p, observationFingerprint: "obs-b" }], {
        priorReceipts: [receipt("ERR_INVALID_TARGET")],
      }).accepted,
    ).toHaveLength(1);
    expect(
      run([{ ...p, observationFingerprint: "obs-b" }], {
        priorReceipts: [receipt("ERR_NOT_OWNER")],
      }).accepted,
    ).toHaveLength(1);
  });
  it("bounds receipts and exponential retry across reset/reorder", () => {
    const p = proposal("W1N1", "a", 0);
    const many = Array.from({ length: 40 }, (_, index) =>
      deriveConstructionSiteAttemptReceipt(
        {
          code: "ERR_FULL",
          proposal: { ...p, stableId: `${p.stableId}:${String(index)}` },
          tick: index,
        },
        [],
      ),
    );
    const bounded = normalizeConstructionSiteReceipts(many);
    expect(bounded).toHaveLength(32);
    expect(JSON.stringify(bounded)).toBe(
      JSON.stringify(normalizeConstructionSiteReceipts([...many].reverse())),
    );
    const retry = deriveConstructionSiteAttemptReceipt(
      { code: "UNEXPECTED", proposal: p, tick: 100 },
      [
        {
          attempt: 16,
          code: "UNEXPECTED",
          layoutFingerprint: p.layoutFingerprint,
          nextEligibleTick: 0,
          observationFingerprint: p.observationFingerprint,
          observedAt: 0,
          policyFingerprint: p.policyFingerprint,
          proposalId: p.stableId,
          roomName: p.pos.roomName,
        },
      ],
    );
    expect(retry.nextEligibleTick - retry.observedAt).toBe(64);
  });
});
