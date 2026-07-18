import type { RuntimeColonyDomainHealthInput } from "../../src/runtime/colony-domain-health";

const active = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({ active: true, id: `${prefix}-${String(index)}` }));

export function colonyDomainHealthFixture(tick = 500): RuntimeColonyDomainHealthInput {
  return {
    tick,
    enabledDomains: new Set([
      "layout",
      "mining",
      "logistics",
      "links",
      "maintenance",
      "resources",
      "labs",
      "industry",
    ] as const),
    rooms: [
      {
        name: "W1N1",
        observedAt: tick,
        controller: { level: 8, ownership: "owned" },
        sources: [{ id: "source-a" }, { id: "source-b" }],
        ownedSpawns: active(3, "spawn"),
        ownedExtensions: active(60, "extension"),
        ownedTowers: active(6, "tower"),
        ownedLinks: active(6, "link"),
        ownedLabs: active(10, "lab"),
      },
    ],
    layoutRecords: [
      {
        algorithmRevision: "owned-room-layout-v2-source-services",
        blockers: [],
        roomName: "W1N1",
        serviceBlockers: [],
      },
    ],
    miningProjections: [
      { blocker: null, colonyId: "W1N1", sourceId: "source-a" },
      { blocker: null, colonyId: "W1N1", sourceId: "source-b" },
    ],
    activeHarvestTargetIds: new Set(["source-a", "source-b"]),
    logisticsHealth: [{ colonyId: "W1N1", observedAt: tick, status: "healthy" }],
    linkHealth: [{ colonyId: "W1N1", observedAt: tick, status: "healthy" }],
    maintenanceHealth: [{ colonyId: "W1N1", observedAt: tick, status: "healthy" }],
    resources: [
      {
        extractorActive: true,
        hasMineral: true,
        hasStorage: true,
        hasTerminal: true,
        roomName: "W1N1",
      },
    ],
    labAssignments: [{ roomName: "W1N1" }],
    mature: {
      catalogAvailable: true,
      capabilities: ["factory", "nuker", "observer", "power-spawn"].map((kind) => ({
        active: true,
        kind,
        roomName: "W1N1",
      })),
      status: "ready",
    },
  };
}
