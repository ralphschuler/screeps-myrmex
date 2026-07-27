import { describe, expect, it } from "vitest";
import {
  contractIdFor,
  type ContractPlanningRecord,
  type WorkContractRequest,
} from "../../bot/src/contracts";
import { CONSTRUCTION_SITE_LIMITS, arbitrateConstructionSites } from "../../bot/src/layout";
import {
  DEFAULT_REMOTE_MINING_POLICY_V1,
  RemoteMiningPlanner,
  type RemoteMiningBudgetEntry,
  type RemoteMiningObjectiveEvidence,
} from "../../bot/src/remotes";
import type { RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { RoomSnapshot } from "../../bot/src/world/snapshot";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

type Kind =
  | "budget"
  | "authorize"
  | "capital"
  | "full-container"
  | "miner-death"
  | "site-cap"
  | "route-change"
  | "threat"
  | "source-loss";
interface World {
  readonly budgets: readonly RemoteMiningBudgetEntry[];
  readonly contract: ContractPlanningRecord | null;
}
interface Input {
  readonly kind: Kind;
  readonly reverse: boolean;
}
interface Outcome {
  readonly kind: Kind;
  readonly miningReasons: readonly string[];
  readonly offloads: readonly string[];
  readonly minerEnergyCaps: readonly number[];
  readonly requests: number;
  readonly transitions: readonly string[];
  readonly site: "accepted" | "blocked" | "none";
}
interface Heap {
  readonly planner: RemoteMiningPlanner;
}

describe("Phase 3 remote mining deterministic outcome", () => {
  it("funds, replaces, degrades, and suspends remote extraction across reset/reorder", () => {
    const warm = runScenario(scenario(false, false));
    const resetReordered = runScenario(scenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes[0]).toEqual(
      expect.objectContaining({
        kind: "budget",
        minerEnergyCaps: [450, 750],
        requests: 0,
      }),
    );
    expect(warm.outcomes[1]).toEqual(
      expect.objectContaining({ kind: "authorize", requests: 2, site: "none" }),
    );
    expect(warm.outcomes[2]).toEqual(
      expect.objectContaining({ kind: "capital", site: "accepted" }),
    );
    expect(warm.outcomes[3]).toEqual(
      expect.objectContaining({
        kind: "full-container",
        offloads: ["container-full-drop", "drop"],
      }),
    );
    expect(warm.outcomes[4]?.transitions).toContain("funded");
    expect(warm.outcomes[5]?.site).toBe("blocked");
    expect(warm.outcomes[6]?.transitions).toContain("cancelled");
    expect(warm.outcomes[7]?.miningReasons).toContain("threat-risk");
    expect(warm.outcomes[8]?.miningReasons).toContain("source-missing");
  });
});

function scenario(reset: boolean, reverse: boolean): ReplayScenario<World, Input, Outcome, Heap> {
  const kinds: readonly Kind[] = [
    "budget",
    "authorize",
    "capital",
    "full-container",
    "miner-death",
    "site-cap",
    "route-change",
    "threat",
    "source-loss",
  ];
  const createHeap = (): Heap => ({ planner: new RemoteMiningPlanner() });
  return defineReplayScenario<World, Input, Outcome, Heap>({
    id: "phase3/mining/funded-lifecycle",
    seed: "phase3-mining-v1",
    initialWorld: { budgets: [], contract: null },
    ticks: kinds.map((kind, index) => ({
      gameTime: 3_000 + index,
      cpuBudget: 0.75,
      resetHeap: reset && [2, 6].includes(index),
      input: { kind, reverse },
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input, world }) {
      const primary = evidence(input.kind, gameTime);
      const secondary = evidence("budget", gameTime, "W1N3", 1_500);
      const objectives = input.reverse ? [secondary, primary] : [primary, secondary];
      const existing: ContractPlanningRecord | null =
        world.contract === null
          ? null
          : input.kind === "miner-death"
            ? { ...world.contract, state: "suspended" as const, remoteMiningRetry: null }
            : { ...world.contract, state: "active" as const };
      const budgets = input.reverse ? [...world.budgets].reverse() : world.budgets;
      const result = heap.planner.plan({
        budgets,
        contracts: { contracts: existing === null ? [] : [existing], status: "ready" },
        objectives,
        policy: DEFAULT_REMOTE_MINING_POLICY_V1,
        tick: gameTime,
      });
      const arbitration = arbitrateConstructionSites({
        globalOwnedSiteCount: input.kind === "site-cap" ? 95 : 0,
        limits: CONSTRUCTION_SITE_LIMITS,
        perRoomSiteCounts: [
          { count: 0, roomName: "W1N2" },
          { count: 0, roomName: "W1N3" },
        ],
        priorReceipts: [],
        progressionAuthorizations: result.siteAuthorizations,
        proposals: result.siteProposals,
        tick: gameTime,
      });
      let nextBudgets = world.budgets;
      if (input.kind === "budget" || input.kind === "authorize") {
        const byIssuer = new Map(
          [...world.budgets, ...result.budgetRequests.map(activeBudget)].map((budget) => [
            budget.issuer,
            budget,
          ]),
        );
        nextBudgets = [...byIssuer.values()].sort((left, right) =>
          left.issuer.localeCompare(right.issuer),
        );
      }
      let nextContract: ContractPlanningRecord | null = existing;
      const primaryRequest = result.contractRequests.find((request) =>
        request.issuer.includes("/W1N2/"),
      );
      if (primaryRequest !== undefined) nextContract = planningRecord(primaryRequest, "active");
      for (const transition of result.transitions) {
        if (nextContract?.contractId !== transition.contractId) continue;
        nextContract =
          transition.to === "cancelled" ||
          transition.to === "completed" ||
          transition.to === "expired" ||
          transition.to === "failed"
            ? null
            : { ...nextContract, state: transition.to };
      }
      return {
        nextWorld: { budgets: nextBudgets, contract: nextContract },
        outcome: {
          kind: input.kind,
          minerEnergyCaps: result.budgetRequests
            .filter(({ category }) => category === "harvesting-filling")
            .map(({ energy }) => energy?.desired ?? 0)
            .sort((left, right) => left - right),
          miningReasons: result.dispositions.map(({ miningReason }) => miningReason),
          offloads: result.dispositions.map(({ offload }) => offload),
          requests: result.contractRequests.length,
          site:
            arbitration.intents.length > 0
              ? "accepted"
              : arbitration.deferred.length > 0
                ? "blocked"
                : "none",
          transitions: result.transitions.map(({ to }) => to),
        },
        cpuUsed: 0.75,
      };
    },
    verify({ outcomes }) {
      if (outcomes.length !== kinds.length) throw new Error("remote mining outcome count mismatch");
      if (outcomes.some(({ requests }) => requests > 2))
        throw new Error("remote mining emitted an unbounded request batch");
    },
  });
}

function evidence(
  kind: Kind,
  tick: number,
  roomName = "W1N2",
  energyCapacity = 3_000,
): RemoteMiningObjectiveEvidence {
  const routeChanged = kind === "route-change";
  const sourceLoss = kind === "source-loss" && roomName === "W1N2";
  const threat = kind === "threat" && roomName === "W1N2";
  const fullContainer = kind === "full-container" && roomName === "W1N2";
  const visible = roomName === "W1N2" ? visibleRoom(tick, fullContainer ? 2_000 : undefined) : null;
  return {
    objective: {
      commitment: { cpuMilli: 1_000, energy: 20_000, memoryCodeUnits: 8_192, spawnTicks: 200 },
      donorColonyId: "W1N1",
      profit: 10_000,
      revision: 2,
      roomName,
      state: "active",
    },
    candidate: {
      commitment: { cpuMilli: 1_000, energy: 20_000, memoryCodeUnits: 8_192, spawnTicks: 200 },
      controller: energyCapacity === 1_500 ? "available" : "self-reserved",
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
      evidenceRevision: `${kind}/${roomName}/${String(tick)}`,
      expiresAt: 5_000,
      intel: intel(roomName, tick, sourceLoss ? [] : [energyCapacity], energyCapacity !== 1_500),
      roomName,
      route: route(roomName, routeChanged ? 60 : 50, routeChanged ? "v2" : "v1"),
      threatRisk: threat ? 1 : 0,
    },
    roadCandidates: [],
    visibleRoom: sourceLoss ? visibleRoom(tick, undefined, false) : visible,
  };
}

function intel(
  roomName: string,
  tick: number,
  capacities: readonly number[],
  selfReserved: boolean,
): RoomIntelQueryResult {
  return {
    freshness: "current",
    generation: null,
    quality: "complete",
    reason: "current-observation",
    record: {
      complete: true,
      controller: selfReserved
        ? {
            id: `controller/${roomName}`,
            level: 0,
            ownerUsername: null,
            ownership: "reserved",
            pos: { x: 25, y: 25 },
            reservationTicksToEnd: 500,
            reservationUsername: "self",
            safeMode: null,
          }
        : null,
      eventLogStatus: "observed",
      events: [],
      eventsObservedAt: tick - 1,
      hostileStatus: "complete",
      hostiles: [],
      mineral: null,
      mineralStatus: "complete",
      observedAt: tick,
      roomName,
      schemaVersion: 1,
      shard: "shard0",
      sourceStatus: "complete",
      sources: capacities.map((energyCapacity) => ({
        energyCapacity,
        id: `source/${roomName}`,
        pos: { x: 10, y: 10 },
      })),
      structureStatus: "complete",
      structures: [],
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
    },
    roomName,
  };
}

function route(roomName: string, outboundTicks: number, revision: string): RoutePlanResult {
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
      requestId: `route/W1N1/${roomName}/${revision}`,
      risk: 0,
      roomNames: [roomName],
      schemaVersion: 1,
      totalCost: 100,
    },
    reason: "route-computed",
    source: "search",
    status: "ready",
  };
}

function visibleRoom(tick: number, containerEnergy?: number, sourcePresent = true): RoomSnapshot {
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
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: sourcePresent
      ? [
          {
            energy: 3_000,
            energyCapacity: 3_000,
            id: "source/W1N2",
            pos: { roomName: "W1N2", x: 10, y: 10 },
            ticksToRegeneration: null,
          },
        ]
      : [],
    storedStructures: container,
    structures: container,
    traversal: { revision: `traversal/${String(tick)}`, walkability: ".".repeat(2_500) },
  };
}

function activeBudget(request: {
  readonly category: string;
  readonly colonyId: string;
  readonly cpu: { readonly desired: number } | null;
  readonly energy: { readonly desired: number } | null;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly revision: number;
}): RemoteMiningBudgetEntry {
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
    remoteMiningRetry: null,
    repairRetry: null,
    reservationRetry: null,
    requestSignature: JSON.stringify(request),
    state,
    targetId: request.targetId,
  };
}
