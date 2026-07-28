import { describe, expect, it } from "vitest";
import { ColonyPopulationPolicy } from "../src/colony";
import {
  ContractLedger,
  contractIdFor,
  normalizeContractRequest,
  type ContractPlanningRecord,
  type WorkContractRequest,
} from "../src/contracts";
import {
  CONSTRUCTION_SITE_LIMITS,
  arbitrateConstructionSites,
  deriveConstructionSiteAttemptReceipt,
} from "../src/layout";
import {
  DEFAULT_REMOTE_MINING_POLICY_V1,
  RemoteMiningPlanner,
  type RemoteMiningBudgetEntry,
  type RemoteMiningObjectiveEvidence,
} from "../src/remotes";
import type { RoomIntelQueryResult } from "../src/world/intel";
import type { RoomSnapshot } from "../src/world/snapshot";
import type { RoutePlanResult } from "../src/world/routes";

const planner = new RemoteMiningPlanner();

describe("RemoteMiningPlanner", () => {
  it("requires an exact donor grant before emitting one replacement-aware routed miner contract", () => {
    const first = plan();
    expect(first.status).toBe("ready");
    expect(first.contractRequests).toEqual([]);
    expect(first.budgetRequests).toEqual([
      expect.objectContaining({
        colonyId: "W1N1",
        category: "harvesting-filling",
        issuer: "remote-mining/W1N1/W1N2/source/W1N2",
        energy: { minimum: 750, desired: 750 },
        cpu: { minimum: 50, desired: 50 },
        spawn: null,
      }),
    ]);
    expect(first.dispositions).toEqual([
      expect.objectContaining({
        sourceId: "source/W1N2",
        miningReason: "budget-unavailable",
        infrastructureReason: "mining-unavailable",
        replacementLeadTicks: 105,
        offload: "drop",
      }),
    ]);

    const funded = plan({ budgets: first.budgetRequests.map(activeBudget) });
    const contract = required(funded.contractRequests[0]);
    expect(contract).toMatchObject({
      kind: "harvest",
      owner: { id: "W1N1", kind: "colony" },
      targetId: "source/W1N2",
      requiredCapability: { work: 5, move: 5, carry: 0 },
      execution: {
        action: "harvest",
        completion: "continuous",
        counterpartId: null,
        offload: "container-or-drop",
        originRoomName: "W1N1",
        resourceType: null,
        routeRoomNames: ["W1N2"],
        routeTravelTicks: 50,
        version: 5,
        workPosition: { roomName: "W1N2", x: 9, y: 9 },
      },
    });
    expect(normalizeContractRequest(contract).execution).toEqual(contract.execution);
    expect(JSON.stringify(contract).length).toBeLessThanOrEqual(4_096);
  });

  it("rejects a route that cannot leave one bounded productive lifetime", () => {
    const result = plan({ evidence: evidence({ routeTravelTicks: 1_300 }) });
    expect(result.budgetRequests).toEqual([]);
    expect(result.contractRequests).toEqual([]);
    expect(result.dispositions[0]?.miningReason).toBe("timeout");
  });

  it("admits profitable container and road capital only after exact funding and site arbitration", () => {
    const containerEvidence = evidence({ visibleRoom: visibleRoom() });
    const first = plan({ evidence: containerEvidence });
    expect(first.budgetRequests.map(({ category }) => category)).toEqual(["harvesting-filling"]);
    expect(first.siteProposals).toEqual([]);
    expect(first.dispositions[0]?.infrastructureReason).toBe("mining-unavailable");
    const miningFunded = plan({
      evidence: containerEvidence,
      budgets: first.budgetRequests.map(activeBudget),
    });
    expect(miningFunded.siteProposals).toEqual([]);
    expect(miningFunded.dispositions[0]?.infrastructureReason).toBe("container-budget-unavailable");

    const funded = plan({
      evidence: containerEvidence,
      budgets: miningFunded.budgetRequests.map(activeBudget),
    });
    expect(funded.siteProposals).toEqual([
      expect.objectContaining({
        colonyId: "W1N1",
        policyPriority: 1_000,
        pos: { roomName: "W1N2", x: 9, y: 9 },
        structureType: "container",
      }),
    ]);
    const capped = arbitrateConstructionSites({
      globalOwnedSiteCount: 95,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName: "W1N2" }],
      priorReceipts: [],
      progressionAuthorizations: funded.siteAuthorizations,
      proposals: funded.siteProposals,
      tick: 100,
    });
    expect(capped.intents).toEqual([]);
    expect(capped.deferred[0]?.reason).toBe("global-headroom");
    const accepted = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName: "W1N2" }],
      priorReceipts: [],
      progressionAuthorizations: funded.siteAuthorizations,
      proposals: funded.siteProposals,
      tick: 100,
    });
    expect(accepted.intents[0]).toEqual(
      expect.objectContaining({
        remoteAuthorization: { controller: "self-reserved", reservationUsername: "self" },
      }),
    );
    const receipt = deriveConstructionSiteAttemptReceipt(
      { code: "ERR_FULL", proposal: required(funded.siteProposals[0]), tick: 100 },
      [],
    );
    const retryBlocked = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName: "W1N2" }],
      priorReceipts: [receipt],
      progressionAuthorizations: funded.siteAuthorizations,
      proposals: funded.siteProposals,
      tick: 101,
    });
    expect(retryBlocked.intents).toEqual([]);
    expect(retryBlocked.deferred[0]?.reason).toBe("receipt-full-backoff");

    const roadEvidence = evidence({
      visibleRoom: visibleRoom({ containerEnergy: 2_000 }),
      roadCandidates: [
        {
          expectedBodyPartUses: 400_000,
          pos: { roomName: "W1N2", x: 8, y: 9 },
          routeRevision: "route/W1N1/W1N2/v1",
          sourceId: "source/W1N2",
          terrain: "plain",
        },
      ],
    });
    const roadFirst = plan({ evidence: roadEvidence });
    const roadBudgeted = plan({
      evidence: roadEvidence,
      budgets: roadFirst.budgetRequests.map(activeBudget),
    });
    const roadFunded = plan({
      evidence: roadEvidence,
      budgets: roadBudgeted.budgetRequests.map(activeBudget),
    });
    expect(roadFunded.siteProposals).toEqual([
      expect.objectContaining({
        pos: { roomName: "W1N2", x: 8, y: 9 },
        structureType: "road",
      }),
    ]);
    expect(roadFunded.dispositions[0]).toEqual(
      expect.objectContaining({
        offload: "container-full-drop",
        infrastructureReason: "road-proposed",
      }),
    );
  });

  it("does not authorize capital when extraction funding is unavailable", () => {
    const current = evidence({ visibleRoom: visibleRoom() });
    const first = plan({ evidence: current });
    const capitalRequest = plan({
      budgets: first.budgetRequests.map(activeBudget),
      evidence: current,
    });
    const capitalOnly = capitalRequest.budgetRequests
      .filter(({ category }) => category === "optional-growth")
      .map(activeBudget);
    const blocked = plan({ budgets: capitalOnly, evidence: current });
    expect(blocked.siteProposals).toEqual([]);
    expect(blocked.siteAuthorizations).toEqual([]);
    expect(blocked.dispositions[0]).toMatchObject({
      infrastructureReason: "mining-unavailable",
      miningReason: "budget-unavailable",
    });
  });

  it("does not spend one room-profit forecast independently for every source", () => {
    const current = multiSourceEvidence();
    const mining = plan({ evidence: current });
    expect(
      mining.budgetRequests.filter(({ category }) => category === "harvesting-filling"),
    ).toHaveLength(2);
    const capital = plan({
      budgets: mining.budgetRequests.map(activeBudget),
      evidence: current,
    });
    expect(
      capital.budgetRequests.filter(({ category }) => category === "optional-growth"),
    ).toHaveLength(1);
    expect(capital.dispositions.map(({ infrastructureReason }) => infrastructureReason)).toEqual([
      "container-budget-unavailable",
      "capital-not-profitable",
    ]);
  });

  it("suspends unsafe work, replaces changed routes, and caps command retries", () => {
    const first = plan();
    const budget = activeBudget(required(first.budgetRequests[0]));
    const request = required(plan({ budgets: [budget] }).contractRequests[0]);
    const active = planningRecord(request, "active");
    const blocked = plan({
      contracts: [active],
      evidence: evidence({ routeStatus: "no-route" }),
    });
    expect(blocked.contractRequests).toEqual([]);
    expect(blocked.transitions).toEqual([
      expect.objectContaining({ contractId: active.contractId, to: "suspended" }),
    ]);
    expect(blocked.dispositions[0]?.miningReason).toBe("route-unavailable");

    const changedRoute = evidence({
      routeRequestId: "route/W1N1/W1N2/v2",
      routeTravelTicks: 60,
    });
    const replaced = plan({ budgets: [budget], contracts: [active], evidence: changedRoute });
    expect(replaced.transitions).toEqual([
      expect.objectContaining({ contractId: active.contractId, to: "cancelled" }),
    ]);
    expect(replaced.contractRequests[0]?.issuerSequence).toBe(2);

    const retrying = planningRecord(request, "suspended", { attempts: 3, eligibleAt: 90 });
    const exhausted = plan({ budgets: [budget], contracts: [retrying] });
    expect(exhausted.transitions).toEqual([]);
    expect(exhausted.dispositions[0]?.miningReason).toBe("retry-exhausted");
  });

  it("makes bounded suspension progress instead of discarding an oversized transition batch", () => {
    const first = plan();
    const grant = activeBudget(required(first.budgetRequests[0]));
    const base = required(plan({ budgets: [grant] }).contractRequests[0]);
    const contracts = Array.from({ length: 33 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      const issuer = `remote-mining/W1N1/W9N9/source-${suffix}`;
      return planningRecord(
        {
          ...base,
          budgetBinding: { ...base.budgetBinding, issuer },
          issuer,
          issuerKey: `source-${suffix}`,
          targetId: `source-${suffix}`,
        },
        "active",
      );
    });
    const batch = planner.plan({
      budgets: [],
      contracts: { contracts, status: "ready" },
      objectives: [],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 100,
    });
    expect(batch.status).toBe("ready");
    expect(batch.transitions).toHaveLength(32);
    const transitioned = new Set(batch.transitions.map(({ contractId }) => contractId));
    const following = planner.plan({
      budgets: [],
      contracts: {
        contracts: contracts.map((contract) =>
          transitioned.has(contract.contractId)
            ? { ...contract, state: "suspended" as const }
            : contract,
        ),
        status: "ready",
      },
      objectives: [],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 101,
    });
    expect(following.status).toBe("ready");
    expect(following.transitions).toHaveLength(1);
  });

  it("is deterministic across objective, road, and funding reordering", () => {
    const left = evidence({
      visibleRoom: visibleRoom({ containerEnergy: 0 }),
      roadCandidates: [
        {
          expectedBodyPartUses: 400_000,
          pos: { roomName: "W1N2", x: 8, y: 9 },
          routeRevision: "route/W1N1/W1N2/v1",
          sourceId: "source/W1N2",
          terrain: "plain",
        },
        {
          expectedBodyPartUses: 1,
          pos: { roomName: "W1N2", x: 8, y: 10 },
          routeRevision: "route/W1N1/W1N2/v1",
          sourceId: "source/W1N2",
          terrain: "plain",
        },
      ],
    });
    const right = evidence({ roomName: "W1N3", visibleRoom: null });
    const first = planner.plan({
      budgets: [],
      contracts: { contracts: [], status: "ready" },
      objectives: [left, right],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 100,
    });
    const budgets = first.budgetRequests.map(activeBudget);
    const ordered = planner.plan({
      budgets,
      contracts: { contracts: [], status: "ready" },
      objectives: [left, right],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 100,
    });
    const reordered = planner.plan({
      budgets: [...budgets].reverse(),
      contracts: { contracts: [], status: "ready" },
      objectives: [
        { ...right, roadCandidates: [...right.roadCandidates].reverse() },
        { ...left, roadCandidates: [...left.roadCandidates].reverse() },
      ],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 100,
    });
    expect(reordered).toEqual(ordered);
  });

  it("projects routed mining as one stationary replacement load", () => {
    const first = plan();
    const contract = required(
      plan({ budgets: first.budgetRequests.map(activeBudget) }).contractRequests[0],
    );
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("ledger failed to open");
    expect(opened.ledger.submit(contract, 100).accepted).toBe(true);
    const contractId = contractIdFor(contract.issuer, contract.issuerKey, contract.issuerSequence);
    opened.ledger.reconcile({
      actors: [
        {
          capability: {
            attack: 0,
            carry: 0,
            claim: 0,
            heal: 0,
            move: 5,
            rangedAttack: 0,
            tough: 0,
            work: 5,
          },
          freeCapacity: 0,
          id: "remote-miner-a",
          name: "remote-miner-a",
          pos: { roomName: "W1N1", x: 25, y: 25 },
          spawning: false,
          ticksToLive: 1_500,
        },
      ],
      funding: {
        authorizations: [
          {
            category: contract.budgetBinding.category,
            colonyId: contract.owner.id,
            expiresAt: contract.expiresAt,
            issuer: contract.budgetBinding.issuer,
            reservationId: "remote-mining-grant",
            revision: contract.issuerSequence,
            status: "active",
          },
        ],
        owners: [{ id: contract.owner.id, visibility: "visible" }],
        status: "ready",
      },
      requests: [],
      tick: 100,
      transitions: [{ contractId, reason: "test-funded", tick: 100, to: "funded" }],
      travel: { estimate: () => 50 },
    });
    expect(opened.ledger.executionView().leases[0]).toMatchObject({
      actorId: "remote-miner-a",
      execution: { version: 5 },
    });
    const funded = opened.ledger.populationView();
    expect(funded.loads[0]).toMatchObject({
      colonyId: "W1N1",
      minimumCapability: { work: 5, move: 5 },
      mode: "stationary",
      travelTicks: 50,
    });
    const zero = { attack: 0, carry: 0, claim: 0, heal: 0, rangedAttack: 0, tough: 0 };
    const replacement = new ColonyPopulationPolicy().project({
      activeThreat: false,
      actors: [
        {
          capability: { ...zero, move: 5, work: 5 },
          id: "miner-a",
          name: "miner-a",
          pos: { roomName: "W1N2", x: 9, y: 9 },
          spawning: false,
          ticksToLive: 105,
        },
      ],
      availableEnergy: 1_000,
      colonyId: "W1N1",
      committedDemandIds: [],
      controllerLevel: 8,
      controllerRisk: false,
      cpuMode: "normal",
      funded,
      maximumBodyEnergy: 1_000,
      protectedSpawnEnergy: 0,
      replacementLeadTicks: 25,
      spawnUtilizationBasisPoints: 0,
      state: "developing",
      visibility: "visible",
    });
    expect(replacement.status).toBe("demanded");
    expect(replacement.demands[0]?.requiredCapability).toEqual(
      expect.objectContaining({ move: 5, work: 5 }),
    );
  });
});

function plan(
  overrides: {
    readonly budgets?: readonly RemoteMiningBudgetEntry[];
    readonly contracts?: readonly ContractPlanningRecord[];
    readonly evidence?: RemoteMiningObjectiveEvidence;
  } = {},
) {
  return planner.plan({
    budgets: overrides.budgets ?? [],
    contracts: { contracts: overrides.contracts ?? [], status: "ready" },
    objectives: [overrides.evidence ?? evidence()],
    policy: DEFAULT_REMOTE_MINING_POLICY_V1,
    tick: 100,
  });
}

function activeBudget(
  request: ReturnType<typeof plan>["budgetRequests"][number],
): RemoteMiningBudgetEntry {
  return {
    category: request.category,
    colonyId: request.colonyId,
    expiresAt: request.expiresAt,
    grant: {
      cpu: request.cpu?.desired ?? 0,
      energy: request.energy?.desired ?? 0,
      spawn: null,
    },
    issuer: request.issuer,
    revision: request.revision,
    status: "active",
  };
}

function planningRecord(
  request: WorkContractRequest,
  state: ContractPlanningRecord["state"],
  remoteMiningRetry: ContractPlanningRecord["remoteMiningRetry"] = null,
): ContractPlanningRecord {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("remote mining contract must be executable");
  return {
    budgetBinding: request.budgetBinding,
    contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
    execution: request.execution,
    issuer: request.issuer,
    issuerSequence: request.issuerSequence,
    owner: request.owner,
    remoteMiningRetry,
    repairRetry: null,
    reservationRetry: null,
    requestSignature: JSON.stringify(request),
    state,
    targetId: request.targetId,
  };
}

function evidence(
  overrides: {
    readonly roadCandidates?: RemoteMiningObjectiveEvidence["roadCandidates"];
    readonly roomName?: string;
    readonly routeRequestId?: string;
    readonly routeStatus?: RoutePlanResult["status"];
    readonly routeTravelTicks?: number;
    readonly visibleRoom?: RoomSnapshot | null;
  } = {},
): RemoteMiningObjectiveEvidence {
  const roomName = overrides.roomName ?? "W1N2";
  return {
    objective: {
      commitment: { cpuMilli: 1_000, energy: 10_000, memoryCodeUnits: 4_096, spawnTicks: 100 },
      donorColonyId: "W1N1",
      profit: 10_000,
      revision: 2,
      roomName,
      state: "active",
    },
    candidate: {
      commitment: { cpuMilli: 1_000, energy: 10_000, memoryCodeUnits: 4_096, spawnTicks: 100 },
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
      evidenceRevision: `evidence/${roomName}/v1`,
      expiresAt: 2_000,
      intel: intel(roomName),
      roomName,
      route: route(
        roomName,
        overrides.routeStatus ?? "ready",
        overrides.routeRequestId,
        overrides.routeTravelTicks,
      ),
      threatRisk: 0,
    },
    roadCandidates: overrides.roadCandidates ?? [],
    visibleRoom: overrides.visibleRoom ?? null,
  };
}

function intel(roomName: string): RoomIntelQueryResult {
  return {
    freshness: "current",
    generation: null,
    quality: "complete",
    reason: "current-observation",
    record: {
      complete: true,
      controller: {
        id: `controller/${roomName}`,
        level: 0,
        ownerUsername: null,
        ownership: "reserved",
        pos: { x: 25, y: 25 },
        reservationTicksToEnd: 500,
        reservationUsername: "self",
        safeMode: null,
      },
      eventLogStatus: "observed",
      events: [],
      eventsObservedAt: 99,
      hostileStatus: "complete",
      hostiles: [],
      mineral: null,
      mineralStatus: "complete",
      observedAt: 100,
      roomName,
      schemaVersion: 1,
      shard: "shard0",
      sourceStatus: "complete",
      sources: [{ energyCapacity: 3_000, id: `source/${roomName}`, pos: { x: 10, y: 10 } }],
      structureStatus: "complete",
      structures: [],
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}/v1` },
    },
    roomName,
  };
}

function route(
  roomName: string,
  status: RoutePlanResult["status"],
  requestId = `route/W1N1/${roomName}/v1`,
  outboundTicks = 50,
): RoutePlanResult {
  const ready = status === "ready";
  return {
    metrics: {
      cacheHits: 0,
      consideredEdges: ready ? 1 : 0,
      expandedRooms: ready ? 1 : 0,
      reason: ready ? "route-computed" : "no-path",
      risk: 0,
      routeRooms: ready ? 1 : 0,
      totalCost: ready ? 100 : 0,
    },
    plan: ready
      ? {
          destinationRoomName: roomName,
          estimate: {
            outboundTicks,
            plainSteps: 50,
            returnTicks: 100,
            roadBodyPartSteps: 0,
            roadSteps: 0,
            roundTripTicks: 150,
            swampSteps: 0,
            throughputMilliCapacityPerTick: 333,
          },
          originRoomName: "W1N1",
          requestId,
          risk: 0,
          roomNames: [roomName],
          schemaVersion: 1,
          totalCost: 100,
        }
      : null,
    reason: ready ? "route-computed" : "no-path",
    source: ready ? "search" : "none",
    status,
  };
}

function visibleRoom(overrides: { readonly containerEnergy?: number } = {}): RoomSnapshot {
  const containerEnergy = overrides.containerEnergy;
  const container =
    containerEnergy === undefined
      ? []
      : [
          {
            hits: 250_000,
            hitsMax: 250_000,
            id: "container-a",
            ownerUsername: null,
            ownership: "unowned" as const,
            pos: { roomName: "W1N2", x: 9, y: 9 },
            store: {
              capacity: 2_000,
              freeCapacity: 2_000 - containerEnergy,
              resources:
                containerEnergy === 0
                  ? []
                  : [{ amount: containerEnergy, resourceType: "energy" as ResourceConstant }],
              usedCapacity: containerEnergy,
            },
            structureType: "container",
            ticksToDecay: 100,
          },
        ];
  return {
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name: "W1N2",
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [
      {
        energy: 3_000,
        energyCapacity: 3_000,
        id: "source/W1N2",
        pos: { roomName: "W1N2", x: 10, y: 10 },
        ticksToRegeneration: null,
      },
    ],
    storedStructures: container,
    structures: container,
    traversal: { revision: "traversal/W1N2/v1", walkability: ".".repeat(2_500) },
  };
}

function multiSourceEvidence(): RemoteMiningObjectiveEvidence {
  const base = evidence({ visibleRoom: visibleRoom() });
  const record = base.candidate.intel.record;
  const room = base.visibleRoom;
  if (record === null || room === null) throw new Error("multi-source fixture requires vision");
  return {
    ...base,
    objective: { ...base.objective, profit: 4_000 },
    candidate: {
      ...base.candidate,
      intel: {
        ...base.candidate.intel,
        record: {
          ...record,
          sources: [
            ...record.sources,
            { energyCapacity: 3_000, id: "source-b", pos: { x: 40, y: 40 } },
          ],
        },
      },
    },
    visibleRoom: {
      ...room,
      sources: [
        ...room.sources,
        {
          energy: 3_000,
          energyCapacity: 3_000,
          id: "source-b",
          pos: { roomName: room.name, x: 40, y: 40 },
          ticksToRegeneration: null,
        },
      ],
    },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required fixture value missing");
  return value;
}
