import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assignMaintenanceExecution,
  authorizeMaintenanceWork,
  maintenanceWorkOutcomes,
  measureMaintenanceTraffic,
  projectMaintenanceBudgets,
  type ConstructionPlanningResult,
  type MaintenanceProposal,
} from "../src/maintenance";
import { ContractLedger, type ContractPlanningRecord } from "../src/contracts";
import { runTick, unpublishedRoutineMaintenanceReservationIds } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";

describe("maintenance budget and contract projection", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

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

    const request = (targetId: string, priority: number) =>
      ({
        budgetBinding: { category: "maintenance", issuer: "maintenance-v2/W1N1" },
        issuer: `maintenance-v2/W1N1/${targetId}`,
        owner: { id: "W1N1", kind: "colony" },
        priority: { class: "maintenance", value: priority },
        targetId,
      }) as never;
    const authorized = {
      creepRequests: [request("road-a", 900), request("road-b", 800)],
      fundedProposals: [],
      retirements: [],
      towerCandidates: [],
    };
    const assigned = assignMaintenanceExecution(authorized, [{ target: "road-a" }]);
    expect(assigned.creepRequests.map(({ targetId }) => targetId)).toEqual(["road-b"]);
    expect(assigned.duplicateTargetsSuppressed).toBe(1);
    expect(
      assignMaintenanceExecution(authorized, []).creepRequests.map(({ targetId }) => targetId),
    ).toEqual(["road-a"]);
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

  it("keeps live budget bytes stable and advances revisions for cost or expiry renewal", () => {
    const first = projectMaintenanceBudgets({
      existing: [],
      planning: planning([proposal("road-a", 90)]),
      tick: 100,
      ttl: 50,
    }).budgets[0];
    if (first === undefined) throw new Error("expected maintenance budget");
    const existing = [
      {
        category: first.category,
        colonyId: first.colonyId,
        issuer: first.issuer,
        request: first,
        revision: first.revision,
        status: "active",
      },
    ];
    expect(
      projectMaintenanceBudgets({
        existing,
        planning: planning([proposal("road-a", 90)]),
        tick: 101,
        ttl: 50,
      }).budgets[0],
    ).toEqual(first);
    expect(
      projectMaintenanceBudgets({
        existing,
        planning: planning([proposal("road-a", 100)]),
        tick: 101,
        ttl: 50,
      }).budgets[0],
    ).toMatchObject({ energy: { desired: 100 }, expiresAt: 151, revision: 2 });
    expect(
      projectMaintenanceBudgets({
        existing,
        planning: planning([proposal("road-a", 90)]),
        tick: 149,
        ttl: 50,
      }).budgets[0],
    ).toMatchObject({ expiresAt: 199, revision: 2 });
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

  it("admits one successor when the same maintenance band is damaged again", () => {
    const next = planning([proposal("road-a", 90)]);
    const budgets = projectMaintenanceBudgets({ existing: [], planning: next, tick: 200, ttl: 50 });
    const issuer = "maintenance-v2/W1N1/road-a/9000";
    const input = {
      budgets: budgets.budgets,
      contracts: {
        contracts: [],
        issuerFrontiers: [{ issuer, retiredThrough: 1 }],
        status: "ready" as const,
      },
      planning: next,
      reservations: [
        {
          category: "maintenance",
          colonyId: "W1N1",
          issuer: "maintenance-v2/W1N1",
          status: "active",
        },
      ],
      tick: 200,
    };
    const first = authorizeMaintenanceWork(input);
    expect(first.creepRequests).toHaveLength(1);
    expect(first.creepRequests[0]).toMatchObject({ issuer, issuerSequence: 2 });
    expect(authorizeMaintenanceWork(roundTrip(input))).toEqual(first);
    const request = first.creepRequests[0];
    if (request === undefined) throw new Error("expected maintenance successor");
    const opened = ContractLedger.open({
      active: [],
      issuerFrontiers: [{ issuer, retiredThrough: 1 }],
      outcomes: [],
      schemaVersion: 1,
    });
    if (opened.status !== "ready") throw new Error("expected maintenance ledger");
    expect(opened.ledger.submit(request, 200)).toMatchObject({
      accepted: true,
      outcome: "created",
    });
    expect(opened.ledger.submit(request, 200)).toMatchObject({
      accepted: true,
      outcome: "duplicate-active",
    });

    const active = contract("successor", issuer, "active", 2);
    expect(
      authorizeMaintenanceWork({
        ...input,
        contracts: {
          ...input.contracts,
          contracts: [active],
        },
      }).creepRequests,
    ).toEqual([]);
  });

  it("serializes one shared-budget target and advances after terminal reconciliation", () => {
    const initialPlanning = planning([proposal("road-a", 90), proposal("road-b", 40)]);
    const budget = projectMaintenanceBudgets({
      existing: [],
      planning: initialPlanning,
      tick: 100,
      ttl: 50,
    }).budgets;
    const reservations = [
      {
        category: "maintenance",
        colonyId: "W1N1",
        issuer: "maintenance-v2/W1N1",
        status: "active",
      },
    ];
    const firstAuthorized = authorizeMaintenanceWork({
      budgets: budget,
      contracts: { status: "ready", contracts: [] },
      planning: initialPlanning,
      reservations,
      tick: 100,
    });
    const firstAssignment = assignMaintenanceExecution(firstAuthorized, []);
    expect(firstAssignment.creepRequests.map(({ targetId }) => targetId)).toEqual(["road-a"]);

    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected maintenance ledger");
    const first = opened.ledger.reconcile({
      actors: [],
      funding: maintenanceFunding(),
      requests: firstAssignment.creepRequests,
      tick: 100,
      transitions: firstAuthorized.retirements,
      travel: { estimate: () => 0 },
    });
    expect(first.submissions).toEqual([
      expect.objectContaining({ accepted: true, outcome: "created" }),
    ]);
    expect(first.submissions.some((submission) => "reason" in submission)).toBe(false);
    expect(opened.ledger.view().active).toEqual([expect.objectContaining({ targetId: "road-a" })]);

    const reset = ContractLedger.open(roundTrip(opened.ledger.view()));
    if (reset.status !== "ready") throw new Error("expected reset maintenance ledger");
    const nextPlanning = planning([proposal("road-b", 40)]);
    const nextAuthorized = authorizeMaintenanceWork({
      budgets: budget,
      contracts: reset.ledger.planningView(),
      planning: nextPlanning,
      reservations,
      tick: 101,
    });
    const nextAssignment = assignMaintenanceExecution(nextAuthorized, []);
    expect(nextAuthorized.retirements).toEqual([
      expect.objectContaining({
        contractId: reset.ledger.view().active[0]?.id,
        reason: "maintenance-band-resolved",
        to: "cancelled",
      }),
    ]);
    expect(nextAssignment.creepRequests.map(({ targetId }) => targetId)).toEqual(["road-b"]);

    const second = reset.ledger.reconcile({
      actors: [],
      funding: maintenanceFunding(),
      requests: nextAssignment.creepRequests,
      tick: 101,
      transitions: nextAuthorized.retirements,
      travel: { estimate: () => 0 },
    });
    expect(second.transitions).toEqual([
      expect.objectContaining({ accepted: true, to: "cancelled" }),
    ]);
    expect(second.submissions).toEqual([
      expect.objectContaining({ accepted: true, outcome: "created" }),
    ]);
    expect(second.submissions.some((submission) => "reason" in submission)).toBe(false);
    expect(reset.ledger.view().active).toEqual([expect.objectContaining({ targetId: "road-b" })]);
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

  it("fails closed when authoritative contract planning is unavailable", () => {
    const plan = planning([proposal("road-a", 90)]);
    const budgets = projectMaintenanceBudgets({ existing: [], planning: plan, tick: 100, ttl: 50 });
    expect(
      authorizeMaintenanceWork({
        budgets: budgets.budgets,
        contracts: { status: "unavailable", contracts: [] },
        planning: plan,
        reservations: [
          {
            category: "maintenance",
            colonyId: "W1N1",
            issuer: "maintenance-v2/W1N1",
            status: "active",
          },
        ],
        tick: 100,
      }),
    ).toEqual({
      creepRequests: [],
      fundedProposals: [],
      retirements: [],
      towerCandidates: [],
    });
  });

  it("aligns routine maintenance budgets with publisher admission and commit", () => {
    const world = establishedRcl2World({
      initialExtensionCount: 5,
      initialExtensionEnergy: 50,
      maintenanceRoad: { hits: 100, hitsMax: 5_000 },
    });
    const memory = {} as Memory;
    const admitted = runTick({ game: world.game(100), memory });
    expect(admitted.kernel.mode).toBe("surplus");
    expect(admitted.colony.reservations).toContainEqual(
      expect.objectContaining({
        category: "maintenance",
        issuer: "maintenance-v2/W1N1",
        status: "active",
      }),
    );
    expect(
      admitted.kernel.systems.find(({ systemId }) => systemId === "maintenance.routine-contracts"),
    ).toMatchObject({ status: "completed" });

    if (memory.myrmex === undefined) throw new Error("expected initialized runtime memory");
    const retainedMemory = roundTrip(memory);
    (
      retainedMemory.myrmex as unknown as {
        kernel: {
          runtime: unknown;
        };
      }
    ).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "surplus",
      health: [
        {
          consecutiveFailures: 1,
          lastSuccessfulTick: 100,
          nextProbeTick: 200,
          systemId: "maintenance.routine-contracts",
        },
      ],
    };
    const retainedWorld = establishedRcl2World({
      initialExtensionCount: 5,
      initialExtensionEnergy: 50,
      maintenanceRoad: { hits: 100, hitsMax: 5_000 },
    });
    const retained = runTick({ game: retainedWorld.game(101), memory: retainedMemory });
    expect(
      retained.kernel.systems.find(({ systemId }) => systemId === "maintenance.routine-contracts"),
    ).toMatchObject({ status: "skipped", skipReason: "quarantined" });
    expect(
      retained.colony.reservations.filter(
        ({ category, status }) =>
          category === "maintenance" && (status === "active" || status === "pending"),
      ),
    ).toHaveLength(1);

    (memory.myrmex as unknown as { contracts: unknown }).contracts = {};
    (
      memory.myrmex as unknown as {
        kernel: {
          runtime: unknown;
        };
      }
    ).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "surplus",
      health: [
        {
          consecutiveFailures: 1,
          lastSuccessfulTick: 100,
          nextProbeTick: 200,
          systemId: "maintenance.routine-contracts",
        },
      ],
    };
    const quarantined = runTick({ game: world.game(101), memory });
    expect(quarantined.kernel.mode).toBe("surplus");
    expect(
      quarantined.kernel.systems.find(
        ({ systemId }) => systemId === "maintenance.routine-contracts",
      ),
    ).toMatchObject({ status: "skipped", skipReason: "quarantined" });
    expect(
      quarantined.colony.reservations.filter(
        ({ category, status }) =>
          category === "maintenance" && (status === "active" || status === "pending"),
      ),
    ).toEqual([]);

    const constrainedWorld = establishedRcl2World({
      initialExtensionCount: 5,
      initialExtensionEnergy: 50,
      maintenanceRoad: { hits: 100, hitsMax: 5_000 },
    });
    constrainedWorld.setCpuBucket(4_000);
    const constrained = runTick({ game: constrainedWorld.game(100), memory: {} as Memory });
    expect(constrained.kernel.mode).toBe("constrained");
    expect(
      constrained.kernel.systems.find(
        ({ systemId }) => systemId === "maintenance.routine-contracts",
      ),
    ).toMatchObject({ status: "skipped", skipReason: "cpu-mode" });
    expect(
      constrained.colony.reservations.filter(
        ({ category, status }) =>
          category === "maintenance" && (status === "active" || status === "pending"),
      ),
    ).toEqual([]);

    const recoveringWorld = establishedRcl2World({
      initialExtensionCount: 5,
      initialExtensionEnergy: 50,
      maintenanceRoad: { hits: 100, hitsMax: 5_000 },
    });
    const recoveringMemory = {
      myrmex: {
        schema: 1,
        boot: { firstTick: 1, lastTick: 40, shard: "shard3" },
        world: { stale: true },
      },
    } as unknown as Memory;
    const recovering = runTick({
      game: recoveringWorld.game(100),
      memory: recoveringMemory,
    });
    expect(recovering.kernel.mode).toBe("recovery");
    expect(
      recovering.kernel.systems.find(
        ({ systemId }) => systemId === "maintenance.routine-contracts",
      ),
    ).toMatchObject({ status: "skipped", skipReason: "cpu-mode" });
    expect(
      recovering.colony.reservations.filter(
        ({ category, status }) =>
          category === "maintenance" && (status === "active" || status === "pending"),
      ),
    ).toEqual([]);
  });

  it("settles routine budgets from exact live contracts or current-tick binding bootstraps", () => {
    const reservation = {
      category: "maintenance",
      colonyId: "W1N1",
      createdAt: 100,
      issuer: "maintenance-v2/W1N1",
      reservationId: "maintenance-reservation",
      status: "active",
    };
    const bootstrap = {
      category: "maintenance" as const,
      colonyId: "W1N1",
      createdAtTick: 100,
      issuer: "maintenance-v2/W1N1",
    };
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [],
        contracts: { contracts: [], status: "ready" },
        reservations: [reservation],
        tick: 100,
      }),
    ).toEqual(["maintenance-reservation"]);
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [bootstrap],
        contracts: { contracts: [], status: "ready" },
        reservations: [
          reservation,
          {
            ...reservation,
            colonyId: "W2N2",
            issuer: "maintenance-v2/W2N2",
            reservationId: "other-maintenance-reservation",
          },
        ],
        tick: 100,
      }),
    ).toEqual(["other-maintenance-reservation"]);
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [bootstrap],
        contracts: { contracts: [], status: "ready" },
        reservations: [{ ...reservation, createdAt: 99 }],
        tick: 100,
      }),
    ).toEqual([]);
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [{ ...bootstrap, createdAtTick: 99 }],
        contracts: { contracts: [], status: "ready" },
        reservations: [reservation],
        tick: 100,
      }),
    ).toEqual(["maintenance-reservation"]);
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [],
        contracts: {
          contracts: [contract("live", "maintenance-v2/W1N1/road-a/9000", "active")],
          status: "ready",
        },
        reservations: [{ ...reservation, createdAt: 99 }],
        tick: 100,
      }),
    ).toEqual([]);
    const exact = contract("lookalike", "maintenance-v2/W1N1/road-a/9000", "active");
    const lookalikes: ContractPlanningRecord[] = [
      { ...exact, owner: { id: "W2N2", kind: "colony" } },
      {
        ...exact,
        budgetBinding: { category: "industry", issuer: "maintenance-v2/W1N1" },
      },
      { ...exact, issuer: "other/W1N1/road-a/9000" },
      {
        ...exact,
        execution: {
          action: "upgrade-controller",
          completion: "work-complete",
          counterpartId: null,
          resourceType: null,
          version: 1,
        },
      },
    ];
    for (const lookalike of lookalikes) {
      expect(
        unpublishedRoutineMaintenanceReservationIds({
          contractBootstraps: [],
          contracts: { contracts: [lookalike], status: "ready" },
          reservations: [{ ...reservation, createdAt: 99 }],
          tick: 100,
        }),
      ).toEqual(["maintenance-reservation"]);
    }
    expect(
      unpublishedRoutineMaintenanceReservationIds({
        contractBootstraps: [],
        contracts: { contracts: [], status: "unavailable" },
        reservations: [{ ...reservation, createdAt: 99 }],
        tick: 100,
      }),
    ).toEqual([]);
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
    health: [],
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
  issuerSequence = 1,
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
    issuerSequence,
    owner: { id: "W1N1", kind: "colony" as const },
    state,
    targetId: "target",
  };
}
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function maintenanceFunding() {
  return {
    authorizations: [
      {
        category: "maintenance",
        colonyId: "W1N1",
        expiresAt: 150,
        issuer: "maintenance-v2/W1N1",
        reservationId: "reservation:maintenance:1",
        revision: 1,
        status: "active" as const,
      },
    ],
    owners: [{ id: "W1N1", visibility: "visible" as const }],
    status: "ready" as const,
  };
}
