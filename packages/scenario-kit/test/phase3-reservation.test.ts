import { describe, expect, it } from "vitest";
import {
  contractIdFor,
  type ContractPlanningRecord,
  type WorkContractRequest,
} from "../../bot/src/contracts";
import {
  DEFAULT_REMOTE_RESERVATION_POLICY_V1,
  RemoteReservationPlanner,
  type RemoteCandidateEvidence,
  type RemotePortfolioObjective,
  type RemoteReservationBudgetEntry,
  type RemoteReservationObjectiveEvidence,
} from "../../bot/src/remotes";
import type { RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

type Kind = "budget" | "authorize" | "death" | "route-loss" | "resume" | "target" | "foreign";
interface World {
  readonly budgets: readonly RemoteReservationBudgetEntry[];
  readonly contract: ContractPlanningRecord | null;
}
interface Input {
  readonly kind: Kind;
  readonly reverse: boolean;
}
interface Outcome {
  readonly reasons: readonly string[];
  readonly requests: number;
  readonly transitions: readonly string[];
  readonly budgeted: number;
}
interface Heap {
  readonly planner: RemoteReservationPlanner;
}

describe("Phase 3 remote reservation deterministic outcome", () => {
  it("schedules, suspends, recovers, and terminates reservation work across reset/reorder", () => {
    const warm = runScenario(scenario(false, false));
    const resetReordered = runScenario(scenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes).toEqual([
      {
        reasons: ["budget-unavailable", "reservation-healthy"],
        requests: 0,
        transitions: [],
        budgeted: 1,
      },
      {
        reasons: ["reservation-due", "reservation-healthy"],
        requests: 1,
        transitions: [],
        budgeted: 1,
      },
      {
        reasons: ["contract-active", "reservation-healthy"],
        requests: 0,
        transitions: ["funded"],
        budgeted: 1,
      },
      {
        reasons: ["route-unavailable", "reservation-healthy"],
        requests: 0,
        transitions: ["suspended"],
        budgeted: 0,
      },
      {
        reasons: ["contract-active", "reservation-healthy"],
        requests: 0,
        transitions: ["funded"],
        budgeted: 1,
      },
      {
        reasons: ["reservation-target-reached", "reservation-healthy"],
        requests: 0,
        transitions: ["cancelled"],
        budgeted: 0,
      },
      {
        reasons: ["controller-blocked", "reservation-healthy"],
        requests: 0,
        transitions: [],
        budgeted: 0,
      },
    ]);
    expect(resetReordered.finalWorld.contract).toBeNull();
  });
});

function scenario(reset: boolean, reverse: boolean): ReplayScenario<World, Input, Outcome, Heap> {
  const kinds: readonly Kind[] = [
    "budget",
    "authorize",
    "death",
    "route-loss",
    "resume",
    "target",
    "foreign",
  ];
  const createHeap = (): Heap => ({ planner: new RemoteReservationPlanner() });
  return defineReplayScenario<World, Input, Outcome, Heap>({
    id: "phase3/reservation/just-in-time-lifecycle",
    seed: "phase3-reservation-v1",
    initialWorld: { budgets: [], contract: null },
    ticks: kinds.map((kind, index) => ({
      gameTime: 2_000 + index,
      cpuBudget: 0.5,
      resetHeap: reset && [2, 4].includes(index),
      input: { kind, reverse },
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input, world }) {
      const primary = evidence(input.kind, gameTime);
      const secondary = evidence("budget", gameTime, "W1N3", 300, "self-reserved");
      const objectives = input.reverse ? [secondary, primary] : [primary, secondary];
      const startingContract =
        input.kind === "death" && world.contract !== null
          ? { ...world.contract, state: "suspended" as const }
          : world.contract;
      const unrelated: RemoteReservationBudgetEntry = {
        category: "optional-growth",
        colonyId: "W9N9",
        issuer: "unrelated",
        revision: 1,
        expiresAt: 9_999,
        status: "active",
        grant: { energy: 1, cpu: 1, spawn: null },
      };
      const budgets = input.reverse ? [unrelated, ...world.budgets] : [...world.budgets, unrelated];
      const result = heap.planner.plan({
        tick: gameTime,
        objectives,
        budgets,
        contracts: {
          contracts: startingContract === null ? [] : [startingContract],
          status: "ready",
        },
        policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
      });
      let nextBudgets = world.budgets;
      if (input.kind === "budget" && result.budgetRequests[0] !== undefined) {
        const request = result.budgetRequests[0];
        nextBudgets = [
          {
            category: request.category,
            colonyId: request.colonyId,
            issuer: request.issuer,
            revision: request.revision,
            expiresAt: request.expiresAt,
            status: "active",
            grant: { energy: 1_300, cpu: 100, spawn: null },
          },
        ];
      }
      let nextContract = startingContract;
      if (result.contractRequests[0] !== undefined)
        nextContract = record(result.contractRequests[0]);
      for (const transition of result.transitions) {
        if (nextContract?.contractId !== transition.contractId) continue;
        nextContract =
          transition.to === "completed" ||
          transition.to === "cancelled" ||
          transition.to === "expired" ||
          transition.to === "failed"
            ? null
            : { ...nextContract, state: transition.to };
      }
      return {
        nextWorld: { budgets: nextBudgets, contract: nextContract },
        outcome: {
          reasons: result.dispositions.map(({ reason }) => reason),
          requests: result.contractRequests.length,
          transitions: result.transitions.map(({ to }) => to),
          budgeted: result.budgetRequests.length,
        },
        cpuUsed: 0.5,
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== kinds.length) throw new Error("reservation outcome count mismatch");
      if (finalWorld.contract !== null) throw new Error("reservation contract did not terminate");
    },
  });
}

function record(request: WorkContractRequest): ContractPlanningRecord {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("reservation contract must be executable");
  return {
    budgetBinding: request.budgetBinding,
    contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
    execution: request.execution,
    issuer: request.issuer,
    issuerSequence: request.issuerSequence,
    owner: request.owner,
    requestSignature: JSON.stringify(request),
    repairRetry: null,
    reservationRetry: null,
    state: "assigned",
    targetId: request.targetId,
  };
}
function evidence(
  kind: Kind,
  tick: number,
  roomName = "W1N2",
  ticks: number | null = null,
  disposition?: RemoteCandidateEvidence["controller"],
): RemoteReservationObjectiveEvidence {
  const routeStatus: RoutePlanResult["status"] = kind === "route-loss" ? "no-route" : "ready";
  const targetTicks = kind === "target" ? 450 : kind === "resume" ? 100 : ticks;
  const controller =
    kind === "foreign" && roomName === "W1N2"
      ? "blocked"
      : (disposition ?? (targetTicks === null ? "available" : "self-reserved"));
  const objective: RemotePortfolioObjective = {
    roomName,
    donorColonyId: "W1N1",
    state: "active",
    revision: 2,
    profit: 10_000,
    commitment: { energy: 1_300, spawnTicks: 12, cpuMilli: 100, memoryCodeUnits: 512 },
  };
  return {
    objective,
    candidate: {
      roomName,
      donorColonyId: "W1N1",
      evidenceRevision: `${kind}/${String(tick)}`,
      expiresAt: 3_000,
      controller,
      donor: "healthy",
      threatRisk: 0,
      intel: intel(roomName, targetTicks),
      route: route(roomName, routeStatus),
      costs: {
        latency: 1,
        spawn: 1,
        body: 1,
        hauling: 1,
        reservation: 1,
        roads: 1,
        repair: 1,
        expectedLoss: 1,
        cpu: 1,
      },
      commitment: objective.commitment,
    },
  };
}
function intel(roomName: string, ticks: number | null): RoomIntelQueryResult {
  return {
    roomName,
    freshness: "current",
    quality: "complete",
    reason: "current-observation",
    generation: null,
    record: {
      schemaVersion: 1,
      shard: "shard0",
      roomName,
      observedAt: 2_000,
      eventsObservedAt: 1_999,
      complete: true,
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
      controller: {
        id: `controller/${roomName}`,
        level: 0,
        ownerUsername: null,
        ownership: ticks === null ? "neutral" : "reserved",
        pos: { x: 25, y: 25 },
        reservationTicksToEnd: ticks,
        reservationUsername: ticks === null ? null : "self",
        safeMode: null,
      },
      mineral: null,
      mineralStatus: "complete",
      sources: [{ id: `source/${roomName}`, energyCapacity: 3_000, pos: { x: 10, y: 10 } }],
      sourceStatus: "complete",
      structures: [],
      structureStatus: "complete",
      hostiles: [],
      hostileStatus: "complete",
      events: [],
      eventLogStatus: "observed",
    },
  };
}
function route(roomName: string, status: RoutePlanResult["status"]): RoutePlanResult {
  const ready = status === "ready";
  return {
    status,
    reason: ready ? "route-computed" : "no-path",
    source: ready ? "search" : "none",
    plan: ready
      ? {
          schemaVersion: 1,
          requestId: `route/${roomName}`,
          originRoomName: "W1N1",
          destinationRoomName: roomName,
          roomNames: [roomName],
          totalCost: 100,
          risk: 0,
          estimate: {
            outboundTicks: 50,
            returnTicks: 100,
            roundTripTicks: 150,
            throughputMilliCapacityPerTick: 333,
            roadSteps: 0,
            plainSteps: 50,
            swampSteps: 0,
            roadBodyPartSteps: 0,
          },
        }
      : null,
    metrics: {
      expandedRooms: ready ? 1 : 0,
      consideredEdges: ready ? 1 : 0,
      cacheHits: 0,
      routeRooms: ready ? 1 : 0,
      totalCost: ready ? 100 : 0,
      risk: 0,
      reason: ready ? "route-computed" : "no-path",
    },
  };
}
