import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  RemotePortfolio,
  type RemoteCandidateEvidence,
  type RemotePortfolioOwnerV1,
  type RemotePortfolioState,
} from "../../bot/src/remotes";
import type { RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

interface PortfolioWorld {
  readonly owner: RemotePortfolioOwnerV1 | Readonly<Record<string, never>>;
}

type PortfolioInputKind =
  "baseline" | "threat" | "safe" | "cpu-pressure" | "loss" | "stale" | "vanished" | "expired";

interface PortfolioInput {
  readonly kind: PortfolioInputKind;
  readonly reverse: boolean;
}

interface PortfolioOutcome {
  readonly states: readonly `${string}:${RemotePortfolioState}`[];
  readonly reasons: readonly string[];
  readonly objectives: readonly string[];
  readonly released: number;
  readonly reservedEnergy: number;
}

interface PortfolioHeap {
  readonly portfolio: RemotePortfolio;
}

describe("Phase 3 remote portfolio deterministic outcome", () => {
  it("keeps profitable remotes, sheds unsafe or unaffordable work, and resumes across reset/reorder", () => {
    const warm = runScenario(portfolioScenario(false, false));
    const resetReordered = runScenario(portfolioScenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes.map(({ states }) => states)).toEqual([
      ["W1N2:probing", "W1N3:candidate"],
      ["W1N2:active", "W1N3:candidate"],
      ["W1N2:threatened", "W1N3:probing"],
      ["W1N2:suspended", "W1N3:active"],
      ["W1N2:suspended", "W1N3:suspended"],
      ["W1N2:cooldown", "W1N3:suspended"],
      ["W1N2:active", "W1N3:suspended"],
      ["W1N2:suspended", "W1N3:cooldown"],
      ["W1N2:suspended", "W1N3:active"],
      ["W1N2:suspended", "W1N3:suspended"],
      ["W1N2:retired", "W1N3:suspended"],
      ["W1N2:retired", "W1N3:retired"],
    ]);
    expect(warm.outcomes[2]).toMatchObject({ released: 1, reservedEnergy: 1_000 });
    expect(warm.outcomes[4]).toMatchObject({ released: 1, reservedEnergy: 0 });
    expect(warm.outcomes[6]).toMatchObject({ objectives: ["W1N2"] });
    expect(warm.outcomes[8]).toMatchObject({ objectives: ["W1N3"] });
  });
});

function portfolioScenario(
  reset: boolean,
  reverse: boolean,
): ReplayScenario<PortfolioWorld, PortfolioInput, PortfolioOutcome, PortfolioHeap> {
  const kinds: readonly PortfolioInputKind[] = [
    "baseline",
    "baseline",
    "threat",
    "safe",
    "cpu-pressure",
    "safe",
    "safe",
    "loss",
    "safe",
    "stale",
    "vanished",
    "expired",
  ];
  const createHeap = (): PortfolioHeap => ({ portfolio: new RemotePortfolio() });
  return defineReplayScenario<PortfolioWorld, PortfolioInput, PortfolioOutcome, PortfolioHeap>({
    id: "phase3/portfolio/full-cost-lifecycle",
    seed: "phase3-portfolio-v1",
    initialWorld: { owner: {} },
    ticks: kinds.map((kind, index) => ({
      gameTime: 1_000 + index,
      cpuBudget: 0.5,
      resetHeap: reset && [2, 5, 8].includes(index),
      input: { kind, reverse },
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input, world }) {
      const candidates = candidatesFor(gameTime, input.kind);
      const result = heap.portfolio.plan({
        tick: gameTime,
        owner: world.owner,
        candidates: input.reverse ? [...candidates].reverse() : candidates,
        capacity: {
          energy: 10_000,
          spawnTicks: 1_000,
          cpuMilli: input.kind === "cpu-pressure" ? 0 : 1_000,
          memoryCodeUnits: 10_000,
          activeRemotes: 1,
        },
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      });
      if (result.status !== "ready" || result.owner === null) {
        throw new Error(`portfolio unavailable: ${result.status}`);
      }
      return {
        nextWorld: { owner: result.owner },
        outcome: {
          states: result.owner.records.map(
            ({ roomName, state }): `${string}:${RemotePortfolioState}` => `${roomName}:${state}`,
          ),
          reasons: result.dispositions.map(({ reason }) => reason),
          objectives: result.objectives.map(({ roomName }) => roomName),
          released: result.metrics.released,
          reservedEnergy: result.metrics.reservedEnergy,
        },
        cpuUsed: 0.5,
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== kinds.length) throw new Error("portfolio outcome count mismatch");
      if (finalWorld.owner.records.some(({ state }) => state !== "retired")) {
        throw new Error("portfolio did not retire terminal candidates");
      }
    },
  });
}

function candidatesFor(tick: number, kind: PortfolioInputKind): readonly RemoteCandidateEvidence[] {
  const first = candidate("W1N2", tick, {
    ...(kind === "threat" ? { threatRisk: 1 } : {}),
    ...(kind === "loss" ? { costs: costs(3_000) } : {}),
    ...(kind === "vanished" ? { intel: intel("W1N2", tick, 0) } : {}),
  });
  const second = candidate("W1N3", tick, {
    ...(kind === "stale"
      ? { intel: { ...intel("W1N3", tick, 2), freshness: "stale" as const } }
      : {}),
    ...(kind === "expired" ? { expiresAt: tick } : {}),
  });
  return [first, second];
}

function candidate(
  roomName: string,
  tick: number,
  overrides: Partial<RemoteCandidateEvidence> = {},
): RemoteCandidateEvidence {
  return {
    roomName,
    donorColonyId: "W1N1",
    evidenceRevision: `evidence/${roomName}/${String(tick)}`,
    expiresAt: 1_100,
    controller: "available",
    donor: "healthy",
    threatRisk: 0,
    intel: intel(roomName, tick, 2),
    route: route(roomName),
    costs: costs(1_000),
    commitment: { energy: 1_000, spawnTicks: 30, cpuMilli: 100, memoryCodeUnits: 256 },
    ...overrides,
  };
}

function costs(value: number): RemoteCandidateEvidence["costs"] {
  return {
    latency: value,
    spawn: value,
    body: value,
    hauling: value,
    reservation: value,
    roads: value,
    repair: value,
    expectedLoss: value,
    cpu: value,
  };
}

function intel(roomName: string, tick: number, sourceCount: number): RoomIntelQueryResult {
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
      sources: Array.from({ length: sourceCount }, (_, index) => ({
        id: `source/${roomName}/${String(index)}`,
        energyCapacity: 3_000,
        pos: { x: 10 + index, y: 10 },
      })),
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
        outboundTicks: 50,
        returnTicks: 100,
        roundTripTicks: 150,
        throughputMilliCapacityPerTick: 333,
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
