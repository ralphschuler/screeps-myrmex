import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../../bot/src/config/runtime-config";
import type { LeasedWorkExecution } from "../../bot/src/contracts";
import {
  DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  DEFAULT_REMOTE_SAFETY_POLICY_V1,
  RemotePortfolio,
  assessRemoteSafety,
  planRemoteEvacuations,
  type RemoteCandidateEvidence,
  type RemotePortfolioOwnerV1,
  type RemoteSafetyEvidence,
} from "../../bot/src/remotes";
import type { CreepSnapshot } from "../../bot/src/world/snapshot";
import type { RoomIntelHostile, RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

type Kind = "safe" | "npc" | "player" | "harmless" | "ally" | "stale" | "route";
interface World {
  readonly minerActive: boolean;
  readonly minerRetreatTicks: number;
  readonly minerRoomName: string;
  readonly owner: RemotePortfolioOwnerV1 | Readonly<Record<string, never>>;
  readonly reserverActive: boolean;
}
interface Input {
  readonly kind: Kind;
  readonly reverse: boolean;
}
interface Outcome {
  readonly activeObjective: boolean;
  readonly assessment: string;
  readonly evacuationReasons: readonly string[];
  readonly overrideCount: number;
  readonly reservedEnergy: number;
  readonly state: string;
  readonly transitionReasons: readonly string[];
}
interface Heap {
  readonly portfolio: RemotePortfolio;
}

const CONFIG = buildRuntimeConfig({ relations: { allies: ["Friendly"], self: ["Myrmex"] } });
const KINDS: readonly Kind[] = [
  "safe",
  "safe",
  "npc",
  "player",
  "harmless",
  "ally",
  "stale",
  "route",
  "safe",
  "safe",
  "safe",
];

describe("Phase 3 remote threat safety deterministic outcome", () => {
  it("evacuates credible threats and resumes only after fresh cooldown probes", () => {
    const warm = runScenario(scenario(false, false));
    const resetReordered = runScenario(scenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes.map(({ state }) => state)).toEqual([
      "probing",
      "active",
      "threatened",
      "threatened",
      "suspended",
      "cooldown",
      "suspended",
      "threatened",
      "suspended",
      "cooldown",
      "active",
    ]);
    expect(warm.outcomes.map(({ assessment }) => assessment)).toEqual([
      "safe",
      "safe",
      "credible-hostile",
      "credible-hostile",
      "harmless-presence",
      "excluded-presence",
      "intel-stale",
      "route-threat",
      "safe",
      "safe",
      "safe",
    ]);
    expect(warm.outcomes[2]).toMatchObject({
      activeObjective: false,
      overrideCount: 1,
      reservedEnergy: 0,
      transitionReasons: ["remote-safety-actor-lost"],
    });
    expect(warm.outcomes.slice(3, 8).map(({ overrideCount }) => overrideCount)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(warm.outcomes.slice(3, 8).flatMap(({ transitionReasons }) => transitionReasons)).toEqual(
      [],
    );
    expect(warm.outcomes[8]).toMatchObject({
      activeObjective: false,
      overrideCount: 1,
      transitionReasons: ["remote-safety-evacuated"],
    });
    expect(warm.outcomes[10]).toMatchObject({ activeObjective: true, overrideCount: 0 });
    expect(warm.outcomes.flatMap(({ transitionReasons }) => transitionReasons)).toEqual([
      "remote-safety-actor-lost",
      "remote-safety-evacuated",
    ]);
  });
});

function scenario(reset: boolean, reverse: boolean): ReplayScenario<World, Input, Outcome, Heap> {
  const createHeap = (): Heap => ({ portfolio: new RemotePortfolio() });
  return defineReplayScenario<World, Input, Outcome, Heap>({
    id: "phase3/safety/threat-evacuation-resumption",
    seed: "phase3-safety-v1",
    initialWorld: {
      minerActive: true,
      minerRetreatTicks: 0,
      minerRoomName: "W1N2",
      owner: {},
      reserverActive: true,
    },
    ticks: KINDS.map((kind, index) => ({
      cpuBudget: 0.75,
      gameTime: 100 + index,
      input: { kind, reverse },
      resetHeap: reset && [2, 6, 9].includes(index),
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input, world }) {
      const evidence = safetyEvidence(input.kind, gameTime, input.reverse);
      const safety = assessRemoteSafety({
        availableCpuMilli: 25,
        config: CONFIG,
        evidence: [evidence],
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: gameTime,
      });
      const portfolio = heap.portfolio.plan({
        candidates: safety.candidates,
        capacity: {
          activeRemotes: 1,
          cpuMilli: 1_000,
          energy: 10_000,
          memoryCodeUnits: 4_096,
          spawnTicks: 500,
        },
        owner: world.owner,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
        tick: gameTime,
      });
      if (portfolio.status !== "ready" || portfolio.owner === null)
        throw new Error(`portfolio unavailable: ${portfolio.status}`);
      const leases = [
        ...(world.minerActive ? [miningLease()] : []),
        ...(world.reserverActive ? [reservationLease()] : []),
      ];
      const actors = world.minerActive ? [actor(world.minerRoomName)] : [];
      const evacuation = planRemoteEvacuations({
        actors: input.reverse ? [...actors].reverse() : actors,
        assessments: safety.assessments,
        evidence: [evidence],
        execution: { leases: input.reverse ? [...leases].reverse() : leases, status: "ready" },
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        portfolioDispositions: portfolio.dispositions,
        tick: gameTime,
      });
      const record = portfolio.owner.records.find(({ roomName }) => roomName === "W1N2");
      if (record === undefined) throw new Error("remote record missing");
      const suspended = new Set(
        evacuation.transitions
          .filter(({ to }) => to === "suspended")
          .map(({ contractId }) => contractId),
      );
      const retreating = evacuation.overrides.some(({ contractId }) => contractId === "mining-a");
      const minerRetreatTicks = world.minerRetreatTicks + (retreating ? 1 : 0);
      return {
        cpuUsed: 0.75,
        nextWorld: {
          minerActive: world.minerActive && !suspended.has("mining-a"),
          minerRetreatTicks,
          minerRoomName: retreating && minerRetreatTicks >= 6 ? "W1N1" : world.minerRoomName,
          owner: portfolio.owner,
          reserverActive: world.reserverActive && !suspended.has("reservation-a"),
        },
        outcome: {
          activeObjective: portfolio.objectives.some(({ state }) => state === "active"),
          assessment: safety.assessments[0]?.reason ?? "unavailable",
          evacuationReasons: evacuation.dispositions.map(({ reason }) => reason),
          overrideCount: evacuation.overrides.length,
          reservedEnergy: portfolio.metrics.reservedEnergy,
          state: record.state,
          transitionReasons: evacuation.transitions.map(({ reason }) => reason),
        },
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== KINDS.length) throw new Error("safety outcome count mismatch");
      const record = finalWorld.owner.records.find(({ roomName }) => roomName === "W1N2");
      if (record?.state !== "active") throw new Error("remote did not cautiously resume");
      if (outcomes.some(({ overrideCount }) => overrideCount > 1))
        throw new Error("evacuation override bound exceeded");
    },
  });
}

function safetyEvidence(kind: Kind, tick: number, reverse: boolean): RemoteSafetyEvidence {
  const hostiles = hostilesFor(kind);
  const candidate = baseCandidate(
    tick,
    reverse ? [...hostiles].reverse() : hostiles,
    kind === "stale",
    kind === "route",
  );
  return {
    candidate,
    confidenceBasisPoints: 10_000,
    evacuationRoute: route("W1N2", "W1N1", "evacuation", 0),
    recentLossBasisPoints: 0,
  };
}

function hostilesFor(kind: Kind): readonly RoomIntelHostile[] {
  if (kind === "npc") return [hostile("Invader", 1), hostile("Scout", 0)];
  if (kind === "player") return [hostile("Enemy", 1), hostile("Friendly", 0)];
  if (kind === "harmless") return [hostile("Scout", 0)];
  if (kind === "ally") return [hostile("Friendly", 10)];
  return [];
}

function baseCandidate(
  tick: number,
  hostiles: readonly RoomIntelHostile[],
  stale: boolean,
  routeThreat: boolean,
): RemoteCandidateEvidence {
  const commitment = { cpuMilli: 1_000, energy: 5_000, memoryCodeUnits: 2_048, spawnTicks: 100 };
  return {
    commitment,
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
    evidenceRevision: `safety/${String(tick)}`,
    expiresAt: 1_000,
    intel: intel(tick, hostiles, stale),
    roomName: "W1N2",
    route: route("W1N1", "W1N2", `acquire/${String(tick)}`, routeThreat ? 1 : 0),
    threatRisk: 0,
  };
}

function intel(
  tick: number,
  hostiles: readonly RoomIntelHostile[],
  stale: boolean,
): RoomIntelQueryResult {
  return {
    freshness: stale ? "stale" : "current",
    generation: null,
    quality: "complete",
    reason: stale ? "age-limit" : "current-observation",
    record: {
      complete: true,
      controller: {
        id: "controller/W1N2",
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
      eventsObservedAt: tick - 1,
      hostileStatus: "complete",
      hostiles,
      mineral: null,
      mineralStatus: "complete",
      observedAt: stale ? tick - 10 : tick,
      roomName: "W1N2",
      schemaVersion: 1,
      shard: "shard0",
      sourceStatus: "complete",
      sources: [{ energyCapacity: 3_000, id: "source-a", pos: { x: 10, y: 10 } }],
      structureStatus: "complete",
      structures: [],
      terrain: { cells: "0".repeat(2_500), revision: "terrain/W1N2" },
    },
    roomName: "W1N2",
  };
}

function hostile(ownerUsername: string, attack: number): RoomIntelHostile {
  const part = (active: number) => ({ active, boosted: 0, total: active });
  return {
    body: {
      activeParts: attack + 1,
      attack: part(attack),
      carry: part(0),
      claim: part(0),
      heal: part(0),
      move: part(1),
      rangedAttack: part(0),
      size: attack + 1,
      tough: part(0),
      work: part(0),
    },
    hits: (attack + 1) * 100,
    hitsMax: (attack + 1) * 100,
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
  risk: number,
): RoutePlanResult {
  return {
    metrics: {
      cacheHits: 0,
      consideredEdges: 1,
      expandedRooms: 1,
      reason: "route-computed",
      risk,
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
      risk,
      roomNames: [destinationRoomName],
      schemaVersion: 1,
      totalCost: 100,
    },
    reason: "route-computed",
    source: "search",
    status: "ready",
  };
}

function miningLease(): LeasedWorkExecution {
  return {
    actorId: "miner-a",
    actorName: "miner-a",
    contractId: "mining-a",
    deadline: 1_000,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      offload: "container-or-drop",
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W1N2"],
      routeTravelTicks: 40,
      version: 5,
      workPosition: { roomName: "W1N2", x: 9, y: 9 },
    },
    expiresAt: 1_001,
    leaseExpiresAt: 1_001,
    priority: { class: "speculation", value: 700 },
    quantity: 300,
    range: 1,
    revision: 1,
    state: "active",
    target: { roomName: "W1N2", x: 10, y: 10 },
    targetId: "source-a",
  };
}

function reservationLease(): LeasedWorkExecution {
  return {
    ...miningLease(),
    actorId: "reserver-a",
    actorName: "reserver-a",
    contractId: "reservation-a",
    execution: {
      action: "reserve-controller",
      completion: "work-complete",
      counterpartId: null,
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W1N2"],
      routeTravelTicks: 40,
      signText: null,
      targetReservationTicks: 450,
      version: 4,
    },
    target: { roomName: "W1N2", x: 25, y: 25 },
    targetId: "controller/W1N2",
  };
}

function actor(roomName: string): CreepSnapshot {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 2,
      attack: zero,
      carry: zero,
      claim: zero,
      heal: zero,
      move: { active: 1, boosted: 0, total: 1 },
      rangedAttack: zero,
      size: 2,
      tough: zero,
      work: { active: 1, boosted: 0, total: 1 },
    },
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id: "miner-a",
    name: "miner-a",
    ownerUsername: "Myrmex",
    pos: { roomName, x: 20, y: 20 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}
