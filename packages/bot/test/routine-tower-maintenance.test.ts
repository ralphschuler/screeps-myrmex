import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { planRoutineTowerMaintenance } from "../src/defense";
import type { MaintenanceProposal } from "../src/maintenance";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("routine tower maintenance arbitration", () => {
  it("emits one maintenance-priority target per funded tower without duplicate overrepair", () => {
    const intents = planRoutineTowerMaintenance(world(), buildRuntimeConfig(), [
      proposal("a", 900),
      proposal("b", 800),
    ]);
    expect(intents.map(({ target }) => target)).toEqual(["a", "b"]);
    expect(
      intents.every(
        ({ exclusiveResourceKey, priority }) =>
          exclusiveResourceKey.startsWith("tower/") && priority.class === "maintenance",
      ),
    ).toBe(true);
  });

  it("preserves emergency reserve and suppresses routine work during attack or healing demand", () => {
    expect(
      planRoutineTowerMaintenance(world({ energy: 499 }), buildRuntimeConfig(), [
        proposal("a", 900),
      ]),
    ).toEqual([]);
    expect(
      planRoutineTowerMaintenance(world({ hostile: true }), buildRuntimeConfig(), [
        proposal("a", 900),
      ]),
    ).toEqual([]);
    expect(
      planRoutineTowerMaintenance(world({ injured: true }), buildRuntimeConfig(), [
        proposal("a", 900),
      ]),
    ).toEqual([]);
  });
});

function proposal(targetId: string, priority: number): MaintenanceProposal {
  return {
    energyCost: 1,
    id: targetId,
    layoutPlanned: true,
    priority,
    reason: "layout-asset-damage",
    roomName: "W1N1",
    structureClass: "road",
    targetHits: 1_000,
    targetId,
    targetPos: { roomName: "W1N1", x: 10, y: 10 },
    towerEligible: true,
    trafficScore: 0,
  };
}
function world(
  change: { energy?: number; hostile?: boolean; injured?: boolean } = {},
): WorldSnapshot {
  const store = {
    capacity: 1_000,
    freeCapacity: 1_000 - (change.energy ?? 800),
    resources: [{ amount: change.energy ?? 800, resourceType: "energy" }],
    usedCapacity: change.energy ?? 800,
  };
  const room = {
    controller: { ownership: "owned" },
    hostileCreeps: change.hostile ? [{}] : [],
    name: "W1N1",
    ownedCreeps: change.injured ? [{ hits: 50, hitsMax: 100 }] : [],
    ownedTowers: [
      {
        hits: 3_000,
        hitsMax: 3_000,
        id: "tower-a",
        pos: { roomName: "W1N1", x: 10, y: 10 },
        store,
      },
      {
        hits: 3_000,
        hitsMax: 3_000,
        id: "tower-b",
        pos: { roomName: "W1N1", x: 11, y: 10 },
        store,
      },
    ],
  };
  return {
    observation: { shard: "shard0", tick: 100 },
    observedAt: 100,
    rooms: [room],
    stats: { estimatedPayloadBytes: 1 },
  } as unknown as WorldSnapshot;
}
