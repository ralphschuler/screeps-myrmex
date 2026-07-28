import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import {
  DEFAULT_REMOTE_MINING_POLICY_V1,
  DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  DEFAULT_REMOTE_RESERVATION_POLICY_V1,
  DEFAULT_REMOTE_SAFETY_POLICY_V1,
  REMOTE_SAFETY_LIMITS,
  RemoteMiningPlanner,
  RemotePortfolio,
  RemoteReservationPlanner,
  assessRemoteSafety,
  planRemoteEvacuations,
  type RemoteCandidateEvidence,
  type RemoteSafetyEvidence,
} from "../src/remotes";
import type {
  ContractPlanningRecord,
  ContractPlanningView,
  LeasedWorkExecution,
} from "../src/contracts";
import { DEFAULT_REMOTE_HAULING_POLICY_V1, projectRemoteHauling } from "../src/logistics";
import type { RoomIntelHostile, RoomIntelQueryResult, RoomIntelRecordV1 } from "../src/world/intel";
import type { RoutePlanResult } from "../src/world/routes";

const CONFIG = buildRuntimeConfig({ relations: { allies: ["Friendly"], self: ["Myrmex"] } });

describe("remote threat safety", () => {
  it("distinguishes credible NPC/player threats from harmless and excluded creeps", () => {
    const cases = [
      evidence("W1N2", [hostile("Invader", { attack: 1 })]),
      evidence("W1N3", [hostile("Enemy", { rangedAttack: 1 })]),
      evidence("W1N4", [hostile("Scout", {})]),
      evidence("W1N5", [hostile("Friendly", { attack: 10 })]),
    ];

    const result = assessRemoteSafety({
      availableCpuMilli: 100,
      config: CONFIG,
      evidence: cases,
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });

    expect(result.status).toBe("ready");
    expect(
      result.assessments.map(({ reason, roomName, threatRisk }) => ({
        reason,
        roomName,
        threatRisk,
      })),
    ).toEqual([
      { reason: "credible-hostile", roomName: "W1N2", threatRisk: 1 },
      { reason: "credible-hostile", roomName: "W1N3", threatRisk: 1 },
      { reason: "harmless-presence", roomName: "W1N4", threatRisk: 0 },
      { reason: "excluded-presence", roomName: "W1N5", threatRisk: 0 },
    ]);
    expect(result.candidates.map(({ roomName, threatRisk }) => ({ roomName, threatRisk }))).toEqual(
      [
        { roomName: "W1N2", threatRisk: 1 },
        { roomName: "W1N3", threatRisk: 1 },
        { roomName: "W1N4", threatRisk: 0 },
        { roomName: "W1N5", threatRisk: 0 },
      ],
    );
  });

  it("fails closed on attack, invader-core, route, freshness, confidence, and loss evidence", () => {
    const attack = changeIntel(
      evidence("W2N2", []),
      {},
      {
        events: [
          {
            amount: 30,
            attackType: 1,
            event: 1,
            objectId: "unknown-attacker",
            resourceType: null,
            structureType: null,
            targetId: "miner-a",
            x: null,
            y: null,
          },
        ],
      },
    );
    const invaderCore = changeIntel(
      evidence("W2N3", []),
      {},
      {
        structures: [
          {
            hits: 100_000,
            hitsMax: 100_000,
            id: "core-a",
            invaderCore: { level: 1, ticksToDeploy: 50 },
            isPublic: null,
            ownerUsername: "Invader",
            ownership: "foreign",
            portal: null,
            pos: { x: 20, y: 20 },
            structureType: "invaderCore",
            ticksToDecay: null,
          },
        ],
      },
    );
    const routeThreatBase = evidence("W2N4", []);
    const routeThreat: RemoteSafetyEvidence = {
      ...routeThreatBase,
      candidate: {
        ...routeThreatBase.candidate,
        route: {
          ...routeThreatBase.candidate.route,
          plan:
            routeThreatBase.candidate.route.plan === null
              ? null
              : { ...routeThreatBase.candidate.route.plan, risk: 1 },
        },
      },
    };
    const stale = changeIntel(evidence("W2N5", []), { freshness: "stale" });
    const confidence = { ...evidence("W2N6", []), confidenceBasisPoints: 7_999 };
    const loss = { ...evidence("W2N7", []), recentLossBasisPoints: 2_501 };
    const partial = changeIntel(evidence("W2N8", []), { quality: "partial" });
    const unavailableBase = evidence("W2N9", []);
    const unavailable: RemoteSafetyEvidence = {
      ...unavailableBase,
      candidate: {
        ...unavailableBase.candidate,
        intel: {
          ...unavailableBase.candidate.intel,
          freshness: "unknown",
          quality: "unknown",
          reason: "service-unavailable",
          record: null,
        },
      },
    };

    const result = assessRemoteSafety({
      availableCpuMilli: 200,
      config: CONFIG,
      evidence: [unavailable, loss, stale, partial, attack, confidence, routeThreat, invaderCore],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });

    expect(
      result.assessments.map(({ reason, roomName, threatRisk }) => ({
        reason,
        roomName,
        threatRisk,
      })),
    ).toEqual([
      { reason: "recent-attack", roomName: "W2N2", threatRisk: 1 },
      { reason: "invader-core", roomName: "W2N3", threatRisk: 1 },
      { reason: "route-threat", roomName: "W2N4", threatRisk: 1 },
      { reason: "intel-stale", roomName: "W2N5", threatRisk: 1 },
      { reason: "confidence-low", roomName: "W2N6", threatRisk: 1 },
      { reason: "loss-risk", roomName: "W2N7", threatRisk: 1 },
      { reason: "intel-partial", roomName: "W2N8", threatRisk: 1 },
      { reason: "intel-unavailable", roomName: "W2N9", threatRisk: 1 },
    ]);
    expect(result.metrics).toMatchObject({ assessed: 8, cpuMilli: 200, unsafe: 8 });
  });

  it("redirects exposed leases, preserves loaded delivery, and settles evacuation or loss", () => {
    const unsafeEvidence = evidence("W4N2", [hostile("Invader", { attack: 1 })]);
    const safety = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [unsafeEvidence],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });
    const miner = miningLease("miner-a");
    const delivery = haulingDeliveryLease("hauler-a");
    const lostReserver = reservationLease("reserver-a");
    const active = planRemoteEvacuations({
      actors: [actor("miner-a", "W4N2", 0), actor("hauler-a", "W4N2", 200)],
      assessments: safety.assessments,
      evidence: [unsafeEvidence],
      execution: { leases: [lostReserver, delivery, miner], status: "ready" },
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });

    expect(active.overrides).toEqual([
      expect.objectContaining({
        actorId: "miner-a",
        contractId: "mining/miner-a",
        destinationRoomName: "W1N1",
        originRoomName: "W4N2",
        routeRoomNames: ["W1N1"],
      }),
    ]);
    expect(active.transitions).toEqual([
      {
        contractId: "reservation/reserver-a",
        reason: "remote-safety-actor-lost",
        tick: 100,
        to: "suspended",
      },
    ]);
    expect(active.dispositions).toEqual([
      expect.objectContaining({ actorId: "hauler-a", reason: "cargo-returning" }),
      expect.objectContaining({ actorId: "miner-a", reason: "evacuating" }),
      expect.objectContaining({ actorId: "reserver-a", reason: "actor-lost" }),
    ]);

    const arrived = planRemoteEvacuations({
      actors: [actor("miner-a", "W1N1", 0)],
      assessments: safety.assessments,
      evidence: [unsafeEvidence],
      execution: { leases: [miner], status: "ready" },
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 101,
    });
    expect(arrived.overrides).toEqual([
      expect.objectContaining({ actorId: "miner-a", mode: "hold", originRoomName: "W1N1" }),
    ]);
    expect(arrived.transitions).toEqual([
      {
        contractId: "mining/miner-a",
        reason: "remote-safety-evacuated",
        tick: 101,
        to: "suspended",
      },
    ]);
  });

  it("holds exposed work when no safe return route is available", () => {
    const unsafeEvidence = evidence("W4N2", [hostile("Invader", { attack: 1 })]);
    const safety = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [unsafeEvidence],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });
    const unavailableEvidence: RemoteSafetyEvidence = {
      ...unsafeEvidence,
      evacuationRoute: {
        ...unsafeEvidence.evacuationRoute,
        plan: null,
        reason: "no-path",
        status: "no-route",
      },
    };
    const result = planRemoteEvacuations({
      actors: [actor("miner-a", "W4N2", 0)],
      assessments: safety.assessments,
      evidence: [unavailableEvidence],
      execution: { leases: [miningLease("miner-a")], status: "ready" },
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });

    expect(result.overrides).toEqual([
      expect.objectContaining({
        actorId: "miner-a",
        destinationRoomName: "W4N2",
        mode: "hold",
        originRoomName: "W4N2",
      }),
    ]);
    expect(result.transitions).toEqual([
      {
        contractId: "mining/miner-a",
        reason: "remote-safety-route-unavailable",
        tick: 100,
        to: "suspended",
      },
    ]);
  });

  it("keeps loaded delivery under Logistics ownership after it enters the donor room", () => {
    const unsafeEvidence = evidence("W4N2", [hostile("Invader", { attack: 1 })]);
    const safety = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [unsafeEvidence],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });
    const result = planRemoteEvacuations({
      actors: [actor("hauler-a", "W1N1", 200)],
      assessments: safety.assessments,
      evidence: [unsafeEvidence],
      execution: { leases: [haulingDeliveryLease("hauler-a")], status: "ready" },
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });

    expect(result.dispositions).toEqual([
      expect.objectContaining({ actorId: "hauler-a", reason: "cargo-returning" }),
    ]);
    expect(result.overrides).toEqual([]);
    expect(result.transitions).toEqual([]);
  });

  it("releases the portfolio and stops replacement, reservation, hauling, and capital demand", () => {
    const safeEvidence = evidence("W1N2", []);
    const portfolio = new RemotePortfolio();
    const capacity = {
      activeRemotes: 1,
      cpuMilli: 10_000,
      energy: 10_000,
      memoryCodeUnits: 10_000,
      spawnTicks: 1_000,
    };
    const probing = portfolio.plan({
      candidates: [safeEvidence.candidate],
      capacity,
      owner: {},
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      tick: 100,
    });
    const active = portfolio.plan({
      candidates: [safeEvidence.candidate],
      capacity,
      owner: probing.owner,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      tick: 101,
    });
    const threatenedEvidence = evidence("W1N2", [hostile("Invader", { attack: 1 })]);
    const safety = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [threatenedEvidence],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 102,
    });
    const threatened = portfolio.plan({
      candidates: safety.candidates,
      capacity,
      owner: active.owner,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      tick: 102,
    });
    const contracts = planningView();
    const mining = new RemoteMiningPlanner().plan({
      budgets: [],
      contracts,
      objectives: [],
      policy: DEFAULT_REMOTE_MINING_POLICY_V1,
      tick: 102,
    });
    const reservation = new RemoteReservationPlanner().plan({
      budgets: [],
      contracts,
      objectives: [],
      policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
      tick: 102,
    });
    const hauling = projectRemoteHauling({
      budgets: [],
      objectives: [],
      policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
      tick: 102,
    });

    expect(threatened.objectives).toEqual([]);
    expect(threatened.metrics).toMatchObject({ released: 1, reservedEnergy: 0 });
    expect(mining).toMatchObject({
      budgetRequests: [],
      contractRequests: [],
      siteProposals: [],
      transitions: [
        expect.objectContaining({ reason: "remote-mining-portfolio-unavailable", to: "suspended" }),
      ],
    });
    expect(reservation).toMatchObject({
      budgetRequests: [],
      contractRequests: [],
      transitions: [
        expect.objectContaining({
          reason: "remote-reservation-portfolio-unavailable",
          to: "suspended",
        }),
      ],
    });
    expect(hauling).toMatchObject({
      budgetRequests: [],
      projection: { edges: [], endpoints: [], nodes: [] },
    });
  });

  it("continues an incomplete evacuation throughout portfolio cooldown", () => {
    const safeEvidence = evidence("W5N2", []);
    const safety = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [safeEvidence],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 103,
    });
    const lease = { ...miningLease("miner-a"), target: { roomName: "W5N2", x: 10, y: 10 } };
    const result = planRemoteEvacuations({
      actors: [actor("miner-a", "W5N2", 0)],
      assessments: safety.assessments,
      evidence: [
        {
          ...safeEvidence,
          evacuationRoute: route("W5N2", "W1N1", "evacuate/W5N2"),
        },
      ],
      execution: { leases: [lease], status: "ready" },
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      portfolioDispositions: [
        {
          profit: 10_000,
          reason: "cooldown-wait",
          roomName: "W5N2",
          state: "suspended",
        },
      ],
      tick: 103,
    });

    expect(result.overrides).toEqual([
      expect.objectContaining({ actorId: "miner-a", destinationRoomName: "W1N1" }),
    ]);
  });

  it("rejects malformed or partial batches when CPU and evidence bounds cannot fit", () => {
    const values = [evidence("W3N2", []), evidence("W3N3", [])];
    expect(
      assessRemoteSafety({
        availableCpuMilli: 25,
        config: CONFIG,
        evidence: [null],
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      } as unknown as Parameters<typeof assessRemoteSafety>[0]),
    ).toMatchObject({ status: "invalid-input", assessments: [], candidates: [] });
    expect(
      assessRemoteSafety({
        availableCpuMilli: 49,
        config: CONFIG,
        evidence: values,
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      }),
    ).toMatchObject({ status: "cpu-budget", assessments: [], candidates: [] });
    expect(
      assessRemoteSafety({
        availableCpuMilli: 1_000,
        config: CONFIG,
        evidence: Array.from({ length: 9 }, (_, index) => evidence(`W${String(index + 10)}N2`, [])),
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      }),
    ).toMatchObject({ status: "limit-exceeded", assessments: [], candidates: [] });
    expect(
      assessRemoteSafety({
        availableCpuMilli: 25,
        config: CONFIG,
        evidence: [
          evidence(
            "W3N4",
            Array.from({ length: 33 }, (_, index) =>
              hostile(`Enemy${String(index)}`, { attack: 1 }),
            ),
          ),
        ],
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      }),
    ).toMatchObject({ status: "invalid-input", assessments: [], candidates: [] });

    expect(() =>
      planRemoteEvacuations(null as unknown as Parameters<typeof planRemoteEvacuations>[0]),
    ).not.toThrow();
    expect(
      planRemoteEvacuations(null as unknown as Parameters<typeof planRemoteEvacuations>[0]),
    ).toMatchObject({ status: "invalid-input", overrides: [], transitions: [] });

    const primary = values[0];
    if (primary === undefined) throw new Error("expected primary safety evidence");
    const assessed = assessRemoteSafety({
      availableCpuMilli: 25,
      config: CONFIG,
      evidence: [primary],
      policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
      tick: 100,
    });
    const primaryAssessment = assessed.assessments[0];
    if (primaryAssessment === undefined) throw new Error("expected primary safety assessment");
    expect(
      planRemoteEvacuations({
        actors: [],
        assessments: [{ ...primaryAssessment, evidenceRevision: "mismatched-revision" }],
        evidence: [primary],
        execution: { leases: [], status: "ready" },
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      }),
    ).toMatchObject({ status: "invalid-input", overrides: [], transitions: [] });
    expect(
      planRemoteEvacuations({
        actors: [],
        assessments: Array.from(
          { length: REMOTE_SAFETY_LIMITS.maximumEvidencePerTick + 1 },
          (_, index) => ({
            ...primaryAssessment,
            roomName: `W${String(index + 10)}N3`,
          }),
        ),
        evidence: [primary],
        execution: { leases: [], status: "ready" },
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: 100,
      }),
    ).toMatchObject({ status: "limit-exceeded", overrides: [], transitions: [] });
    expect(
      planRemoteEvacuations({
        actors: [],
        assessments: assessed.assessments,
        evidence: [primary],
        execution: { leases: [], status: "ready" },
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        portfolioDispositions: Array.from(
          { length: REMOTE_SAFETY_LIMITS.maximumPortfolioDispositions + 1 },
          (_, index) => ({
            profit: 1,
            reason: "positive-active" as const,
            roomName: `W${String(index + 10)}N4`,
            state: "active" as const,
          }),
        ),
        tick: 100,
      }),
    ).toMatchObject({ status: "limit-exceeded", overrides: [], transitions: [] });
  });
});

function evidence(roomName: string, hostiles: readonly RoomIntelHostile[]): RemoteSafetyEvidence {
  return {
    candidate: candidate(roomName, hostiles),
    confidenceBasisPoints: 10_000,
    evacuationRoute: route(roomName, "W1N1", `evacuate/${roomName}`),
    recentLossBasisPoints: 0,
  };
}

function planningView(): ContractPlanningView {
  const mining = miningLease("miner-a");
  const reservation = reservationLease("reserver-a");
  const record = (lease: LeasedWorkExecution, issuer: string): ContractPlanningRecord => ({
    budgetBinding: { category: "harvesting-filling", issuer },
    contractId: lease.contractId,
    execution: lease.execution,
    issuer,
    issuerSequence: 1,
    owner: { id: "W1N1", kind: "colony" },
    state: "active",
    targetId: lease.targetId,
  });
  return {
    contracts: [
      record(mining, "remote-mining/W1N1/W1N2/source-a"),
      record(reservation, "remote-reservation/W1N1/W1N2"),
    ],
    status: "ready",
  };
}

function miningLease(actorId: string): LeasedWorkExecution {
  return {
    actorId,
    actorName: actorId,
    contractId: `mining/${actorId}`,
    deadline: 1_000,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      offload: "container-or-drop",
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W4N2"],
      routeTravelTicks: 40,
      version: 5,
      workPosition: { roomName: "W4N2", x: 9, y: 9 },
    },
    expiresAt: 1_001,
    leaseExpiresAt: 1_001,
    priority: { class: "speculation", value: 700 },
    quantity: 300,
    range: 1,
    revision: 1,
    state: "active",
    target: { roomName: "W4N2", x: 10, y: 10 },
    targetId: "source-a",
  };
}

function reservationLease(actorId: string): LeasedWorkExecution {
  return {
    ...miningLease(actorId),
    contractId: `reservation/${actorId}`,
    execution: {
      action: "reserve-controller",
      completion: "work-complete",
      counterpartId: null,
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W4N2"],
      routeTravelTicks: 40,
      signText: null,
      targetReservationTicks: 450,
      version: 4,
    },
    target: { roomName: "W4N2", x: 25, y: 25 },
    targetId: "controller-a",
  };
}

function haulingDeliveryLease(actorId: string): LeasedWorkExecution {
  return {
    ...miningLease(actorId),
    contractId: `hauling/${actorId}`,
    execution: {
      acquireOriginRoomName: "W1N1",
      acquireRouteRoomNames: ["W4N2"],
      acquireRouteTravelTicks: 40,
      action: "transfer",
      completion: "target-full",
      counterpartId: "container-a",
      deliverOriginRoomName: "W4N2",
      deliverRouteRoomNames: ["W1N1"],
      deliverRouteTravelTicks: 40,
      flowId: "remote-haul/a",
      recommendedCarry: 4,
      recommendedMove: 4,
      reservedAmount: 200,
      resourceType: "energy",
      sinkBaselineAmount: 1_000,
      sinkNodeId: "sink-a",
      sinkPosition: { roomName: "W1N1", x: 20, y: 20 },
      sinkTargetId: "storage-a",
      sourceNodeId: "source-a",
      sourcePosition: { roomName: "W4N2", x: 9, y: 9 },
      sourceTargetId: "container-a",
      stage: "deliver",
      version: 6,
    },
    quantity: 200,
    target: { roomName: "W1N1", x: 20, y: 20 },
    targetId: "storage-a",
  };
}

function actor(id: string, roomName: string, energy: number) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 2,
      attack: zero,
      carry: { active: 1, boosted: 0, total: 1 },
      claim: zero,
      heal: zero,
      move: { active: 1, boosted: 0, total: 1 },
      rangedAttack: zero,
      size: 2,
      tough: zero,
      work: zero,
    },
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id,
    name: id,
    ownerUsername: "Myrmex",
    pos: { roomName, x: 20, y: 20 },
    spawning: false,
    store: {
      capacity: 200,
      freeCapacity: 200 - energy,
      resources:
        energy === 0 ? [] : [{ amount: energy, resourceType: "energy" as ResourceConstant }],
      usedCapacity: energy,
    },
    ticksToLive: 1_000,
  };
}

function changeIntel(
  value: RemoteSafetyEvidence,
  query: Partial<RoomIntelQueryResult>,
  record: Partial<RoomIntelRecordV1> = {},
): RemoteSafetyEvidence {
  const prior = value.candidate.intel.record;
  if (prior === null) throw new Error("expected intel record");
  return {
    ...value,
    candidate: {
      ...value.candidate,
      intel: { ...value.candidate.intel, ...query, record: { ...prior, ...record } },
    },
  };
}

function candidate(
  roomName: string,
  hostiles: readonly RoomIntelHostile[],
): RemoteCandidateEvidence {
  return {
    commitment: { cpuMilli: 1_000, energy: 5_000, memoryCodeUnits: 2_048, spawnTicks: 100 },
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
    expiresAt: 1_000,
    intel: intel(roomName, hostiles),
    roomName,
    route: route("W1N1", roomName, `acquire/${roomName}`),
    threatRisk: 0,
  };
}

function intel(roomName: string, hostiles: readonly RoomIntelHostile[]): RoomIntelQueryResult {
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
        reservationTicksToEnd: 1_000,
        reservationUsername: "Myrmex",
        safeMode: null,
      },
      eventLogStatus: "observed",
      events: [],
      eventsObservedAt: 99,
      hostileStatus: "complete",
      hostiles,
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
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
    },
    roomName,
  };
}

function hostile(
  ownerUsername: string,
  offense: Partial<Record<"attack" | "claim" | "rangedAttack" | "work", number>>,
): RoomIntelHostile {
  const part = (active: number) => ({ active, boosted: 0, total: active });
  const attack = offense.attack ?? 0;
  const claim = offense.claim ?? 0;
  const rangedAttack = offense.rangedAttack ?? 0;
  const work = offense.work ?? 0;
  const move = 1;
  const size = attack + claim + rangedAttack + work + move;
  return {
    body: {
      activeParts: size,
      attack: part(attack),
      carry: part(0),
      claim: part(claim),
      heal: part(0),
      move: part(move),
      rangedAttack: part(rangedAttack),
      size,
      tough: part(0),
      work: part(work),
    },
    hits: size * 100,
    hitsMax: size * 100,
    id: `creep/${ownerUsername}`,
    ownerUsername,
    pos: { x: 20, y: 20 },
    ticksToLive: 1_000,
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
