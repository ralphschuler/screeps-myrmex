import { describe, expect, it } from "vitest";
import { projectColonyDomainHealth } from "../src/colony";
import { deriveRuntimeColonyDomainHealth } from "../src/runtime/colony-domain-health";
import { colonyDomainHealthFixture } from "./support/colony-domain-health-fixture";

const tick = 500;

describe("runtime colony domain health composition", () => {
  it("publishes healthy direct RCL8 status without reading telemetry", () => {
    const statuses = deriveRuntimeColonyDomainHealth(colonyDomainHealthFixture());
    const projection = projectColonyDomainHealth({ colonyId: "W1N1", statuses, tick });

    expect(projection).toMatchObject({ status: "healthy", blocker: null });
    expect(statuses).toHaveLength(8);
  });

  it("fails the owning domains when required structure or current work evidence disappears", () => {
    const baseline = colonyDomainHealthFixture();
    const statuses = deriveRuntimeColonyDomainHealth({
      ...baseline,
      activeHarvestTargetIds: new Set(["source-a"]),
      linkHealth: [{ colonyId: "W1N1", observedAt: tick, status: "failed" as const }],
    });

    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "mining", status: "failed" }),
        expect.objectContaining({ domain: "links", status: "failed" }),
      ]),
    );
    expect(projectColonyDomainHealth({ colonyId: "W1N1", statuses, tick })).toMatchObject({
      status: "blocked",
      blocker: { domain: "mining", reasonCode: "failed" },
    });
  });

  it("isolates a maintenance cap failure to its owning room", () => {
    const baseline = colonyDomainHealthFixture();
    const firstRoom = baseline.rooms[0];
    const firstLayout = baseline.layoutRecords[0];
    const firstResource = baseline.resources[0];
    if (firstRoom === undefined || firstLayout === undefined || firstResource === undefined) {
      throw new Error("health fixture room inputs missing");
    }
    const secondRoom = {
      ...firstRoom,
      name: "W2N2",
      sources: [{ id: "source-c" }, { id: "source-d" }],
    };
    const statuses = deriveRuntimeColonyDomainHealth({
      ...baseline,
      rooms: [firstRoom, secondRoom],
      layoutRecords: [...baseline.layoutRecords, { ...firstLayout, roomName: "W2N2" }],
      miningProjections: [
        ...baseline.miningProjections,
        { blocker: null, colonyId: "W2N2", sourceId: "source-c" },
        { blocker: null, colonyId: "W2N2", sourceId: "source-d" },
      ],
      activeHarvestTargetIds: new Set(["source-a", "source-b", "source-c", "source-d"]),
      logisticsHealth: [
        ...baseline.logisticsHealth,
        { colonyId: "W2N2", observedAt: tick, status: "healthy" as const },
      ],
      linkHealth: [
        ...baseline.linkHealth,
        { colonyId: "W2N2", observedAt: tick, status: "healthy" as const },
      ],
      maintenanceHealth: [
        { colonyId: "W1N1", observedAt: tick, status: "failed" },
        { colonyId: "W2N2", observedAt: tick, status: "healthy" },
      ],
      resources: [...baseline.resources, { ...firstResource, roomName: "W2N2" }],
      labAssignments: [...baseline.labAssignments, { roomName: "W2N2" }],
      mature: {
        ...baseline.mature,
        capabilities: [
          ...baseline.mature.capabilities,
          ...baseline.mature.capabilities.map((capability) => ({
            ...capability,
            roomName: "W2N2",
          })),
        ],
      },
    });

    expect(statuses.filter(({ domain }) => domain === "maintenance")).toEqual([
      { colonyId: "W1N1", domain: "maintenance", observedAt: tick, status: "failed" },
      { colonyId: "W2N2", domain: "maintenance", observedAt: tick, status: "healthy" },
    ]);
  });

  it("is canonical across room, projection, and capability reordering", () => {
    const original = deriveRuntimeColonyDomainHealth(colonyDomainHealthFixture());
    const reversed = colonyDomainHealthFixture();
    const result = deriveRuntimeColonyDomainHealth({
      ...reversed,
      labAssignments: [...reversed.labAssignments].reverse(),
      linkHealth: [...reversed.linkHealth].reverse(),
      logisticsHealth: [...reversed.logisticsHealth].reverse(),
      miningProjections: [...reversed.miningProjections].reverse(),
      mature: {
        ...reversed.mature,
        capabilities: [...reversed.mature.capabilities].reverse(),
      },
      rooms: [...reversed.rooms].reverse(),
    });

    expect(JSON.stringify(result)).toBe(JSON.stringify(original));
  });
});
