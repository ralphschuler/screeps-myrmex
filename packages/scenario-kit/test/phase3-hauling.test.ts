import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_HAULING_POLICY_V1,
  planLogistics,
  projectLogisticsContracts,
  projectRemoteHauling,
  type RemoteHaulingBudgetEntry,
  type RemoteHaulingObjectiveEvidence,
} from "../../bot/src/logistics";
import { planLogisticsRuntime } from "../../bot/src/logistics/runtime";
import type {
  ContractExecutionView,
  ContractPlanningView,
  WorkContractRequest,
} from "../../bot/src/contracts";
import type { RemoteMiningDisposition } from "../../bot/src/remotes";
import type { RoomIntelQueryResult } from "../../bot/src/world/intel";
import type { OwnedRoomSnapshot, RoomSnapshot, WorldSnapshot } from "../../bot/src/world/snapshot";
import type { RoutePlanResult } from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

type Kind =
  | "budget"
  | "exact"
  | "under"
  | "over"
  | "drop-decay"
  | "full-sink"
  | "death"
  | "route-change"
  | "hostile"
  | "blocked-route"
  | "deliver";
interface World {
  readonly budgets: readonly RemoteHaulingBudgetEntry[];
  readonly donorEnergy: number;
  readonly flowId: string | null;
}
interface Input {
  readonly kind: Kind;
  readonly reverse: boolean;
}
interface Outcome {
  readonly kind: Kind;
  readonly reason: string;
  readonly carry: number;
  readonly actorCapable: boolean;
  readonly pickup: number;
  readonly projected: number;
  readonly routedContract: boolean;
  readonly replaced: boolean;
  readonly delivered: number;
  readonly lost: number;
}
interface Heap {
  readonly revision: number;
}

const KINDS: readonly Kind[] = [
  "budget",
  "exact",
  "under",
  "over",
  "drop-decay",
  "full-sink",
  "death",
  "route-change",
  "hostile",
  "blocked-route",
  "deliver",
];

describe("Phase 3 remote hauling deterministic outcome", () => {
  it("sizes, routes, replaces, loses, suspends, and delivers without reset/reorder drift", () => {
    const warm = runScenario(scenario(false, false));
    const resetReordered = runScenario(scenario(true, true));
    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes[0]).toMatchObject({ kind: "budget", carry: 16, projected: 0 });
    expect(warm.outcomes[1]).toMatchObject({
      kind: "exact",
      actorCapable: true,
      routedContract: true,
    });
    expect(warm.outcomes[2]).toMatchObject({ kind: "under", actorCapable: false });
    expect(warm.outcomes[3]).toMatchObject({ kind: "over", actorCapable: true });
    expect(warm.outcomes[4]).toMatchObject({ kind: "drop-decay", pickup: 760 });
    expect(warm.outcomes[5]?.reason).toBe("sink-full");
    expect(warm.outcomes[6]).toMatchObject({ delivered: 0, lost: 800 });
    expect(warm.outcomes[7]?.replaced).toBe(true);
    expect(warm.outcomes[8]?.reason).toBe("threat-risk");
    expect(warm.outcomes[9]?.reason).toBe("route-unavailable");
    expect(warm.outcomes[10]).toMatchObject({ delivered: 800, routedContract: true });
    expect(warm.finalWorld.donorEnergy).toBe(995_800);
  });
});

function scenario(reset: boolean, reverse: boolean): ReplayScenario<World, Input, Outcome, Heap> {
  const createHeap = (): Heap => ({ revision: 1 });
  return defineReplayScenario<World, Input, Outcome, Heap>({
    id: "phase3/hauling/loss-aware-routed-delivery",
    seed: "phase3-hauling-v1",
    initialWorld: { budgets: [], donorEnergy: 995_000, flowId: null },
    ticks: KINDS.map((kind, index) => ({
      gameTime: 4_000 + index,
      cpuBudget: 0.75,
      resetHeap: reset && [3, 7].includes(index),
      input: { kind, reverse },
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, input, world }) {
      const primary = evidence(input.kind, gameTime, world.donorEnergy);
      const secondary = evidence("exact", gameTime, world.donorEnergy, "W1N3");
      const objectives = input.reverse ? [secondary, primary] : [primary, secondary];
      const budgets = input.reverse ? [...world.budgets].reverse() : world.budgets;
      const result = projectRemoteHauling({
        budgets,
        objectives,
        policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
        tick: gameTime,
      });
      const primaryDisposition = result.dispositions.find(({ roomName }) => roomName === "W1N2");
      const nodes = result.projection.nodes;
      const primaryEdges = result.projection.edges.filter(
        (edge) => nodes.find(({ id }) => id === edge.sourceNodeId)?.position.roomName === "W1N2",
      );
      const plan = planLogistics({
        edges: result.projection.edges,
        maximumNodeAge: 0,
        nodes,
        planningHorizon: 50,
        tick: gameTime,
      });
      const contracts = projectLogisticsContracts({
        endpoints: result.projection.endpoints,
        nodes,
        plan,
        previous: [],
        progress: [],
        tick: gameTime,
      });
      const flowId = primaryEdges[0]?.id ?? null;
      const acquire = contracts.commitments.find((commitment) => commitment.flowId === flowId);
      const deliver =
        acquire === undefined
          ? null
          : (projectLogisticsContracts({
              endpoints: result.projection.endpoints.map((endpoint) => ({
                ...endpoint,
                observedAt: gameTime + 1,
              })),
              nodes: nodes.map((node) => ({ ...node, observedAt: gameTime + 1 })),
              plan,
              previous: [acquire],
              progress: [
                {
                  actorState: "alive",
                  cargoAmount: acquire.reservedAmount,
                  deliveredAmount: 0,
                  flowId: acquire.flowId,
                },
              ],
              tick: gameTime + 1,
            }).commitments.find((commitment) => commitment.flowId === acquire.flowId)?.request ??
            null);
      const settlement =
        (input.kind === "death" || input.kind === "deliver") && deliver?.execution?.version === 6
          ? planLogisticsRuntime({
              execution: scenarioExecutionView(deliver),
              includeOptional: false,
              planning: scenarioPlanningView(deliver),
              snapshot: settlementSnapshot(
                gameTime + 2,
                world.donorEnergy +
                  (input.kind === "deliver" ? deliver.execution.reservedAmount : 0),
                input.kind === "deliver" ? 0 : null,
              ),
              tick: gameTime + 2,
            })
          : null;
      const carry = primaryDisposition?.carry ?? 0;
      const actorCarry = input.kind === "under" ? 15 : input.kind === "over" ? 17 : carry;
      const routedContract = deliver?.execution?.version === 6;
      const delivered =
        input.kind === "deliver" &&
        routedContract &&
        settlement?.contracts.retirements.some(
          ({ reason, to }) => reason === "logistics-flow-complete" && to === "completed",
        )
          ? deliver.execution.reservedAmount
          : 0;
      const lossCommitment = settlement?.contracts.commitments.find(
        (commitment) =>
          deliver?.execution?.version === 6 && commitment.flowId === deliver.execution.flowId,
      );
      const lost =
        input.kind === "death" &&
        settlement !== null &&
        lossCommitment !== undefined &&
        lossCommitment.cycle > 0 &&
        settlement.contracts.retirements.some(
          ({ reason, to }) => reason === "logistics-actor-died" && to === "failed",
        )
          ? lossCommitment.cycleAmount
          : 0;
      const nextBudgets =
        input.kind === "budget" ? result.budgetRequests.map(activeBudget) : world.budgets;
      return {
        nextWorld: {
          budgets: nextBudgets,
          donorEnergy: world.donorEnergy + delivered,
          flowId: flowId ?? world.flowId,
        },
        outcome: {
          actorCapable: carry > 0 && actorCarry >= carry,
          carry,
          delivered,
          kind: input.kind,
          lost,
          pickup: primaryDisposition?.predictedPickupAmount ?? 0,
          projected: primaryEdges.length,
          reason: primaryDisposition?.reason ?? "unavailable",
          replaced: input.kind === "route-change" && flowId !== null && flowId !== world.flowId,
          routedContract,
        },
        cpuUsed: 0.75,
      };
    },
    verify({ outcomes }) {
      if (outcomes.length !== KINDS.length)
        throw new Error("remote hauling outcome count mismatch");
      if (outcomes.some(({ projected }) => projected > 2))
        throw new Error("remote hauling projection exceeded objective bound");
    },
  });
}

function scenarioPlanningView(request: WorkContractRequest): ContractPlanningView {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("expected executable routed request");
  return {
    contracts: [
      {
        budgetBinding: request.budgetBinding,
        contractId: "scenario-remote-haul",
        earliestStart: request.earliestStart,
        execution: request.execution,
        issuer: request.issuer,
        issuerSequence: request.issuerSequence,
        owner: request.owner,
        state: "active",
        targetId: request.targetId,
      },
    ],
    status: "ready",
  };
}

function scenarioExecutionView(request: WorkContractRequest): ContractExecutionView {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("expected executable routed request");
  return {
    leases: [
      {
        actorId: "hauler-a",
        actorName: "hauler-a",
        contractId: "scenario-remote-haul",
        deadline: request.deadline,
        execution: request.execution,
        expiresAt: request.expiresAt,
        leaseExpiresAt: request.expiresAt,
        priority: request.priority,
        quantity: request.quantity,
        range: request.range,
        revision: 1,
        state: "active",
        target: request.target,
        targetId: request.targetId,
      },
    ],
    status: "ready",
  };
}

function settlementSnapshot(
  tick: number,
  donorEnergy: number,
  cargo: number | null,
): WorldSnapshot {
  const donorRoom = donor(tick, donorEnergy, false);
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [donorRoom as OwnedRoomSnapshot],
    rooms: [
      {
        ...donorRoom,
        ownedCreeps: cargo === null ? [] : [scenarioHauler(cargo)],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: cargo === null ? 0 : 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 2,
        tombstones: 0,
        total: cargo === null ? 3 : 4,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: [{ age: 0, observedAt: tick, roomName: "W1N1", status: "visible" }],
      scope: "current-tick",
    },
  };
}

function scenarioHauler(cargo: number) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 32,
      attack: zero,
      carry: { active: 16, boosted: 0, total: 16 },
      claim: zero,
      heal: zero,
      move: { active: 16, boosted: 0, total: 16 },
      rangedAttack: zero,
      size: 32,
      tough: zero,
      work: zero,
    },
    fatigue: 0,
    hits: 3_200,
    hitsMax: 3_200,
    id: "hauler-a",
    name: "hauler-a",
    ownerUsername: "self",
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning: false,
    store: {
      capacity: 800,
      freeCapacity: 800 - cargo,
      resources: cargo === 0 ? [] : [{ amount: cargo, resourceType: "energy" as ResourceConstant }],
      usedCapacity: cargo,
    },
    ticksToLive: 1_000,
  };
}

function evidence(
  kind: Kind,
  tick: number,
  donorEnergy: number,
  roomName = "W1N2",
): RemoteHaulingObjectiveEvidence {
  const commitment = { cpuMilli: 2_000, energy: 20_000, memoryCodeUnits: 8_192, spawnTicks: 500 };
  const revision = kind === "route-change" && roomName === "W1N2" ? "v2" : "v1";
  const acquireRoute = route("W1N1", roomName, `acquire/${roomName}/${revision}`);
  return {
    acquireRoute,
    candidate: {
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
      evidenceRevision: `${kind}/${roomName}/${String(tick)}`,
      expiresAt: 6_000,
      intel: intel(roomName, tick),
      roomName,
      route: acquireRoute,
      threatRisk: kind === "hostile" && roomName === "W1N2" ? 1 : 0,
    },
    deliverRoute: route(
      kind === "blocked-route" && roomName === "W1N2" ? "W9N9" : roomName,
      "W1N1",
      `deliver/${roomName}/${revision}`,
    ),
    donorRoom: donor(tick, donorEnergy, kind === "full-sink" && roomName === "W1N2"),
    mining: [mining(roomName)],
    objective: {
      commitment,
      donorColonyId: "W1N1",
      profit: 10_000,
      revision: 2,
      roomName,
      state: "active",
    },
    predictedLossBasisPoints: 0,
    remoteRoom: remote(
      roomName,
      tick,
      kind === "drop-decay" && roomName === "W1N2" ? 0 : 800,
      kind === "drop-decay" && roomName === "W1N2" ? 800 : 0,
    ),
  };
}
function mining(roomName: string): RemoteMiningDisposition {
  return {
    infrastructureReason: "container-active",
    miningReason: "contract-active",
    offload: "container",
    replacementLeadTicks: 95,
    roomName,
    sourceId: `source/${roomName}`,
    workPosition: { roomName, x: 9, y: 9 },
  };
}
function intel(roomName: string, tick: number): RoomIntelQueryResult {
  return {
    freshness: "current",
    generation: null,
    quality: "complete",
    reason: "current-observation",
    record: {
      complete: true,
      controller: null,
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
      sources: [{ energyCapacity: 3_000, id: `source/${roomName}`, pos: { x: 10, y: 10 } }],
      structureStatus: "complete",
      structures: [],
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
    },
    roomName,
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
function remote(
  roomName: string,
  tick: number,
  containerEnergy: number,
  dropEnergy: number,
): RoomSnapshot {
  const container = structure(
    `container/${roomName}`,
    "container",
    roomName,
    2_000,
    containerEnergy,
    "unowned",
  );
  return room(roomName, tick, {
    droppedResources:
      dropEnergy === 0
        ? []
        : [
            {
              amount: dropEnergy,
              id: `drop/${roomName}`,
              pos: { roomName, x: 9, y: 9 },
              resourceType: "energy",
            },
          ],
    sources: [
      {
        energy: 3_000,
        energyCapacity: 3_000,
        id: `source/${roomName}`,
        pos: { roomName, x: 10, y: 10 },
        ticksToRegeneration: null,
      },
    ],
    storedStructures: [container],
  });
}
function donor(tick: number, energy: number, full: boolean): RoomSnapshot {
  const used = full ? 1_000_000 : energy;
  return room("W1N1", tick, {
    controller: {
      id: "controller/W1N1",
      level: 8,
      ownerUsername: "self",
      ownership: "owned",
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: null,
      progressTotal: null,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 100_000,
      upgradeBlocked: null,
    },
    storedStructures: [
      structure("storage-a", "storage", "W1N1", 1_000_000, used, "owned"),
      structure("terminal-a", "terminal", "W1N1", 300_000, full ? 300_000 : 0, "owned"),
    ],
  });
}
function structure(
  id: string,
  type: string,
  roomName: string,
  capacity: number,
  energy: number,
  ownership: "owned" | "unowned",
) {
  return {
    hits: 250_000,
    hitsMax: 250_000,
    id,
    ownerUsername: ownership === "owned" ? "self" : null,
    ownership,
    pos: {
      roomName,
      x: type === "container" ? 9 : type === "storage" ? 20 : 21,
      y: type === "container" ? 9 : 20,
    },
    store: {
      capacity,
      freeCapacity: capacity - energy,
      resources:
        energy === 0 ? [] : [{ amount: energy, resourceType: "energy" as ResourceConstant }],
      usedCapacity: energy,
    },
    structureType: type,
    ticksToDecay: type === "container" ? 100 : null,
  };
}
function room(name: string, observedAt: number, overrides: Partial<RoomSnapshot>): RoomSnapshot {
  return {
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name,
    observedAt,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    traversal: {
      revision: `traversal/${name}/${String(observedAt)}`,
      walkability: ".".repeat(2_500),
    },
    ...overrides,
  };
}
function activeBudget(request: {
  category: string;
  colonyId: string;
  cpu: { desired: number } | null;
  energy: { desired: number } | null;
  expiresAt: number;
  issuer: string;
  revision: number;
}): RemoteHaulingBudgetEntry {
  return {
    category: request.category,
    colonyId: request.colonyId,
    expiresAt: request.expiresAt,
    grant: { cpu: request.cpu?.desired ?? 0, energy: request.energy?.desired ?? 0, spawn: null },
    issuer: request.issuer,
    revision: request.revision,
    status: "active",
  };
}
