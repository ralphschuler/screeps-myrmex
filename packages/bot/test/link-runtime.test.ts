import { describe, expect, it } from "vitest";
import {
  planLinkRuntime,
  projectLinkDomainHealth,
  type LinkRoomLayoutEvidence,
} from "../src/links";
import type { LedgerEntry } from "../src/colony";
import type { RoomSnapshot } from "../src/world/snapshot";

describe("link runtime projection", () => {
  it("produces funded source-to-hub and loss-attributed hub-to-controller decisions", () => {
    const sourceToHub = plan({ links: [link("source", 11, 10, 800), link("hub", 20, 20, 0)] });
    expect(sourceToHub.rooms[0]?.arbitration.accepted[0]).toMatchObject({
      budget: { id: "reservation-mining" },
      flowId: "mining/W1N1/source-a",
      sourceLinkId: "source",
      targetLinkId: "hub",
    });
    const hubToController = plan({
      links: [link("hub", 20, 20, 800), link("controller", 39, 40, 0)],
    });
    expect(hubToController.rooms[0]?.arbitration.accepted[0]).toMatchObject({
      budget: { id: "reservation-growth" },
      flowId: "growth/W1N1/controller",
      sourceLinkId: "hub",
      targetLinkId: "controller",
    });
  });

  it("uses direct source-to-controller, partial capacity, cooldown, structure loss, and reset deterministically", () => {
    const direct = plan({
      links: [link("source", 11, 10, 800), link("controller", 39, 40, 700)],
    });
    expect(direct.rooms[0]?.arbitration.accepted[0]).toMatchObject({
      deliveredAmount: 100,
      sourceLinkId: "source",
      targetLinkId: "controller",
    });
    const reset: unknown = JSON.parse(JSON.stringify(direct));
    expect(plan({ links: [link("controller", 39, 40, 700), link("source", 11, 10, 800)] })).toEqual(
      reset,
    );
    expect(
      plan({
        links: [link("source", 11, 10, 800, 1), link("hub", 20, 20, 0)],
      }).rooms[0]?.arbitration.deferred.some(({ reason }) => reason === "cooldown"),
    ).toBe(true);
    expect(plan({ links: [link("source", 11, 10, 800)] }).rooms[0]?.arbitration.accepted).toEqual(
      [],
    );
  });

  it("publishes direct health only for complete current role classification", () => {
    const room = {
      controller: { level: 8, ownership: "owned" },
      name: "W1N1",
      observedAt: 100,
      ownedLinks: [
        link("source", 11, 10, 800),
        link("hub", 20, 20, 0),
        link("controller", 39, 40, 0),
      ],
    } as unknown as RoomSnapshot;
    expect(projectLinkDomainHealth({ layouts: [layout()], rooms: [room], tick: 100 })).toEqual([
      { colonyId: "W1N1", domain: "links", observedAt: 100, status: "healthy" },
    ]);
    expect(
      projectLinkDomainHealth({
        layouts: [layout()],
        rooms: [
          {
            ...room,
            ownedLinks: [link("a", 12, 10, 0), link("b", 21, 20, 0), link("c", 38, 40, 0)],
          },
        ],
        tick: 100,
      }),
    ).toEqual([{ colonyId: "W1N1", domain: "links", observedAt: 100, status: "failed" }]);
  });

  it("fails closed when funding, activity, or current layout evidence disappears", () => {
    expect(plan({ reservations: [] }).rooms[0]?.arbitration.accepted).toEqual([]);
    expect(
      plan({ links: [link("source", 11, 10, 800, 0, false), link("hub", 20, 20, 0)] }).rooms[0]
        ?.classification.blockers,
    ).toContainEqual({ id: "source", reason: "inactive-link" });
    expect(plan({ layouts: [] }).rooms).toEqual([]);
  });
});

function plan(
  change: {
    links?: ReturnType<typeof link>[];
    layouts?: LinkRoomLayoutEvidence[];
    reservations?: LedgerEntry[];
  } = {},
) {
  const room = {
    controller: { ownership: "owned" },
    name: "W1N1",
    observedAt: 100,
    ownedLinks: change.links ?? [link("source", 11, 10, 800), link("hub", 20, 20, 0)],
  } as unknown as RoomSnapshot;
  return planLinkRuntime({
    growth: [
      {
        action: "upgrade-controller",
        budgetRequest: budget("growth/W1N1/controller", "optional-growth"),
        colonyId: "W1N1",
        order: 0,
        reasonCode: "optional-growth",
        target: pos(40, 40),
        targetId: "controller-id",
      },
    ],
    layouts: change.layouts ?? [layout()],
    logistics: {
      budgets: [],
      contracts: { commitments: [], retirements: [] },
      graph: { edges: [], endpoints: [], nodes: [] },
      health: [],
      plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
    },
    mining: {
      projections: [
        {
          blocker: null,
          budgetRequest: budget("mining/W1N1/source-a", "harvesting-filling"),
          colonyId: "W1N1",
          contractRequest: null,
          identity: "mining/W1N1/source-a",
          offloadState: "link-candidate",
          sourceId: "source-a",
          workPosition: pos(10, 10),
        },
      ],
      requests: [],
      transitions: [],
    },
    reservations: change.reservations ?? [
      reservation("reservation-mining", "mining/W1N1/source-a", "harvesting-filling"),
      reservation("reservation-growth", "growth/W1N1/controller", "optional-growth"),
    ],
    rooms: [room],
    tick: 100,
  });
}

function layout(): LinkRoomLayoutEvidence {
  return {
    roomName: "W1N1",
    evidence: {
      algorithmRevision: "layout-v2",
      controller: pos(40, 40),
      fingerprint: "a",
      linkPlacements: [pos(11, 10), pos(20, 20), pos(39, 40)],
      sourceServices: [{ pos: pos(10, 10), sourceId: "source-a" }],
      storage: pos(20, 21),
    },
  };
}
function link(id: string, x: number, y: number, energy: number, cooldown = 0, active = true) {
  return {
    active,
    cooldown,
    hits: 1000,
    hitsMax: 1000,
    id,
    pos: pos(x, y),
    store: {
      capacity: 800,
      freeCapacity: 800 - energy,
      resources: [{ amount: energy, resourceType: "energy" }],
      usedCapacity: energy,
    },
  };
}
function budget(issuer: string, category: "harvesting-filling" | "optional-growth") {
  return {
    category,
    colonyId: "W1N1",
    cpu: { desired: 1, minimum: 1 },
    energy: null,
    expiresAt: 1000,
    issuer,
    revision: 1,
    spawn: null,
  } as const;
}
function reservation(
  reservationId: string,
  issuer: string,
  category: "harvesting-filling" | "optional-growth",
) {
  return {
    category,
    colonyId: "W1N1",
    issuer,
    reservationId,
    status: "active",
  } as unknown as LedgerEntry;
}
function pos(x: number, y: number) {
  return { roomName: "W1N1", x, y };
}
