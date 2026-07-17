import { describe, expect, it } from "vitest";
import {
  arbitrateLinkTransfers,
  classifyLinks,
  deriveLinkRoleAnchors,
  MAX_LINK_TRANSFER_PROPOSALS,
  type ClassifiedLink,
  type LinkTransferProposal,
} from "../src/links";

const pos = (x: number, y: number, roomName = "W1N1") => ({ roomName, x, y });

describe("LinkArbiter", () => {
  it("derives source, controller, hub, and reserve roles from versioned layout geometry", () => {
    const anchors = deriveLinkRoleAnchors({
      algorithmRevision: "layout-v2",
      controller: pos(40, 40),
      fingerprint: "fingerprint-a",
      linkPlacements: [pos(25, 25), pos(11, 10), pos(39, 40), pos(20, 20)],
      sourceServices: [{ pos: pos(10, 10), sourceId: "source-a" }],
      storage: pos(20, 21),
    });
    expect(anchors.map(({ pos: anchorPos, role }) => [anchorPos.x, anchorPos.y, role])).toEqual([
      [11, 10, "source"],
      [20, 20, "hub"],
      [25, 25, "reserve"],
      [39, 40, "controller"],
    ]);
    expect(new Set(anchors.map(({ layoutRevision }) => layoutRevision))).toEqual(
      new Set(["layout-v2:fingerprint-a"]),
    );
  });

  it("classifies exact anchors identically across reset and insertion reordering", () => {
    const anchors = deriveLinkRoleAnchors({
      algorithmRevision: "layout-v2",
      controller: pos(40, 40),
      fingerprint: "a",
      linkPlacements: [pos(10, 10), pos(20, 20)],
      sourceServices: [{ pos: pos(9, 10), sourceId: "source-a" }],
      storage: pos(20, 21),
    });
    const links = [link("link-source", "source", 10, 10), link("link-hub", "hub", 20, 20)];
    const input = { anchors, layoutRevision: "layout-v2:a", links, tick: 100 };
    const warm = classifyLinks(input);
    const resetInput = JSON.parse(
      JSON.stringify({ ...input, anchors: [...anchors].reverse(), links: [...links].reverse() }),
    ) as typeof input;
    expect(classifyLinks(resetInput)).toEqual(warm);
    expect(warm.links.map(({ id, role }) => [id, role])).toEqual([
      ["link-hub", "hub"],
      ["link-source", "source"],
    ]);
  });

  it("fails closed for stale, foreign, inactive, missing, unclassified, and stale-layout facts", () => {
    const result = classifyLinks({
      anchors: [
        anchor("a-foreign", 1, 1, "source"),
        anchor("a-inactive", 2, 2, "source"),
        anchor("a-stale", 3, 3, "hub"),
        anchor("a-missing", 4, 4, "controller"),
        { ...anchor("a-old", 5, 5, "reserve"), layoutRevision: "layout-old" },
      ],
      layoutRevision: "layout-a",
      links: [
        { ...link("foreign", "source", 1, 1), owned: false },
        { ...link("inactive", "source", 2, 2), active: false },
        { ...link("stale", "hub", 3, 3), observedAt: 99 },
        link("unknown", "reserve", 9, 9),
      ],
      tick: 100,
    });
    expect(result.links).toEqual([]);
    expect(result.blockers.map(({ reason }) => reason).sort()).toEqual(
      [
        "foreign-link",
        "inactive-link",
        "layout-revision-mismatch",
        "missing-link",
        "stale-link",
        "unclassified-link",
      ].sort(),
    );
  });

  it("admits mandatory work first with exact loss and shared-capacity reservations", () => {
    const result = arbitrateLinkTransfers({
      layoutRevision: "layout-a",
      links: [
        link("source-a", "source", 10, 10, { energy: 800 }),
        link("source-b", "source", 11, 10, { energy: 800 }),
        link("hub", "hub", 20, 20, { energy: 0, freeCapacity: 800 }),
      ],
      proposals: [
        proposal("optional", "source-a", "hub", 800, "growth", 1),
        proposal("survival", "source-b", "hub", 400, "survival", 100),
      ],
      tick: 100,
    });
    expect(result.accepted).toEqual([
      {
        deliveredAmount: 388,
        flowId: "flow-survival",
        lostAmount: 12,
        proposalId: "survival",
        sentAmount: 400,
        sourceLinkId: "source-b",
        targetLinkId: "hub",
      },
      {
        deliveredAmount: 412,
        flowId: "flow-optional",
        lostAmount: 13,
        proposalId: "optional",
        sentAmount: 425,
        sourceLinkId: "source-a",
        targetLinkId: "hub",
      },
    ]);
    expect(result.accepted.reduce((sum, value) => sum + value.deliveredAmount, 0)).toBe(800);
  });

  it("permits one outbound command per source and returns canonical typed deferrals", () => {
    const result = arbitrateLinkTransfers({
      layoutRevision: "layout-a",
      links: [
        link("source", "source", 10, 10, { energy: 800 }),
        link("hub", "hub", 20, 20),
        link("controller", "controller", 25, 25),
      ],
      proposals: [
        proposal("first", "source", "controller", 400, "survival", 100),
        proposal("second", "source", "hub", 400, "maintenance", 1),
        {
          ...proposal("denied", "hub", "controller", 100, "maintenance", 1),
          fundingStatus: "denied",
        },
      ],
      tick: 100,
    });
    expect(result.accepted.map(({ proposalId }) => proposalId)).toEqual(["first"]);
    expect(result.deferred).toEqual([
      { proposalId: "denied", reason: "budget-unavailable" },
      { proposalId: "second", reason: "source-already-used" },
    ]);
  });

  it.each([
    ["cooldown", { cooldown: 1 }, "cooldown"],
    ["empty", { energy: 0 }, "insufficient-source"],
    ["inactive", { active: false }, "foreign-or-inactive"],
    ["stale", { observedAt: 99 }, "stale-link"],
  ] as const)("defers a %s source", (_name, change, reason) => {
    const result = arbitrateLinkTransfers({
      layoutRevision: "layout-a",
      links: [link("source", "source", 10, 10, change), link("hub", "hub", 20, 20)],
      proposals: [proposal("p", "source", "hub", 100, "maintenance", 1)],
      tick: 100,
    });
    expect(result.deferred).toEqual([{ proposalId: "p", reason }]);
  });

  it("bounds proposal work and marks every overflow deterministically", () => {
    const proposals = Array.from({ length: MAX_LINK_TRANSFER_PROPOSALS + 2 }, (_, index) =>
      proposal(`p-${String(index).padStart(3, "0")}`, "source", "hub", 100, "maintenance", 1),
    );
    const result = arbitrateLinkTransfers({
      layoutRevision: "layout-a",
      links: [link("source", "source", 10, 10), link("hub", "hub", 20, 20)],
      proposals: [...proposals].reverse(),
      tick: 100,
    });
    expect(result.evaluatedProposals).toBe(MAX_LINK_TRANSFER_PROPOSALS);
    expect(result.truncatedProposals).toBe(2);
    expect(result.deferred.filter(({ reason }) => reason === "proposal-cap")).toHaveLength(2);
  });
});

function anchor(id: string, x: number, y: number, role: ClassifiedLink["role"]) {
  return { id, layoutRevision: "layout-a", pos: pos(x, y), role };
}

function link(
  id: string,
  role: ClassifiedLink["role"],
  x: number,
  y: number,
  change: Partial<ClassifiedLink> = {},
): ClassifiedLink {
  return {
    active: true,
    anchorId: `anchor-${id}`,
    cooldown: 0,
    energy: 400,
    freeCapacity: 400,
    id,
    layoutRevision: "layout-a",
    observedAt: 100,
    owned: true,
    pos: pos(x, y),
    role,
    ...change,
  };
}

function proposal(
  id: string,
  sourceLinkId: string,
  targetLinkId: string,
  amount: number,
  priorityClass: "survival" | "maintenance" | "growth",
  value: number,
): LinkTransferProposal {
  return {
    amount,
    budget: { cost: amount, id: `links/${id}` },
    deadline: 110,
    flowId: `flow-${id}`,
    fundingStatus: "active",
    id,
    layoutRevision: "layout-a",
    priority: { class: priorityClass, value },
    sourceLinkId,
    targetLinkId,
  };
}
