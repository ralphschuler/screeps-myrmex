import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_ACCOUNTING_POLICY_V1,
  REMOTE_ACCOUNTING_LIMITS,
  RemotePortfolio,
  reduceRemoteAccounting,
  type RemoteAccountingObservation,
  type RemoteAccountingPolicyV1,
  type RemoteAccountingSampleV1,
  type RemoteCandidateEvidence,
} from "../src/remotes";
import type { RoomIntelQueryResult } from "../src/world/intel";
import type { RoutePlanResult } from "../src/world/routes";

const POLICY: RemoteAccountingPolicyV1 = Object.freeze({
  ...DEFAULT_REMOTE_ACCOUNTING_POLICY_V1,
  windowTicks: 10,
  maximumSamplesPerRemote: 10,
  minimumCompleteTicks: 3,
  minimumConfidenceBasisPoints: 7_500,
  staleAfterTicks: 2,
  minimumProfitMilliPerTick: 1,
  marginalProfitMilliPerTick: 1_000,
  spawnTimeCostMilliEnergyPerTick: 100,
  travelCostMilliEnergyPerTick: 50,
  cpuCostMilliEnergyPerMilliCpu: 2,
});

describe("RemotePortfolio realized accounting", () => {
  it("attributes every realized cost and classifies complete rolling profit", () => {
    let records = reduceRemoteAccounting({
      observations: [observation(100, { deliveredEnergy: 20 })],
      policy: POLICY,
      previous: [],
      tick: 100,
    }).records;
    records = reduceRemoteAccounting({
      observations: [observation(101, { deliveredEnergy: 20 })],
      policy: POLICY,
      previous: records,
      tick: 101,
    }).records;
    const result = reduceRemoteAccounting({
      observations: [
        observation(102, {
          constructionEnergy: 2,
          cpuMilli: 100,
          creepLossEnergy: 7,
          deliveredEnergy: 20,
          downtimeTicks: 1,
          repairEnergy: 3,
          reservationEnergy: 5,
          spawnEnergy: 11,
          spawnTicks: 13,
          travelTicks: 17,
        }),
      ],
      policy: POLICY,
      previous: records,
      tick: 102,
    });

    expect(result.status).toBe("ready");
    expect(result.summaries).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        windowStartTick: 100,
        windowEndTick: 102,
        sampleTicks: 3,
        completeTicks: 3,
        confidenceBasisPoints: 10_000,
        harvestedEnergy: 30,
        deliveredEnergy: 60,
        downtimeTicks: 1,
        forecastProfitMilliPerTick: 4_000,
        reason: "profitable",
        costs: {
          spawnEnergyMilli: 11_000,
          spawnTimeMilli: 1_300,
          travelMilli: 850,
          reservationMilli: 5_000,
          constructionMilli: 2_000,
          repairMilli: 3_000,
          cpuMilli: 200,
          creepLossMilli: 7_000,
          downtimeMilli: 10_000,
          totalMilli: 40_350,
        },
        revenueMilli: 60_000,
        profitMilli: 19_650,
        profitMilliPerTick: 6_550,
        forecastVarianceMilliPerTick: 2_550,
        utilizationBasisPoints: 10_000,
      }),
    ]);
    expect(result.metrics).toMatchObject({
      observed: 1,
      tracked: 1,
      profitable: 1,
      lossMaking: 0,
      revenueMilli: 60_000,
      costMilli: 40_350,
      profitMilli: 19_650,
    });
  });

  it("keeps marginal and loss-making outcomes distinct from forecast", () => {
    const profitable = reduceThreeTicks((tick) =>
      observation(tick, { deliveredEnergy: 10, forecastProfitMilliPerTick: 9_000 }),
    );
    const marginal = reduceThreeTicks((tick) =>
      observation(tick, {
        deliveredEnergy: 1,
        forecastProfitMilliPerTick: 9_000,
      }),
    );
    const loss = reduceThreeTicks((tick) =>
      observation(tick, {
        deliveredEnergy: 0,
        forecastProfitMilliPerTick: 9_000,
        repairEnergy: 1,
      }),
    );

    expect(profitable.summaries[0]).toMatchObject({
      reason: "profitable",
      profitMilliPerTick: 10_000,
      forecastVarianceMilliPerTick: 1_000,
    });
    expect(marginal.summaries[0]).toMatchObject({
      reason: "marginal",
      profitMilliPerTick: 1_000,
      forecastVarianceMilliPerTick: -8_000,
    });
    expect(loss.summaries[0]).toMatchObject({
      reason: "loss-making",
      profitMilliPerTick: -1_000,
      forecastVarianceMilliPerTick: -10_000,
    });
  });

  it("rejects cyclic input, future samples, and arithmetic overflow without a prefix", () => {
    const cyclic = observation(100) as unknown as Record<string, unknown>;
    cyclic.harvestedEnergy = cyclic;
    const cyclicResult = (): ReturnType<typeof reduceRemoteAccounting> =>
      reduceRemoteAccounting({
        observations: [cyclic as unknown as RemoteAccountingObservation],
        policy: POLICY,
        previous: [],
        tick: 100,
      });
    const futureSample: RemoteAccountingSampleV1 = [101, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1];
    const future = reduceRemoteAccounting({
      observations: [],
      policy: POLICY,
      previous: [{ roomName: "W1N2", donorColonyId: "W1N1", samples: [futureSample] }],
      tick: 100,
    });
    const overflowingSample: RemoteAccountingSampleV1 = [
      100,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick,
      REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick,
      0,
    ];
    const offsetSample: RemoteAccountingSampleV1 = [101, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
    const overflow = reduceRemoteAccounting({
      observations: [],
      policy: POLICY,
      previous: [
        {
          roomName: "W1N2",
          donorColonyId: "W1N1",
          samples: [overflowingSample, offsetSample],
        },
      ],
      tick: 101,
    });

    expect(cyclicResult).not.toThrow();
    expect(cyclicResult()).toMatchObject({ status: "invalid-input", changed: false, records: [] });
    expect(future).toMatchObject({ status: "invalid-input", changed: false });
    expect(future.records[0]?.samples).toEqual([futureSample]);
    expect(overflow).toMatchObject({ status: "invalid-input", changed: false });
    expect(overflow.records[0]?.samples).toEqual([overflowingSample, offsetSample]);
  });

  it("fails stale, partial, conflicting, and over-cap accounting closed without a prefix", () => {
    const initial = reduceRemoteAccounting({
      observations: [observation(100)],
      policy: POLICY,
      previous: [],
      tick: 100,
    });
    const sameTick = reduceRemoteAccounting({
      observations: [observation(100)],
      policy: POLICY,
      previous: initial.records,
      tick: 100,
    });
    const conflict = reduceRemoteAccounting({
      observations: [observation(100, { deliveredEnergy: 999 })],
      policy: POLICY,
      previous: initial.records,
      tick: 100,
    });
    const partial = reduceRemoteAccounting({
      observations: [observation(101, { quality: "partial" })],
      policy: POLICY,
      previous: initial.records,
      tick: 101,
    });
    const stale = reduceRemoteAccounting({
      observations: [],
      policy: POLICY,
      previous: initial.records,
      tick: 103,
    });
    const overflow = reduceRemoteAccounting({
      observations: Array.from(
        { length: REMOTE_ACCOUNTING_LIMITS.maximumObservationsPerTick + 1 },
        (_, index) => observation(200, { roomName: `W${String(index + 2)}N2` }),
      ),
      policy: POLICY,
      previous: initial.records,
      tick: 200,
    });

    expect(sameTick).toEqual({ ...initial, changed: false });
    expect(conflict).toMatchObject({ status: "invalid-input", changed: false });
    expect(conflict.records).toEqual(initial.records);
    expect(partial.summaries[0]).toMatchObject({ reason: "incomplete" });
    expect(stale.summaries[0]).toMatchObject({ reason: "stale" });
    expect(overflow).toMatchObject({ status: "limit-exceeded", changed: false });
    expect(overflow.records).toEqual(initial.records);
  });

  it("feeds qualified realized loss into the sole portfolio suspension authority", () => {
    const portfolio = new RemotePortfolio();
    let owner: unknown = {};
    let result: ReturnType<RemotePortfolio["plan"]> | null = null;
    for (const tick of [100, 101, 102]) {
      result = portfolio.plan({
        accounting: [
          observation(tick, {
            deliveredEnergy: 0,
            forecastProfitMilliPerTick: 9_000,
            repairEnergy: 1,
          }),
        ],
        accountingPolicy: POLICY,
        candidates: [portfolioCandidate(tick)],
        capacity: {
          activeRemotes: 1,
          cpuMilli: 1_000,
          energy: 10_000,
          memoryCodeUnits: 10_000,
          spawnTicks: 1_000,
        },
        owner,
        policy: {
          schemaVersion: 1,
          revision: "test-portfolio-policy-v1",
          minimumProfitMilliPerTick: 1,
          activeRetentionBonusMilliPerTick: 1_000,
          maximumThreatRisk: 0,
          probingTicks: 2,
          suspensionCooldownTicks: 3,
          resumptionProbeTicks: 2,
        },
        tick,
      });
      owner = result.owner;
    }

    expect(result?.accounting.summaries[0]).toMatchObject({
      reason: "loss-making",
      forecastProfitMilliPerTick: 9_000,
      profitMilliPerTick: -1_000,
    });
    expect(result?.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "realized-negative",
      commitment: null,
    });
    expect(result?.metrics).toMatchObject({ released: 1, reservedEnergy: 0 });
  });

  it("preserves every tracked commitment when a ninth accounting receipt cannot fit", () => {
    const portfolio = new RemotePortfolio();
    const rooms = Array.from(
      { length: REMOTE_ACCOUNTING_LIMITS.maximumRecords },
      (_, index) => `W${String(index + 2)}N2`,
    );
    let owner: unknown = {};
    for (const tick of [100, 101]) {
      const result = portfolio.plan({
        accounting: rooms.map((roomName) => observation(tick, { roomName, deliveredEnergy: 10 })),
        accountingPolicy: POLICY,
        candidates: rooms.map((roomName) => portfolioCandidate(tick, roomName)),
        capacity: {
          activeRemotes: REMOTE_ACCOUNTING_LIMITS.maximumRecords,
          cpuMilli: 10_000,
          energy: 100_000,
          memoryCodeUnits: 20_000,
          spawnTicks: 10_000,
        },
        owner,
        policy: portfolioPolicy(),
        tick,
      });
      expect(result.status).toBe("ready");
      owner = result.owner;
    }
    const overflow = portfolio.plan({
      accounting: [observation(102, { roomName: "E1S1", deliveredEnergy: 10 })],
      accountingPolicy: POLICY,
      candidates: rooms.map((roomName) => portfolioCandidate(102, roomName)),
      capacity: {
        activeRemotes: REMOTE_ACCOUNTING_LIMITS.maximumRecords,
        cpuMilli: 10_000,
        energy: 100_000,
        memoryCodeUnits: 20_000,
        spawnTicks: 10_000,
      },
      owner,
      policy: portfolioPolicy(),
      tick: 102,
    });

    expect(overflow).toMatchObject({ status: "limit-exceeded", changed: false, owner: null });
  });

  it("suspends tracked work when realized accounting becomes stale or incomplete", () => {
    const portfolio = new RemotePortfolio();
    let owner: unknown = {};
    for (const tick of [100, 101, 102]) {
      const result = portfolio.plan({
        accounting: [observation(tick, { deliveredEnergy: 10 })],
        accountingPolicy: POLICY,
        candidates: [portfolioCandidate(tick)],
        capacity: portfolioCapacity(),
        owner,
        policy: portfolioPolicy(),
        tick,
      });
      owner = result.owner;
    }
    const stale = portfolio.plan({
      accounting: [],
      accountingPolicy: POLICY,
      candidates: [portfolioCandidate(105)],
      capacity: portfolioCapacity(),
      owner,
      policy: portfolioPolicy(),
      tick: 105,
    });
    const incomplete = portfolio.plan({
      accounting: [observation(103, { deliveredEnergy: 10, quality: "partial" })],
      accountingPolicy: POLICY,
      candidates: [portfolioCandidate(103)],
      capacity: portfolioCapacity(),
      owner,
      policy: portfolioPolicy(),
      tick: 103,
    });

    expect(stale.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "accounting-stale",
    });
    expect(incomplete.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "accounting-incomplete",
    });
  });

  it("is deterministic under reordering and evicts only unprotected oldest accounting", () => {
    const observations = Array.from(
      { length: REMOTE_ACCOUNTING_LIMITS.maximumRecords },
      (_, index) => observation(100, { roomName: `W${String(index + 2)}N2` }),
    );
    const ordered = reduceRemoteAccounting({
      observations,
      policy: POLICY,
      previous: [],
      tick: 100,
    });
    const reversed = reduceRemoteAccounting({
      observations: [...observations].reverse(),
      policy: POLICY,
      previous: [],
      tick: 100,
    });
    const protectedRoomNames = ordered.records.map(({ roomName }) => roomName);
    const rejected = reduceRemoteAccounting({
      observations: [observation(101, { roomName: "E1S1" })],
      policy: POLICY,
      previous: ordered.records,
      protectedRoomNames,
      tick: 101,
    });
    const evicted = reduceRemoteAccounting({
      observations: [observation(101, { roomName: "E1S1" })],
      policy: POLICY,
      previous: ordered.records,
      protectedRoomNames: ["W2N2"],
      tick: 101,
    });

    expect(reversed).toEqual(ordered);
    expect(rejected).toMatchObject({ status: "limit-exceeded", changed: false });
    expect(rejected.records).toEqual(ordered.records);
    expect(evicted.status).toBe("ready");
    expect(evicted.records.map(({ roomName }) => roomName)).toContain("W2N2");
    expect(evicted.records.map(({ roomName }) => roomName)).toContain("E1S1");
    expect(evicted.records.map(({ roomName }) => roomName)).not.toContain("W3N2");
  });
});

function reduceThreeTicks(
  build: (tick: number) => RemoteAccountingObservation,
): ReturnType<typeof reduceRemoteAccounting> {
  let records: ReturnType<typeof reduceRemoteAccounting>["records"] = [];
  let result: ReturnType<typeof reduceRemoteAccounting> | null = null;
  for (const tick of [100, 101, 102]) {
    result = reduceRemoteAccounting({
      observations: [build(tick)],
      policy: POLICY,
      previous: records,
      tick,
    });
    records = result.records;
  }
  if (result === null) throw new Error("missing accounting result");
  return result;
}

function portfolioCapacity() {
  return {
    activeRemotes: 1,
    cpuMilli: 1_000,
    energy: 10_000,
    memoryCodeUnits: 10_000,
    spawnTicks: 1_000,
  } as const;
}

function portfolioPolicy() {
  return {
    schemaVersion: 1,
    revision: "test-portfolio-policy-v1",
    minimumProfitMilliPerTick: 1,
    activeRetentionBonusMilliPerTick: 1_000,
    maximumThreatRisk: 0,
    probingTicks: 2,
    suspensionCooldownTicks: 3,
    resumptionProbeTicks: 2,
  } as const;
}

function portfolioCandidate(tick: number, roomName = "W1N2"): RemoteCandidateEvidence {
  return {
    roomName,
    donorColonyId: "W1N1",
    evidenceRevision: `evidence/${roomName}/${String(tick)}`,
    expiresAt: 1_000,
    controller: "available",
    donor: "healthy",
    threatRisk: 0,
    intel: portfolioIntel(tick, roomName),
    route: portfolioRoute(roomName),
    costs: {
      latency: 1_000,
      spawn: 1_000,
      body: 1_000,
      hauling: 1_000,
      reservation: 1_000,
      roads: 1_000,
      repair: 1_000,
      expectedLoss: 1_000,
      cpu: 1_000,
    },
    commitment: { energy: 1_000, spawnTicks: 30, cpuMilli: 100, memoryCodeUnits: 256 },
  };
}

function portfolioIntel(tick: number, roomName = "W1N2"): RoomIntelQueryResult {
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
      observedAt: tick,
      eventsObservedAt: tick - 1,
      complete: true,
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
      controller: {
        id: `controller/${roomName}`,
        level: 0,
        ownerUsername: null,
        ownership: "neutral",
        pos: { x: 25, y: 25 },
        reservationTicksToEnd: null,
        reservationUsername: null,
        safeMode: null,
      },
      mineral: null,
      mineralStatus: "complete",
      sources: [{ id: "source-a", energyCapacity: 3_000, pos: { x: 10, y: 10 } }],
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

function portfolioRoute(roomName = "W1N2"): RoutePlanResult {
  return {
    status: "ready",
    reason: "route-computed",
    source: "search",
    plan: {
      schemaVersion: 1,
      requestId: `route/${roomName}`,
      originRoomName: "W1N1",
      destinationRoomName: roomName,
      roomNames: [roomName],
      totalCost: 100,
      risk: 0,
      estimate: {
        outboundTicks: 50,
        returnTicks: 50,
        roundTripTicks: 100,
        throughputMilliCapacityPerTick: 500,
        roadSteps: 0,
        plainSteps: 50,
        swampSteps: 0,
        roadBodyPartSteps: 0,
      },
    },
    metrics: {
      expandedRooms: 1,
      consideredEdges: 1,
      cacheHits: 0,
      routeRooms: 1,
      totalCost: 100,
      risk: 0,
      reason: "route-computed",
    },
  };
}

function observation(
  observedAt: number,
  overrides: Partial<RemoteAccountingObservation> = {},
): RemoteAccountingObservation {
  return {
    roomName: "W1N2",
    donorColonyId: "W1N1",
    observedAt,
    quality: "complete",
    harvestedEnergy: 10,
    deliveredEnergy: 0,
    spawnEnergy: 0,
    spawnTicks: 0,
    travelTicks: 0,
    reservationEnergy: 0,
    constructionEnergy: 0,
    repairEnergy: 0,
    cpuMilli: 0,
    creepLossEnergy: 0,
    downtimeTicks: 0,
    forecastRevenueMilliPerTick: 10_000,
    forecastProfitMilliPerTick: 4_000,
    ...overrides,
  };
}
