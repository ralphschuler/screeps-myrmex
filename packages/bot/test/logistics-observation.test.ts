import { describe, expect, it } from "vitest";
import {
  MAX_LOGISTICS_NODES,
  MAX_LOGISTICS_OBSERVATION_BLOCKERS,
  observeLogistics,
} from "../src/logistics";
import type { RoomSnapshot, StoreSnapshot, StoredStructureSnapshot } from "../src/world/snapshot";

const pos = (x: number, y: number) => ({ roomName: "W1N1", x, y });
const store = (
  resources: Readonly<Record<string, number>>,
  freeCapacity: number | null = 100,
): StoreSnapshot => ({
  capacity:
    freeCapacity === null
      ? null
      : Object.values(resources).reduce((sum, amount) => sum + amount, 0) + freeCapacity,
  freeCapacity,
  resources: Object.entries(resources).map(([resourceType, amount]) => ({ resourceType, amount })),
  usedCapacity: Object.values(resources).reduce((sum, amount) => sum + amount, 0),
});

const structure = (
  id: string,
  structureType: string,
  contents: Readonly<Record<string, number>>,
  freeCapacity = 100,
): StoredStructureSnapshot => ({
  hits: 1_000,
  hitsMax: 1_000,
  id,
  ownerUsername: "me",
  ownership: "owned",
  pos: pos(20, 20),
  store: store(contents, freeCapacity),
  structureType,
});

const room = (overrides: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  constructionSites: [],
  controller: {
    id: "controller",
    level: 4,
    ownerUsername: "me",
    ownership: "owned",
    pos: pos(25, 25),
    progress: 1,
    progressTotal: 2,
    reservationTicksToEnd: null,
    reservationUsername: null,
    safeMode: null,
    safeModeAvailable: 1,
    safeModeCooldown: null,
    ticksToDowngrade: 10_000,
    upgradeBlocked: null,
  },
  energyAvailable: 0,
  energyCapacityAvailable: 300,
  droppedResources: [],
  hostileCreeps: [],
  name: "W1N1",
  observedAt: 100,
  ownedCreeps: [],
  ownedExtensions: [],
  ownedSpawns: [],
  ownedTowers: [],
  ruins: [],
  sources: [],
  storedStructures: [],
  tombstones: [],
  ...overrides,
});

describe("LogisticsObservation", () => {
  it("normalizes only fresh visible owned rooms into mandatory and stored flow nodes", () => {
    const result = observeLogistics({
      rooms: [
        room({
          ownedSpawns: [
            {
              active: true,
              hits: 5_000,
              hitsMax: 5_000,
              id: "spawn",
              name: "Spawn1",
              pos: pos(10, 10),
              spawning: null,
              store: store({ energy: 100 }, 200),
            },
          ],
          ownedTowers: [
            {
              hits: 3_000,
              hitsMax: 3_000,
              id: "tower",
              pos: pos(11, 10),
              store: store({ energy: 400 }, 600),
            },
          ],
          storedStructures: [
            structure("container", "container", { energy: 800 }),
            structure("storage", "storage", { energy: 2_000 }, 8_000),
          ],
        }),
      ],
      tick: 100,
    });
    expect(result.nodes.map(({ id, kind, priority }) => [id, kind, priority.class])).toEqual([
      ["container/container/energy", "source", "normal"],
      ["controller/W1N1/energy", "sink", "mandatory"],
      ["spawn/spawn/energy", "sink", "mandatory"],
      ["storage/storage/energy", "buffer", "normal"],
      ["tower/tower/energy", "sink", "mandatory"],
    ]);
  });

  it("fails closed for full, empty, unknown, and inactive stores", () => {
    const result = observeLogistics({
      rooms: [
        room({
          ownedExtensions: [
            {
              active: false,
              hits: 1_000,
              hitsMax: 1_000,
              id: "inactive",
              pos: pos(1, 1),
              store: store({}, 50),
            },
            {
              active: true,
              hits: 1_000,
              hitsMax: 1_000,
              id: "full",
              pos: pos(2, 1),
              store: store({ energy: 50 }, 0),
            },
            {
              active: true,
              hits: 1_000,
              hitsMax: 1_000,
              id: "unknown",
              pos: pos(3, 1),
              store: store({}, null),
            },
          ],
          storedStructures: [structure("empty", "container", {})],
        }),
      ],
      tick: 100,
    });
    expect(result.blockers.map(({ id, reason }) => [id, reason])).toEqual([
      ["container/empty", "empty-store"],
      ["extension/full/energy", "full-store"],
      ["extension/inactive/energy", "inactive-structure"],
      ["extension/unknown/energy", "unknown-capacity"],
    ]);
  });

  it("keeps dropped-resource identity stable while amount and freshness advance", () => {
    const first = observeLogistics({
      rooms: [
        room({
          droppedResources: [{ amount: 50, id: "drop-a", pos: pos(5, 5), resourceType: "energy" }],
        }),
      ],
      tick: 100,
    });
    const later = observeLogistics({
      rooms: [
        room({
          observedAt: 101,
          droppedResources: [{ amount: 25, id: "drop-a", pos: pos(5, 5), resourceType: "energy" }],
        }),
      ],
      tick: 101,
    });
    expect(first.nodes.find((node) => node.id.startsWith("drop/"))).toMatchObject({
      id: "drop/drop-a/energy",
      observedAmount: 50,
      observedAt: 100,
    });
    expect(later.nodes.find((node) => node.id.startsWith("drop/"))).toMatchObject({
      id: "drop/drop-a/energy",
      observedAmount: 25,
      observedAt: 101,
    });
  });

  it("preserves vanished and stale expected colonies as stable blockers", () => {
    const result = observeLogistics({
      rooms: [room({ observedAt: 99 })],
      tick: 100,
      expectedColonyIds: ["W2N2", "W1N1"],
    });
    expect(result.nodes).toEqual([]);
    expect(result.blockers).toEqual([
      { id: "room/W1N1", reason: "room-stale" },
      { id: "room/W2N2", reason: "room-unobserved" },
    ]);
  });

  it("retains mixed resources as independent observed source amounts", () => {
    const result = observeLogistics({
      rooms: [
        room({ tombstones: [{ id: "tomb", pos: pos(7, 7), store: store({ energy: 30, H: 12 }) }] }),
      ],
      tick: 100,
    });
    expect(
      result.nodes
        .filter((node) => node.id.startsWith("tombstone/"))
        .map(({ id, observedAmount }) => [id, observedAmount]),
    ).toEqual([
      ["tombstone/tomb/energy", 30],
      ["tombstone/tomb/H", 12],
    ]);
  });

  it("is byte-equivalent when structures and resources are reordered", () => {
    const structures = [
      structure("b", "container", { H: 5, energy: 20 }),
      structure("a", "terminal", { O: 7, energy: 10 }),
    ];
    const reordered = structures
      .map((item) => ({
        ...item,
        store: { ...item.store, resources: [...item.store.resources].reverse() },
      }))
      .reverse();
    expect(
      observeLogistics({ rooms: [room({ storedStructures: structures })], tick: 100 }),
    ).toEqual(observeLogistics({ rooms: [room({ storedStructures: reordered })], tick: 100 }));
  });

  it("caps normalized nodes and blockers before planner input", () => {
    const drops = Array.from(
      { length: MAX_LOGISTICS_NODES + MAX_LOGISTICS_OBSERVATION_BLOCKERS + 10 },
      (_, index) => ({
        amount: 1,
        id: `drop-${String(index).padStart(4, "0")}`,
        pos: pos(index % 50, Math.floor(index / 50)),
        resourceType: "energy" as const,
      }),
    );
    const result = observeLogistics({ rooms: [room({ droppedResources: drops })], tick: 100 });
    expect(result.nodes).toHaveLength(MAX_LOGISTICS_NODES);
    expect(result.blockers).toHaveLength(MAX_LOGISTICS_OBSERVATION_BLOCKERS);
    expect(result.blockers).toContainEqual({ id: "observation/blockers", reason: "blocker-cap" });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "terminalSend",
      "linkTransfer",
      "marketValue",
      "hostileSafety",
      "command",
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
