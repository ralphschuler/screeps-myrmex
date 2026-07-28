import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_ACCOUNTING_POLICY_V1,
  DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  REMOTE_ACCOUNTING_LIMITS,
  RemotePortfolio,
  type RemoteAccountingObservation,
  type RemoteCandidateEvidence,
  type RemotePortfolioOwnerV2,
} from "../../bot/src/remotes";
import type { RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

interface World {
  readonly owner: RemotePortfolioOwnerV2 | Readonly<Record<string, never>>;
}
interface Input {
  readonly kind: "baseline" | "threat" | "safe" | "stale" | "partial" | "cap";
  readonly reverse: boolean;
}
interface Outcome {
  readonly accounting: readonly `${string}:${string}`[];
  readonly accountingStatus: string;
  readonly active: readonly string[];
  readonly costMilli: number;
  readonly deliveredEnergy: number;
  readonly ownerBytes: number;
  readonly portfolio: readonly `${string}:${string}:${string}`[];
  readonly released: number;
}
interface Heap {
  readonly portfolio: RemotePortfolio;
}

const ACCOUNTING_POLICY = Object.freeze({
  ...DEFAULT_REMOTE_ACCOUNTING_POLICY_V1,
  revision: "phase3-profitability-accounting-v1",
  windowTicks: 3,
  maximumSamplesPerRemote: 3,
  minimumCompleteTicks: 3,
  minimumConfidenceBasisPoints: 7_500,
  staleAfterTicks: 2,
});
const KINDS: readonly Input["kind"][] = [
  "baseline",
  "baseline",
  "baseline",
  "threat",
  "safe",
  "safe",
  "stale",
  "partial",
  "cap",
];

describe("Phase 3 realized remote profitability deterministic outcome", () => {
  it("keeps profitable and marginal remotes, suspends loss/stale work, and survives reset/reorder", () => {
    const warm = runScenario(scenario(false, false));
    const resetReordered = runScenario(scenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes[2]).toMatchObject({
      accounting: ["W1N2:profitable", "W1N3:marginal", "W1N4:loss-making"],
      active: ["W1N2", "W1N3"],
      deliveredEnergy: 73,
      portfolio: [
        "W1N2:active:retained-active",
        "W1N3:active:retained-active",
        "W1N4:suspended:realized-negative",
      ],
      released: 1,
    });
    expect(warm.outcomes[3]?.portfolio[0]).toBe("W1N2:threatened:threat-risk");
    expect(warm.outcomes[6]).toMatchObject({
      accounting: ["W1N2:profitable", "W1N3:stale", "W1N4:loss-making"],
      active: [],
      portfolio: [
        "W1N2:cooldown:cooldown-probe",
        "W1N3:suspended:accounting-stale",
        "W1N4:suspended:realized-negative",
      ],
    });
    expect(warm.outcomes[7]).toMatchObject({
      active: ["W1N2"],
      accounting: ["W1N2:profitable", "W1N3:warming-up", "W1N4:incomplete"],
    });
    expect(warm.outcomes[8]).toMatchObject({ accountingStatus: "limit-exceeded" });
    expect(warm.outcomes[8]?.portfolio).toEqual(warm.outcomes[7]?.portfolio);
    expect(warm.outcomes.every(({ ownerBytes }) => ownerBytes <= 32_768)).toBe(true);
  });
});

function scenario(reset: boolean, reverse: boolean): ReplayScenario<World, Input, Outcome, Heap> {
  const createHeap = (): Heap => ({ portfolio: new RemotePortfolio() });
  return defineReplayScenario<World, Input, Outcome, Heap>({
    id: "phase3/profitability/realized-full-cost-window",
    seed: "phase3-profitability-v1",
    initialWorld: { owner: {} },
    ticks: KINDS.map((kind, index) => ({
      cpuBudget: 0.75,
      gameTime: 100 + index,
      input: { kind, reverse },
      resetHeap: reset && [3, 6].includes(index),
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input, world }) {
      const candidates = candidateRows(gameTime, input.kind);
      const accounting = accountingRows(gameTime, input.kind);
      const result = heap.portfolio.plan({
        accounting: input.reverse ? [...accounting].reverse() : accounting,
        accountingPolicy: ACCOUNTING_POLICY,
        candidates: input.reverse ? [...candidates].reverse() : candidates,
        capacity: {
          activeRemotes: 3,
          cpuMilli: 3_000,
          energy: 30_000,
          memoryCodeUnits: 20_000,
          spawnTicks: 3_000,
        },
        owner: world.owner,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
        tick: gameTime,
      });
      const owner = result.owner ?? world.owner;
      const records = "records" in owner ? owner.records : [];
      return {
        cpuUsed: 0.75,
        nextWorld: { owner },
        outcome: {
          accounting: result.accounting.summaries.map(
            ({ reason, roomName }): `${string}:${string}` => `${roomName}:${reason}`,
          ),
          accountingStatus: result.accounting.status,
          active: result.objectives
            .filter(({ state }) => state === "active")
            .map(({ roomName }) => roomName),
          costMilli: result.accounting.metrics.costMilli,
          deliveredEnergy: result.accounting.metrics.deliveredEnergy,
          ownerBytes: JSON.stringify(owner).length,
          portfolio: records.map(
            ({ reasonCode, roomName, state }): `${string}:${string}:${string}` =>
              `${roomName}:${state}:${reasonCode}`,
          ),
          released: result.metrics.released,
        },
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== KINDS.length) throw new Error("profitability outcome count mismatch");
      if (!("records" in finalWorld.owner)) throw new Error("profitability owner unavailable");
      if (finalWorld.owner.accounting.length > REMOTE_ACCOUNTING_LIMITS.maximumRecords)
        throw new Error("accounting record bound exceeded");
    },
  });
}

function candidateRows(tick: number, kind: Input["kind"]): readonly RemoteCandidateEvidence[] {
  return ["W1N2", "W1N3", "W1N4"].map((roomName) =>
    candidate(roomName, tick, kind === "threat" && roomName === "W1N2"),
  );
}

function accountingRows(tick: number, kind: Input["kind"]): readonly RemoteAccountingObservation[] {
  if (kind === "cap") {
    return Array.from(
      { length: REMOTE_ACCOUNTING_LIMITS.maximumObservationsPerTick + 1 },
      (_, index) => observation(`W${String(index + 2)}N2`, tick, 10),
    );
  }
  const common = [
    observation("W1N2", tick, kind === "threat" || (kind === "safe" && tick === 104) ? 0 : 10, {
      ...(tick === 100
        ? {
            constructionEnergy: 1,
            cpuMilli: 1,
            creepLossEnergy: 1,
            deliveredEnergy: 50,
            repairEnergy: 1,
            reservationEnergy: 1,
            spawnEnergy: 1,
            spawnTicks: 1,
            travelTicks: 1,
          }
        : {}),
      ...(kind === "threat" || (kind === "safe" && tick <= 104) ? { downtimeTicks: 1 } : {}),
    }),
    observation("W1N4", tick, 0, {
      quality: kind === "partial" ? "partial" : "complete",
      repairEnergy: 1,
    }),
  ];
  return kind === "stale" || kind === "safe" ? common : [...common, observation("W1N3", tick, 1)];
}

function observation(
  roomName: string,
  observedAt: number,
  deliveredEnergy: number,
  overrides: Partial<RemoteAccountingObservation> = {},
): RemoteAccountingObservation {
  return {
    roomName,
    donorColonyId: "W1N1",
    observedAt,
    quality: "complete",
    harvestedEnergy: 10,
    deliveredEnergy,
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
    forecastProfitMilliPerTick: 9_000,
    ...overrides,
  };
}

function candidate(roomName: string, tick: number, threatened: boolean): RemoteCandidateEvidence {
  return {
    roomName,
    donorColonyId: "W1N1",
    evidenceRevision: `profitability/${roomName}/${String(tick)}`,
    expiresAt: 1_000,
    controller: "available",
    donor: "healthy",
    threatRisk: threatened ? 1 : 0,
    intel: intel(roomName, tick),
    route: route(roomName),
    costs: {
      latency: 100,
      spawn: 100,
      body: 100,
      hauling: 100,
      reservation: 100,
      roads: 100,
      repair: 100,
      expectedLoss: 100,
      cpu: 100,
    },
    commitment: { energy: 1_000, spawnTicks: 30, cpuMilli: 100, memoryCodeUnits: 512 },
  };
}

function intel(roomName: string, tick: number): RoomIntelQueryResult {
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

function route(roomName: string): RoutePlanResult {
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
        outboundTicks: 40,
        returnTicks: 40,
        roundTripTicks: 80,
        throughputMilliCapacityPerTick: 625,
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
