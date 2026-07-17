import { describe, expect, it } from "vitest";
import { LinkExecutor, type LinkTransferDecision } from "../src/links";

describe("LinkExecutor", () => {
  it("calls transferEnergy once and settles predicted flow and budget attribution on OK", () => {
    const calls: unknown[][] = [];
    const target = {} as StructureLink;
    const source = {
      transferEnergy: (...args: unknown[]) => (calls.push(args), 0),
    } as StructureLink;
    const execution = new LinkExecutor().execute([decision()], adapter(source, target));
    expect(calls).toEqual([[target, 400]]);
    expect(execution[0]).toMatchObject({
      actualDeliveredAmount: 388,
      actualLostAmount: 12,
      actualSentAmount: 400,
      called: true,
      code: "OK",
      decision: { budget: { cost: 400, id: "reservation-a" }, flowId: "flow-a" },
      fault: null,
    });
  });

  it.each([
    [-1, "ERR_NOT_OWNER"],
    [-6, "ERR_NOT_ENOUGH_RESOURCES"],
    [-7, "ERR_INVALID_TARGET"],
    [-8, "ERR_FULL"],
    [-9, "ERR_NOT_IN_RANGE"],
    [-10, "ERR_INVALID_ARGS"],
    [-11, "ERR_TIRED"],
    [-14, "ERR_RCL_NOT_ENOUGH"],
  ] as const)("normalizes %i without attributing a transfer", (returnCode, code) => {
    const source = { transferEnergy: () => returnCode } as unknown as StructureLink;
    expect(
      new LinkExecutor().execute([decision()], adapter(source, {} as StructureLink))[0],
    ).toMatchObject({
      actualDeliveredAmount: 0,
      actualLostAmount: 0,
      actualSentAmount: 0,
      called: true,
      code,
      fault: null,
    });
  });

  it("fails closed for stale layout, missing objects, duplicates, unknown codes, and exceptions", () => {
    const stale = new LinkExecutor().execute([decision()], {
      isCurrentLayoutRevision: () => false,
      resolveLink: () => null,
    });
    expect(stale[0]).toMatchObject({ called: false, fault: "stale-layout" });
    const missing = new LinkExecutor().execute([decision()], {
      isCurrentLayoutRevision: () => true,
      resolveLink: () => null,
    });
    expect(missing[0]).toMatchObject({ called: false, fault: "source-unavailable" });
    const throwing = {
      transferEnergy: () => {
        throw new Error("boom");
      },
    } as unknown as StructureLink;
    expect(
      new LinkExecutor().execute([decision()], adapter(throwing, {} as StructureLink))[0],
    ).toMatchObject({
      called: false,
      code: "UNEXPECTED",
      fault: "adapter-fault",
    });
    const unknown = { transferEnergy: () => -99 } as unknown as StructureLink;
    expect(
      new LinkExecutor().execute([decision()], adapter(unknown, {} as StructureLink))[0],
    ).toMatchObject({
      called: true,
      fault: "adapter-fault",
    });
    const duplicate = new LinkExecutor().execute(
      [decision("b"), decision("a")],
      adapter({ transferEnergy: () => 0 } as unknown as StructureLink, {} as StructureLink),
    );
    expect(duplicate.map(({ fault }) => fault)).toEqual([null, "duplicate-source"]);
  });

  it("backs off repeated command errors with bounded heap-only receipts", () => {
    let calls = 0;
    const source = {
      transferEnergy: () => {
        calls += 1;
        return -11;
      },
    } as unknown as StructureLink;
    const executor = new LinkExecutor();
    expect(executor.execute([decision()], adapter(source, {} as StructureLink), 100)[0]?.code).toBe(
      "ERR_TIRED",
    );
    expect(
      executor.execute([decision()], adapter(source, {} as StructureLink), 101)[0],
    ).toMatchObject({ called: false, code: "DEFERRED_BACKOFF", fault: "command-backoff" });
    expect(executor.execute([decision()], adapter(source, {} as StructureLink), 102)[0]?.code).toBe(
      "ERR_TIRED",
    );
    expect(calls).toBe(2);
    expect(
      new LinkExecutor().execute([decision()], adapter(source, {} as StructureLink), 101)[0],
    ).toMatchObject({ called: true, code: "ERR_TIRED" });
  });
});

function decision(proposalId = "proposal-a"): LinkTransferDecision {
  return {
    budget: { cost: 400, id: "reservation-a" },
    deliveredAmount: 388,
    flowId: "flow-a",
    layoutRevision: "layout-v2:fingerprint-a",
    lostAmount: 12,
    proposalId,
    sentAmount: 400,
    sourceLinkId: "source-link",
    targetLinkId: "target-link",
  };
}

function adapter(source: StructureLink, target: StructureLink) {
  return {
    isCurrentLayoutRevision: () => true,
    resolveLink: (id: string) =>
      id === "source-link" ? source : id === "target-link" ? target : null,
  };
}
