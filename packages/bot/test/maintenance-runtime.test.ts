import { describe, expect, it } from "vitest";
import {
  assignMaintenanceExecution,
  authorizeMaintenanceWork,
  maintenanceWorkOutcomes,
  measureMaintenanceTraffic,
  projectMaintenanceBudgets,
  type ConstructionPlanningResult,
  type MaintenanceProposal,
} from "../src/maintenance";
import type { ContractPlanningRecord } from "../src/contracts";

describe("maintenance budget and contract projection", () => {
  it("measures current traffic deterministically and assigns tower targets exclusively", () => {
    const room = {
      name: "W1N1",
      ownedCreeps: [
        { id: "creep-b", pos: { x: 10, y: 10 } },
        { id: "creep-a", pos: { x: 11, y: 10 } },
      ],
      roads: [
        { id: "road-b", pos: { x: 13, y: 10 } },
        { id: "road-a", pos: { x: 10, y: 10 } },
      ],
      storedStructures: [],
      structures: [],
    };
    const snapshot = { rooms: [room] } as unknown as Parameters<
      typeof measureMaintenanceTraffic
    >[0];
    const traffic = measureMaintenanceTraffic(snapshot);
    expect(traffic).toEqual([
      { targetId: "road-a", score: 6 },
      { targetId: "road-b", score: 2 },
    ]);
    expect(
      measureMaintenanceTraffic({
        rooms: [
          {
            ...room,
            ownedCreeps: [...room.ownedCreeps].reverse(),
            roads: [...room.roads].reverse(),
          },
        ],
      } as unknown as Parameters<typeof measureMaintenanceTraffic>[0]),
    ).toEqual(traffic);

    const request = (targetId: string) => ({ targetId }) as never;
    const authorized = {
      creepRequests: [request("road-a"), request("road-b")],
      fundedProposals: [],
      retirements: [],
      towerCandidates: [],
    };
    const assigned = assignMaintenanceExecution(authorized, [{ target: "road-a" }]);
    expect(assigned.creepRequests.map(({ targetId }) => targetId)).toEqual(["road-b"]);
    expect(assigned.duplicateTargetsSuppressed).toBe(1);
    expect(assignMaintenanceExecution(authorized, []).creepRequests).toHaveLength(2);
  });

  it("projects one bounded discretionary room tranche after critical maintenance", () => {
    const projection = projectMaintenanceBudgets({
      existing: [],
      planning: planning([proposal("road-a", 90), proposal("spawn-a", 40)]),
      tick: 100,
      ttl: 50,
    });
    expect(projection.budgets).toEqual([
      {
        category: "maintenance",
        colonyId: "W1N1",
        cpu: { desired: 1, minimum: 0 },
        energy: { desired: 130, minimum: 1 },
        expiresAt: 150,
        issuer: "maintenance-v2/W1N1",
        revision: 1,
        spawn: null,
      },
    ]);
  });

  it("emits target-band identities only for active room funding", () => {
    const planningResult = planning([proposal("road-a", 90), proposal("spawn-a", 40)]);
    const projection = projectMaintenanceBudgets({
      existing: [],
      planning: planningResult,
      tick: 100,
      ttl: 50,
    });
    const authorized = authorizeMaintenanceWork({
      budgets: projection.budgets,
      contracts: { status: "ready", contracts: [] },
      planning: planningResult,
      reservations: [
        {
          category: "maintenance",
          colonyId: "W1N1",
          issuer: "maintenance-v2/W1N1",
          status: "active",
        },
      ],
      tick: 100,
    });
    expect(authorized.creepRequests.map(({ issuer }) => issuer)).toEqual([
      "maintenance-v2/W1N1/road-a/9000",
      "maintenance-v2/W1N1/spawn-a/9000",
    ]);
    expect(authorized.creepRequests[0]).toMatchObject({
      budgetBinding: { category: "maintenance", issuer: "maintenance-v2/W1N1" },
      execution: { action: "repair", completionHits: 9_000 },
      priority: { class: "maintenance" },
      range: 3,
    });
    expect(authorized.towerCandidates.map(({ targetId }) => targetId)).toEqual(["road-a"]);
  });

  it("retires destroyed, satisfied, and changed target bands deterministically after reset", () => {
    const next = planning([proposal("road-a", 90, 12_000)]);
    const budgets = projectMaintenanceBudgets({ existing: [], planning: next, tick: 101, ttl: 50 });
    const contracts = {
      status: "ready" as const,
      contracts: [
        contract("old-band", "maintenance-v2/W1N1/road-a/9000", "active"),
        contract("destroyed", "maintenance-v2/W1N1/spawn-a/9000", "active"),
        contract("current", "maintenance-v2/W1N1/road-a/12000", "suspended"),
      ],
    };
    const input = {
      budgets: budgets.budgets,
      contracts,
      planning: next,
      reservations: [
        {
          category: "maintenance",
          colonyId: "W1N1",
          issuer: "maintenance-v2/W1N1",
          status: "active",
        },
      ],
      tick: 101,
    };
    const first = authorizeMaintenanceWork(input);
    const reset = authorizeMaintenanceWork({
      ...input,
      contracts: { ...contracts, contracts: [...contracts.contracts].reverse() },
    });
    expect(reset).toEqual(first);
    expect(first.retirements).toEqual([
      { contractId: "current", reason: "maintenance-funded", tick: 101, to: "funded" },
      { contractId: "destroyed", reason: "maintenance-band-resolved", tick: 101, to: "cancelled" },
      { contractId: "old-band", reason: "maintenance-band-resolved", tick: 101, to: "cancelled" },
    ]);
  });

  it("fails closed without an active reservation", () => {
    const plan = planning([proposal("road-a", 90)]);
    const budgets = projectMaintenanceBudgets({ existing: [], planning: plan, tick: 100, ttl: 50 });
    expect(
      authorizeMaintenanceWork({
        budgets: budgets.budgets,
        contracts: { status: "ready", contracts: [] },
        planning: plan,
        reservations: [],
        tick: 100,
      }),
    ).toMatchObject({ creepRequests: [], fundedProposals: [], towerCandidates: [] });
  });

  it("classifies destroyed, exact, and over-target retirement receipts", () => {
    const contracts = {
      status: "ready" as const,
      contracts: [
        {
          ...contract("destroyed", "maintenance-v2/W1N1/destroyed/9000", "active"),
          targetId: "gone",
        },
        { ...contract("exact", "maintenance-v2/W1N1/exact/9000", "active"), targetId: "exact" },
        { ...contract("over", "maintenance-v2/W1N1/over/9000", "active"), targetId: "over" },
      ],
    };
    const outcomes = maintenanceWorkOutcomes(
      contracts,
      {
        rooms: [
          {
            roads: [
              { id: "exact", hits: 9_000 },
              { id: "over", hits: 9_001 },
            ],
            storedStructures: [],
            structures: [],
          },
        ],
      } as unknown as Parameters<typeof maintenanceWorkOutcomes>[1],
      contracts.contracts.map(({ contractId }) => ({
        contractId,
        reason: "maintenance-band-resolved",
        tick: 101,
        to: "cancelled" as const,
      })),
    );
    expect(outcomes).toEqual(["overshoot", "retired", "satisfied"]);
  });
});

function planning(proposals: readonly MaintenanceProposal[]): ConstructionPlanningResult {
  return {
    deferred: [],
    deferredCount: 0,
    proposals,
    scannedStructures: proposals.length,
    truncatedStructures: 0,
  };
}
function proposal(targetId: string, energyCost: number, targetHits = 9_000): MaintenanceProposal {
  return {
    energyCost,
    id: `maintenance/W1N1/${targetId}/${String(targetHits)}`,
    layoutPlanned: true,
    priority: targetId === "road-a" ? 900 : 800,
    reason: "layout-asset-damage",
    roomName: "W1N1",
    structureClass: targetId === "road-a" ? "road" : "ordinary",
    targetHits,
    targetId,
    targetPos: { roomName: "W1N1", x: 10, y: 10 },
    towerEligible: targetId === "road-a",
    trafficScore: 0,
  };
}
function contract(
  contractId: string,
  issuer: string,
  state: "active" | "suspended",
): ContractPlanningRecord {
  return {
    budgetBinding: { category: "maintenance", issuer: "maintenance-v2/W1N1" },
    contractId,
    execution: {
      action: "repair",
      completion: "work-complete",
      completionHits: 9_000,
      counterpartId: null,
      resourceType: null,
      version: 1 as const,
    },
    issuer,
    owner: { id: "W1N1", kind: "colony" as const },
    state,
    targetId: "target",
  };
}
