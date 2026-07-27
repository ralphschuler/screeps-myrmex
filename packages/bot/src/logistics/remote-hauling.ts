import type { BudgetGrant, BudgetRequest } from "../colony";
import type {
  RemoteCandidateEvidence,
  RemoteMiningDisposition,
  RemotePortfolioObjective,
} from "../remotes";
import type { RoomSnapshot, StoredStructureSnapshot } from "../world/snapshot";
import type { RoutePlanResult, RoutePlanV1 } from "../world/routes";
import type { LogisticsContractEndpoint } from "./contracts";
import {
  aggregateStoreCapacityReservationKey,
  sizeRoutedLogisticsEdge,
  type LogisticsEdge,
  type LogisticsNode,
  type RoutedLogisticsBodySize,
  type RoutedLogisticsEdge,
} from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export const REMOTE_HAULING_LIMITS = Object.freeze({
  maximumBudgetEntries: 512,
  maximumObjectivesPerTick: 8,
  maximumRouteRooms: 16,
  maximumSourcesPerObjective: 8,
} as const);

export interface RemoteHaulingPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly sourceRegenerationTicks: number;
  readonly carryCapacity: number;
  readonly carryPartEnergy: number;
  readonly movePartEnergy: number;
  readonly spawnTicksPerPart: number;
  readonly creepLifetime: number;
  readonly replacementSafetyTicks: number;
  readonly cpuMilliPerSource: number;
  readonly memoryCodeUnitsPerSource: number;
  readonly maximumSourceEnergyCapacity: number;
  readonly maximumIntelAgeTicks: number;
  readonly maximumThreatRisk: number;
  readonly maximumPredictedLossBasisPoints: number;
  readonly droppedResourceDecayDivisor: number;
}

export const DEFAULT_REMOTE_HAULING_POLICY_V1: RemoteHaulingPolicyV1 = freeze({
  schemaVersion: 1,
  revision: "remote-hauling-policy-v1",
  sourceRegenerationTicks: 300,
  carryCapacity: 50,
  carryPartEnergy: 50,
  movePartEnergy: 50,
  spawnTicksPerPart: 3,
  creepLifetime: 1_500,
  replacementSafetyTicks: 25,
  cpuMilliPerSource: 50,
  memoryCodeUnitsPerSource: 1_024,
  maximumSourceEnergyCapacity: 3_000,
  maximumIntelAgeTicks: 25,
  maximumThreatRisk: 0,
  maximumPredictedLossBasisPoints: 2_500,
  droppedResourceDecayDivisor: 1_000,
});

export interface RemoteHaulingBudgetEntry {
  readonly category: string;
  readonly colonyId: string;
  readonly issuer: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly status: "active" | "pending" | "consumed" | "released" | "expired";
  readonly grant: BudgetGrant | null;
}

export interface RemoteHaulingObjectiveEvidence {
  readonly objective: RemotePortfolioObjective;
  readonly candidate: RemoteCandidateEvidence;
  readonly mining: readonly RemoteMiningDisposition[];
  readonly acquireRoute: RoutePlanResult;
  readonly deliverRoute: RoutePlanResult;
  readonly remoteRoom: RoomSnapshot | null;
  readonly donorRoom: RoomSnapshot | null;
  readonly predictedLossBasisPoints: number;
}

export type RemoteHaulingReason =
  | "budget-insufficient"
  | "budget-unavailable"
  | "capacity-limit"
  | "contract-ready"
  | "donor-unavailable"
  | "intel-partial"
  | "intel-stale"
  | "intel-unavailable"
  | "invalid-input"
  | "memory-budget"
  | "mining-unavailable"
  | "objective-not-active"
  | "portfolio-budget"
  | "route-unavailable"
  | "sink-full"
  | "source-empty"
  | "source-missing"
  | "threat-risk"
  | "timeout"
  | "vision-unavailable";

export interface RemoteHaulingDisposition {
  readonly acquireAction: "pickup" | "withdraw" | null;
  readonly carry: number;
  readonly move: number;
  readonly predictedPickupAmount: number;
  readonly predictedTransitLoss: number;
  readonly reason: RemoteHaulingReason;
  readonly replacementLeadTicks: number;
  readonly roomName: string;
  readonly sinkTargetId: string | null;
  readonly sourceId: string;
  readonly sourceTargetId: string | null;
}

export interface RemoteHaulingMetrics {
  readonly objectives: number;
  readonly sources: number;
  readonly budgeted: number;
  readonly projected: number;
  readonly blocked: number;
  readonly carryParts: number;
  readonly idleSources: number;
  readonly plannedEmptyTravelTicks: number;
  readonly plannedLoadedTravelTicks: number;
  readonly predictedDecay: number;
  readonly predictedTransitLoss: number;
}

export interface RemoteHaulingPlan {
  readonly status: "ready" | "invalid-input" | "limit-exceeded";
  readonly budgetRequests: readonly BudgetRequest[];
  readonly dispositions: readonly RemoteHaulingDisposition[];
  readonly metrics: RemoteHaulingMetrics;
  readonly projection: LogisticsResourceDemandProjection;
}

interface Pickup {
  readonly action: "pickup" | "withdraw";
  readonly amount: number;
  readonly id: string;
  readonly position: LogisticsNode["position"];
  readonly decay: number;
}
interface Sink {
  readonly amount: number;
  readonly free: number;
  readonly id: string;
  readonly position: LogisticsNode["position"];
}

export function projectRemoteHauling(input: {
  readonly budgets: readonly RemoteHaulingBudgetEntry[];
  readonly objectives: readonly RemoteHaulingObjectiveEvidence[];
  readonly policy: RemoteHaulingPolicyV1;
  readonly tick: number;
}): RemoteHaulingPlan {
  if (!validInput(input)) return empty("invalid-input");
  if (
    input.objectives.length > REMOTE_HAULING_LIMITS.maximumObjectivesPerTick ||
    input.budgets.length > REMOTE_HAULING_LIMITS.maximumBudgetEntries
  )
    return empty("limit-exceeded");
  const ordered = [...input.objectives].sort(compareObjective);
  if (
    new Set(ordered.map(({ objective }) => `${objective.donorColonyId}\0${objective.roomName}`))
      .size !== ordered.length
  )
    return empty("invalid-input");

  const requests: BudgetRequest[] = [];
  const dispositions: RemoteHaulingDisposition[] = [];
  const edges: LogisticsEdge[] = [];
  const endpoints: LogisticsContractEndpoint[] = [];
  const nodes: LogisticsNode[] = [];
  let sources = 0;
  let budgeted = 0;
  let carryParts = 0;
  let plannedEmptyTravelTicks = 0;
  let plannedLoadedTravelTicks = 0;
  let predictedDecay = 0;
  let predictedTransitLoss = 0;

  for (const evidence of ordered) {
    const objectiveReason = objectiveBlocker(evidence, input.tick, input.policy);
    const mining = [...evidence.mining]
      .filter(({ roomName }) => roomName === evidence.objective.roomName)
      .sort((a, b) => compare(a.sourceId, b.sourceId));
    if (mining.length > REMOTE_HAULING_LIMITS.maximumSourcesPerObjective)
      return empty("limit-exceeded");
    sources += mining.length;
    let remainingEnergy = evidence.objective.commitment.energy;
    let remainingSpawnTicks = evidence.objective.commitment.spawnTicks;
    let remainingCpuMilli = evidence.objective.commitment.cpuMilli;
    let remainingMemoryCodeUnits = evidence.objective.commitment.memoryCodeUnits;
    for (const work of mining) {
      if (objectiveReason !== null) {
        dispositions.push(disposition(evidence, work.sourceId, objectiveReason));
        continue;
      }
      if (work.miningReason !== "contract-active" || work.workPosition === null) {
        dispositions.push(disposition(evidence, work.sourceId, "mining-unavailable"));
        continue;
      }
      const source = evidence.candidate.intel.record?.sources.find(
        ({ id }) => id === work.sourceId,
      );
      if (source === undefined) {
        dispositions.push(disposition(evidence, work.sourceId, "source-missing"));
        continue;
      }
      if (
        source.energyCapacity <= 0 ||
        source.energyCapacity > input.policy.maximumSourceEnergyCapacity
      ) {
        dispositions.push(disposition(evidence, work.sourceId, "invalid-input"));
        continue;
      }
      const pickup = selectPickup(evidence, work, input.policy);
      if (pickup === null) {
        dispositions.push(disposition(evidence, work.sourceId, "source-empty"));
        continue;
      }
      const sink = selectSink(evidence.donorRoom);
      if (sink === null) {
        dispositions.push(disposition(evidence, work.sourceId, "sink-full"));
        continue;
      }
      const routed = routeEvidence(evidence, source.energyCapacity, input.policy);
      if (routed === null) {
        dispositions.push(disposition(evidence, work.sourceId, "route-unavailable"));
        continue;
      }
      const identity = hash(
        [
          evidence.objective.donorColonyId,
          evidence.objective.roomName,
          work.sourceId,
          pickup.id,
          sink.id,
          evidence.acquireRoute.plan?.requestId,
          routed.acquire.originRoomName,
          routed.acquire.roomNames.join("/"),
          routed.acquire.travelTicks,
          evidence.deliverRoute.plan?.requestId,
          routed.deliver.originRoomName,
          routed.deliver.roomNames.join("/"),
          routed.deliver.travelTicks,
          routed.predictedLossBasisPoints,
          routed.productionMilliPerTick,
        ].join("\0"),
      );
      const edge: LogisticsEdge = {
        id: `remote-haul/${identity}`,
        maximumAmount: pickup.amount,
        roundTripTicks: routed.acquire.travelTicks + routed.deliver.travelTicks,
        routed,
        sinkNodeId: `remote-haul-sink/${identity}`,
        sourceNodeId: `remote-haul-source/${identity}`,
      };
      const body = sizeRoutedLogisticsEdge(edge);
      if (body === null) {
        dispositions.push(disposition(evidence, work.sourceId, "capacity-limit"));
        continue;
      }
      const energy = body.carry * (input.policy.carryPartEnergy + input.policy.movePartEnergy);
      const spawnTicks = (body.carry + body.move) * input.policy.spawnTicksPerPart;
      const lead = routed.acquire.travelTicks + spawnTicks + input.policy.replacementSafetyTicks;
      const details = { body, lead, pickup, sink };
      if (lead >= input.policy.creepLifetime || evidence.candidate.expiresAt - input.tick <= lead) {
        dispositions.push(disposition(evidence, work.sourceId, "timeout", details));
        continue;
      }
      if (
        remainingEnergy < energy ||
        remainingSpawnTicks < spawnTicks ||
        remainingCpuMilli < input.policy.cpuMilliPerSource
      ) {
        dispositions.push(disposition(evidence, work.sourceId, "portfolio-budget", details));
        continue;
      }
      if (remainingMemoryCodeUnits < input.policy.memoryCodeUnitsPerSource) {
        dispositions.push(disposition(evidence, work.sourceId, "memory-budget", details));
        continue;
      }
      remainingEnergy -= energy;
      remainingSpawnTicks -= spawnTicks;
      remainingCpuMilli -= input.policy.cpuMilliPerSource;
      remainingMemoryCodeUnits -= input.policy.memoryCodeUnitsPerSource;
      const budget = requestBudget(evidence, work.sourceId, energy, input);
      requests.push(budget);
      carryParts += body.carry;
      predictedDecay += pickup.decay;
      predictedTransitLoss += body.predictedTransitLoss;
      const grant = authorization(budget, input.budgets);
      if (grant === null) {
        dispositions.push(
          disposition(
            evidence,
            work.sourceId,
            hasBudgetIdentity(budget, input.budgets) ? "budget-insufficient" : "budget-unavailable",
            details,
          ),
        );
        continue;
      }
      budgeted += 1;
      plannedEmptyTravelTicks += routed.acquire.travelTicks;
      plannedLoadedTravelTicks += routed.deliver.travelTicks;
      const sourceNode: LogisticsNode = {
        colonyId: evidence.objective.donorColonyId,
        freeCapacity: 0,
        id: edge.sourceNodeId,
        kind: "source",
        observedAmount: pickup.amount,
        observedAt: input.tick,
        position: pickup.position,
        priority: { class: "normal", deadline: evidence.candidate.expiresAt - 1 },
        resourceType: "energy",
      };
      const sinkNode: LogisticsNode = {
        capacityReservationKey: aggregateStoreCapacityReservationKey(
          evidence.objective.donorColonyId,
          sink.id,
        ),
        colonyId: evidence.objective.donorColonyId,
        freeCapacity: sink.free,
        id: edge.sinkNodeId,
        kind: "sink",
        observedAmount: sink.amount,
        observedAt: input.tick,
        position: sink.position,
        priority: { class: "normal", deadline: evidence.candidate.expiresAt - 1 },
        resourceType: "energy",
      };
      nodes.push(sourceNode, sinkNode);
      endpoints.push(endpoint(sourceNode, pickup.id, pickup.action), endpoint(sinkNode, sink.id));
      edges.push({
        ...edge,
        budgetBinding: { category: "harvesting-filling", issuer: budget.issuer },
      });
      dispositions.push(disposition(evidence, work.sourceId, "contract-ready", details));
    }
  }
  requests.sort((a, b) => compare(a.colonyId, b.colonyId) || compare(a.issuer, b.issuer));
  dispositions.sort((a, b) => compare(a.roomName, b.roomName) || compare(a.sourceId, b.sourceId));
  edges.sort((a, b) => compare(a.id, b.id));
  endpoints.sort((a, b) => compare(a.nodeId, b.nodeId));
  nodes.sort((a, b) => compare(a.id, b.id));
  return freeze({
    status: "ready",
    budgetRequests: requests,
    dispositions,
    metrics: {
      objectives: ordered.length,
      sources,
      budgeted,
      projected: edges.length,
      blocked: dispositions.filter(({ reason }) => reason !== "contract-ready").length,
      carryParts,
      idleSources: dispositions.filter(({ reason }) => reason !== "contract-ready").length,
      plannedEmptyTravelTicks,
      plannedLoadedTravelTicks,
      predictedDecay,
      predictedTransitLoss,
    },
    projection: { edges, endpoints, nodes },
  });
}

function objectiveBlocker(
  value: RemoteHaulingObjectiveEvidence,
  tick: number,
  policy: RemoteHaulingPolicyV1,
): RemoteHaulingReason | null {
  const { objective, candidate } = value;
  if (
    objective.roomName !== candidate.roomName ||
    objective.donorColonyId !== candidate.donorColonyId ||
    candidate.expiresAt <= tick ||
    JSON.stringify(objective.commitment) !== JSON.stringify(candidate.commitment)
  )
    return "invalid-input";
  if (objective.state !== "active") return "objective-not-active";
  if (candidate.donor !== "healthy") return "donor-unavailable";
  if (
    candidate.threatRisk > policy.maximumThreatRisk ||
    value.predictedLossBasisPoints > policy.maximumPredictedLossBasisPoints
  )
    return "threat-risk";
  if (candidate.intel.freshness === "stale" || candidate.intel.freshness === "expired")
    return "intel-stale";
  if (candidate.intel.freshness === "unknown" || candidate.intel.record === null)
    return "intel-unavailable";
  if (candidate.intel.quality !== "complete" || !candidate.intel.record.complete)
    return "intel-partial";
  if (
    candidate.intel.record.observedAt > tick ||
    tick - candidate.intel.record.observedAt > policy.maximumIntelAgeTicks
  )
    return "intel-stale";
  if (
    value.remoteRoom?.name !== objective.roomName ||
    value.remoteRoom.observedAt !== tick ||
    value.donorRoom?.name !== objective.donorColonyId ||
    value.donorRoom.observedAt !== tick ||
    value.donorRoom.controller?.ownership !== "owned"
  )
    return "vision-unavailable";
  return null;
}

function routeEvidence(
  value: RemoteHaulingObjectiveEvidence,
  capacity: number,
  policy: RemoteHaulingPolicyV1,
): RoutedLogisticsEdge | null {
  const acquire = readyRoute(
    value.acquireRoute,
    value.objective.donorColonyId,
    value.objective.roomName,
    policy,
  );
  const deliver = readyRoute(
    value.deliverRoute,
    value.objective.roomName,
    value.objective.donorColonyId,
    policy,
  );
  if (acquire === null || deliver === null) return null;
  return {
    acquire: {
      originRoomName: acquire.originRoomName,
      roomNames: [...acquire.roomNames],
      travelTicks: acquire.estimate.outboundTicks,
    },
    deliver: {
      originRoomName: deliver.originRoomName,
      roomNames: [...deliver.roomNames],
      travelTicks: deliver.estimate.outboundTicks,
    },
    predictedLossBasisPoints: value.predictedLossBasisPoints,
    productionMilliPerTick: Math.ceil((capacity * 1_000) / policy.sourceRegenerationTicks),
  };
}

function readyRoute(
  result: RoutePlanResult,
  origin: string,
  destination: string,
  policy: RemoteHaulingPolicyV1,
): RoutePlanV1 | null {
  const plan = result.plan;
  return result.status === "ready" &&
    plan !== null &&
    plan.originRoomName === origin &&
    plan.destinationRoomName === destination &&
    plan.roomNames.length > 0 &&
    plan.roomNames.length <= REMOTE_HAULING_LIMITS.maximumRouteRooms &&
    plan.roomNames[plan.roomNames.length - 1] === destination &&
    plan.risk <= policy.maximumThreatRisk &&
    plan.estimate.outboundTicks > 0
    ? plan
    : null;
}

function selectPickup(
  value: RemoteHaulingObjectiveEvidence,
  mining: RemoteMiningDisposition,
  policy: RemoteHaulingPolicyV1,
): Pickup | null {
  const room = value.remoteRoom;
  if (room === null || mining.workPosition === null) return null;
  const drop = [...(room.droppedResources ?? [])]
    .filter(
      ({ amount, pos, resourceType }) =>
        amount > 0 &&
        resourceType === "energy" &&
        samePosition(pos, mining.workPosition as LogisticsNode["position"]),
    )
    .sort((a, b) => compare(a.id, b.id))[0];
  if (drop !== undefined && value.acquireRoute.plan !== null) {
    const decay = Math.min(
      drop.amount,
      Math.ceil(drop.amount / policy.droppedResourceDecayDivisor) *
        value.acquireRoute.plan.estimate.outboundTicks,
    );
    if (drop.amount > decay)
      return {
        action: "pickup",
        amount: drop.amount - decay,
        id: drop.id,
        position: drop.pos,
        decay,
      };
  }
  const container = [...room.storedStructures]
    .filter(
      (item) =>
        item.structureType === "container" &&
        item.ownership !== "foreign" &&
        samePosition(item.pos, mining.workPosition as LogisticsNode["position"]) &&
        resourceAmount(item) > 0,
    )
    .sort((a, b) => compare(a.id, b.id))[0];
  return container === undefined
    ? null
    : {
        action: "withdraw",
        amount: resourceAmount(container),
        id: container.id,
        position: container.pos,
        decay: 0,
      };
}

function selectSink(room: RoomSnapshot | null): Sink | null {
  if (room === null) return null;
  const rank = (type: string) => (type === "storage" ? 0 : 1);
  const target = [...room.storedStructures]
    .filter(
      ({ ownership, store, structureType }) =>
        ownership === "owned" &&
        (structureType === "storage" || structureType === "terminal") &&
        store.freeCapacity !== null &&
        store.freeCapacity > 0,
    )
    .sort((a, b) => rank(a.structureType) - rank(b.structureType) || compare(a.id, b.id))[0];
  return target === undefined || target.store.freeCapacity === null
    ? null
    : {
        amount: resourceAmount(target),
        free: target.store.freeCapacity,
        id: target.id,
        position: target.pos,
      };
}

function requestBudget(
  value: RemoteHaulingObjectiveEvidence,
  sourceId: string,
  energy: number,
  input: {
    readonly budgets: readonly RemoteHaulingBudgetEntry[];
    readonly policy: RemoteHaulingPolicyV1;
    readonly tick: number;
  },
): BudgetRequest {
  const issuer = `remote-hauling/${hash(`${value.objective.donorColonyId}/${value.objective.roomName}/${sourceId}`)}`;
  const prior = [...input.budgets]
    .filter(
      ({ colonyId, issuer: key }) => colonyId === value.objective.donorColonyId && key === issuer,
    )
    .sort((a, b) => b.revision - a.revision)[0];
  const reusable =
    prior !== undefined &&
    (prior.status === "active" || prior.status === "pending") &&
    prior.expiresAt > input.tick;
  return {
    category: "harvesting-filling",
    colonyId: value.objective.donorColonyId,
    cpu: { desired: input.policy.cpuMilliPerSource, minimum: input.policy.cpuMilliPerSource },
    energy: { desired: energy, minimum: energy },
    expiresAt: reusable ? prior.expiresAt : value.candidate.expiresAt,
    issuer,
    revision: reusable ? prior.revision : (prior?.revision ?? 0) + 1,
    spawn: null,
  };
}

function authorization(
  request: BudgetRequest,
  values: readonly RemoteHaulingBudgetEntry[],
): RemoteHaulingBudgetEntry | null {
  return (
    values.find(
      (entry) =>
        entry.category === request.category &&
        entry.colonyId === request.colonyId &&
        entry.issuer === request.issuer &&
        entry.revision === request.revision &&
        entry.expiresAt === request.expiresAt &&
        entry.status === "active" &&
        entry.grant !== null &&
        entry.grant.energy >= (request.energy?.minimum ?? 0) &&
        entry.grant.cpu >= (request.cpu?.minimum ?? 0),
    ) ?? null
  );
}
function hasBudgetIdentity(
  request: BudgetRequest,
  values: readonly RemoteHaulingBudgetEntry[],
): boolean {
  return values.some(
    (entry) =>
      entry.category === request.category &&
      entry.colonyId === request.colonyId &&
      entry.issuer === request.issuer &&
      entry.revision === request.revision,
  );
}
function endpoint(
  node: LogisticsNode,
  targetId: string,
  acquireAction?: "pickup" | "withdraw",
): LogisticsContractEndpoint {
  return {
    ...(acquireAction === undefined ? {} : { acquireAction }),
    freeCapacity: node.freeCapacity,
    nodeId: node.id,
    observedAmount: node.observedAmount,
    observedAt: node.observedAt,
    position: node.position,
    resourceType: node.resourceType,
    targetId,
  };
}
function disposition(
  value: RemoteHaulingObjectiveEvidence,
  sourceId: string,
  reason: RemoteHaulingReason,
  detail?: {
    readonly body: RoutedLogisticsBodySize;
    readonly lead: number;
    readonly pickup: Pickup;
    readonly sink: Sink;
  },
): RemoteHaulingDisposition {
  return {
    acquireAction: detail?.pickup.action ?? null,
    carry: detail?.body.carry ?? 0,
    move: detail?.body.move ?? 0,
    predictedPickupAmount: detail?.pickup.amount ?? 0,
    predictedTransitLoss: detail?.body.predictedTransitLoss ?? 0,
    reason,
    replacementLeadTicks: detail?.lead ?? 0,
    roomName: value.objective.roomName,
    sinkTargetId: detail?.sink.id ?? null,
    sourceId,
    sourceTargetId: detail?.pickup.id ?? null,
  };
}
function resourceAmount(structure: StoredStructureSnapshot): number {
  return (
    structure.store.resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0
  );
}
function validInput(input: {
  readonly objectives: readonly RemoteHaulingObjectiveEvidence[];
  readonly budgets: readonly RemoteHaulingBudgetEntry[];
  readonly policy: RemoteHaulingPolicyV1;
  readonly tick: number;
}): boolean {
  const p = input.policy;
  return (
    nonnegative(input.tick) &&
    p.revision.length > 0 &&
    p.revision.length <= 128 &&
    p.sourceRegenerationTicks === 300 &&
    p.carryCapacity === 50 &&
    p.carryPartEnergy === 50 &&
    p.movePartEnergy === 50 &&
    p.spawnTicksPerPart === 3 &&
    p.creepLifetime === 1_500 &&
    nonnegative(p.replacementSafetyTicks) &&
    positive(p.cpuMilliPerSource) &&
    positive(p.memoryCodeUnitsPerSource) &&
    p.maximumSourceEnergyCapacity === 3_000 &&
    nonnegative(p.maximumIntelAgeTicks) &&
    nonnegative(p.maximumThreatRisk) &&
    nonnegative(p.maximumPredictedLossBasisPoints) &&
    p.maximumPredictedLossBasisPoints < 10_000 &&
    p.droppedResourceDecayDivisor === 1_000 &&
    Array.isArray(input.objectives) &&
    input.objectives.every(
      ({ mining, predictedLossBasisPoints }) =>
        Array.isArray(mining) && nonnegative(predictedLossBasisPoints),
    ) &&
    Array.isArray(input.budgets) &&
    input.budgets.every(validBudget)
  );
}
function validBudget(value: RemoteHaulingBudgetEntry): boolean {
  return (
    value.category.length > 0 &&
    value.category.length <= 64 &&
    value.colonyId.length > 0 &&
    value.colonyId.length <= 64 &&
    value.issuer.length > 0 &&
    value.issuer.length <= 128 &&
    nonnegative(value.revision) &&
    nonnegative(value.expiresAt) &&
    ["active", "pending", "consumed", "released", "expired"].includes(value.status) &&
    (value.grant === null || (nonnegative(value.grant.energy) && nonnegative(value.grant.cpu)))
  );
}
function empty(status: RemoteHaulingPlan["status"]): RemoteHaulingPlan {
  return freeze({
    status,
    budgetRequests: [],
    dispositions: [],
    metrics: {
      objectives: 0,
      sources: 0,
      budgeted: 0,
      projected: 0,
      blocked: 0,
      carryParts: 0,
      idleSources: 0,
      plannedEmptyTravelTicks: 0,
      plannedLoadedTravelTicks: 0,
      predictedDecay: 0,
      predictedTransitLoss: 0,
    },
    projection: { edges: [], endpoints: [], nodes: [] },
  });
}
function compareObjective(
  a: RemoteHaulingObjectiveEvidence,
  b: RemoteHaulingObjectiveEvidence,
): number {
  return (
    compare(a.objective.donorColonyId, b.objective.donorColonyId) ||
    compare(a.objective.roomName, b.objective.roomName)
  );
}
function samePosition(a: LogisticsNode["position"], b: LogisticsNode["position"]): boolean {
  return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
}
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
