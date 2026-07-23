import { describe, expect, it } from "vitest";
import {
  minerCapability,
  planStaticMining,
  reconcileStaleSourceServiceContracts,
} from "../src/economy";
import { contractIdFor, requestSignature, type ContractPlanningView } from "../src/contracts";
import type { LayoutPlacement } from "../src/layout";
import type { WorldSnapshot } from "../src/world/snapshot";

const pos = (x: number, y: number) => ({ roomName: "W1N1", x, y });
const service = (
  sourceId: string,
  x: number,
  adoption: LayoutPlacement["adoption"] = "planned",
  issuerSequence?: number,
): LayoutPlacement => ({
  adoption,
  layer: "primary",
  minimumRcl: 2,
  pos: pos(x, 10),
  service: {
    ...(issuerSequence === undefined ? {} : { issuerSequence }),
    kind: "source-container",
    sourceId,
  },
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

  it("replaces one prior source position with the exact next mining sequence", () => {
    const predecessorRequest = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 11)]]]),
      snapshot: world(),
      tick: 10,
    }).requests[0];
    if (predecessorRequest === undefined) throw new Error("expected predecessor request");
    const predecessorId = contractIdFor(
      predecessorRequest.issuer,
      predecessorRequest.issuerKey,
      predecessorRequest.issuerSequence,
    );
    const predecessorExecution = predecessorRequest.execution;
    if (predecessorExecution === undefined) throw new Error("expected predecessor execution");
    const planning: ContractPlanningView = {
      status: "ready",
      contracts: [
        {
          budgetBinding: predecessorRequest.budgetBinding,
          contractId: predecessorId,
          execution: predecessorExecution,
          issuer: predecessorRequest.issuer,
          issuerSequence: 1,
          owner: predecessorRequest.owner,
          requestSignature: requestSignature(predecessorRequest),
          state: "active",
          targetId: "a",
        },
      ],
    };

    const result = planStaticMining({
      layouts: new Map([["W1N1", [service("a", 12, "exact", 2)]]]),
      planning,
      snapshot: world(),
      tick: 11,
    });
    const successor = result.replacements[0]?.successor;
    expect(result.requests).toEqual([]);
    expect(result.replacements).toEqual([
      {
        predecessorContractId: predecessorId,
        reason: "source-service-handoff",
        successor,
        tick: 11,
      },
    ]);
    expect(successor).toMatchObject({
      issuer: "mining/W1N1/a",
      issuerSequence: 2,
      execution: { version: 2, workPosition: pos(12, 10) },
    });
  });

  it.each(["proposed", "funded", "assigned", "active", "suspended"] as const)(
    "matches one settled stale source-service issuance in %s state",
    (state) => {
      const placement = service("a", 11, "exact", 2);
      const issuer = "mining/W1N1/a";
      const contractId = contractIdFor(issuer, "a", 2);
      const planning: ContractPlanningView = {
        status: "ready",
        contracts: [
          {
            budgetBinding: { category: "harvesting-filling", issuer },
            contractId,
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 2,
              workPosition: placement.pos,
            },
            issuer,
            issuerSequence: 2,
            owner: { id: "W1N1", kind: "colony" },
            requestSignature: canonicalRequestSignature(placement),
            state,
            targetId: "a",
          },
        ],
      };

      const result = reconcileStaleSourceServiceContracts({
        energyCapacityAvailable: 800,
        planning,
        roomName: "W1N1",
        sources: sourceSnapshots("a"),
        sourceServices: [placement],
      });

      expect(result).toEqual({ matchedContractIds: [contractId], status: "matched" });
      expect(
        reconcileStaleSourceServiceContracts({
          energyCapacityAvailable: 800,
          planning: JSON.parse(JSON.stringify(planning)) as ContractPlanningView,
          roomName: "W1N1",
          sources: sourceSnapshots("a"),
          sourceServices: [JSON.parse(JSON.stringify(placement)) as LayoutPlacement],
        }),
      ).toEqual(result);
    },
  );

  it("requires the complete stale service set after any explicit issuance", () => {
    const services = [service("a", 11, "exact", 2), service("b", 19, "exact")];
    const record = (placement: LayoutPlacement): ContractPlanningView["contracts"][number] => {
      const sourceId = placement.service?.sourceId;
      if (sourceId === undefined) throw new Error("expected source service");
      const issuerSequence = placement.service?.issuerSequence ?? 1;
      const issuer = `mining/W1N1/${sourceId}`;
      return {
        budgetBinding: { category: "harvesting-filling", issuer },
        contractId: contractIdFor(issuer, sourceId, issuerSequence),
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: null,
          resourceType: null,
          version: 2,
          workPosition: placement.pos,
        },
        issuer,
        issuerSequence,
        owner: { id: "W1N1", kind: "colony" },
        requestSignature: canonicalRequestSignature(placement),
        state: "active",
        targetId: sourceId,
      };
    };
    const contracts = services.map(record);
    const input = {
      energyCapacityAvailable: 800,
      roomName: "W1N1",
      sources: sourceSnapshots("a", "b"),
      sourceServices: services,
    } as const;

    expect(
      reconcileStaleSourceServiceContracts({
        ...input,
        planning: { contracts: contracts.slice(0, 1), status: "ready" },
      }),
    ).toEqual({ matchedContractIds: [], status: "blocked" });
    expect(
      reconcileStaleSourceServiceContracts({
        ...input,
        planning: { contracts: [...contracts].reverse(), status: "ready" },
        sources: [...input.sources].reverse(),
      }),
    ).toEqual({
      matchedContractIds: contracts.map(({ contractId }) => contractId).sort(),
      status: "matched",
    });
  });

  it.each([
    {
      name: "unavailable planning",
      update: (planning: ContractPlanningView) => ({ ...planning, status: "unavailable" as const }),
    },
    {
      name: "duplicate issuer",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: [
          ...planning.contracts,
          ...(planning.contracts[0] ? [planning.contracts[0]] : []),
        ],
      }),
    },
    {
      name: "wrong contract ID",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          contractId: "different-contract",
        })),
      }),
    },
    {
      name: "wrong sequence",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({ ...contract, issuerSequence: 1 })),
      }),
    },
    {
      name: "wrong source target",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({ ...contract, targetId: "b" })),
      }),
    },
    {
      name: "wrong budget binding",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          budgetBinding: { category: "optional-growth", issuer: contract.issuer },
        })),
      }),
    },
    {
      name: "wrong execution action",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          execution: {
            ...contract.execution,
            action: "build",
          } as ContractPlanningView["contracts"][number]["execution"],
        })),
      }),
    },
    {
      name: "wrong execution resource",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          execution: {
            ...contract.execution,
            resourceType: "energy",
          } as ContractPlanningView["contracts"][number]["execution"],
        })),
      }),
    },
    {
      name: "wrong execution version",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          execution: {
            action: "build" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 1 as const,
          },
        })),
      }),
    },
    {
      name: "wrong full request signature",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          requestSignature: `${contract.requestSignature ?? "missing"}:changed`,
        })),
      }),
    },
    {
      name: "wrong owner",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          owner: { id: "W2N2", kind: "colony" as const },
        })),
      }),
    },
    {
      name: "wrong work position",
      update: (planning: ContractPlanningView) => ({
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          execution: {
            action: "harvest" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 2 as const,
            workPosition: pos(12, 10),
          },
        })),
      }),
    },
  ])("blocks stale source-service reconciliation with $name", ({ update }) => {
    const placement = service("a", 11, "exact", 2);
    const issuer = "mining/W1N1/a";
    const planning: ContractPlanningView = {
      status: "ready",
      contracts: [
        {
          budgetBinding: { category: "harvesting-filling", issuer },
          contractId: contractIdFor(issuer, "a", 2),
          execution: {
            action: "harvest",
            completion: "continuous",
            counterpartId: null,
            resourceType: null,
            version: 2,
            workPosition: placement.pos,
          },
          issuer,
          issuerSequence: 2,
          owner: { id: "W1N1", kind: "colony" },
          requestSignature: canonicalRequestSignature(placement),
          state: "active",
          targetId: "a",
        },
      ],
    };

    expect(
      reconcileStaleSourceServiceContracts({
        energyCapacityAvailable: 800,
        planning: update(planning),
        roomName: "W1N1",
        sources: sourceSnapshots("a"),
        sourceServices: [placement],
      }),
    ).toEqual({ matchedContractIds: [], status: "blocked" });
  });

  it("blocks an explicit stale issuance whose source is no longer visible", () => {
    const placement = service("a", 11, "exact", 2);
    const issuer = "mining/W1N1/a";
    expect(
      reconcileStaleSourceServiceContracts({
        energyCapacityAvailable: 800,
        planning: {
          status: "ready",
          contracts: [
            {
              budgetBinding: { category: "harvesting-filling", issuer },
              contractId: contractIdFor(issuer, "a", 2),
              execution: {
                action: "harvest",
                completion: "continuous",
                counterpartId: null,
                resourceType: null,
                version: 2,
                workPosition: placement.pos,
              },
              issuer,
              issuerSequence: 2,
              owner: { id: "W1N1", kind: "colony" },
              state: "active",
              targetId: "a",
            },
          ],
        },
        roomName: "W1N1",
        sources: [],
        sourceServices: [placement],
      }),
    ).toEqual({ matchedContractIds: [], status: "blocked" });
  });

  it("does not require reconciliation without an explicit stale issuance", () => {
    expect(
      reconcileStaleSourceServiceContracts({
        energyCapacityAvailable: 800,
        planning: { contracts: [], status: "unavailable" },
        roomName: "W1N1",
        sources: sourceSnapshots("a"),
        sourceServices: [service("a", 11, "exact")],
      }),
    ).toEqual({ matchedContractIds: [], status: "not-required" });
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
    expect(Object.keys(result).sort()).toEqual([
      "projections",
      "replacements",
      "requests",
      "transitions",
    ]);
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

function canonicalRequestSignature(placement: LayoutPlacement): string {
  const sourceId = placement.service?.sourceId;
  if (sourceId === undefined) throw new Error("expected source service");
  const request = planStaticMining({
    layouts: new Map([["W1N1", [placement]]]),
    snapshot: world(),
    tick: 10,
  }).requests.find(({ issuerKey }) => issuerKey === sourceId);
  if (request === undefined) throw new Error(`expected static request for ${sourceId}`);
  return requestSignature(request);
}

function sourceSnapshots(...sourceIds: readonly string[]) {
  const room = world().rooms[0];
  if (room === undefined) throw new Error("expected room");
  const selected = new Set(sourceIds);
  return room.sources.filter(({ id }) => selected.has(id));
}

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
        issuerSequence: 1,
        owner: { id: "W1N1", kind: "colony" },
        requestSignature: canonicalRequestSignature(service("a", 11)),
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
