import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_HAULING_POLICY_V1,
  planLogistics,
  projectLogisticsContracts,
  projectRemoteHauling,
  type RemoteHaulingBudgetEntry,
  type RemoteHaulingObjectiveEvidence,
} from "../src/logistics";
import { planLogisticsRuntime } from "../src/logistics/runtime";
import {
  ContractLedger,
  normalizeContractRequest,
  serializeContractLedgerState,
} from "../src/contracts";
import type { RemoteMiningDisposition } from "../src/remotes";
import type { RoomIntelQueryResult } from "../src/world/intel";
import type { OwnedRoomSnapshot, RoomSnapshot, WorldSnapshot } from "../src/world/snapshot";
import type { RoutePlanResult } from "../src/world/routes";

describe("loss-aware remote hauling projection", () => {
  it("requires donor funding before LogisticsPlanner admits one exactly sized routed flow", () => {
    const first = project([]);
    expect(first.projection.edges).toEqual([]);
    expect(first.budgetRequests[0]).toMatchObject({
      category: "harvesting-filling",
      colonyId: "W1N1",
      cpu: { desired: 50, minimum: 50 },
      energy: { desired: 1_600, minimum: 1_600 },
      spawn: null,
    });
    expect(first.dispositions[0]).toMatchObject({
      carry: 16,
      move: 16,
      predictedPickupAmount: 800,
      reason: "budget-unavailable",
    });
    const funded = project(first.budgetRequests.map(activeBudget));
    const plan = planLogistics({
      edges: funded.projection.edges,
      maximumNodeAge: 0,
      nodes: funded.projection.nodes,
      planningHorizon: 50,
      tick: 100,
    });
    expect(plan.projections[0]).toMatchObject({
      admittedAmount: 800,
      blocker: null,
      recommendedCarry: 16,
      recommendedMove: 16,
    });
    expect(funded.metrics).toMatchObject({
      idleSources: 0,
      plannedEmptyTravelTicks: 40,
      plannedLoadedTravelTicks: 40,
    });
    const contract = projectLogisticsContracts({
      endpoints: funded.projection.endpoints,
      nodes: funded.projection.nodes,
      plan,
      previous: [],
      progress: [],
      tick: 100,
    }).commitments[0]?.request;
    if (contract === null || contract === undefined) throw new Error("expected routed contract");
    expect(contract).toMatchObject({
      requiredCapability: { carry: 16, move: 16 },
      execution: {
        acquireOriginRoomName: "W1N1",
        acquireRouteRoomNames: ["W1N2"],
        deliverOriginRoomName: "W1N2",
        deliverRouteRoomNames: ["W1N1"],
        sinkBaselineAmount: 995_000,
        stage: "acquire",
        version: 6,
      },
    });
    expect(normalizeContractRequest(contract).execution).toEqual(contract.execution);
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected ledger");
    const submission = opened.ledger.submit(contract, 100);
    if (submission.contractId === null) throw new Error("expected contract id");
    opened.ledger.reconcile({
      actors: [hauler("under", 15), hauler("exact", 16), hauler("over", 17)],
      funding: {
        authorizations: [
          {
            category: contract.budgetBinding.category,
            colonyId: contract.owner.id,
            expiresAt: contract.expiresAt,
            issuer: contract.budgetBinding.issuer,
            reservationId: "haul-grant",
            revision: 1,
            status: "active",
          },
        ],
        owners: [{ id: contract.owner.id, visibility: "visible" }],
        status: "ready",
      },
      requests: [],
      tick: 101,
      transitions: [
        { contractId: submission.contractId, reason: "test-funded", tick: 101, to: "funded" },
      ],
      travel: { estimate: () => 40 },
    });
    expect(opened.ledger.executionView().leases[0]?.actorId).toBe("exact");
    expect(opened.ledger.populationView().loads[0]?.minimumCapability).toMatchObject({
      carry: 16,
      move: 16,
    });
    const serialized = serializeContractLedgerState(opened.ledger.view());
    const reopened = ContractLedger.open(JSON.parse(JSON.stringify(serialized)) as unknown);
    expect(reopened.status).toBe("ready");
  });

  it("continues observed delivery without remote vision and never counts death as delivery", () => {
    const initial = project([]);
    const funded = project(initial.budgetRequests.map(activeBudget));
    const plan = planLogistics({
      edges: funded.projection.edges,
      maximumNodeAge: 0,
      nodes: funded.projection.nodes,
      planningHorizon: 50,
      tick: 100,
    });
    const acquire = projectLogisticsContracts({
      endpoints: funded.projection.endpoints,
      nodes: funded.projection.nodes,
      plan,
      previous: [],
      progress: [],
      tick: 100,
    }).commitments[0];
    if (acquire === undefined) throw new Error("expected acquire");
    const deliver = projectLogisticsContracts({
      endpoints: funded.projection.endpoints,
      nodes: funded.projection.nodes,
      plan,
      previous: [acquire],
      progress: [
        { actorState: "alive", cargoAmount: 800, deliveredAmount: 0, flowId: acquire.flowId },
      ],
      tick: 101,
    }).commitments[0];
    if (deliver === undefined) throw new Error("expected deliver");
    const sink = funded.projection.endpoints.find(({ targetId }) => targetId === "storage-a");
    if (sink === undefined) throw new Error("expected sink");
    const continuation = projectLogisticsContracts({
      endpoints: [{ ...sink, observedAt: 102 }],
      nodes: [],
      plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
      previous: [deliver],
      progress: [
        { actorState: "alive", cargoAmount: 500, deliveredAmount: 300, flowId: deliver.flowId },
      ],
      tick: 102,
    }).commitments[0];
    expect(continuation).toMatchObject({
      deliveredAmount: 300,
      reason: "active",
      stage: "deliver",
    });
    expect(continuation?.request?.execution).toMatchObject({ stage: "deliver", version: 6 });
    const died = projectLogisticsContracts({
      endpoints: [{ ...sink, observedAt: 103 }],
      nodes: [],
      plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
      previous: [deliver],
      progress: [
        { actorState: "dead", cargoAmount: 0, deliveredAmount: 0, flowId: deliver.flowId },
      ],
      tick: 103,
    });
    expect(died.commitments[0]).toMatchObject({
      cycle: 1,
      deliveredAmount: 0,
      reason: "source-vanished",
      request: null,
      stage: "acquire",
    });
    expect(died.retirements[0]?.to).toBe("failed");
  });

  it("retires the old flow before a route-revision replacement", () => {
    const initial = project([]);
    const budgets = initial.budgetRequests.map(activeBudget);
    const first = project(budgets);
    const firstPlan = planLogistics({
      edges: first.projection.edges,
      maximumNodeAge: 0,
      nodes: first.projection.nodes,
      planningHorizon: 50,
      tick: 100,
    });
    const old = projectLogisticsContracts({
      endpoints: first.projection.endpoints,
      nodes: first.projection.nodes,
      plan: firstPlan,
      previous: [],
      progress: [],
      tick: 100,
    }).commitments[0];
    if (old === undefined) throw new Error("expected old flow");
    const changed = project(budgets, evidence({ routeRevision: "v2" }));
    expect(changed.projection.edges, JSON.stringify(changed.dispositions)).toHaveLength(1);
    const changedNodes = changed.projection.nodes.map((node) => ({ ...node, observedAt: 101 }));
    const changedEndpoints = changed.projection.endpoints.map((endpoint) => ({
      ...endpoint,
      observedAt: 101,
    }));
    const changedPlan = planLogistics({
      edges: changed.projection.edges,
      maximumNodeAge: 0,
      nodes: changedNodes,
      planningHorizon: 50,
      tick: 101,
    });
    const replacement = projectLogisticsContracts({
      endpoints: changedEndpoints,
      nodes: changedNodes,
      plan: changedPlan,
      previous: [old],
      progress: [],
      tick: 101,
    });
    expect(replacement.retirements).toEqual([expect.objectContaining({ to: "failed" })]);
    expect(
      replacement.commitments.some(
        ({ flowId, request }) => flowId !== old.flowId && request?.execution?.version === 6,
      ),
      JSON.stringify(replacement.commitments),
    ).toBe(true);
  });

  it("revises flow identity when predicted loss changes under the same route request", () => {
    const withoutLossInput = evidence({ loss: 0 });
    const withoutLoss = project(
      project([], withoutLossInput).budgetRequests.map(activeBudget),
      withoutLossInput,
    );
    const withLossInput = evidence({ loss: 1_000 });
    const withLoss = project(
      project([], withLossInput).budgetRequests.map(activeBudget),
      withLossInput,
    );
    expect(withoutLoss.projection.edges).toHaveLength(1);
    expect(withLoss.projection.edges).toHaveLength(1);
    expect(withLoss.projection.edges[0]?.id).not.toBe(withoutLoss.projection.edges[0]?.id);
  });

  it("rebaselines delivery, retains loaded cargo under sink pressure, and starts another cycle", () => {
    const initial = project([]);
    const funded = project(initial.budgetRequests.map(activeBudget));
    const plan = planLogistics({
      edges: funded.projection.edges,
      maximumNodeAge: 0,
      nodes: funded.projection.nodes,
      planningHorizon: 50,
      tick: 100,
    });
    const acquire = projectLogisticsContracts({
      endpoints: funded.projection.endpoints,
      nodes: funded.projection.nodes,
      plan,
      previous: [],
      progress: [],
      tick: 100,
    }).commitments[0];
    if (acquire === undefined) throw new Error("expected acquire");
    const endpointsAtPickup = funded.projection.endpoints.map((endpoint) => ({
      ...endpoint,
      observedAmount: endpoint.targetId === "storage-a" ? 995_200 : endpoint.observedAmount,
      observedAt: 101,
    }));
    const deliver = projectLogisticsContracts({
      endpoints: endpointsAtPickup,
      nodes: funded.projection.nodes.map((node) => ({ ...node, observedAt: 101 })),
      plan: {
        ...plan,
        projections: plan.projections.map((flow) => ({ ...flow, admittedAmount: 800 })),
      },
      previous: [acquire],
      progress: [
        { actorState: "alive", cargoAmount: 800, deliveredAmount: 0, flowId: acquire.flowId },
      ],
      tick: 101,
    }).commitments[0];
    expect(deliver?.request?.execution).toMatchObject({
      reservedAmount: 800,
      sinkBaselineAmount: 995_200,
      stage: "deliver",
      version: 6,
    });
    if (deliver === undefined) throw new Error("expected deliver");
    const pressured = projectLogisticsContracts({
      endpoints: endpointsAtPickup.map((endpoint) =>
        endpoint.targetId === "storage-a"
          ? { ...endpoint, freeCapacity: 0, observedAt: 102 }
          : { ...endpoint, observedAt: 102 },
      ),
      nodes: [],
      plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
      previous: [deliver],
      progress: [
        { actorState: "alive", cargoAmount: 800, deliveredAmount: 0, flowId: deliver.flowId },
      ],
      tick: 102,
    });
    expect(pressured.retirements).toEqual([]);
    expect(pressured.commitments[0]).toMatchObject({ reason: "sink-full", stage: "deliver" });
    expect(pressured.commitments[0]?.request?.execution).toMatchObject({
      stage: "deliver",
      version: 6,
    });

    const completed = projectLogisticsContracts({
      endpoints: endpointsAtPickup.map((endpoint) =>
        endpoint.targetId === "storage-a"
          ? { ...endpoint, observedAmount: 996_000, observedAt: 103 }
          : { ...endpoint, observedAt: 103 },
      ),
      nodes: funded.projection.nodes.map((node) => ({ ...node, observedAt: 103 })),
      plan: {
        ...plan,
        projections: plan.projections.map((flow) => ({ ...flow, admittedAmount: 800 })),
      },
      previous: [deliver],
      progress: [
        { actorState: "alive", cargoAmount: 0, deliveredAmount: 800, flowId: deliver.flowId },
      ],
      tick: 103,
    });
    expect(completed.retirements).toEqual([expect.objectContaining({ to: "completed" })]);
    expect(completed.commitments[0]).toMatchObject({
      cycle: 1,
      deliveredAmount: 0,
      reason: "active",
      stage: "acquire",
    });
    expect(completed.commitments[0]?.request).toMatchObject({ issuerSequence: 2 });
    expect(completed.commitments[0]?.request?.execution).toMatchObject({
      sinkBaselineAmount: 996_000,
      stage: "acquire",
      version: 6,
    });
  });

  it("attributes sink gain to live cargo reduction and rejects a no-longer-owned sink", () => {
    const initial = project([]);
    const funded = project(initial.budgetRequests.map(activeBudget));
    const plan = planLogistics({
      edges: funded.projection.edges,
      maximumNodeAge: 0,
      nodes: funded.projection.nodes,
      planningHorizon: 50,
      tick: 100,
    });
    const acquire = projectLogisticsContracts({
      endpoints: funded.projection.endpoints,
      nodes: funded.projection.nodes,
      plan,
      previous: [],
      progress: [],
      tick: 100,
    }).commitments[0];
    if (acquire === undefined) throw new Error("expected acquire");
    const deliver = projectLogisticsContracts({
      endpoints: funded.projection.endpoints.map((endpoint) => ({ ...endpoint, observedAt: 101 })),
      nodes: funded.projection.nodes.map((node) => ({ ...node, observedAt: 101 })),
      plan,
      previous: [acquire],
      progress: [
        { actorState: "alive", cargoAmount: 800, deliveredAmount: 0, flowId: acquire.flowId },
      ],
      tick: 101,
    }).commitments[0]?.request;
    if (deliver?.execution?.version !== 6 || deliver.targetId === null)
      throw new Error("expected routed deliver request");

    const unrelatedGain = planLogisticsRuntime({
      execution: executionView(deliver),
      includeOptional: false,
      planning: planningView(deliver),
      snapshot: haulingSnapshot(101, 995_800, 800, true),
      tick: 101,
    });
    expect(unrelatedGain.contracts.commitments[0]).toMatchObject({
      deliveredAmount: 0,
      reason: "active",
      stage: "deliver",
    });

    const transferred = planLogisticsRuntime({
      execution: executionView(deliver),
      includeOptional: false,
      planning: planningView(deliver),
      snapshot: haulingSnapshot(101, 995_800, 0, true),
      tick: 101,
    });
    expect(transferred.contracts.commitments[0]).toMatchObject({
      cycle: 1,
      deliveredAmount: 0,
      stage: "acquire",
    });
    expect(transferred.contracts.retirements).toEqual([
      expect.objectContaining({ reason: "logistics-flow-complete", to: "completed" }),
    ]);

    const lostOwnership = planLogisticsRuntime({
      execution: executionView(deliver),
      includeOptional: false,
      planning: planningView(deliver),
      snapshot: haulingSnapshot(101, 995_000, 800, false),
      tick: 101,
    });
    expect(lostOwnership.contracts.commitments[0]).toMatchObject({
      reason: "sink-vanished",
      request: null,
    });
  });

  it("prices predicted loss and official dropped-resource decay", () => {
    const result = project([], evidence({ containerEnergy: 0, dropEnergy: 800, loss: 1_000 }));
    expect(result.dispositions[0]).toMatchObject({
      acquireAction: "pickup",
      carry: 18,
      move: 18,
      predictedPickupAmount: 760,
      predictedTransitLoss: 89,
    });
    expect(result.budgetRequests[0]?.energy).toEqual({ desired: 1_800, minimum: 1_800 });
  });

  it("falls back from full storage to terminal and blocks when every sink is full", () => {
    expect(
      project([], evidence({ storageFree: 0, terminalFree: 2_000 })).dispositions[0],
    ).toMatchObject({ reason: "budget-unavailable", sinkTargetId: "terminal-a" });
    const blocked = project([], evidence({ storageFree: 0, terminalFree: 0 }));
    expect(blocked.budgetRequests).toEqual([]);
    expect(blocked.dispositions[0]?.reason).toBe("sink-full");
  });

  it("fails closed on threat, stale intel, invalid routes, and malformed budget receipts", () => {
    for (const value of [
      evidence({ threatRisk: 1 }),
      evidence({ freshness: "stale" }),
      evidence({ deliverOrigin: "W9N9" }),
    ]) {
      const result = project([], value);
      expect(result.budgetRequests).toEqual([]);
      expect(result.projection.edges).toEqual([]);
    }
    const request = project([]).budgetRequests[0];
    if (request === undefined) throw new Error("expected budget request");
    const malformed = projectRemoteHauling({
      budgets: [{ ...activeBudget(request), revision: -1 }],
      objectives: [evidence()],
      policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
      tick: 100,
    });
    expect(malformed.status).toBe("invalid-input");
    expect(malformed.projection.edges).toEqual([]);
  });

  it("is deterministic across objective, budget, and observation reorder", () => {
    const left = evidence();
    const right = evidence({ roomName: "W1N3" });
    const initial = projectRemoteHauling({
      budgets: [],
      objectives: [left, right],
      policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
      tick: 100,
    });
    const budgets = initial.budgetRequests.map(activeBudget);
    const ordered = projectRemoteHauling({
      budgets,
      objectives: [left, right],
      policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
      tick: 100,
    });
    const reordered = projectRemoteHauling({
      budgets: [...budgets].reverse(),
      objectives: [reorder(right), reorder(left)],
      policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
      tick: 100,
    });
    expect(reordered).toEqual(ordered);
  });
});

function project(budgets: readonly RemoteHaulingBudgetEntry[], value = evidence()) {
  return projectRemoteHauling({
    budgets,
    objectives: [value],
    policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
    tick: 100,
  });
}
function evidence(
  overrides: {
    containerEnergy?: number;
    deliverOrigin?: string;
    dropEnergy?: number;
    freshness?: RoomIntelQueryResult["freshness"];
    loss?: number;
    roomName?: string;
    routeRevision?: string;
    storageFree?: number;
    terminalFree?: number;
    threatRisk?: number;
  } = {},
): RemoteHaulingObjectiveEvidence {
  const roomName = overrides.roomName ?? "W1N2";
  const commitment = { cpuMilli: 2_000, energy: 20_000, memoryCodeUnits: 8_192, spawnTicks: 500 };
  const revision = overrides.routeRevision ?? "v1";
  const acquireRoute = route("W1N1", roomName, `acquire/${roomName}/${revision}`);
  return {
    acquireRoute,
    candidate: {
      commitment,
      controller: "self-reserved",
      costs: {
        body: 1,
        cpu: 1,
        expectedLoss: 1,
        hauling: 1,
        latency: 1,
        repair: 1,
        reservation: 1,
        roads: 1,
        spawn: 1,
      },
      donor: "healthy",
      donorColonyId: "W1N1",
      evidenceRevision: `evidence/${roomName}`,
      expiresAt: 2_000,
      intel: intel(roomName, overrides.freshness ?? "current"),
      roomName,
      route: acquireRoute,
      threatRisk: overrides.threatRisk ?? 0,
    },
    deliverRoute: route(
      overrides.deliverOrigin ?? roomName,
      "W1N1",
      `deliver/${roomName}/${revision}`,
    ),
    donorRoom: donor(overrides.storageFree ?? 5_000, overrides.terminalFree ?? 0),
    mining: [mining(roomName)],
    objective: {
      commitment,
      donorColonyId: "W1N1",
      profit: 10_000,
      revision: 2,
      roomName,
      state: "active",
    },
    predictedLossBasisPoints: overrides.loss ?? 0,
    remoteRoom: remote(roomName, overrides.containerEnergy ?? 800, overrides.dropEnergy ?? 0),
  };
}
function mining(roomName: string): RemoteMiningDisposition {
  return {
    infrastructureReason: "container-active",
    miningReason: "contract-active",
    offload: "container",
    replacementLeadTicks: 95,
    roomName,
    sourceId: `source/${roomName}`,
    workPosition: { roomName, x: 9, y: 9 },
  };
}
function intel(
  roomName: string,
  freshness: RoomIntelQueryResult["freshness"],
): RoomIntelQueryResult {
  return {
    freshness,
    generation: null,
    quality: "complete",
    reason: freshness === "stale" ? "age-limit" : "current-observation",
    record: {
      complete: true,
      controller: null,
      eventLogStatus: "observed",
      events: [],
      eventsObservedAt: 99,
      hostileStatus: "complete",
      hostiles: [],
      mineral: null,
      mineralStatus: "complete",
      observedAt: freshness === "stale" ? 50 : 100,
      roomName,
      schemaVersion: 1,
      shard: "shard0",
      sourceStatus: "complete",
      sources: [{ energyCapacity: 3_000, id: `source/${roomName}`, pos: { x: 10, y: 10 } }],
      structureStatus: "complete",
      structures: [],
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
    },
    roomName,
  };
}
function route(
  originRoomName: string,
  destinationRoomName: string,
  requestId: string,
): RoutePlanResult {
  return {
    metrics: {
      cacheHits: 0,
      consideredEdges: 1,
      expandedRooms: 1,
      reason: "route-computed",
      risk: 0,
      routeRooms: 1,
      totalCost: 100,
    },
    plan: {
      destinationRoomName,
      estimate: {
        outboundTicks: 40,
        plainSteps: 50,
        returnTicks: 40,
        roadBodyPartSteps: 0,
        roadSteps: 0,
        roundTripTicks: 80,
        swampSteps: 0,
        throughputMilliCapacityPerTick: 1_250,
      },
      originRoomName,
      requestId,
      risk: 0,
      roomNames: [destinationRoomName],
      schemaVersion: 1,
      totalCost: 100,
    },
    reason: "route-computed",
    source: "search",
    status: "ready",
  };
}
function remote(roomName: string, containerEnergy: number, dropEnergy: number): RoomSnapshot {
  const container = structure(
    `container/${roomName}`,
    "container",
    roomName,
    2_000,
    containerEnergy,
    "unowned",
  );
  return room(roomName, {
    droppedResources:
      dropEnergy === 0
        ? []
        : [
            {
              amount: dropEnergy,
              id: `drop/${roomName}`,
              pos: { roomName, x: 9, y: 9 },
              resourceType: "energy",
            },
          ],
    sources: [
      {
        energy: 3_000,
        energyCapacity: 3_000,
        id: `source/${roomName}`,
        pos: { roomName, x: 10, y: 10 },
        ticksToRegeneration: null,
      },
    ],
    storedStructures: [container],
  });
}
function donor(storageFree: number, terminalFree: number): RoomSnapshot {
  return room("W1N1", {
    controller: {
      id: "controller/W1N1",
      level: 8,
      ownerUsername: "self",
      ownership: "owned",
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: null,
      progressTotal: null,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 100_000,
      upgradeBlocked: null,
    },
    storedStructures: [
      structure("storage-a", "storage", "W1N1", 1_000_000, 1_000_000 - storageFree, "owned"),
      structure("terminal-a", "terminal", "W1N1", 300_000, 300_000 - terminalFree, "owned"),
    ],
  });
}
function structure(
  id: string,
  structureType: string,
  roomName: string,
  capacity: number,
  energy: number,
  ownership: "owned" | "unowned",
) {
  return {
    hits: 250_000,
    hitsMax: 250_000,
    id,
    ownerUsername: ownership === "owned" ? "self" : null,
    ownership,
    pos: {
      roomName,
      x: structureType === "container" ? 9 : structureType === "storage" ? 20 : 21,
      y: structureType === "container" ? 9 : 20,
    },
    store: {
      capacity,
      freeCapacity: capacity - energy,
      resources:
        energy === 0 ? [] : [{ amount: energy, resourceType: "energy" as ResourceConstant }],
      usedCapacity: energy,
    },
    structureType,
    ticksToDecay: structureType === "container" ? 100 : null,
  };
}
function room(name: string, overrides: Partial<RoomSnapshot>): RoomSnapshot {
  return {
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name,
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    traversal: { revision: `traversal/${name}`, walkability: ".".repeat(2_500) },
    ...overrides,
  };
}
function activeBudget(
  request: ReturnType<typeof project>["budgetRequests"][number],
): RemoteHaulingBudgetEntry {
  return {
    category: request.category,
    colonyId: request.colonyId,
    expiresAt: request.expiresAt,
    grant: { cpu: request.cpu?.desired ?? 0, energy: request.energy?.desired ?? 0, spawn: null },
    issuer: request.issuer,
    revision: request.revision,
    status: "active",
  };
}
function planningView(
  request: NonNullable<
    ReturnType<typeof projectLogisticsContracts>["commitments"][number]["request"]
  >,
) {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("expected executable request");
  return {
    contracts: [
      {
        budgetBinding: request.budgetBinding,
        contractId: "remote-haul-contract",
        earliestStart: request.earliestStart,
        execution: request.execution,
        issuer: request.issuer,
        issuerSequence: request.issuerSequence,
        owner: request.owner,
        state: "active" as const,
        targetId: request.targetId,
      },
    ],
    status: "ready" as const,
  };
}
function executionView(
  request: NonNullable<
    ReturnType<typeof projectLogisticsContracts>["commitments"][number]["request"]
  >,
) {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("expected executable request");
  return {
    leases: [
      {
        actorId: "hauler-a",
        actorName: "hauler-a",
        contractId: "remote-haul-contract",
        deadline: request.deadline,
        execution: request.execution,
        expiresAt: request.expiresAt,
        leaseExpiresAt: request.expiresAt,
        priority: request.priority,
        quantity: request.quantity,
        range: request.range,
        revision: 1,
        state: "active" as const,
        target: request.target,
        targetId: request.targetId,
      },
    ],
    status: "ready" as const,
  };
}
function haulingSnapshot(
  tick: number,
  sinkEnergy: number,
  cargo: number,
  owned: boolean,
): WorldSnapshot {
  const donorRoom = donor(1_000_000 - sinkEnergy, 0);
  const controller = donorRoom.controller;
  const storage = donorRoom.storedStructures.find(({ id }) => id === "storage-a");
  if (controller === null || storage === undefined) throw new Error("expected donor fixtures");
  const rooms = [
    {
      ...donorRoom,
      controller: {
        ...controller,
        ownerUsername: owned ? "self" : "other",
        ownership: owned ? ("owned" as const) : ("foreign" as const),
      },
      observedAt: tick,
      ownedCreeps: [haulerSnapshot(cargo)],
      storedStructures: donorRoom.storedStructures.map((structure) =>
        structure.id === storage.id
          ? {
              ...structure,
              ownerUsername: owned ? "self" : "other",
              ownership: owned ? ("owned" as const) : ("foreign" as const),
            }
          : structure,
      ),
    },
  ];
  return {
    observation: { age: 0 as const, shard: "shard0", status: "observed" as const, tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: owned ? ([rooms[0]] as readonly OwnedRoomSnapshot[]) : [],
    rooms,
    schemaVersion: 1 as const,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 2,
        tombstones: 0,
        total: 4,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: {
      absentRoomSemantics: "unknown" as const,
      rooms: [{ age: 0, observedAt: tick, roomName: "W1N1", status: "visible" }],
      scope: "current-tick" as const,
    },
  };
}
function haulerSnapshot(cargo: number) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 32,
      attack: zero,
      carry: { active: 16, boosted: 0, total: 16 },
      claim: zero,
      heal: zero,
      move: { active: 16, boosted: 0, total: 16 },
      rangedAttack: zero,
      size: 32,
      tough: zero,
      work: zero,
    },
    fatigue: 0,
    hits: 3_200,
    hitsMax: 3_200,
    id: "hauler-a",
    name: "hauler-a",
    ownerUsername: "self",
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning: false,
    store: {
      capacity: 800,
      freeCapacity: 800 - cargo,
      resources: cargo === 0 ? [] : [{ amount: cargo, resourceType: "energy" as ResourceConstant }],
      usedCapacity: cargo,
    },
    ticksToLive: 1_000,
  };
}
function hauler(id: string, carry: number) {
  return {
    capability: {
      attack: 0,
      carry,
      claim: 0,
      heal: 0,
      move: carry,
      rangedAttack: 0,
      tough: 0,
      work: 0,
    },
    energy: 0,
    freeCapacity: carry * 50,
    fatigue: 0,
    id,
    movementWeight: carry,
    name: id,
    pos: { roomName: "W1N1", x: 25, y: 25 },
    spawning: false,
    ticksToLive: 1_500,
  };
}
function reorder(value: RemoteHaulingObjectiveEvidence): RemoteHaulingObjectiveEvidence {
  return {
    ...value,
    donorRoom:
      value.donorRoom === null
        ? null
        : { ...value.donorRoom, storedStructures: [...value.donorRoom.storedStructures].reverse() },
    mining: [...value.mining].reverse(),
    remoteRoom:
      value.remoteRoom === null
        ? null
        : {
            ...value.remoteRoom,
            droppedResources: [...(value.remoteRoom.droppedResources ?? [])].reverse(),
            storedStructures: [...value.remoteRoom.storedStructures].reverse(),
          },
  };
}
