import { describe, expect, it } from "vitest";
import { minerCapability, planStaticMining } from "../src/economy";
import type { ContractPlanningView } from "../src/contracts";
import type { LayoutPlacement } from "../src/layout";
import type { WorldSnapshot } from "../src/world/snapshot";

const pos = (x: number, y: number) => ({ roomName: "W1N1", x, y });
const service = (
  sourceId: string,
  x: number,
  adoption: LayoutPlacement["adoption"] = "planned",
): LayoutPlacement => ({
  adoption,
  layer: "primary",
  minimumRcl: 2,
  pos: pos(x, 10),
  service: { kind: "source-container", sourceId },
  structureType: "container",
});

describe("StaticMiningPlanner", () => {
  it("projects one stable v2 commitment per healthy source independently", () => {
    const input = {
      layouts: new Map([["W1N1", [service("a", 11)]]]),
      snapshot: world(),
      tick: 10,
    };
    const result = planStaticMining(input);
    expect(result.projections.map(({ identity, blocker }) => [identity, blocker])).toEqual([
      ["mining/W1N1/a", null],
      ["mining/W1N1/b", "layout-missing"],
    ]);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      issuer: "mining/W1N1/a",
      requiredCapability: { work: 5, move: 3 },
      execution: { version: 2, workPosition: pos(11, 10) },
    });
    expect(JSON.stringify(planStaticMining({ ...input, snapshot: world(true) }))).toBe(
      JSON.stringify(result),
    );
  });

  it("scales deterministic stationary bodies at room-capacity boundaries", () => {
    expect(minerCapability(300)).toMatchObject({ work: 2, move: 1 });
    expect(minerCapability(550)).toMatchObject({ work: 4, move: 2 });
    expect(minerCapability(800)).toMatchObject({ work: 5, move: 3 });
  });

  it.each([
    [1, "planned", [], "rcl-locked"],
    [2, "planned", [], "site-needed"],
    [2, "exact", [], "container-destroyed"],
    [
      2,
      "planned",
      [
        {
          id: "container-site-a",
          ownerUsername: "me",
          ownership: "owned",
          pos: pos(11, 10),
          progress: 0,
          progressTotal: 5_000,
          structureType: "container",
        },
      ],
      "site-pending",
    ],
  ] as const)("derives offload state %#", (level, adoption, sites, expected) => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined || room.controller === null) throw new Error("expected owned room");
    const changed = {
      ...snapshot,
      rooms: [
        {
          ...room,
          controller: { ...room.controller, level },
          constructionSites: sites,
        },
      ],
    };
    const result = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 11, adoption)]]]),
      snapshot: changed,
      tick: 10,
    });
    expect(result.projections[0]?.offloadState).toBe(expected);
    expect(result.requests).toHaveLength(1);
  });

  it.each([
    ["container-ready", 2_000, 250_000, 250_000, false],
    ["container-full", 0, 250_000, 250_000, false],
    ["container-decaying", 1_000, 100_000, 250_000, false],
    ["link-candidate", 2_000, 250_000, 250_000, true],
  ] as const)("derives the %s offload outcome", (expected, free, hits, hitsMax, withLink) => {
    const snapshot = offloadWorld({ free, hits, hitsMax, withLink });
    const result = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 11)]]]),
      snapshot,
      tick: 10,
    });
    expect(result.projections[0]?.offloadState).toBe(expected);
    expect(result.requests).toHaveLength(1);
  });

  it("suspends an existing static contract only for visible room or layout loss", () => {
    const planning = staticPlanning();
    const layoutLoss = planStaticMining({
      layouts: new Map(),
      planning,
      snapshot: world(),
      tick: 11,
    });
    expect(layoutLoss.transitions).toEqual([
      expect.objectContaining({ contractId: "static-a", reason: "static-layout-unavailable" }),
    ]);

    const visible = world();
    const room = visible.rooms[0];
    if (room === undefined || room.controller === null) throw new Error("expected owned room");
    const roomLoss = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 11)]]]),
      planning,
      snapshot: {
        ...visible,
        rooms: [
          {
            ...room,
            controller: { ...room.controller, ownership: "foreign", ownerUsername: "enemy" },
          },
        ],
      },
      tick: 12,
    });
    expect(roomLoss.transitions).toEqual([
      expect.objectContaining({ contractId: "static-a", reason: "static-room-lost" }),
    ]);

    expect(
      planStaticMining({
        layouts: new Map(),
        planning,
        snapshot: { ...visible, rooms: [] },
        tick: 13,
      }).transitions,
    ).toEqual([]);
  });

  it("emits extraction data only and no adjacent-scope policy or command authority", () => {
    const result = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 11)]]]),
      snapshot: offloadWorld({ free: 2_000, hits: 250_000, hitsMax: 250_000, withLink: true }),
      tick: 10,
    });
    expect(Object.keys(result).sort()).toEqual(["projections", "requests", "transitions"]);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.kind).toBe("harvest");
    expect(result.requests[0]?.execution).toMatchObject({
      action: "harvest",
      counterpartId: null,
      resourceType: null,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      '"action":"transfer"',
      '"action":"repair"',
      '"commands"',
      '"hauling"',
      '"linkTransfer"',
      '"telemetry"',
    ])
      expect(serialized).not.toContain(forbidden);
  });
});

function staticPlanning(): ContractPlanningView {
  return {
    status: "ready",
    contracts: [
      {
        budgetBinding: { category: "harvesting-filling", issuer: "mining/W1N1/a" },
        contractId: "static-a",
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: null,
          resourceType: null,
          version: 2,
          workPosition: pos(11, 10),
        },
        issuer: "mining/W1N1/a",
        owner: { id: "W1N1", kind: "colony" },
        state: "active",
        targetId: "a",
      },
    ],
  };
}

function offloadWorld(input: {
  readonly free: number;
  readonly hits: number;
  readonly hitsMax: number;
  readonly withLink: boolean;
}): WorldSnapshot {
  const snapshot = world();
  const room = snapshot.rooms[0];
  if (room === undefined) throw new Error("expected room");
  const store = {
    capacity: 2_000,
    freeCapacity: input.free,
    resources: [{ amount: 2_000 - input.free, resourceType: "energy" }],
    usedCapacity: 2_000 - input.free,
  };
  const container = {
    hits: input.hits,
    hitsMax: input.hitsMax,
    id: "container-a",
    pos: pos(11, 10),
    store,
    structureType: "container",
  };
  const link = {
    ...container,
    id: "link-a",
    pos: pos(12, 10),
    structureType: "link",
  };
  return {
    ...snapshot,
    rooms: [
      {
        ...room,
        storedStructures: [container],
        structures: input.withLink ? [container, link] : [container],
      },
    ],
  } as unknown as WorldSnapshot;
}

function world(reorder = false): WorldSnapshot {
  const sources = [
    { energy: 0, energyCapacity: 3_000, id: "a", pos: pos(10, 10), ticksToRegeneration: 5 },
    { energy: 3_000, energyCapacity: 3_000, id: "b", pos: pos(20, 10), ticksToRegeneration: null },
  ];
  return {
    schemaVersion: 1,
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: {
          id: "controller",
          level: 8,
          ownership: "owned",
          ownerUsername: "me",
          pos: pos(25, 25),
          progress: 0,
          progressTotal: 0,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 1,
          upgradeBlocked: null,
        },
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 10,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: [],
        sources: reorder ? [...sources].reverse() : sources,
        storedStructures: [],
        structures: [],
      },
    ],
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: 2,
        storedStructures: 0,
        total: 3,
      },
      estimatedPayloadBytes: 0,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
