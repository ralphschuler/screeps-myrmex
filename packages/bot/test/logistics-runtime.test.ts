import { describe, expect, it } from "vitest";
import { planLeaseAgents } from "../src/agents";
import {
  emptyContractExecutionView,
  emptyContractPlanningView,
  type ContractExecutionView,
} from "../src/contracts";
import { assignLabCluster, fingerprintLabLayout } from "../src/industry";
import {
  layoutExtensionEvacuationBudgetIssuer,
  layoutExtensionEvacuationFlowId,
  layoutLabEvacuationBudgetIssuer,
  layoutLabEvacuationFlowIds,
  layoutLinkEvacuationBudgetIssuer,
  layoutLinkEvacuationFlowId,
  layoutTowerEvacuationBudgetIssuer,
  layoutTowerEvacuationFlowId,
  type LayoutRecord,
} from "../src/layout";
import {
  completeExecutableLayoutContainerMigrationFlowIds,
  completedLayoutContainerMigrationRoomNames,
  projectLayoutContainerMigrations,
  projectLayoutContainerMigrationSuppression,
} from "../src/logistics/container-migration";
import {
  completedLayoutExtensionEvacuationRoomNames,
  projectLayoutExtensionEvacuations,
} from "../src/logistics/extension-evacuation";
import {
  completeExecutableLayoutLabEvacuationFlowIds,
  projectLayoutLabEvacuations,
} from "../src/logistics/lab-evacuation";
import {
  authorizeLayoutLinkEvacuationFlowIds,
  completedLayoutLinkEvacuationRoomNames,
  projectLayoutLinkEvacuations,
  projectLayoutLinkEvacuationSuppressedSinkTargetIds,
} from "../src/logistics/link-evacuation";
import {
  currentlyExecutableLogisticsFlowIds,
  executableLogisticsView,
  logisticsAcquireAdmissionLimits,
  observeLogisticsGraph,
  planLogisticsRuntime,
} from "../src/logistics/runtime";
import {
  completedLayoutTowerEvacuationRoomNames,
  projectLayoutTowerEvacuations,
  projectLayoutTowerEvacuationSuppressedSinkTargetIds,
} from "../src/logistics/tower-evacuation";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("logistics runtime adapter", () => {
  it("fails closed without contract prerequisites and suppresses optional sinks under pressure", () => {
    const snapshot = world();
    const unavailable = planLogisticsRuntime({
      execution: emptyContractExecutionView(),
      includeOptional: true,
      planning: emptyContractPlanningView(),
      snapshot,
      tick: 10,
    });
    expect(unavailable.contracts.commitments).toEqual([]);
    expect(unavailable.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "failed" }]);

    const constrained = observeLogisticsGraph(snapshot, false);
    expect(constrained.nodes.some(({ id }) => id === "store:storage:sink:energy")).toBe(false);
    expect(constrained.nodes.some(({ id }) => id === "store:spawn:sink:energy")).toBe(true);
  });

  it("drops an oversized optional demand batch before it can displace observed logistics", () => {
    const snapshot = world();
    const observed = observeLogisticsGraph(snapshot, true);
    const optionalNodes = Array.from({ length: 128 }, (_, index) => ({
      colonyId: "W1N1",
      freeCapacity: 0,
      id: `a:optional:${String(index).padStart(3, "0")}`,
      kind: "source" as const,
      observedAmount: 1,
      observedAt: 10,
      position: position(1, 1),
      priority: { class: "normal" as const, deadline: 20 },
      resourceType: "energy",
    }));
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: { edges: [], endpoints: [], nodes: optionalNodes },
      snapshot,
      tick: 10,
    });

    expect(result.graph).toEqual(observed);
    expect(result.plan.blockers.some(({ reason }) => reason === "node-cap")).toBe(false);
  });

  it("removes a retiring stale logistics lease before agent planning", () => {
    const execution = {
      leases: [
        { contractId: "retiring", execution: { flowId: "blocked", version: 3 } },
        { contractId: "retained", execution: { flowId: "retained", version: 3 } },
      ],
      status: "ready",
    } as unknown as ContractExecutionView;

    expect(
      executableLogisticsView(execution, new Set(["blocked"])).leases.map(
        ({ contractId }) => contractId,
      ),
    ).toEqual(["retained"]);
  });

  it("caps an acquire lease to fresh admitted stock without changing delivery", () => {
    const execution = {
      leases: [
        {
          contractId: "acquire",
          execution: { flowId: "flow", reservedAmount: 1_000, stage: "acquire", version: 3 },
          quantity: 1_000,
        },
        {
          contractId: "deliver",
          execution: { flowId: "flow", reservedAmount: 1_000, stage: "deliver", version: 3 },
          quantity: 1_000,
        },
      ],
      status: "ready",
    } as unknown as ContractExecutionView;

    expect(executableLogisticsView(execution, new Set(), new Map([["flow", 500]]))).toMatchObject({
      leases: [
        {
          contractId: "acquire",
          execution: { reservedAmount: 500, stage: "acquire" },
          quantity: 500,
        },
        {
          contractId: "deliver",
          execution: { reservedAmount: 1_000, stage: "deliver" },
          quantity: 1_000,
        },
      ],
    });
    expect(executableLogisticsView(execution, new Set(), new Map([["flow", 0]]))).toMatchObject({
      leases: [expect.objectContaining({ contractId: "deliver" })],
    });
  });

  it("defaults every current acquire lease to zero before overlaying fresh admission", () => {
    const execution = {
      leases: [
        { execution: { flowId: "acquire-flow", stage: "acquire", version: 3 } },
        { execution: { flowId: "deliver-only", stage: "deliver", version: 3 } },
      ],
      status: "ready",
    } as unknown as ContractExecutionView;

    for (const projections of [[], [{ admittedAmount: 0, id: "acquire-flow" }]]) {
      expect(logisticsAcquireAdmissionLimits(execution, { plan: { projections } })).toEqual(
        new Map([["acquire-flow", 0]]),
      );
    }
    expect(
      logisticsAcquireAdmissionLimits(execution, {
        plan: { projections: [{ admittedAmount: 500, id: "acquire-flow" }] },
      }),
    ).toEqual(new Map([["acquire-flow", 500]]));
  });

  it("normalizes dropped, tombstone, ruin, and stored sources for one runtime graph", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new TypeError("logistics fixture room is missing");
    const graph = observeLogisticsGraph(
      {
        ...snapshot,
        rooms: [
          {
            ...room,
            droppedResources: [
              {
                amount: 50,
                id: "drop-a",
                pos: { roomName: "W1N1", x: 9, y: 10 },
                resourceType: "energy",
              },
            ],
            ruins: [
              {
                id: "ruin-a",
                pos: { roomName: "W1N1", x: 8, y: 10 },
                store: {
                  capacity: null,
                  freeCapacity: null,
                  resources: [{ amount: 25, resourceType: "H" }],
                  usedCapacity: 25,
                },
              },
            ],
            tombstones: [
              {
                id: "tomb-a",
                pos: { roomName: "W1N1", x: 7, y: 10 },
                store: {
                  capacity: null,
                  freeCapacity: null,
                  resources: [{ amount: 30, resourceType: "energy" }],
                  usedCapacity: 30,
                },
              },
            ],
          },
        ],
      },
      true,
    );
    expect(graph.nodes.some(({ id }) => id.startsWith("drop:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("ruin:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("tombstone:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("store:container:source:"))).toBe(true);
  });

  it("leaves loose-resource recovery with bootstrap fallback until a dedicated hauler exists", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new TypeError("logistics fixture room is missing");
    const graph = observeLogisticsGraph(
      {
        ...snapshot,
        rooms: [
          {
            ...room,
            droppedResources: [
              {
                amount: 50,
                id: "drop-a",
                pos: { roomName: "W1N1", x: 9, y: 10 },
                resourceType: "energy",
              },
            ],
            ownedCreeps: [],
          },
        ],
      },
      true,
    );
    expect(graph.nodes.some(({ id }) => id.startsWith("drop:"))).toBe(false);
    expect(graph.nodes.some(({ id }) => id.startsWith("store:container:source:"))).toBe(true);
  });

  it("projects one mandatory reservation-backed haul without duplicate flow identities", () => {
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(),
      tick: 10,
    });
    const active = result.contracts.commitments.filter(({ request }) => request !== null);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ priorityClass: "mandatory", stage: "acquire" });
    expect(active[0]?.request).toMatchObject({
      execution: { action: "withdraw", stage: "acquire", version: 3 },
      kind: "haul",
      quantity: 200,
    });
    expect(result.budgets).toEqual([
      expect.objectContaining({
        category: "harvesting-filling",
        cpu: { minimum: 100, desired: 100 },
        energy: null,
      }),
    ]);
    expect(new Set(active.map(({ flowId }) => flowId)).size).toBe(active.length);
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "healthy" }]);
  });

  it("reports duplicate or capped graph evidence through direct room health", () => {
    const snapshot = world();
    const observed = observeLogisticsGraph(snapshot, true);
    const duplicate = observed.nodes[0];
    if (duplicate === undefined) throw new Error("logistics health fixture node missing");
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: {
        blockers: [],
        dispositions: [],
        edges: [],
        endpoints: [],
        nodes: [duplicate],
      },
      snapshot,
      tick: 10,
    });

    expect(result.plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "duplicate-id" })]),
    );
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "failed" }]);
  });

  it("retains operational funding while constrained planning preempts optional reserve use", () => {
    const normal = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(0, 250),
      tick: 10,
    });
    expect(normal.budgets.map(({ category }) => category).sort()).toEqual([
      "harvesting-filling",
      "optional-growth",
    ]);
    expect(normal.budgets.every(({ energy }) => energy === null)).toBe(true);
    expect(
      normal.budgets.find(({ category }) => category === "harvesting-filling")?.cpu?.minimum,
    ).toBe(100);

    const constrained = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(0, 250),
      tick: 10,
    });
    expect(constrained.budgets.map(({ category }) => category)).toEqual(["harvesting-filling"]);
  });

  it("composes externally funded lab demand without creating a second budget", () => {
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: {
        blockers: [],
        dispositions: [],
        edges: [
          {
            budgetBinding: { category: "industry", issuer: "industry/labs/U" },
            id: "lab-demand:u:r1:fill:U",
            maximumAmount: 100,
            roundTripTicks: 10,
            sinkNodeId: "lab:W1N1:lab-a:mineral:U",
            sourceNodeId: "inventory:W1N1:storage:U",
          },
        ],
        endpoints: [
          {
            acquireAction: "withdraw",
            freeCapacity: 0,
            nodeId: "inventory:W1N1:storage:U",
            observedAmount: 100,
            observedAt: 10,
            position: position(15, 15),
            resourceType: "U",
            targetId: "storage",
          },
          {
            freeCapacity: 3_000,
            nodeId: "lab:W1N1:lab-a:mineral:U",
            observedAmount: 0,
            observedAt: 10,
            position: position(14, 15),
            resourceType: "U",
            targetId: "lab-a",
          },
        ],
        nodes: [
          {
            colonyId: "W1N1",
            freeCapacity: 0,
            id: "inventory:W1N1:storage:U",
            kind: "source",
            observedAmount: 100,
            observedAt: 10,
            position: position(15, 15),
            priority: { class: "normal", deadline: 50 },
            resourceType: "U",
          },
          {
            capacityReservationKey: "lab:W1N1:lab-a:mineral-capacity",
            colonyId: "W1N1",
            freeCapacity: 3_000,
            id: "lab:W1N1:lab-a:mineral:U",
            kind: "sink",
            observedAmount: 0,
            observedAt: 10,
            position: position(14, 15),
            priority: { class: "normal", deadline: 50 },
            resourceType: "U",
          },
        ],
      },
      snapshot: world(),
      tick: 10,
    });

    const lab = result.contracts.commitments.find(({ flowId }) => flowId.startsWith("lab-demand:"));
    expect(lab?.request?.budgetBinding).toEqual({
      category: "industry",
      issuer: "industry/labs/U",
    });
    expect(result.budgets.some(({ category }) => category === "industry")).toBe(false);
  });

  it("routes one persisted obsolete-extension evacuation without refilling its source", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("extension evacuation fixture room missing");
    const extension = (id: string, x: number, used: number) => ({
      active: true,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: position(x, 12),
      store: {
        capacity: 50,
        freeCapacity: 50 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
    });
    const evacuationWorld = {
      ...snapshot,
      rooms: [
        {
          ...room,
          ownedExtensions: [
            extension("extension-obsolete", 11, 40),
            extension("extension-replacement", 12, 0),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const evacuationTerms = {
      amount: 40,
      expiresAt: 160,
      replacementId: "extension-replacement",
      replacementInitialEnergy: 0,
      sourceId: "extension-obsolete",
      startedAt: 10,
    } as const;
    const budgetIssuer = layoutExtensionEvacuationBudgetIssuer("W1N1", evacuationTerms);
    if (budgetIssuer === null) throw new Error("extension evacuation budget issuer overflowed");
    const evacuation = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: evacuationWorld,
      tick: 10,
    });
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: evacuation.demands,
      snapshot: evacuationWorld,
      tick: 10,
    });
    const flow = result.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-extension-evacuation:"),
    );

    expect(evacuation.budgets).toEqual([
      expect.objectContaining({
        category: "optional-growth",
        issuer: budgetIssuer,
      }),
    ]);
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:extension-obsolete:sink:energy" }),
    );
    expect(flow?.request).toMatchObject({
      budgetBinding: {
        category: "optional-growth",
        issuer: budgetIssuer,
      },
      execution: {
        action: "withdraw",
        counterpartId: "extension-replacement",
      },
      quantity: 40,
      targetId: "extension-obsolete",
    });
    expect(result.budgets.some(({ issuer }) => issuer === budgetIssuer)).toBe(false);

    const driftedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          ownedExtensions: [
            extension("extension-obsolete", 11, 40),
            extension("extension-replacement", 12, 1),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const drifted = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: driftedWorld,
      tick: 10,
    });
    expect(drifted.budgets).toEqual([]);
    expect(drifted.demands.edges).toEqual([]);
    expect(drifted.demands.suppressedSinkTargetIds).toEqual([
      "extension-obsolete",
      "extension-replacement",
    ]);

    const threatenedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          hostileCreeps: [
            {
              id: "hostile-a",
            } as unknown as WorldSnapshot["rooms"][number]["hostileCreeps"][number],
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const threatened = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: threatenedWorld,
      tick: 10,
    });
    expect(threatened.budgets).toEqual([]);
    expect(threatened.demands.edges).toEqual([]);
    expect(threatened.demands.suppressedSinkTargetIds).toEqual([
      "extension-obsolete",
      "extension-replacement",
    ]);

    const emptiedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          ownedExtensions: [
            extension("extension-obsolete", 11, 0),
            extension("extension-replacement", 12, 0),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const emptied = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: emptiedWorld,
      tick: 10,
    });
    const emptiedResult = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: emptied.demands,
      snapshot: emptiedWorld,
      tick: 10,
    });
    expect(emptiedResult.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:extension-obsolete:sink:energy" }),
    );
    expect(emptiedResult.graph.nodes).toContainEqual(
      expect.objectContaining({ id: "store:extension-replacement:sink:energy" }),
    );

    const deliveredWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          observedAt: 11,
          ownedExtensions: [
            extension("extension-obsolete", 11, 0),
            extension("extension-replacement", 12, 40),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const deliveredRoom = deliveredWorld.rooms[0];
    if (deliveredRoom === undefined) throw new Error("delivered extension room missing");
    const staleRecord = {
      algorithmRevision: "owned-room-layout-v1",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      extensionEvacuation: evacuationTerms,
      fingerprint: "layout-stale",
      roomName: "W1N1",
      transform: 0,
    } as const;
    const completion = (
      overrides: {
        readonly activeFlowIds?: ReadonlySet<string>;
        readonly activeTargetIds?: ReadonlySet<string>;
        readonly snapshot?: WorldSnapshot;
        readonly tick?: number;
      } = {},
    ) =>
      completedLayoutExtensionEvacuationRoomNames({
        activeFlowIds: overrides.activeFlowIds ?? new Set(),
        activeTargetIds: overrides.activeTargetIds ?? new Set(),
        records: [staleRecord],
        snapshot: overrides.snapshot ?? deliveredWorld,
        tick: overrides.tick ?? 11,
      });

    expect(completion()).toEqual(["W1N1"]);
    expect(
      completedLayoutExtensionEvacuationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        records: [staleRecord],
        snapshot: {
          ...deliveredWorld,
          rooms: [
            {
              ...deliveredRoom,
              ownedExtensions: [...deliveredRoom.ownedExtensions].reverse(),
            },
          ],
        },
        tick: 11,
      }),
    ).toEqual(["W1N1"]);
    expect(
      completion({
        activeFlowIds: new Set([layoutExtensionEvacuationFlowId("W1N1", evacuationTerms)]),
      }),
    ).toEqual([]);
    expect(completion({ activeTargetIds: new Set(["extension-obsolete"]) })).toEqual([]);
    expect(completion({ activeTargetIds: new Set(["extension-replacement"]) })).toEqual([]);
    expect(completion({ tick: evacuationTerms.expiresAt })).toEqual([]);
    expect(
      completion({
        snapshot: {
          ...deliveredWorld,
          rooms: [
            {
              ...deliveredRoom,
              ownedExtensions: [
                extension("extension-obsolete", 11, 1),
                extension("extension-replacement", 12, 40),
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      completion({
        snapshot: {
          ...deliveredWorld,
          rooms: [
            {
              ...deliveredRoom,
              ownedExtensions: [
                extension("extension-obsolete", 11, 0),
                extension("extension-replacement", 12, 39),
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      completion({
        snapshot: {
          ...deliveredWorld,
          rooms: [
            {
              ...deliveredRoom,
              ownedExtensions: [
                extension("extension-obsolete", 11, 0),
                extension("extension-replacement", 12, 41),
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      completedLayoutExtensionEvacuationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        records: Array.from({ length: 65 }, () => staleRecord),
        snapshot: deliveredWorld,
        tick: 11,
      }),
    ).toEqual([]);
    expect(
      completion({
        snapshot: {
          ...deliveredWorld,
          rooms: [
            {
              ...deliveredRoom,
              hostileCreeps: [
                {
                  id: "hostile-a",
                } as unknown as WorldSnapshot["rooms"][number]["hostileCreeps"][number],
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("routes authorized energy and mineral obsolete-lab evacuation through the sole logistics graph", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("lab evacuation fixture room missing");
    const lab = (id: string, x: number, y: number, energy: number) => ({
      active: true,
      cooldown: 0,
      energy,
      energyCapacity: 2_000,
      hits: 500,
      hitsMax: 500,
      id,
      mineralAmount: 0,
      mineralCapacity: 3_000,
      mineralType: null,
      pos: position(x, y),
      store: {
        capacity: null,
        freeCapacity: null,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
    });
    const exactPositions = [
      [10, 10],
      [11, 10],
      [12, 10],
      [10, 11],
      [11, 11],
      [12, 11],
      [10, 12],
      [11, 12],
      [12, 12],
    ] as const;
    const emptyExactLabs = exactPositions.map(([x, y], index) =>
      lab(`lab-exact-${String(index)}`, x, y, 0),
    );
    const limits = { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 };
    const exactAssignment = assignLabCluster({
      labs: emptyExactLabs,
      layoutFingerprint: fingerprintLabLayout("W1N1", emptyExactLabs),
      limits,
      roomName: "W1N1",
    }).assignment;
    if (exactAssignment === null) throw new Error("expected exact lab assignment");
    const replacementId = [
      ...exactAssignment.reagentLabIds,
      ...exactAssignment.productLabIds,
      ...exactAssignment.boostLabIds,
    ].sort()[0];
    if (replacementId === undefined) throw new Error("expected assigned replacement lab");
    const ownedLabs = [
      ...emptyExactLabs.map((value) =>
        value.id === replacementId ? lab(value.id, value.pos.x, value.pos.y, 250) : value,
      ),
      lab("lab-obsolete", 30, 30, 750),
    ];
    const assignment = assignLabCluster({
      labs: ownedLabs,
      layoutFingerprint: fingerprintLabLayout("W1N1", ownedLabs),
      limits,
      roomName: "W1N1",
    }).assignment;
    if (assignment === null) throw new Error("expected current lab assignment");
    expect([
      ...assignment.reagentLabIds,
      ...assignment.productLabIds,
      ...assignment.boostLabIds,
    ]).not.toContain("lab-obsolete");
    const evacuationWorld = {
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      rooms: [
        {
          ...room,
          observedAt: 11,
          ownedLabs,
          storedStructures: [
            ...room.storedStructures,
            ...ownedLabs.map((value) => ({
              hits: value.hits,
              hitsMax: value.hitsMax,
              id: value.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: value.pos,
              store: value.store,
              structureType: "lab",
              ticksToDecay: null,
            })),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const terms = {
      amount: 750,
      expiresAt: 160,
      replacementId,
      replacementInitialEnergy: 250,
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    const budgetIssuer = layoutLabEvacuationBudgetIssuer("W1N1", terms);
    if (budgetIssuer === null) throw new Error("lab evacuation budget issuer overflowed");
    const record = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-a",
      labEvacuation: terms,
      roomName: "W1N1",
      transform: 0,
    } as const satisfies LayoutRecord;
    const migrationRooms = [
      {
        activity: [],
        assignment,
        evacuationStorageId: null,
        limits,
        observedAt: 11,
        quiescent: true,
        roomName: "W1N1",
      },
    ] as const;
    const evacuation = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms,
      records: [record],
      snapshot: evacuationWorld,
      tick: 11,
    });
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: evacuation.demands,
      snapshot: evacuationWorld,
      tick: 11,
    });
    const flow = result.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-lab-evacuation:"),
    );
    if (flow === undefined) throw new Error("expected admitted lab evacuation commitment");
    const blockedFlowId = `${flow.flowId}:blocked`;
    const authorizationProjection = {
      ...result,
      contracts: {
        ...result.contracts,
        commitments: [
          ...result.contracts.commitments,
          { ...flow, flowId: blockedFlowId, request: null },
        ],
      },
    };

    expect([
      ...currentlyExecutableLogisticsFlowIds(
        new Set([flow.flowId, blockedFlowId]),
        authorizationProjection,
      ),
    ]).toEqual([flow.flowId]);
    expect(evacuation.authorizedFlowIds).toEqual([
      `layout-lab-evacuation:W1N1:lab-obsolete:${replacementId}`,
    ]);
    expect(evacuation.budgets).toEqual([
      expect.objectContaining({ category: "optional-growth", issuer: budgetIssuer }),
    ]);
    expect(evacuation.demands).toMatchObject({
      suppressedSinkTargetIds: ["lab-obsolete", replacementId],
      suppressedSourceTargetIds: ["lab-obsolete", replacementId],
    });
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:lab-obsolete:source:energy" }),
    );
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: `store:${replacementId}:source:energy` }),
    );
    expect(flow.request).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer: budgetIssuer },
      execution: { action: "withdraw", counterpartId: replacementId },
      quantity: 750,
      targetId: "lab-obsolete",
    });

    const mineralLabs = ownedLabs.map((value) =>
      value.id === "lab-obsolete"
        ? {
            ...value,
            energy: 0,
            mineralAmount: 750,
            mineralType: "XGH2O",
            store: {
              ...value.store,
              resources: [{ amount: 750, resourceType: "XGH2O" }],
              usedCapacity: 750,
            },
          }
        : value,
    );
    const storage = {
      active: true,
      hits: 10_000,
      hitsMax: 10_000,
      id: "storage",
      pos: position(20, 20),
      store: {
        capacity: 1_000_000,
        freeCapacity: 800,
        resources: [
          { amount: 998_200, resourceType: "energy" },
          { amount: 1_000, resourceType: "XGH2O" },
        ],
        usedCapacity: 999_200,
      },
    } as const;
    const mineralRoom = evacuationWorld.rooms[0];
    if (mineralRoom === undefined) throw new Error("mineral evacuation fixture room missing");
    const labIds = new Set(mineralLabs.map(({ id }) => id));
    const mineralWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...mineralRoom,
          ownedLabs: mineralLabs,
          ownedSpawns: mineralRoom.ownedSpawns.map((spawn) => ({
            ...spawn,
            store: {
              capacity: 300,
              freeCapacity: 0,
              resources: [{ amount: 300, resourceType: "energy" }],
              usedCapacity: 300,
            },
          })),
          ownedStorages: [storage],
          storedStructures: [
            ...mineralRoom.storedStructures.filter(
              ({ id }) => id !== storage.id && !labIds.has(id),
            ),
            ...mineralLabs.map((value) => ({
              hits: value.hits,
              hitsMax: value.hitsMax,
              id: value.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: value.pos,
              store: value.store,
              structureType: "lab",
              ticksToDecay: null,
            })),
            {
              hits: storage.hits,
              hitsMax: storage.hitsMax,
              id: storage.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: storage.pos,
              store: storage.store,
              structureType: "storage",
              ticksToDecay: null,
            },
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const mineralTerms = {
      amount: 750,
      destinationId: storage.id,
      destinationInitialAmount: 1_000,
      expiresAt: 160,
      replacementId,
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    const mineralRecord = {
      ...record,
      labEvacuation: mineralTerms,
    } as const satisfies LayoutRecord;
    const mineralProjection = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms: [{ ...migrationRooms[0], evacuationStorageId: storage.id }],
      records: [mineralRecord],
      snapshot: mineralWorld,
      tick: 11,
    });
    const mineralRuntime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: mineralProjection.demands,
      snapshot: mineralWorld,
      tick: 11,
    });
    const mineralFlow = mineralRuntime.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-lab-evacuation:"),
    );
    expect(mineralProjection.demands).toMatchObject({
      suppressedSinkTargetIds: ["lab-obsolete"],
      suppressedSourceTargetIds: ["lab-obsolete"],
    });
    expect(mineralFlow?.request).toMatchObject({
      budgetBinding: { category: "optional-growth" },
      execution: {
        action: "withdraw",
        counterpartId: storage.id,
        resourceType: "XGH2O",
        version: 3,
      },
      targetId: "lab-obsolete",
    });
    const storageSinkNodeIds = new Set(
      mineralRuntime.graph.endpoints
        .filter(({ targetId }) => targetId === storage.id)
        .map(({ nodeId }) => nodeId),
    );
    expect(
      mineralRuntime.plan.projections
        .filter(({ sinkNodeId }) => storageSinkNodeIds.has(sinkNodeId))
        .reduce((total, { admittedAmount }) => total + admittedAmount, 0),
    ).toBe(storage.store.freeCapacity);
    expect(mineralRuntime.plan.reservations).toContainEqual({
      nodeId: "store-capacity/4:W1N1/7:storage",
      sinkCapacity: storage.store.freeCapacity,
      sourceAmount: 0,
    });

    const mixedLabs = mineralLabs.map((value) =>
      value.id === "lab-obsolete"
        ? {
            ...value,
            energy: 500,
            store: {
              ...value.store,
              resources: [
                { amount: 500, resourceType: "energy" },
                { amount: 750, resourceType: "XGH2O" },
              ],
              usedCapacity: 1_250,
            },
          }
        : value,
    );
    const mixedRoom = mineralWorld.rooms[0];
    if (mixedRoom === undefined) throw new Error("mixed evacuation fixture room missing");
    const mixedWorld = {
      ...mineralWorld,
      rooms: [
        {
          ...mixedRoom,
          ownedLabs: mixedLabs,
          storedStructures: [
            ...mixedRoom.storedStructures.filter(({ id }) => !labIds.has(id)),
            ...mixedLabs.map((value) => ({
              hits: value.hits,
              hitsMax: value.hitsMax,
              id: value.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: value.pos,
              store: value.store,
              structureType: "lab",
              ticksToDecay: null,
            })),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const mixedTerms = {
      destinationId: storage.id,
      destinationInitialAmount: 1_000,
      energyAmount: 500,
      expiresAt: 160,
      mineralAmount: 750,
      replacementId,
      replacementInitialEnergy: 250,
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    const mixedFlowIds = layoutLabEvacuationFlowIds("W1N1", mixedTerms);
    if (mixedFlowIds === null) throw new Error("mixed lab flow identities overflowed");
    const mixedRecord = { ...record, labEvacuation: mixedTerms } as const satisfies LayoutRecord;
    const mixedProjection = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms: [{ ...migrationRooms[0], evacuationStorageId: storage.id }],
      records: [mixedRecord],
      snapshot: mixedWorld,
      tick: 11,
    });
    expect(mixedProjection.authorizedFlowIds).toEqual(mixedFlowIds);
    expect([
      ...completeExecutableLayoutLabEvacuationFlowIds({
        executableFlowIds: new Set([mixedFlowIds[0] ?? ""]),
        projectedFlowIds: new Set(mixedFlowIds),
        records: [mixedRecord],
      }),
    ]).toEqual([]);
    expect([
      ...completeExecutableLayoutLabEvacuationFlowIds({
        executableFlowIds: new Set(mixedFlowIds),
        projectedFlowIds: new Set(mixedFlowIds),
        records: [mixedRecord],
      }),
    ]).toEqual(mixedFlowIds);
    expect(mixedProjection.budgets).toHaveLength(2);
    expect(mixedProjection.demands.edges).toEqual([
      expect.objectContaining({ id: mixedFlowIds[0], maximumAmount: 500 }),
      expect.objectContaining({ id: mixedFlowIds[1], maximumAmount: 750 }),
    ]);
    expect(mixedProjection.demands).toMatchObject({
      suppressedSinkTargetIds: ["lab-obsolete", replacementId],
      suppressedSourceTargetIds: ["lab-obsolete", replacementId],
    });

    const emptiedSourceLabs = mixedLabs.map((value) =>
      value.id === "lab-obsolete"
        ? {
            ...value,
            energy: 0,
            mineralAmount: 0,
            mineralType: null,
            store: { ...value.store, resources: [], usedCapacity: 0 },
          }
        : value,
    );
    const emptiedSourceRoom = mixedWorld.rooms[0];
    if (emptiedSourceRoom === undefined) throw new Error("empty mixed source fixture missing");
    const emptiedSourceWorld = {
      ...mixedWorld,
      rooms: [
        {
          ...emptiedSourceRoom,
          ownedLabs: emptiedSourceLabs,
          storedStructures: [
            ...emptiedSourceRoom.storedStructures.filter(({ id }) => !labIds.has(id)),
            ...emptiedSourceLabs.map((value) => ({
              hits: value.hits,
              hitsMax: value.hitsMax,
              id: value.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: value.pos,
              store: value.store,
              structureType: "lab",
              ticksToDecay: null,
            })),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [{ ...migrationRooms[0], evacuationStorageId: storage.id }],
        records: [mixedRecord],
        snapshot: emptiedSourceWorld,
        tick: 11,
      }),
    ).toMatchObject({
      authorizedFlowIds: mixedFlowIds,
      demands: {
        edges: [
          expect.objectContaining({ id: mixedFlowIds[0] }),
          expect.objectContaining({ id: mixedFlowIds[1] }),
        ],
        suppressedSinkTargetIds: ["lab-obsolete", replacementId],
      },
    });
    const capacityLostStorage = {
      ...storage,
      store: {
        ...storage.store,
        freeCapacity: 100,
        resources: [
          { amount: 998_900, resourceType: "energy" },
          { amount: 1_000, resourceType: "XGH2O" },
        ],
        usedCapacity: 999_900,
      },
    } as const;
    const capacityRoom = emptiedSourceWorld.rooms[0];
    if (capacityRoom === undefined) throw new Error("mixed capacity fixture missing");
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [{ ...migrationRooms[0], evacuationStorageId: storage.id }],
        records: [mixedRecord],
        snapshot: {
          ...emptiedSourceWorld,
          rooms: [
            {
              ...capacityRoom,
              ownedStorages: [capacityLostStorage],
              storedStructures: capacityRoom.storedStructures.map((value) =>
                value.id === storage.id ? { ...value, store: capacityLostStorage.store } : value,
              ),
            },
          ],
        },
        tick: 11,
      }).demands.edges,
    ).toEqual([]);

    const terminal = {
      ...storage,
      cooldown: 0,
      id: "terminal",
      store: {
        capacity: 300_000,
        freeCapacity: 800,
        resources: [
          { amount: 298_200, resourceType: "energy" },
          { amount: 1_000, resourceType: "XGH2O" },
        ],
        usedCapacity: 299_200,
      },
    } as const;
    const terminalRoom = mineralWorld.rooms[0];
    if (terminalRoom === undefined) throw new Error("terminal evacuation fixture missing");
    const terminalWorld = {
      ...mineralWorld,
      rooms: [
        {
          ...terminalRoom,
          ownedStorages: [],
          ownedTerminals: [terminal],
          storedStructures: terminalRoom.storedStructures.map((value) =>
            value.id === storage.id
              ? {
                  ...value,
                  id: terminal.id,
                  store: terminal.store,
                  structureType: "terminal",
                }
              : value,
          ),
        },
      ],
    } satisfies WorldSnapshot;
    const terminalTerms = {
      ...mineralTerms,
      destinationId: terminal.id,
      destinationStructureType: "terminal" as const,
    };
    const terminalRecord = {
      ...record,
      labEvacuation: terminalTerms,
    } as const satisfies LayoutRecord;
    const terminalProjection = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms: [
        {
          ...migrationRooms[0],
          evacuationStorageId: null,
          evacuationTerminalId: terminal.id,
        },
      ],
      records: [terminalRecord],
      snapshot: terminalWorld,
      tick: 11,
    });
    const terminalRuntime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: terminalProjection.demands,
      snapshot: terminalWorld,
      tick: 11,
    });
    expect(terminalProjection.authorizedFlowIds).toHaveLength(1);
    expect(
      terminalRuntime.contracts.commitments.find(({ flowId }) =>
        terminalProjection.authorizedFlowIds.includes(flowId),
      )?.request,
    ).toMatchObject({
      execution: { counterpartId: terminal.id, resourceType: "XGH2O", version: 3 },
      targetId: "lab-obsolete",
    });
    expect(terminalRuntime.plan.reservations).toContainEqual({
      nodeId: "store-capacity/4:W1N1/8:terminal",
      sinkCapacity: terminal.store.freeCapacity,
      sourceAmount: 0,
    });

    const mixedTerminalRoom = terminalWorld.rooms[0];
    if (mixedTerminalRoom === undefined)
      throw new Error("mixed terminal evacuation fixture missing");
    const mixedTerminalWorld = {
      ...terminalWorld,
      rooms: [
        {
          ...mixedTerminalRoom,
          ownedLabs: mixedLabs,
          storedStructures: [
            ...mixedTerminalRoom.storedStructures.filter(({ id }) => !labIds.has(id)),
            ...mixedLabs.map((value) => ({
              hits: value.hits,
              hitsMax: value.hitsMax,
              id: value.id,
              ownerUsername: "me",
              ownership: "owned" as const,
              pos: value.pos,
              store: value.store,
              structureType: "lab",
              ticksToDecay: null,
            })),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const mixedTerminalTerms = {
      ...mixedTerms,
      destinationId: terminal.id,
      destinationStructureType: "terminal" as const,
    };
    const mixedTerminalRecord = {
      ...record,
      labEvacuation: mixedTerminalTerms,
    } as const satisfies LayoutRecord;
    const mixedTerminalProjection = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms: [
        {
          ...migrationRooms[0],
          evacuationStorageId: null,
          evacuationTerminalId: terminal.id,
        },
      ],
      records: [mixedTerminalRecord],
      snapshot: mixedTerminalWorld,
      tick: 11,
    });
    const mixedTerminalRuntime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: mixedTerminalProjection.demands,
      snapshot: mixedTerminalWorld,
      tick: 11,
    });
    expect(mixedTerminalProjection.authorizedFlowIds).toHaveLength(2);
    const mixedTerminalCommitments = mixedTerminalRuntime.contracts.commitments.filter(
      ({ flowId }) => mixedTerminalProjection.authorizedFlowIds.includes(flowId),
    );
    expect(mixedTerminalCommitments).toHaveLength(2);
    expect(mixedTerminalCommitments[0]?.request).toMatchObject({
      execution: { counterpartId: replacementId },
    });
    expect(mixedTerminalCommitments[1]?.request).toMatchObject({
      execution: {
        counterpartId: terminal.id,
        resourceType: "XGH2O",
        version: 3,
      },
    });
    expect(mixedTerminalRuntime.plan.reservations).toContainEqual({
      nodeId: "store-capacity/4:W1N1/8:terminal",
      sinkCapacity: terminal.store.freeCapacity,
      sourceAmount: 0,
    });
    const activeMixedTerminalMigration = {
      ...migrationRooms[0],
      activity: ["commitment", "pending-attempt"] as const,
      assignmentHandoff: {
        assignment,
        fromFingerprint: assignment.fingerprint,
        kind: "reaction" as const,
        layoutFingerprint: record.fingerprint,
        objectiveId: "reaction",
        objectiveRevision: 1,
        status: "ready" as const,
        targetLabId: "lab-obsolete",
      },
      evacuationStorageId: null,
      evacuationTerminalId: terminal.id,
      quiescent: false,
    };
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [activeMixedTerminalMigration],
        records: [mixedTerminalRecord],
        snapshot: mixedTerminalWorld,
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual(mixedTerminalProjection.authorizedFlowIds);
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [
          {
            ...activeMixedTerminalMigration,
            assignmentHandoff: {
              ...activeMixedTerminalMigration.assignmentHandoff,
              kind: "boost" as const,
            },
          },
        ],
        records: [mixedTerminalRecord],
        snapshot: mixedTerminalWorld,
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual(mixedTerminalProjection.authorizedFlowIds);

    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [
          {
            ...migrationRooms[0],
            evacuationStorageId: null,
            evacuationTerminalId: terminal.id,
          },
        ],
        records: [terminalRecord],
        snapshot: {
          ...terminalWorld,
          rooms: terminalWorld.rooms.map((value) => ({
            ...value,
            ownedTerminals: value.ownedTerminals.map((candidate) => ({
              ...candidate,
              store: { ...candidate.store, capacity: 1_000_000, freeCapacity: 700_800 },
            })),
          })),
        },
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual([]);
    const activeTerminalMigration = {
      ...migrationRooms[0],
      activity: ["commitment", "pending-attempt"] as const,
      assignmentHandoff: {
        assignment,
        fromFingerprint: assignment.fingerprint,
        kind: "reaction" as const,
        layoutFingerprint: record.fingerprint,
        objectiveId: "reaction",
        objectiveRevision: 1,
        status: "ready" as const,
        targetLabId: "lab-obsolete",
      },
      evacuationStorageId: null,
      evacuationTerminalId: terminal.id,
      quiescent: false,
    };
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [activeTerminalMigration],
        records: [terminalRecord],
        snapshot: terminalWorld,
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual(terminalProjection.authorizedFlowIds);
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [
          {
            ...activeTerminalMigration,
            assignmentHandoff: { ...activeTerminalMigration.assignmentHandoff, kind: "boost" },
          },
        ],
        records: [terminalRecord],
        snapshot: terminalWorld,
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual(terminalProjection.authorizedFlowIds);
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [activeTerminalMigration],
        records: [terminalRecord],
        snapshot: {
          ...terminalWorld,
          rooms: terminalWorld.rooms.map((value) => ({ ...value, ownedStorages: [storage] })),
        },
        tick: 11,
      }).authorizedFlowIds,
    ).toEqual([]);

    const empty = {
      authorizedFlowIds: [],
      budgets: [],
      demands: {
        edges: [],
        endpoints: [],
        nodes: [],
        suppressedSinkTargetIds: [],
        suppressedSourceTargetIds: [],
      },
    };
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [{ ...migrationRooms[0], evacuationStorageId: storage.id }],
        records: Array.from({ length: 33 }, () => mixedRecord),
        snapshot: mixedWorld,
        tick: 11,
      }),
    ).toEqual(empty);
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms: [{ ...migrationRooms[0], activity: ["commitment"], quiescent: false }],
        records: [record],
        snapshot: evacuationWorld,
        tick: 11,
      }),
    ).toEqual(empty);
    expect(
      projectLayoutLabEvacuations({
        existingBudgets: [],
        migrationRooms,
        records: Array.from({ length: 65 }, () => record),
        snapshot: evacuationWorld,
        tick: 11,
      }),
    ).toEqual(empty);
  });

  it("routes one persisted obsolete-tower evacuation through the sole logistics graph", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("tower evacuation fixture room missing");
    const tower = (id: string, x: number, used: number) => ({
      active: true,
      hits: 3_000,
      hitsMax: 3_000,
      id,
      pos: position(x, 12),
      store: {
        capacity: 1_000,
        freeCapacity: 1_000 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
    });
    const evacuationWorld = {
      ...snapshot,
      rooms: [
        {
          ...room,
          ownedTowers: [tower("tower-obsolete", 11, 500), tower("tower-replacement", 12, 10)],
        },
      ],
    } satisfies WorldSnapshot;
    const terms = {
      amount: 500,
      expiresAt: 160,
      replacementId: "tower-replacement",
      replacementInitialEnergy: 10,
      sourceId: "tower-obsolete",
      startedAt: 10,
    } as const;
    const budgetIssuer = layoutTowerEvacuationBudgetIssuer("W1N1", terms);
    if (budgetIssuer === null) throw new Error("tower evacuation budget issuer overflowed");
    const record = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-a",
      roomName: "W1N1",
      towerEvacuation: terms,
      transform: 0,
    } as const satisfies LayoutRecord;
    const evacuation = projectLayoutTowerEvacuations({
      existingBudgets: [],
      records: [record],
      snapshot: evacuationWorld,
      tick: 10,
    });
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: evacuation.demands,
      snapshot: evacuationWorld,
      tick: 10,
    });
    const flow = result.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-tower-evacuation:"),
    );

    expect(evacuation.budgets).toEqual([
      expect.objectContaining({ category: "optional-growth", issuer: budgetIssuer }),
    ]);
    expect(evacuation.demands.nodes).toHaveLength(2);
    expect(evacuation.demands.endpoints).toHaveLength(2);
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:tower-obsolete:sink:energy" }),
    );
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:tower-replacement:sink:energy" }),
    );
    expect(flow?.request).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer: budgetIssuer },
      execution: { action: "withdraw", counterpartId: "tower-replacement" },
      quantity: 500,
      targetId: "tower-obsolete",
    });

    const reset = projectLayoutTowerEvacuations({
      existingBudgets: [],
      records: JSON.parse(JSON.stringify([record])) as LayoutRecord[],
      snapshot: {
        ...evacuationWorld,
        rooms: [
          {
            ...room,
            ownedTowers: [tower("tower-replacement", 12, 10), tower("tower-obsolete", 11, 500)],
          },
        ],
      },
      tick: 10,
    });
    expect(JSON.stringify(reset)).toBe(JSON.stringify(evacuation));
    expect(
      projectLayoutTowerEvacuations({
        existingBudgets: [],
        records: Array.from({ length: 65 }, () => record),
        snapshot: evacuationWorld,
        tick: 10,
      }),
    ).toEqual({
      budgets: [],
      demands: { edges: [], endpoints: [], nodes: [], suppressedSinkTargetIds: [] },
    });

    const flowId = layoutTowerEvacuationFlowId("W1N1", terms);
    if (flowId === null) throw new Error("tower evacuation flow identity overflowed");
    const deliveredWorld = {
      ...snapshot,
      rooms: [
        {
          ...room,
          observedAt: 11,
          ownedTowers: [tower("tower-obsolete", 11, 0), tower("tower-replacement", 12, 510)],
        },
      ],
    } satisfies WorldSnapshot;
    expect(
      completedLayoutTowerEvacuationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        records: [record],
        snapshot: deliveredWorld,
        tick: 11,
      }),
    ).toEqual(["W1N1"]);
    expect(
      projectLayoutTowerEvacuationSuppressedSinkTargetIds({
        records: [record],
        snapshot: deliveredWorld,
        tick: 11,
      }),
    ).toEqual(["tower-obsolete", "tower-replacement"]);
    expect(
      projectLayoutTowerEvacuationSuppressedSinkTargetIds({
        records: [record],
        snapshot: deliveredWorld,
        tick: terms.expiresAt,
      }),
    ).toEqual([]);
    expect(
      completedLayoutTowerEvacuationRoomNames({
        activeFlowIds: new Set([flowId]),
        activeTargetIds: new Set(),
        records: [record],
        snapshot: deliveredWorld,
        tick: 11,
      }),
    ).toEqual([]);
    expect(
      completedLayoutTowerEvacuationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set([terms.replacementId]),
        records: [record],
        snapshot: deliveredWorld,
        tick: 11,
      }),
    ).toEqual([]);

    const observedEvacuationRoom = evacuationWorld.rooms[0];
    const hostile = room.ownedCreeps[0];
    if (observedEvacuationRoom === undefined || hostile === undefined)
      throw new Error("threatened tower evacuation fixture incomplete");
    const threatenedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...observedEvacuationRoom,
          hostileCreeps: [{ ...hostile, id: "hostile", ownerUsername: "enemy" }],
        },
      ],
    } satisfies WorldSnapshot;
    expect(
      projectLayoutTowerEvacuationSuppressedSinkTargetIds({
        records: [record],
        snapshot: threatenedWorld,
        tick: 10,
      }),
    ).toEqual(["tower-obsolete", "tower-replacement"]);
    expect(
      projectLayoutTowerEvacuations({
        existingBudgets: [],
        records: [record],
        snapshot: {
          ...evacuationWorld,
          rooms: [
            {
              ...room,
              ownedTowers: [tower("tower-obsolete", 11, 500), tower("tower-replacement", 12, 11)],
            },
          ],
        },
        tick: 10,
      }).demands.edges,
    ).toEqual([]);

    const sourceTower = tower("tower-obsolete", 11, 500);
    const replacementTower = tower("tower-replacement", 12, 10);
    const invalidTowerSets = [
      [sourceTower, { ...sourceTower, pos: position(13, 12) }, replacementTower],
      [{ ...sourceTower, active: false }, replacementTower],
      [
        {
          ...sourceTower,
          store: { ...sourceTower.store, freeCapacity: sourceTower.store.freeCapacity - 1 },
        },
        replacementTower,
      ],
    ];
    for (const ownedTowers of invalidTowerSets)
      expect(
        projectLayoutTowerEvacuations({
          existingBudgets: [],
          records: [record],
          snapshot: { ...evacuationWorld, rooms: [{ ...room, ownedTowers }] },
          tick: 10,
        }).demands.edges,
      ).toEqual([]);
  });

  it("routes one persisted reserve-link evacuation through the sole logistics graph", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("link evacuation fixture room missing");
    const link = (id: string, x: number, used: number) => ({
      active: true,
      cooldown: 0,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: position(x, 13),
      store: {
        capacity: 800,
        freeCapacity: 800 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
    });
    const evacuationWorld = {
      ...snapshot,
      rooms: [
        {
          ...room,
          ownedLinks: [link("link-reserve-external", 11, 300), link("link-reserve-exact", 12, 0)],
        },
      ],
    } satisfies WorldSnapshot;
    const terms = {
      amount: 300,
      expiresAt: 160,
      replacementId: "link-reserve-exact",
      replacementInitialEnergy: 0,
      sourceId: "link-reserve-external",
      startedAt: 10,
    } as const;
    const budgetIssuer = layoutLinkEvacuationBudgetIssuer("W1N1", terms);
    const flowId = layoutLinkEvacuationFlowId("W1N1", terms);
    if (budgetIssuer === null || flowId === null)
      throw new Error("link evacuation identity overflowed");
    const record = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-a",
      linkEvacuation: terms,
      roomName: "W1N1",
      transform: 0,
    } as const satisfies LayoutRecord;
    expect(
      projectLayoutLinkEvacuationSuppressedSinkTargetIds({
        records: [record],
        snapshot: evacuationWorld,
        tick: 10,
      }),
    ).toEqual(["link-reserve-external", "link-reserve-exact"]);
    expect(
      projectLayoutLinkEvacuations({
        authorizedFlowIds: new Set(),
        existingBudgets: [],
        records: [record],
        snapshot: evacuationWorld,
        tick: 10,
      }),
    ).toEqual({
      budgets: [],
      demands: {
        edges: [],
        endpoints: [],
        nodes: [],
        suppressedSinkTargetIds: ["link-reserve-external", "link-reserve-exact"],
      },
    });
    const evacuation = projectLayoutLinkEvacuations({
      authorizedFlowIds: new Set([flowId]),
      existingBudgets: [],
      records: [record],
      snapshot: evacuationWorld,
      tick: 10,
    });
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: evacuation.demands,
      snapshot: evacuationWorld,
      tick: 10,
    });
    const flow = result.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-link-evacuation:"),
    );

    expect(evacuation.budgets).toEqual([
      expect.objectContaining({ category: "optional-growth", issuer: budgetIssuer }),
    ]);
    expect(
      authorizeLayoutLinkEvacuationFlowIds(evacuation, new Set([flowId]), new Set([budgetIssuer])),
    ).toEqual(new Set([flowId]));
    expect(authorizeLayoutLinkEvacuationFlowIds(evacuation, new Set([flowId]), new Set())).toEqual(
      new Set(),
    );
    expect(evacuation.demands.nodes).toHaveLength(2);
    expect(evacuation.demands.endpoints).toHaveLength(2);
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:link-reserve-external:sink:energy" }),
    );
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:link-reserve-exact:sink:energy" }),
    );
    expect(flow?.request).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer: budgetIssuer },
      execution: { action: "withdraw", counterpartId: "link-reserve-exact" },
      quantity: 300,
      targetId: "link-reserve-external",
    });

    const reset = projectLayoutLinkEvacuations({
      authorizedFlowIds: new Set([flowId]),
      existingBudgets: [],
      records: JSON.parse(JSON.stringify([record])) as LayoutRecord[],
      snapshot: {
        ...evacuationWorld,
        rooms: [
          {
            ...room,
            ownedLinks: [link("link-reserve-exact", 12, 0), link("link-reserve-external", 11, 300)],
          },
        ],
      },
      tick: 10,
    });
    expect(JSON.stringify(reset)).toBe(JSON.stringify(evacuation));

    const completedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          observedAt: 11,
          ownedLinks: [link("link-reserve-exact", 12, 300), link("link-reserve-external", 11, 0)],
        },
      ],
    } satisfies WorldSnapshot;
    const completionInput = {
      activeFlowIds: new Set<string>(),
      activeTargetIds: new Set<string>(),
      authorizedFlowIds: new Set([flowId]),
      nativeTransferExcludedLinkIds: new Set([terms.sourceId, terms.replacementId]),
      records: [record],
      snapshot: completedWorld,
      tick: 11,
    } as const;
    expect(completedLayoutLinkEvacuationRoomNames(completionInput)).toEqual(["W1N1"]);
    expect(
      completedLayoutLinkEvacuationRoomNames({
        ...completionInput,
        activeFlowIds: new Set([flowId]),
      }),
    ).toEqual([]);
    expect(
      completedLayoutLinkEvacuationRoomNames({
        ...completionInput,
        authorizedFlowIds: new Set(),
      }),
    ).toEqual([]);
    expect(
      completedLayoutLinkEvacuationRoomNames({
        ...completionInput,
        nativeTransferExcludedLinkIds: new Set([terms.sourceId]),
      }),
    ).toEqual([]);
    expect(
      completedLayoutLinkEvacuationRoomNames({
        ...completionInput,
        snapshot: {
          ...completedWorld,
          rooms: [
            {
              ...room,
              observedAt: 11,
              ownedLinks: [
                link("link-reserve-exact", 12, 300),
                { ...link("link-reserve-external", 11, 0), cooldown: 1 },
              ],
            },
          ],
        },
      }),
    ).toEqual([]);

    expect(
      projectLayoutLinkEvacuations({
        authorizedFlowIds: new Set([flowId]),
        existingBudgets: [],
        records: Array.from({ length: 65 }, () => record),
        snapshot: evacuationWorld,
        tick: 10,
      }),
    ).toEqual({
      budgets: [],
      demands: { edges: [], endpoints: [], nodes: [], suppressedSinkTargetIds: [] },
    });
  });

  it("suppresses refill of one persisted empty obsolete general container", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("container migration fixture room missing");
    const store = (used: number) => ({
      capacity: 2_000,
      freeCapacity: 2_000 - used,
      resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
      usedCapacity: used,
    });
    const container = (id: string, x: number, used = 0) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: position(x, 12),
      store: store(used),
      structureType: "container",
      ticksToDecay: 5_000,
    });
    const obsolete = container("container-obsolete", 12);
    const replacement = container("container-replacement", 13);
    const migrationWorld = {
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      observedAt: 11,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [...room.storedStructures, obsolete, replacement],
        },
      ],
    } satisfies WorldSnapshot;
    const visibleMigrationRoom = migrationWorld.rooms[0];
    if (visibleMigrationRoom === undefined) throw new Error("migration room missing");
    const migration = {
      expiresAt: 160,
      replacementId: replacement.id,
      startedAt: 10,
      targetId: obsolete.id,
    } as const;
    const migrationRecord = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      containerMigration: migration,
      fingerprint: "layout-a",
      roomName: "W1N1",
      transform: 0 as const,
    };
    const sameTickWorld = {
      ...migrationWorld,
      observation: { ...migrationWorld.observation, tick: 10 },
      observedAt: 10,
      rooms: [{ ...visibleMigrationRoom, observedAt: 10 }],
    };
    expect(
      projectLayoutContainerMigrations({
        records: [migrationRecord],
        snapshot: sameTickWorld,
        tick: 10,
      }).suppressedSinkTargetIds,
    ).toEqual([]);
    expect(
      projectLayoutContainerMigrations({
        records: [
          {
            ...migrationRecord,
            containerMigration: { ...migration, expiresAt: 162, startedAt: 12 },
          },
        ],
        snapshot: migrationWorld,
        tick: 11,
      }).suppressedSinkTargetIds,
    ).toEqual([]);
    const demands = projectLayoutContainerMigrations({
      records: [migrationRecord],
      snapshot: migrationWorld,
      tick: 11,
    });
    const flowId = `flow:store:container:source:energy->store:${obsolete.id}:sink:energy`;
    const planning = {
      contracts: [
        {
          budgetBinding: { category: "optional-growth" as const, issuer: "logistics/active" },
          contractId: "contract-active-container-flow",
          execution: {
            action: "withdraw" as const,
            completion: "target-depleted" as const,
            counterpartId: obsolete.id,
            flowId,
            recommendedCarry: 1,
            recommendedMove: 1,
            reservedAmount: 50,
            resourceType: "energy" as ResourceConstant,
            stage: "acquire" as const,
            version: 3 as const,
          },
          issuer: "logistics/active",
          owner: { id: "W1N1", kind: "colony" as const },
          state: "assigned" as const,
          targetId: "container",
        },
      ],
      status: "ready" as const,
    };
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning,
      resourceDemands: demands,
      snapshot: migrationWorld,
      tick: 11,
    });

    expect(demands.suppressedSinkTargetIds).toEqual([obsolete.id]);
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: `store:${obsolete.id}:sink:energy` }),
    );
    expect(result.graph.nodes).toContainEqual(
      expect.objectContaining({ id: `store:${replacement.id}:sink:energy` }),
    );
    expect(result.contracts.commitments).toContainEqual(
      expect.objectContaining({ flowId, reason: "sink-vanished", request: null }),
    );
    expect(result.contracts.retirements).toContainEqual(
      expect.objectContaining({ reason: "logistics-sink-vanished", to: "failed" }),
    );
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 11, status: "healthy" }]);
    const cargoWorld = world(50);
    const cargoRoom = cargoWorld.rooms[0];
    if (cargoRoom === undefined) throw new Error("deliver cargo room missing");
    const deliverExecution = execution("deliver", 50);
    const deliver = planLogisticsRuntime({
      execution: {
        ...deliverExecution,
        leases: deliverExecution.leases.map((lease) => ({
          ...lease,
          execution: { ...lease.execution, flowId },
          targetId: obsolete.id,
        })),
      },
      includeOptional: true,
      planning: {
        ...planning,
        contracts: planning.contracts.map((contract) => ({
          ...contract,
          execution: {
            ...contract.execution,
            action: "transfer" as const,
            completion: "target-full" as const,
            counterpartId: "container",
            stage: "deliver" as const,
          },
          state: "active" as const,
          targetId: obsolete.id,
        })),
      },
      resourceDemands: demands,
      snapshot: {
        ...migrationWorld,
        rooms: [{ ...visibleMigrationRoom, ownedCreeps: cargoRoom.ownedCreeps }],
      },
      tick: 11,
    });
    expect(deliver.contracts.retirements).toContainEqual(
      expect.objectContaining({ reason: "logistics-sink-vanished", to: "failed" }),
    );
    expect(deliver.health).toEqual([{ colonyId: "W1N1", observedAt: 11, status: "healthy" }]);
    expect(
      projectLayoutContainerMigrations({
        records: [migrationRecord],
        snapshot: {
          ...migrationWorld,
          rooms: [
            {
              ...visibleMigrationRoom,
              storedStructures: [
                ...room.storedStructures,
                container(obsolete.id, 12, 1),
                replacement,
              ],
            },
          ],
        },
        tick: 11,
      }).suppressedSinkTargetIds,
    ).toEqual([]);
  });

  it("projects one funded exact-energy flow for a stocked general-container migration", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("container evacuation fixture room missing");
    const container = (id: string, x: number, used: number) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: position(x, 12),
      store: {
        capacity: 2_000,
        freeCapacity: 2_000 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
      structureType: "container",
      ticksToDecay: 5_000,
    });
    const obsolete = container("container-obsolete", 12, 50);
    const replacement = container("container-replacement", 13, 0);
    const migration = {
      energyAmount: 50,
      expiresAt: 160,
      replacementId: replacement.id,
      replacementInitialEnergy: 0,
      startedAt: 10,
      targetId: obsolete.id,
    } as const;
    const migrationSnapshot = {
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      observedAt: 11,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [...room.storedStructures, obsolete, replacement],
        },
      ],
    } satisfies WorldSnapshot;
    const projection = projectLayoutContainerMigrations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          containerMigration: migration,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: migrationSnapshot,
      tick: 11,
    });

    expect(projection.budgets).toEqual([
      expect.objectContaining({
        category: "optional-growth",
        colonyId: "W1N1",
        expiresAt: 160,
      }),
    ]);
    expect(projection.edges).toEqual([
      expect.objectContaining({
        id: "layout-container-evacuation:W1N1:container-obsolete:container-replacement",
        maximumAmount: 50,
      }),
    ]);
    expect(projection.nodes).toEqual([
      expect.objectContaining({ kind: "source", observedAmount: 50 }),
      expect.objectContaining({ freeCapacity: 2_000, kind: "sink" }),
    ]);
    expect(projection.suppressedSinkTargetIds).toEqual([
      "container-obsolete",
      "container-replacement",
    ]);
    expect(projection.suppressedSourceTargetIds).toEqual(["container-obsolete"]);
    expect(
      projectLayoutContainerMigrations({
        records: [
          {
            algorithmRevision: "owned-room-layout-v1",
            anchor: position(25, 25),
            blockers: [],
            committedAt: 1,
            containerMigration: migration,
            fingerprint: "layout-stale",
            roomName: "W1N1",
            transform: 0,
          },
        ],
        snapshot: {
          ...migrationSnapshot,
          rooms: [
            {
              ...room,
              observedAt: 11,
              storedStructures: [
                ...room.storedStructures,
                obsolete,
                container(replacement.id, 13, 20),
              ],
            },
          ],
        },
        tick: 11,
      }).edges,
    ).toEqual([]);
    const runtime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: projection,
      snapshot: migrationSnapshot,
      tick: 11,
    });
    expect(runtime.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: `store:${obsolete.id}:source:energy` }),
    );
    expect(runtime.graph.nodes).toContainEqual(
      expect.objectContaining({
        id: `${projection.edges[0]?.id ?? ""}:source:energy`,
        observedAmount: 50,
      }),
    );
    expect(runtime.plan.blockers).not.toContainEqual(
      expect.objectContaining({ reason: "duplicate-id" }),
    );
  });

  it("durably suppresses and exactly settles one energy-only container migration", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("stale container fixture room missing");
    const container = (id: string, x: number, energy: number) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: position(x, 12),
      store: {
        capacity: 2_000,
        freeCapacity: 2_000 - energy,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
      structureType: "container",
      ticksToDecay: 5_000,
    });
    const migration = {
      energyAmount: 50,
      expiresAt: 160,
      replacementId: "container-replacement",
      replacementInitialEnergy: 10,
      startedAt: 10,
      targetId: "container-obsolete",
    } as const;
    const record: LayoutRecord = {
      algorithmRevision: "owned-room-layout-v1",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      containerMigration: migration,
      fingerprint: "layout-stale",
      roomName: "W1N1",
      transform: 0,
    };
    const migrationWorld = (targetEnergy: number, replacementEnergy: number) => ({
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      observedAt: 11,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [
            ...room.storedStructures,
            container(migration.targetId, 12, targetEnergy),
            container(migration.replacementId, 13, replacementEnergy),
          ],
        },
      ],
    });
    const pending = migrationWorld(50, 10);
    const pendingRoom = pending.rooms[0];
    if (pendingRoom === undefined) throw new Error("pending container room missing");
    const suppression = projectLayoutContainerMigrationSuppression({
      records: [record],
      snapshot: { ...pending, rooms: [{ ...pendingRoom, hostileCreeps: [{} as never] }] },
      tick: 11,
    });
    expect(suppression).toEqual({
      suppressedSinkTargetIds: [migration.targetId, migration.replacementId],
      suppressedSourceTargetIds: [migration.targetId],
    });
    expect(
      projectLayoutContainerMigrationSuppression({
        records: [record],
        snapshot: pending,
        tick: migration.expiresAt,
      }),
    ).toEqual({ suppressedSinkTargetIds: [], suppressedSourceTargetIds: [] });

    const delivered = migrationWorld(0, 60);
    const deliveredRoom = delivered.rooms[0];
    if (deliveredRoom === undefined) throw new Error("delivered container room missing");
    const flowId = "layout-container-evacuation:W1N1:container-obsolete:container-replacement";
    const completed = (activeFlowIds = new Set<string>(), activeTargetIds = new Set<string>()) =>
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds,
        activeTargetIds,
        authorizedFlowIds: new Set([flowId]),
        records: [record],
        snapshot: delivered,
        tick: 11,
      });
    expect(completed()).toEqual(["W1N1"]);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set(),
        records: [record],
        snapshot: delivered,
        tick: 11,
      }),
    ).toEqual([]);
    expect(completed(new Set([flowId]))).toEqual([]);
    expect(completed(new Set(), new Set([migration.targetId]))).toEqual([]);
    expect(completed(new Set(), new Set([migration.replacementId]))).toEqual([]);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [record],
        snapshot: migrationWorld(0, 61),
        tick: 11,
      }),
    ).toEqual([]);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [record],
        snapshot: {
          ...delivered,
          rooms: [
            {
              ...deliveredRoom,
              storedStructures: [...deliveredRoom.storedStructures].reverse(),
            },
          ],
        },
        tick: 11,
      }),
    ).toEqual(["W1N1"]);

    const sourceSpecificRecord: LayoutRecord = {
      ...record,
      containerMigration: { ...migration, sourceId: "source-a" },
      sourceServices: [
        {
          adoption: "exact",
          layer: "primary",
          minimumRcl: 2,
          pos: position(13, 12),
          service: { kind: "source-container", sourceId: "source-a" },
          structureType: "container",
        },
      ],
    };
    const sourceSpecificWorld = (serviceX: number, sourcePosition = position(12, 11)) => ({
      ...delivered,
      rooms: [
        {
          ...deliveredRoom,
          sources: [
            {
              energy: 3_000,
              energyCapacity: 3_000,
              id: "source-a",
              pos: sourcePosition,
              ticksToRegeneration: 300,
            },
          ],
          storedStructures: deliveredRoom.storedStructures.map((structure) =>
            structure.id === migration.replacementId
              ? { ...structure, pos: position(serviceX, 12) }
              : structure,
          ),
        },
      ],
    });
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [sourceSpecificRecord],
        snapshot: sourceSpecificWorld(13),
        tick: 11,
      }),
    ).toEqual(["W1N1"]);
    for (const drifted of [
      sourceSpecificWorld(14),
      sourceSpecificWorld(13, position(10, 12)),
      sourceSpecificWorld(13, position(11, 12)),
    ])
      expect(
        completedLayoutContainerMigrationRoomNames({
          activeFlowIds: new Set(),
          activeTargetIds: new Set(),
          authorizedFlowIds: new Set([flowId]),
          records: [sourceSpecificRecord],
          snapshot: drifted,
          tick: 11,
        }),
      ).toEqual([]);
  });

  it("exactly settles one singleton non-energy container migration", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("non-energy container fixture room missing");
    const container = (
      id: string,
      x: number,
      resources: readonly { readonly amount: number; readonly resourceType: string }[],
    ) => {
      const usedCapacity = resources.reduce((total, { amount }) => total + amount, 0);
      return {
        hits: 250_000,
        hitsMax: 250_000,
        id,
        ownerUsername: null,
        ownership: "unowned" as const,
        pos: position(x, 12),
        store: {
          capacity: 2_000,
          freeCapacity: 2_000 - usedCapacity,
          resources,
          usedCapacity,
        },
        structureType: "container",
        ticksToDecay: 5_000,
      };
    };
    const migration = {
      expiresAt: 160,
      replacementId: "container-replacement",
      resourceManifest: [["U", 50, 10]],
      startedAt: 10,
      targetId: "container-obsolete",
    } as const;
    const record: LayoutRecord = {
      algorithmRevision: "owned-room-layout-v1",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      containerMigration: migration,
      fingerprint: "layout-stale",
      roomName: "W1N1",
      transform: 0,
    };
    const migrationWorld = (targetAmount: number, replacementAmount: number, reverse = false) => ({
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      observedAt: 11,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [
            ...room.storedStructures,
            container(
              migration.targetId,
              12,
              targetAmount === 0 ? [] : [{ amount: targetAmount, resourceType: "U" }],
            ),
            container(migration.replacementId, 13, [
              { amount: 20, resourceType: "energy" },
              { amount: replacementAmount, resourceType: "U" },
            ]),
          ].sort((left, right) =>
            reverse ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id),
          ),
        },
      ],
    });
    const flowId = "layout-container-evacuation:W1N1:container-obsolete:container-replacement:1:U";
    const partial = migrationWorld(25, 35);
    const partialProjection = projectLayoutContainerMigrations({
      records: [record],
      snapshot: partial,
      tick: 11,
    });
    expect(partialProjection.edges).toEqual([
      expect.objectContaining({ id: flowId, maximumAmount: 50 }),
    ]);
    expect(partialProjection.nodes).toContainEqual(
      expect.objectContaining({ kind: "source", observedAmount: 25, resourceType: "U" }),
    );
    expect(
      projectLayoutContainerMigrations({
        records: JSON.parse(JSON.stringify([record])) as readonly LayoutRecord[],
        snapshot: JSON.parse(JSON.stringify(migrationWorld(25, 35, true))) as WorldSnapshot,
        tick: 11,
      }),
    ).toEqual(partialProjection);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [record],
        snapshot: partial,
        tick: 11,
      }),
    ).toEqual([]);

    const delivered = migrationWorld(0, 60);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [record],
        snapshot: delivered,
        tick: 11,
      }),
    ).toEqual(["W1N1"]);
    expect(
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([
          "layout-container-evacuation:W1N1:container-obsolete:container-replacement",
        ]),
        records: [record],
        snapshot: delivered,
        tick: 11,
      }),
    ).toEqual([]);

    const sourceSpecificRoom = delivered.rooms[0];
    if (sourceSpecificRoom === undefined) throw new Error("source-specific room missing");
    const sourceSpecificService = {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: position(13, 12),
      service: { kind: "source-container", sourceId: "source-a" },
      structureType: "container",
    } as const;
    const sourceSpecificRecord: LayoutRecord = {
      ...record,
      containerMigration: { ...migration, sourceId: "source-a" },
      sourceServices: [sourceSpecificService],
    };
    const sourceSpecificWorld = (sourcePosition = position(12, 11)) => ({
      ...delivered,
      rooms: [
        {
          ...sourceSpecificRoom,
          sources: [
            {
              energy: 3_000,
              energyCapacity: 3_000,
              id: "source-a",
              pos: sourcePosition,
              ticksToRegeneration: 300,
            },
          ],
        },
      ],
    });
    const completedSourceSpecific = (candidate: LayoutRecord, candidateWorld: WorldSnapshot) =>
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: new Set(),
        activeTargetIds: new Set(),
        authorizedFlowIds: new Set([flowId]),
        records: [candidate],
        snapshot: candidateWorld,
        tick: 11,
      });
    expect(completedSourceSpecific(sourceSpecificRecord, sourceSpecificWorld())).toEqual(["W1N1"]);
    expect(
      completedSourceSpecific(sourceSpecificRecord, sourceSpecificWorld(position(10, 12))),
    ).toEqual([]);
    expect(
      completedSourceSpecific(sourceSpecificRecord, sourceSpecificWorld(position(11, 12))),
    ).toEqual([]);
    expect(
      completedSourceSpecific(
        {
          ...sourceSpecificRecord,
          sourceServices: [{ ...sourceSpecificService, pos: position(14, 12) }],
        },
        sourceSpecificWorld(),
      ),
    ).toEqual([]);
    expect(
      completedSourceSpecific(
        {
          ...sourceSpecificRecord,
          sourceServices: [
            sourceSpecificService,
            { ...sourceSpecificService, pos: position(14, 12) },
          ],
        },
        sourceSpecificWorld(),
      ),
    ).toEqual([]);
  });

  it("projects mixed container stock as atomic resource-specific funded flows", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("mixed container fixture room missing");
    const stored = (
      id: string,
      x: number,
      resources: readonly { readonly amount: number; readonly resourceType: string }[],
    ) => {
      const usedCapacity = resources.reduce((total, { amount }) => total + amount, 0);
      return {
        hits: 250_000,
        hitsMax: 250_000,
        id,
        ownerUsername: null,
        ownership: "unowned" as const,
        pos: position(x, 12),
        store: {
          capacity: 2_000,
          freeCapacity: 2_000 - usedCapacity,
          resources,
          usedCapacity,
        },
        structureType: "container",
        ticksToDecay: 5_000,
      };
    };
    const obsolete = stored("container-obsolete", 12, [
      { amount: 25, resourceType: "energy" },
      { amount: 25, resourceType: "U" },
    ]);
    const replacement = stored("container-replacement", 13, []);
    const migration = {
      expiresAt: 160,
      replacementId: replacement.id,
      resourceManifest: [
        ["U", 25, 0],
        ["energy", 25, 0],
      ],
      startedAt: 10,
      targetId: obsolete.id,
    } as const;
    const migrationSnapshot = {
      ...snapshot,
      observation: { ...snapshot.observation, tick: 11 },
      observedAt: 11,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [...room.storedStructures, obsolete, replacement],
        },
      ],
    } satisfies WorldSnapshot;
    const record = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: position(25, 25),
      blockers: [],
      committedAt: 1,
      containerMigration: migration,
      fingerprint: "layout-a",
      roomName: "W1N1",
      transform: 0,
    } as const;
    const projection = projectLayoutContainerMigrations({
      existingBudgets: [],
      records: [record],
      snapshot: migrationSnapshot,
      tick: 11,
    });

    expect(projection.edges).toEqual([
      expect.objectContaining({
        id: "layout-container-evacuation:W1N1:container-obsolete:container-replacement:1:U",
        maximumAmount: 25,
      }),
      expect.objectContaining({
        id: "layout-container-evacuation:W1N1:container-obsolete:container-replacement:6:energy",
        maximumAmount: 25,
      }),
    ]);
    expect(new Set(projection.budgets.map(({ issuer }) => issuer)).size).toBe(2);
    expect(projection.nodes.filter(({ kind }) => kind === "source")).toEqual([
      expect.objectContaining({ observedAmount: 25, resourceType: "U" }),
      expect.objectContaining({ observedAmount: 25, resourceType: "energy" }),
    ]);
    expect(
      new Set(
        projection.nodes.flatMap(({ capacityReservationKey }) =>
          capacityReservationKey === undefined ? [] : [capacityReservationKey],
        ),
      ),
    ).toEqual(new Set(["store-capacity/4:W1N1/21:container-replacement"]));
    expect(projection.suppressedSinkTargetIds).toEqual([
      "container-obsolete",
      "container-replacement",
    ]);
    expect(projection.suppressedSourceTargetIds).toEqual(["container-obsolete"]);
    const runtime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: projection,
      snapshot: migrationSnapshot,
      tick: 11,
    });
    const migrationPlans = runtime.plan.projections.filter(({ id }) =>
      id.startsWith("layout-container-evacuation:"),
    );
    expect(migrationPlans).toEqual([
      expect.objectContaining({ admittedAmount: 25, blocker: null, resourceType: "U" }),
      expect.objectContaining({ admittedAmount: 25, blocker: null, resourceType: "energy" }),
    ]);
    const migrationCommitments = runtime.contracts.commitments.filter(({ flowId }) =>
      flowId.startsWith("layout-container-evacuation:"),
    );
    expect(migrationCommitments.map(({ resourceType }) => resourceType)).toEqual(["U", "energy"]);
    expect(migrationCommitments.map(({ budgetBinding }) => budgetBinding?.category)).toEqual([
      "optional-growth",
      "optional-growth",
    ]);
    expect(
      migrationCommitments.map(({ request }) =>
        request?.execution?.version === 3
          ? { resourceType: request.execution.resourceType, version: request.execution.version }
          : null,
      ),
    ).toEqual([
      { resourceType: "U", version: 3 },
      { resourceType: "energy", version: 3 },
    ]);

    const flowIds = projection.edges.map(({ id }) => id);
    expect([
      ...completeExecutableLayoutContainerMigrationFlowIds({
        executableFlowIds: new Set(flowIds),
        projectedFlowIds: new Set(flowIds),
        records: [record],
      }),
    ]).toEqual(flowIds);
    expect(
      completeExecutableLayoutContainerMigrationFlowIds({
        executableFlowIds: new Set([flowIds[0] ?? ""]),
        projectedFlowIds: new Set(flowIds),
        records: [record],
      }),
    ).toEqual(new Set());
    const completionSnapshot = (
      targetResources: readonly { readonly amount: number; readonly resourceType: string }[],
      replacementResources: readonly { readonly amount: number; readonly resourceType: string }[],
      reverse = false,
    ) => ({
      ...migrationSnapshot,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [
            ...room.storedStructures,
            stored(migration.targetId, 12, targetResources),
            stored(migration.replacementId, 13, replacementResources),
          ].sort((left, right) =>
            reverse ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id),
          ),
        },
      ],
    });
    const delivered = completionSnapshot(
      [],
      [
        { amount: 25, resourceType: "energy" },
        { amount: 25, resourceType: "U" },
      ],
    );
    const completed = (input?: {
      readonly activeFlowIds?: ReadonlySet<string>;
      readonly activeTargetIds?: ReadonlySet<string>;
      readonly authorizedFlowIds?: ReadonlySet<string>;
      readonly snapshot?: WorldSnapshot;
    }) =>
      completedLayoutContainerMigrationRoomNames({
        activeFlowIds: input?.activeFlowIds ?? new Set(),
        activeTargetIds: input?.activeTargetIds ?? new Set(),
        authorizedFlowIds: input?.authorizedFlowIds ?? new Set(flowIds),
        records: [record],
        snapshot: input?.snapshot ?? delivered,
        tick: 11,
      });
    expect(completed()).toEqual(["W1N1"]);
    expect(completed({ authorizedFlowIds: new Set([flowIds[0] ?? ""]) })).toEqual([]);
    expect(completed({ activeFlowIds: new Set([flowIds[1] ?? ""]) })).toEqual([]);
    expect(completed({ activeTargetIds: new Set([migration.replacementId]) })).toEqual([]);
    expect(
      completed({
        snapshot: completionSnapshot(
          [{ amount: 25, resourceType: "energy" }],
          [{ amount: 25, resourceType: "U" }],
        ),
      }),
    ).toEqual([]);
    expect(
      completed({
        snapshot: completionSnapshot(
          [],
          [
            { amount: 24, resourceType: "energy" },
            { amount: 25, resourceType: "U" },
          ],
        ),
      }),
    ).toEqual([]);
    expect(
      completed({
        snapshot: JSON.parse(
          JSON.stringify(
            completionSnapshot(
              [],
              [
                { amount: 25, resourceType: "U" },
                { amount: 25, resourceType: "energy" },
              ],
              true,
            ),
          ),
        ) as WorldSnapshot,
      }),
    ).toEqual(["W1N1"]);

    const singletonTarget = stored("container-obsolete", 12, [{ amount: 50, resourceType: "U" }]);
    const singletonSnapshot = {
      ...migrationSnapshot,
      rooms: [
        {
          ...room,
          observedAt: 11,
          storedStructures: [...room.storedStructures, singletonTarget, replacement],
        },
      ],
    } satisfies WorldSnapshot;
    const singletonRecord = {
      ...record,
      containerMigration: {
        ...migration,
        resourceManifest: [["U", 50, 0]],
      },
    } as const;
    const singletonProjection = projectLayoutContainerMigrations({
      records: [singletonRecord],
      snapshot: singletonSnapshot,
      tick: 11,
    });
    expect(singletonProjection.edges).toEqual([
      expect.objectContaining({
        id: "layout-container-evacuation:W1N1:container-obsolete:container-replacement:1:U",
        maximumAmount: 50,
      }),
    ]);
    expect(singletonProjection.budgets).toHaveLength(1);
    expect(singletonProjection.nodes).toEqual([
      expect.objectContaining({ kind: "source", observedAmount: 50, resourceType: "U" }),
      expect.objectContaining({
        capacityReservationKey: "store-capacity/4:W1N1/21:container-replacement",
        kind: "sink",
        resourceType: "U",
      }),
    ]);
    expect(singletonProjection.suppressedSinkTargetIds).toEqual([
      "container-obsolete",
      "container-replacement",
    ]);
    expect(singletonProjection.suppressedSourceTargetIds).toEqual(["container-obsolete"]);
    const singletonRuntime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: singletonProjection,
      snapshot: singletonSnapshot,
      tick: 11,
    });
    expect(
      singletonRuntime.contracts.commitments
        .filter(({ flowId }) => flowId.startsWith("layout-container-evacuation:"))
        .map(({ request, resourceType }) =>
          request?.execution?.version === 3
            ? {
                executionResourceType: request.execution.resourceType,
                resourceType,
                version: request.execution.version,
              }
            : null,
        ),
    ).toEqual([{ executionResourceType: "U", resourceType: "U", version: 3 }]);
    const singletonEnergyTarget = stored("container-obsolete", 12, [
      { amount: 50, resourceType: "energy" },
    ]);
    expect(
      projectLayoutContainerMigrations({
        records: [
          {
            ...record,
            containerMigration: {
              ...migration,
              resourceManifest: [["energy", 50, 0]],
            },
          },
        ],
        snapshot: {
          ...migrationSnapshot,
          rooms: [
            {
              ...room,
              observedAt: 11,
              storedStructures: [...room.storedStructures, singletonEnergyTarget, replacement],
            },
          ],
        },
        tick: 11,
      }).edges,
    ).toEqual([]);
    expect(
      projectLayoutContainerMigrations({
        records: [
          {
            ...singletonRecord,
            containerMigration: {
              ...singletonRecord.containerMigration,
              resourceManifest: [["U", 50, 0, "unexpected"]],
            } as never,
          },
        ],
        snapshot: singletonSnapshot,
        tick: 11,
      }).edges,
    ).toEqual([]);

    const overflowRecords: LayoutRecord[] = [];
    const overflowRooms: WorldSnapshot["rooms"][number][] = [];
    for (let index = 0; index < 33; index += 1) {
      const overflowRoomName = `W${String(index)}N1`;
      const move = (value: typeof obsolete, id: string) => ({
        ...value,
        id,
        pos: { ...value.pos, roomName: overflowRoomName },
      });
      const overflowTarget = move(obsolete, `target-${String(index)}`);
      const overflowReplacement = move(replacement, `replacement-${String(index)}`);
      overflowRooms.push({
        ...room,
        name: overflowRoomName,
        observedAt: 11,
        storedStructures: [overflowTarget, overflowReplacement],
      });
      overflowRecords.push({
        ...record,
        anchor: { ...record.anchor, roomName: overflowRoomName },
        containerMigration: {
          ...migration,
          replacementId: overflowReplacement.id,
          targetId: overflowTarget.id,
        },
        fingerprint: `layout-${String(index)}`,
        roomName: overflowRoomName,
      });
    }
    expect(
      projectLayoutContainerMigrations({
        records: overflowRecords,
        snapshot: { ...migrationSnapshot, rooms: overflowRooms },
        tick: 11,
      }),
    ).toMatchObject({ budgets: [], edges: [], endpoints: [], nodes: [] });

    const malformedCapacityTarget = {
      ...obsolete,
      store: { ...obsolete.store, capacity: 1_999 },
    };
    expect(
      projectLayoutContainerMigrations({
        records: [record],
        snapshot: {
          ...migrationSnapshot,
          rooms: [
            {
              ...room,
              observedAt: 11,
              storedStructures: [malformedCapacityTarget, replacement],
            },
          ],
        },
        tick: 11,
      }).edges,
    ).toEqual([]);
  });

  it("clamps V3 acquire and partial delivery to observed exact quantities", () => {
    const acquire = planLeaseAgents({
      availablePathCpu: 1,
      execution: execution("acquire", 40),
      paths: { plan: () => ({ status: "unavailable" }) } as never,
      snapshot: world(0),
      tick: 10,
    });
    expect(acquire.actions[0]).toMatchObject({ amount: 40, kind: "withdraw" });

    const deliver = planLeaseAgents({
      availablePathCpu: 1,
      execution: execution("deliver", 50),
      paths: { plan: () => ({ status: "unavailable" }) } as never,
      snapshot: world(30),
      tick: 10,
    });
    expect(deliver.actions[0]).toMatchObject({ amount: 30, kind: "transfer" });
  });
});

function execution(stage: "acquire" | "deliver", quantity: number) {
  return {
    status: "ready" as const,
    leases: [
      {
        actorId: "hauler",
        actorName: "hauler",
        contractId: `contract:${stage}`,
        deadline: 50,
        execution: {
          action: stage === "acquire" ? ("withdraw" as const) : ("transfer" as const),
          completion: stage === "acquire" ? ("target-depleted" as const) : ("target-full" as const),
          counterpartId: stage === "acquire" ? "spawn" : "container",
          flowId: "flow:container-spawn",
          recommendedCarry: 1,
          recommendedMove: 1,
          reservedAmount: quantity,
          resourceType: "energy" as ResourceConstant,
          stage,
          version: 3 as const,
        },
        expiresAt: 51,
        leaseExpiresAt: 20,
        priority: { class: "survival" as const, value: 850 },
        quantity,
        range: 1,
        revision: 1,
        state: "assigned" as const,
        target: stage === "acquire" ? position(10, 11) : position(11, 10),
        targetId: stage === "acquire" ? "container" : "spawn",
      },
    ],
  };
}

function world(cargo = 0, spawnEnergy = 0): WorldSnapshot {
  const part = { active: 0, boosted: 0, total: 0 };
  const store = (capacity: number, energy: number) => ({
    capacity,
    freeCapacity: capacity - energy,
    resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
    usedCapacity: energy,
  });
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: {
          id: "controller",
          level: 2,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(25, 25),
          progress: 0,
          progressTotal: 1,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 10_000,
          upgradeBlocked: null,
        },
        droppedResources: [],
        energyAvailable: 0,
        energyCapacityAvailable: 300,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 10,
        ownedExtensions: [],
        ownedTowers: [],
        ruins: [],
        sources: [],
        tombstones: [],
        ownedCreeps: [
          {
            body: {
              activeParts: 2,
              attack: part,
              carry: { ...part, active: 1, total: 1 },
              claim: part,
              heal: part,
              move: { ...part, active: 1, total: 1 },
              rangedAttack: part,
              size: 2,
              tough: part,
              work: part,
            },
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            id: "hauler",
            name: "hauler",
            ownerUsername: "me",
            pos: position(10, 10),
            spawning: false,
            store: store(50, cargo),
            ticksToLive: 100,
          },
        ],
        ownedSpawns: [
          {
            active: true,
            hits: 5000,
            hitsMax: 5000,
            id: "spawn",
            name: "Spawn1",
            pos: position(11, 10),
            spawning: null,
            store: store(300, spawnEnergy),
          },
        ],
        storedStructures: [
          {
            hits: 250000,
            hitsMax: 250000,
            id: "container",
            ownerUsername: null,
            ownership: "unowned",
            pos: position(10, 11),
            store: store(2000, 200),
            structureType: "container",
            ticksToDecay: 5000,
          },
          {
            hits: 10000,
            hitsMax: 10000,
            id: "storage",
            ownerUsername: "me",
            ownership: "owned",
            pos: position(15, 15),
            store: store(1000000, 300),
            structureType: "storage",
            ticksToDecay: null,
          },
        ],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 2,
        tombstones: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function position(x: number, y: number) {
  return { roomName: "W1N1", x, y };
}
