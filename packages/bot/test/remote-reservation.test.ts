import { describe, expect, it } from "vitest";
import {
  contractIdFor,
  normalizeContractRequest,
  openContractLedgerState,
  requestSignature,
  type ContractPlanningRecord,
  type WorkContractRequest,
} from "../src/contracts";
import {
  DEFAULT_REMOTE_RESERVATION_POLICY_V1,
  RemoteReservationPlanner,
  type RemoteCandidateEvidence,
  type RemotePortfolioObjective,
  type RemoteReservationBudgetEntry,
  type RemoteReservationObjectiveEvidence,
} from "../src/remotes";
import type { RoomIntelQueryResult } from "../src/world/intel";
import type { RoutePlanResult } from "../src/world/routes";

const planner = new RemoteReservationPlanner();

describe("RemoteReservationPlanner", () => {
  it("requires an exact post-survival budget before emitting one bounded reservation contract", () => {
    const first = plan();
    expect(first.budgetRequests).toEqual([
      expect.objectContaining({
        colonyId: "W1N1",
        category: "harvesting-filling",
        issuer: "remote-reservation/W1N1/W1N2",
        energy: { minimum: 1_300, desired: 1_300 },
        cpu: { minimum: 100, desired: 100 },
        spawn: null,
      }),
    ]);
    expect(first.contractRequests).toEqual([]);
    expect(first.dispositions[0]?.reason).toBe("budget-unavailable");
    const budget = required(first.budgetRequests[0], "missing budget request");
    const funded = plan({ budgets: [activeBudget(budget)] });
    const contract = required(funded.contractRequests[0], "missing contract request");
    expect(funded.contractRequests).toEqual([
      expect.objectContaining({
        kind: "reserve",
        estimatedWorkTicks: 450,
        range: 1,
        target: { roomName: "W1N2", x: 25, y: 25 },
        targetId: "controller/W1N2",
        execution: {
          action: "reserve-controller",
          completion: "work-complete",
          counterpartId: null,
          originRoomName: "W1N1",
          resourceType: null,
          routeRoomNames: ["W1N2"],
          routeTravelTicks: 50,
          signText: "MYRMEX",
          targetReservationTicks: 450,
          version: 4,
        },
      }),
    ]);
    expect(contract.requiredCapability).toMatchObject({ claim: 2, move: 2 });
    expect(funded.metrics).toMatchObject({ budgeted: 1, contracts: 1, due: 1 });
    const normalized = normalizeContractRequest(contract);
    expect(normalized.execution).toEqual(contract.execution);
    expect(
      openContractLedgerState({
        schemaVersion: 1,
        active: [
          {
            ...normalized,
            history: [{ from: null, reason: "submitted", tick: 100, to: "proposed" }],
            id: contractIdFor(normalized.issuer, normalized.issuerKey, normalized.issuerSequence),
            lease: null,
            requestSignature: requestSignature(normalized),
            revision: 1,
            state: "proposed",
          },
        ],
        issuerFrontiers: [],
        outcomes: [],
      }).status,
    ).toBe("ready");
    expect(JSON.stringify(funded.contractRequests[0]).length).toBeLessThanOrEqual(4_096);
  });

  it("starts only inside the spawn-plus-route lead and stops at the reservation target", () => {
    const healthy = plan({ evidence: evidence({ reservationTicksToEnd: 200 }) });
    const due = plan({ evidence: evidence({ reservationTicksToEnd: 80 }) });
    const request = authorizedRequest();
    const active = record(request, "active");
    const completed = plan({
      tick: 101,
      evidence: evidence({ reservationTicksToEnd: 450 }),
      contracts: { contracts: [active], status: "ready" },
    });
    expect(healthy.budgetRequests).toEqual([]);
    expect(healthy.dispositions[0]?.reason).toBe("reservation-healthy");
    expect(due.dispositions[0]?.leadTicks).toBe(87);
    expect(completed.transitions).toEqual([
      {
        contractId: active.contractId,
        reason: "remote-reservation-target-reached",
        tick: 101,
        to: "completed",
      },
    ]);
  });

  it("fails closed on stale, blocked, unsafe, and missing objectives without ghost commands", () => {
    const request = authorizedRequest();
    const active = record(request, "active");
    const cases: readonly [string, RemoteReservationObjectiveEvidence[]][] = [
      ["intel-stale", [evidence({ freshness: "stale" })]],
      ["controller-blocked", [evidence({ controller: "blocked" })]],
      ["route-unavailable", [evidence({ routeStatus: "no-route" })]],
      ["portfolio-unavailable", []],
    ];
    for (const [reason, objectives] of cases) {
      const result = planner.plan({
        tick: 101,
        objectives,
        budgets: [],
        contracts: { contracts: [active], status: "ready" },
        policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
      });
      expect(result.contractRequests, reason).toEqual([]);
      expect(result.transitions, reason).toEqual([
        expect.objectContaining({ contractId: active.contractId, to: "suspended" }),
      ]);
      expect(result.dispositions[0]?.reason, reason).toBe(reason);
    }
    const aged = planner.plan({
      tick: 126,
      objectives: [evidence()],
      budgets: [],
      contracts: { contracts: [active], status: "ready" },
      policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
    });
    expect(aged.dispositions[0]?.reason).toBe("intel-stale");
    expect(aged.transitions).toEqual([
      expect.objectContaining({ contractId: active.contractId, to: "suspended" }),
    ]);
  });

  it("backs off command failures, replaces dead reservers, and caps retries", () => {
    const request = authorizedRequest();
    const budget = activeBudgetForRequest(request);
    const retrying = record(request, "suspended", { attempts: 2, eligibleAt: 100 });
    const waiting = plan({
      tick: 103,
      budgets: [budget],
      contracts: { contracts: [retrying], status: "ready" },
    });
    const due = plan({
      tick: 104,
      budgets: [budget],
      contracts: { contracts: [retrying], status: "ready" },
    });
    const exhausted = plan({
      tick: 110,
      budgets: [budget],
      contracts: {
        contracts: [record(request, "suspended", { attempts: 3, eligibleAt: 100 })],
        status: "ready",
      },
    });
    const dead = plan({
      tick: 101,
      budgets: [budget],
      contracts: { contracts: [record(request, "suspended")], status: "ready" },
    });
    expect(waiting.dispositions[0]?.reason).toBe("retry-wait");
    expect(due.transitions).toEqual([
      expect.objectContaining({ reason: "remote-reservation-retry-due", to: "funded" }),
    ]);
    expect(exhausted.transitions).toEqual([]);
    expect(exhausted.dispositions[0]?.reason).toBe("retry-exhausted");
    expect(dead.transitions).toEqual([
      expect.objectContaining({ reason: "remote-reservation-work-remains", to: "funded" }),
    ]);
  });

  it("is deterministic across objective and funding reordering", () => {
    const left = evidence();
    const right = evidence({ roomName: "W1N3" });
    const leftBudget = activeBudgetForRequest(authorizedRequest());
    const unrelated = { ...leftBudget, issuer: "unrelated", colonyId: "W9N9" };
    const reversed = planner.plan({
      tick: 100,
      objectives: [right, left],
      budgets: [unrelated, leftBudget],
      contracts: { contracts: [], status: "ready" },
      policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
    });
    const ordered = planner.plan({
      tick: 100,
      objectives: [left, right],
      budgets: [leftBudget, unrelated],
      contracts: { contracts: [], status: "ready" },
      policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
    });
    expect(reversed).toEqual(ordered);
    expect(ordered.dispositions.map(({ roomName }) => roomName)).toEqual(["W1N2", "W1N3"]);
  });
});

function plan(
  overrides: {
    tick?: number;
    evidence?: RemoteReservationObjectiveEvidence;
    budgets?: readonly RemoteReservationBudgetEntry[];
    contracts?: { contracts: readonly ContractPlanningRecord[]; status: "ready" };
  } = {},
) {
  return planner.plan({
    tick: overrides.tick ?? 100,
    objectives: [overrides.evidence ?? evidence()],
    budgets: overrides.budgets ?? [],
    contracts: overrides.contracts ?? { contracts: [], status: "ready" },
    policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
  });
}
function authorizedRequest(): WorkContractRequest {
  const projected = plan();
  const budget = required(projected.budgetRequests[0], "missing projected budget");
  const funded = plan({ budgets: [activeBudget(budget)] });
  return required(funded.contractRequests[0], "missing authorized contract");
}
function activeBudgetForRequest(request: WorkContractRequest): RemoteReservationBudgetEntry {
  return {
    category: request.budgetBinding.category,
    colonyId: request.owner.id,
    issuer: request.budgetBinding.issuer,
    revision: request.issuerSequence,
    expiresAt: request.expiresAt,
    status: "active",
    grant: { energy: 1_300, cpu: 100, spawn: null },
  };
}
function activeBudget(
  request: ReturnType<typeof plan>["budgetRequests"][number],
): RemoteReservationBudgetEntry {
  return {
    category: request.category,
    colonyId: request.colonyId,
    issuer: request.issuer,
    revision: request.revision,
    expiresAt: request.expiresAt,
    status: "active",
    grant: { energy: 1_300, cpu: 100, spawn: null },
  };
}
function record(
  request: WorkContractRequest,
  state: ContractPlanningRecord["state"],
  reservationRetry: ContractPlanningRecord["reservationRetry"] = null,
): ContractPlanningRecord {
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
    reservationRetry,
    state,
    targetId: request.targetId,
  };
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
function evidence(
  overrides: {
    roomName?: string;
    reservationTicksToEnd?: number | null;
    freshness?: RoomIntelQueryResult["freshness"];
    controller?: RemoteCandidateEvidence["controller"];
    routeStatus?: RoutePlanResult["status"];
  } = {},
): RemoteReservationObjectiveEvidence {
  const roomName = overrides.roomName ?? "W1N2";
  const ticks = overrides.reservationTicksToEnd ?? null;
  const controller = overrides.controller ?? (ticks === null ? "available" : "self-reserved");
  const objective: RemotePortfolioObjective = {
    roomName,
    donorColonyId: "W1N1",
    state: "active",
    revision: 2,
    profit: 10_000,
    commitment: { energy: 1_300, spawnTicks: 12, cpuMilli: 100, memoryCodeUnits: 512 },
  };
  const candidate: RemoteCandidateEvidence = {
    roomName,
    donorColonyId: "W1N1",
    evidenceRevision: `evidence/${roomName}`,
    expiresAt: 1_000,
    controller,
    donor: "healthy",
    threatRisk: 0,
    intel: intel(roomName, ticks, overrides.freshness ?? "current"),
    route: route(roomName, overrides.routeStatus ?? "ready"),
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
  };
  return { objective, candidate };
}
function intel(
  roomName: string,
  ticks: number | null,
  freshness: RoomIntelQueryResult["freshness"],
): RoomIntelQueryResult {
  return {
    roomName,
    freshness,
    quality: "complete",
    reason: freshness === "current" ? "current-observation" : "segment-ready",
    generation: null,
    record: {
      schemaVersion: 1,
      shard: "shard0",
      roomName,
      observedAt: 100,
      eventsObservedAt: 99,
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
