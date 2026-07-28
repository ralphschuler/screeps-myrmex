import type { CacheManager } from "../cache";
import type { RuntimeConfig } from "../config";
import type { BudgetRequest, LedgerEntry } from "../colony";
import type {
  ContractExecutionView,
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import {
  DEFAULT_REMOTE_HAULING_POLICY_V1,
  projectRemoteHauling,
  type RemoteHaulingPlan,
} from "../logistics/remote-hauling";
import type { LayoutSiteProposal } from "../layout";
import type { WorldSnapshot, RoomSnapshot } from "../world/snapshot";
import type { IntelRuntimeResult, RoomIntelQuery } from "../world/intel";
import {
  DEFAULT_ROUTE_POLICY_V1,
  ROUTE_PLANNER_LIMITS,
  RoutePlanner,
  getRoutePlanCache,
  observeRouteTopology,
  projectRouteRoomEvidence,
  type RouteBodyProfile,
  type RouteMapView,
  type RoutePlanResult,
  type RouteRoomEvidence,
} from "../world/routes";
import type {
  RemoteCandidateEvidence,
  RemotePortfolioCapacity,
  RemotePortfolioResult,
} from "./contracts";
import {
  REMOTE_ACCOUNTING_LIMITS,
  type RemoteAccountingObservation,
  type RemoteAccountingPolicyV1,
} from "./accounting-contracts";
import { resolveRemotePortfolioOwner } from "./persistence";
import { DEFAULT_REMOTE_MINING_POLICY_V1 } from "./mining-policy";
import { RemoteMiningPlanner } from "./mining";
import type { RemoteMiningPlan } from "./mining-contracts";
import { DEFAULT_REMOTE_RESERVATION_POLICY_V1 } from "./reservation-policy";
import { RemoteReservationPlanner } from "./reservation";
import type { RemoteReservationPlan } from "./reservation-contracts";
import { DEFAULT_REMOTE_SAFETY_POLICY_V1 } from "./safety-policy";
import { assessRemoteSafety, planRemoteEvacuations } from "./safety";
import type { RemoteEvacuationPlan, RemoteSafetyAssessmentResult } from "./safety-contracts";

export const REMOTE_RUNTIME_LIMITS = Object.freeze({
  maximumCandidatesPerTick: 4,
  maximumIntelAgeTicks: 5,
  intelExpiryTicks: 25,
  objectiveLifetimeTicks: 1_500,
  objectiveRenewalWindowTicks: 250,
  colonyPlanningCpuReserve: 2.25,
  donorStorageReserveEnergy: 10_000,
  memoryCodeUnitsPerCandidate: 4_352,
} as const);

/** Production receipts are cycle settlements, not per-tick revenue estimates. */
export const PRODUCTION_REMOTE_ACCOUNTING_POLICY_V1: RemoteAccountingPolicyV1 = Object.freeze({
  schemaVersion: 1,
  revision: "remote-accounting-policy-v1-production-cycles",
  windowTicks: 1_000,
  maximumSamplesPerRemote: 50,
  minimumCompleteTicks: 5,
  minimumConfidenceBasisPoints: 0,
  staleAfterTicks: 250,
  minimumProfitMilliPerTick: 1,
  marginalProfitMilliPerTick: 1_000,
  spawnTimeCostMilliEnergyPerTick: 100,
  travelCostMilliEnergyPerTick: 50,
  cpuCostMilliEnergyPerMilliCpu: 2,
});

export interface RemoteRuntimeDiscovery {
  readonly candidates: readonly RemoteCandidateEvidence[];
  readonly capacity: RemotePortfolioCapacity;
  readonly evacuationRoutes: Readonly<Record<string, RoutePlanResult>>;
  readonly safety: RemoteSafetyAssessmentResult;
}

export interface RemoteOperationsPlan {
  readonly budgetRequests: readonly BudgetRequest[];
  readonly contractRequests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
  readonly mining: RemoteMiningPlan;
  readonly reservation: RemoteReservationPlan;
  readonly hauling: RemoteHaulingPlan;
  readonly evacuation: RemoteEvacuationPlan;
  readonly siteAuthorizations: readonly RemoteMiningPlan["siteAuthorizations"][number][];
  readonly siteProposals: readonly LayoutSiteProposal[];
}

/**
 * Bounded adjacent-room evidence discovery. It selects no portfolio winner and owns no state.
 * RemotePortfolio remains the sole lifecycle and capacity authority.
 */
export function discoverRemoteRuntime(input: {
  readonly cache: CacheManager;
  readonly config: RuntimeConfig;
  readonly cpuCapacityMilli: number;
  readonly intel: IntelRuntimeResult;
  readonly map: RouteMapView | null;
  readonly owner: unknown;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): RemoteRuntimeDiscovery {
  const empty = (): RemoteRuntimeDiscovery =>
    freeze({
      candidates: [],
      capacity: remoteCapacity(input.snapshot, input.cpuCapacityMilli),
      evacuationRoutes: {},
      safety: assessRemoteSafety({
        availableCpuMilli: 0,
        config: input.config,
        evidence: [],
        policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
        tick: input.tick,
      }),
    });
  if (input.map === null || input.intel.status !== "ready") return empty();
  const pairs = selectRemoteCandidatePairs(input.snapshot, input.map, input.owner);
  if (pairs.length === 0) return empty();
  const roomNames = [...new Set(pairs.flatMap(({ donor, remote }) => [donor.name, remote]))].sort(
    compare,
  );
  const topology = observeRouteTopology({ map: input.map, roomNames });
  if (topology.status !== "ready") return empty();
  const intelByRoom = new Map(input.intel.rooms.map((result) => [result.roomName, result]));
  const topologyByRoom = new Map(topology.rooms.map((room) => [room.roomName, room]));
  const evidence: RouteRoomEvidence[] = [];
  for (const roomName of roomNames) {
    const topologyRoom = topologyByRoom.get(roomName);
    const roomIntel = intelByRoom.get(roomName);
    const room = input.snapshot.rooms.find(({ name }) => name === roomName);
    if (topologyRoom === undefined || roomIntel === undefined) return empty();
    const relation =
      room?.controller?.ownership === "owned" ? "self" : relationForController(room, input.config);
    const projected = projectRouteRoomEvidence({
      roomName,
      exits: topologyRoom.exits,
      status: topologyRoom.status,
      relation,
      threatRisk: credibleThreat(room, input.config) ? 1 : 0,
      intel: roomIntel,
    });
    if (projected === null) return empty();
    evidence.push(projected);
  }
  const routePlanner = new RoutePlanner(getRoutePlanCache(input.cache));
  const previous = resolveRemotePortfolioOwner(input.owner).owner;
  const candidates: RemoteCandidateEvidence[] = [];
  const evacuationRoutes: Record<string, RoutePlanResult> = {};
  let remainingRouteCpuMilli = Math.max(0, input.cpuCapacityMilli);
  const authorizeRouteCpu = (): number => {
    if (remainingRouteCpuMilli < ROUTE_PLANNER_LIMITS.minimumColdSearchCpuMilli) return 0;
    remainingRouteCpuMilli -= ROUTE_PLANNER_LIMITS.minimumColdSearchCpuMilli;
    return ROUTE_PLANNER_LIMITS.minimumColdSearchCpuMilli;
  };
  for (const { donor, remote } of pairs) {
    const intel = intelByRoom.get(remote);
    if (intel === undefined) continue;
    const route = planRoute(
      routePlanner,
      input.tick,
      donor.name,
      remote,
      evidence,
      "outbound",
      authorizeRouteCpu(),
    );
    const evacuationRoute = planRoute(
      routePlanner,
      input.tick,
      remote,
      donor.name,
      evidence,
      "return",
      authorizeRouteCpu(),
    );
    evacuationRoutes[remote] = evacuationRoute;
    const remoteRoom = input.snapshot.rooms.find(({ name }) => name === remote);
    const prior = previous?.records.find(({ roomName }) => roomName === remote);
    const sourceCount = intel.record?.sources.length ?? 0;
    const routeReady = route.status === "ready" && route.plan !== null;
    const commitment = routeReady
      ? commitmentFor(sourceCount, route)
      : (prior?.commitment ?? { energy: 0, spawnTicks: 0, cpuMilli: 0, memoryCodeUnits: 0 });
    const expiresAt =
      prior === undefined
        ? safeAdd(input.tick, REMOTE_RUNTIME_LIMITS.objectiveLifetimeTicks)
        : prior.state !== "retired" &&
            prior.expiresAt > input.tick &&
            prior.expiresAt - input.tick <= REMOTE_RUNTIME_LIMITS.objectiveRenewalWindowTicks
          ? safeAdd(input.tick, REMOTE_RUNTIME_LIMITS.objectiveLifetimeTicks)
          : prior.expiresAt;
    candidates.push(
      freeze({
        roomName: remote,
        donorColonyId: donor.name,
        evidenceRevision: runtimeRevision(
          input.tick,
          remote,
          intel.record?.observedAt ?? -1,
          route,
        ),
        expiresAt,
        controller: controllerDisposition(remoteRoom, input.config),
        donor: donorHealthy(donor, input.config) ? "healthy" : "brownout",
        threatRisk: credibleThreat(remoteRoom, input.config) ? 1 : 0,
        intel,
        route,
        costs: routeReady ? costsFor(commitment, route) : costsFromPrior(prior?.forecast.cost ?? 0),
        commitment,
      }),
    );
  }
  const orderedCandidates = candidates.sort((left, right) =>
    compare(left.roomName, right.roomName),
  );
  const safety = assessRemoteSafety({
    availableCpuMilli:
      orderedCandidates.length * DEFAULT_REMOTE_SAFETY_POLICY_V1.assessmentCpuMilli,
    config: input.config,
    evidence: orderedCandidates.map((candidate) => ({
      candidate,
      confidenceBasisPoints: 10_000,
      evacuationRoute: evacuationRoutes[candidate.roomName] ?? unavailableRoute(),
      recentLossBasisPoints: 0,
    })),
    policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
    tick: input.tick,
  });
  return freeze({
    candidates: safety.status === "ready" ? safety.candidates : [],
    capacity: remoteCapacity(input.snapshot, input.cpuCapacityMilli),
    evacuationRoutes,
    safety,
  });
}

/** Composes active portfolio objectives through existing donor-budget, contract, logistics, and
 * evacuation authorities. It persists and executes nothing. */
export function planRemoteOperations(input: {
  readonly contracts: ContractPlanningView;
  readonly discovery: RemoteRuntimeDiscovery;
  readonly execution: ContractExecutionView;
  readonly ledger: readonly LedgerEntry[];
  readonly portfolio: RemotePortfolioResult;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): RemoteOperationsPlan {
  const budgets = input.ledger.map((entry) => ({
    category: entry.category,
    colonyId: entry.colonyId,
    expiresAt: entry.request.expiresAt,
    grant: entry.grant,
    issuer: entry.issuer,
    revision: entry.revision,
    status: entry.status,
  }));
  const evidence = input.portfolio.objectives.flatMap((objective) => {
    const candidate = input.discovery.candidates.find(
      ({ donorColonyId, roomName }) =>
        roomName === objective.roomName && donorColonyId === objective.donorColonyId,
    );
    return candidate === undefined ? [] : [{ candidate, objective }];
  });
  const reservation = new RemoteReservationPlanner().plan({
    budgets,
    contracts: input.contracts,
    objectives: evidence,
    policy: DEFAULT_REMOTE_RESERVATION_POLICY_V1,
    tick: input.tick,
  });
  const mining = new RemoteMiningPlanner().plan({
    budgets,
    contracts: input.contracts,
    objectives: evidence.map((item) => ({
      ...item,
      roadCandidates: [],
      visibleRoom:
        input.snapshot.rooms.find(({ name }) => name === item.objective.roomName) ?? null,
    })),
    policy: DEFAULT_REMOTE_MINING_POLICY_V1,
    tick: input.tick,
  });
  const hauling = projectRemoteHauling({
    budgets,
    objectives: evidence.map((item) => ({
      ...item,
      acquireRoute: item.candidate.route,
      deliverRoute: input.discovery.evacuationRoutes[item.objective.roomName] ?? unavailableRoute(),
      donorRoom:
        input.snapshot.rooms.find(({ name }) => name === item.objective.donorColonyId) ?? null,
      mining: mining.dispositions.filter(({ roomName }) => roomName === item.objective.roomName),
      predictedLossBasisPoints: 0,
      remoteRoom: input.snapshot.rooms.find(({ name }) => name === item.objective.roomName) ?? null,
    })),
    policy: DEFAULT_REMOTE_HAULING_POLICY_V1,
    tick: input.tick,
  });
  const evacuation = planRemoteEvacuations({
    actors: input.snapshot.rooms.flatMap((room) => room.ownedCreeps),
    assessments: input.discovery.safety.assessments,
    evidence: input.discovery.candidates.map((candidate) => ({
      candidate,
      confidenceBasisPoints: 10_000,
      evacuationRoute: input.discovery.evacuationRoutes[candidate.roomName] ?? unavailableRoute(),
      recentLossBasisPoints: 0,
    })),
    execution: input.execution,
    policy: DEFAULT_REMOTE_SAFETY_POLICY_V1,
    portfolioDispositions: input.portfolio.dispositions,
    tick: input.tick,
  });
  return freeze({
    budgetRequests: [
      ...reservation.budgetRequests,
      ...mining.budgetRequests,
      ...hauling.budgetRequests,
    ].sort(compareBudgetRequest),
    contractRequests: [...reservation.contractRequests, ...mining.contractRequests].sort(
      (left, right) => compare(left.issuer, right.issuer),
    ),
    transitions: [
      ...reservation.transitions,
      ...mining.transitions,
      ...evacuation.transitions,
    ].sort((left, right) => compare(left.contractId, right.contractId)),
    mining,
    reservation,
    hauling,
    evacuation,
    siteAuthorizations: mining.siteAuthorizations,
    siteProposals: mining.siteProposals,
  });
}

/**
 * Projects settled current observation and existing active remote contracts into disjoint
 * portfolio-owned accounting receipts. Warm-up and ordinary in-flight ticks emit no optimistic or
 * zero-revenue sample; delivery and actor-loss settlements alone advance the cycle policy.
 */
export function projectRemoteAccountingObservations(input: {
  readonly candidates: readonly RemoteCandidateEvidence[];
  readonly contracts: ContractPlanningView;
  readonly execution: ContractExecutionView;
  readonly owner: unknown;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): readonly RemoteAccountingObservation[] {
  const owner = resolveRemotePortfolioOwner(input.owner).owner;
  if (owner === null || input.contracts.status !== "ready" || input.execution.status !== "ready")
    return Object.freeze([]);
  const actorById = new Map(
    input.snapshot.rooms.flatMap((room) => room.ownedCreeps).map((actor) => [actor.id, actor]),
  );
  const leaseByContract = new Map(input.execution.leases.map((lease) => [lease.contractId, lease]));
  const observations: RemoteAccountingObservation[] = [];
  for (const record of owner.records) {
    if (record.state !== "active" && record.state !== "probing" && record.state !== "cooldown")
      continue;
    const candidate = input.candidates.find(
      ({ donorColonyId, roomName }) =>
        roomName === record.roomName && donorColonyId === record.donorColonyId,
    );
    if (candidate === undefined) continue;
    const sourceCount = candidate.intel.record?.sources.length ?? 0;
    const contracts = input.contracts.contracts.filter((contract) =>
      remoteContractRoom(contract, record.roomName, record.donorColonyId),
    );
    const mining = contracts.filter(({ execution }) => execution.version === 5);
    const hauling = contracts.filter(({ execution }) => execution.version === 6);
    const reservation = contracts.filter(({ execution }) => execution.version === 4);
    const accounting = owner.accounting.find(({ roomName }) => roomName === record.roomName);
    const tracked = accounting !== undefined;
    const fullyPublished =
      sourceCount > 0 &&
      mining.length >= sourceCount &&
      hauling.length >= sourceCount &&
      [...mining, ...hauling].every(({ state }) => state === "assigned" || state === "active");
    if (!fullyPublished && !tracked) continue;

    let deliveredEnergy = 0;
    let creepLossEnergy = 0;
    let travelTicks = 0;
    for (const contract of [...reservation, ...mining, ...hauling]) {
      const lease = leaseByContract.get(contract.contractId);
      const actor = lease === undefined ? undefined : actorById.get(lease.actorId);
      if (lease !== undefined && actor === undefined) {
        creepLossEnergy += remoteBodyEnergy(contract, candidate);
        travelTicks += expectedContractTravelTicks(contract, candidate);
        continue;
      }
      const execution = contract.execution;
      if (execution.version !== 6 || execution.stage !== "deliver") continue;
      const sinkRoom = input.snapshot.rooms.find(
        ({ name }) => name === execution.sinkPosition.roomName,
      );
      const sink = sinkRoom?.storedStructures.find(({ id }) => id === execution.sinkTargetId);
      const sinkAmount =
        sink?.store.resources.find(({ resourceType }) => resourceType === execution.resourceType)
          ?.amount ?? 0;
      const actorAmount =
        actor?.store.resources.find(({ resourceType }) => resourceType === execution.resourceType)
          ?.amount ?? 0;
      const settled = Math.min(
        execution.reservedAmount,
        Math.max(0, sinkAmount - execution.sinkBaselineAmount),
        Math.max(0, execution.reservedAmount - actorAmount),
      );
      deliveredEnergy += settled;
      if (settled > 0)
        travelTicks += execution.acquireRouteTravelTicks + execution.deliverRouteTravelTicks;
    }
    if (deliveredEnergy === 0 && creepLossEnergy === 0) continue;
    const previousSample = accounting?.samples[accounting.samples.length - 1];
    const defaultCycleTicks = Math.max(
      1,
      candidate.route.plan?.estimate.roundTripTicks ?? 0,
      ...hauling.map(({ execution }) =>
        execution.version === 6
          ? execution.acquireRouteTravelTicks + execution.deliverRouteTravelTicks
          : 0,
      ),
    );
    const settlementTicks = Math.max(
      1,
      Math.min(
        PRODUCTION_REMOTE_ACCOUNTING_POLICY_V1.windowTicks,
        previousSample === undefined ? defaultCycleTicks : input.tick - previousSample[0],
      ),
    );
    travelTicks += amortizedStationaryTravelTicks(
      [...reservation, ...mining],
      candidate,
      settlementTicks,
    );
    const spawnEnergy = amortizedBodyCost(
      [...reservation, ...mining, ...hauling],
      candidate,
      settlementTicks,
      remoteBodyEnergy,
    );
    const spawnTicks = amortizedBodyCost(
      [...reservation, ...mining, ...hauling],
      candidate,
      settlementTicks,
      (contract, value) => remoteBodyParts(contract, value) * 3,
    );
    observations.push({
      constructionEnergy: 0,
      cpuMilli: boundedProduct(candidate.commitment.cpuMilli, settlementTicks),
      creepLossEnergy,
      deliveredEnergy,
      donorColonyId: record.donorColonyId,
      downtimeTicks: 0,
      forecastProfitMilliPerTick: record.forecast.profit,
      forecastRevenueMilliPerTick: record.forecast.revenue,
      harvestedEnergy: 0,
      observedAt: input.tick,
      quality: fullyPublished ? "complete" : "partial",
      repairEnergy: 0,
      reservationEnergy: 0,
      roomName: record.roomName,
      spawnEnergy,
      spawnTicks,
      travelTicks,
    });
  }
  return freeze(observations.sort((left, right) => compare(left.roomName, right.roomName)));
}

function remoteContractRoom(
  contract: ContractPlanningView["contracts"][number],
  roomName: string,
  donorColonyId: string,
): boolean {
  if (contract.owner.kind !== "colony" || contract.owner.id !== donorColonyId) return false;
  const execution = contract.execution;
  if (execution.version === 4)
    return (
      contract.targetId !== "" &&
      contract.issuer === `remote-reservation/${donorColonyId}/${roomName}` &&
      activeContractRoom(contract) === roomName
    );
  if (execution.version === 5)
    return (
      contract.targetId !== "" &&
      contract.issuer.startsWith(`remote-mining/${donorColonyId}/${roomName}/`) &&
      activeContractRoom(contract) === roomName
    );
  return (
    execution.version === 6 &&
    contract.budgetBinding.category === "harvesting-filling" &&
    contract.budgetBinding.issuer.startsWith("remote-hauling/") &&
    execution.flowId.startsWith("remote-haul/") &&
    execution.sourceNodeId.startsWith("remote-haul-source/") &&
    execution.sinkNodeId.startsWith("remote-haul-sink/") &&
    execution.acquireOriginRoomName === donorColonyId &&
    execution.sourcePosition.roomName === roomName &&
    execution.deliverOriginRoomName === roomName &&
    execution.sinkPosition.roomName === donorColonyId
  );
}

function activeContractRoom(contract: ContractPlanningView["contracts"][number]): string {
  const execution = contract.execution;
  if (execution.version === 4 || execution.version === 5)
    return (
      execution.routeRoomNames[execution.routeRoomNames.length - 1] ?? execution.originRoomName
    );
  if (execution.version === 6)
    return execution.stage === "acquire"
      ? execution.sourcePosition.roomName
      : execution.sinkPosition.roomName;
  return contract.owner.id;
}

function remoteBodyEnergy(
  contract: ContractPlanningView["contracts"][number],
  candidate: RemoteCandidateEvidence,
): number {
  const execution = contract.execution;
  if (execution.version === 4) return 1_300;
  if (execution.version === 6) return (execution.recommendedCarry + execution.recommendedMove) * 50;
  if (execution.version === 5) {
    const capacity =
      candidate.intel.record?.sources.find(({ id }) => id === contract.targetId)?.energyCapacity ??
      0;
    const work = Math.ceil(capacity / 300 / 2);
    return work * 150;
  }
  return 0;
}

function remoteBodyParts(
  contract: ContractPlanningView["contracts"][number],
  candidate: RemoteCandidateEvidence,
): number {
  const execution = contract.execution;
  if (execution.version === 4) return 4;
  if (execution.version === 6) return execution.recommendedCarry + execution.recommendedMove;
  if (execution.version === 5) return Math.floor(remoteBodyEnergy(contract, candidate) / 75);
  return 0;
}

function expectedContractTravelTicks(
  contract: ContractPlanningView["contracts"][number],
  candidate: RemoteCandidateEvidence,
): number {
  const execution = contract.execution;
  if (execution.version === 6)
    return execution.acquireRouteTravelTicks + execution.deliverRouteTravelTicks;
  if (execution.version === 4 || execution.version === 5)
    return candidate.route.plan?.estimate.outboundTicks ?? execution.routeTravelTicks;
  return 0;
}

function amortizedStationaryTravelTicks(
  contracts: readonly ContractPlanningView["contracts"][number][],
  candidate: RemoteCandidateEvidence,
  settlementTicks: number,
): number {
  let total = 0;
  for (const contract of contracts) {
    const lifetime =
      contract.execution.version === 4
        ? DEFAULT_REMOTE_RESERVATION_POLICY_V1.claimCreepLifetime
        : 1_500;
    total = Math.min(
      REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick,
      total +
        Math.ceil((expectedContractTravelTicks(contract, candidate) * settlementTicks) / lifetime),
    );
  }
  return total;
}

function amortizedBodyCost(
  contracts: readonly ContractPlanningView["contracts"][number][],
  candidate: RemoteCandidateEvidence,
  settlementTicks: number,
  value: (
    contract: ContractPlanningView["contracts"][number],
    candidate: RemoteCandidateEvidence,
  ) => number,
): number {
  let total = 0;
  for (const contract of contracts) {
    const lifetime =
      contract.execution.version === 4
        ? DEFAULT_REMOTE_RESERVATION_POLICY_V1.claimCreepLifetime
        : 1_500;
    const amortized = Math.ceil((value(contract, candidate) * settlementTicks) / lifetime);
    total = Math.min(REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick, total + amortized);
  }
  return total;
}

function boundedProduct(left: number, right: number): number {
  return Math.min(REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick, left * right);
}

/** Rooms queried by IntelService before portfolio planning. Current adjacent exits and retained
 * lifecycle identities are included; no route or portfolio choice is made here. */
export function remoteRuntimeIntelQueries(input: {
  readonly map: RouteMapView | null;
  readonly owner: unknown;
  readonly snapshot: WorldSnapshot;
}): readonly RoomIntelQuery[] {
  const retained =
    resolveRemotePortfolioOwner(input.owner).owner?.records.map(({ roomName }) => roomName) ?? [];
  const pairRooms =
    input.map === null
      ? []
      : selectRemoteCandidatePairs(input.snapshot, input.map, input.owner).flatMap(
          ({ donor, remote }) => [donor.name, remote],
        );
  const owned = input.snapshot.ownedRooms.map(({ name }) => name);
  return freeze(
    [...new Set([...pairRooms, ...retained, ...owned])]
      .filter(validRoomName)
      .slice(0, 8)
      .sort(compare)
      .map((roomName) => ({
        roomName,
        maximumAge: REMOTE_RUNTIME_LIMITS.maximumIntelAgeTicks,
        expiresAfter: REMOTE_RUNTIME_LIMITS.intelExpiryTicks,
      })),
  );
}

export function selectRemoteCandidatePairs(
  snapshot: WorldSnapshot,
  map: RouteMapView,
  owner: unknown,
): readonly { readonly donor: RoomSnapshot; readonly remote: string }[] {
  const records = resolveRemotePortfolioOwner(owner).owner?.records ?? [];
  const retainedByRoom = new Map(
    records.filter(({ state }) => state !== "retired").map((record) => [record.roomName, record]),
  );
  const pairs: { donor: RoomSnapshot; remote: string }[] = [];
  for (const donor of [...snapshot.ownedRooms].sort((left, right) =>
    compare(left.name, right.name),
  )) {
    let exits: readonly string[];
    try {
      exits = Object.values(map.describeExits(donor.name) ?? {})
        .filter(validRoomName)
        .sort(compare);
    } catch {
      continue;
    }
    for (const remote of exits) {
      const visible = snapshot.rooms.find(({ name }) => name === remote);
      if (
        !retainedByRoom.has(remote) &&
        (visible?.controller === null || visible?.controller?.ownership === "owned")
      )
        continue;
      pairs.push({ donor, remote });
    }
  }
  const byRemote = new Map<string, { donor: RoomSnapshot; remote: string }>();
  for (const pair of pairs.sort((left, right) => {
    const room = compare(left.remote, right.remote);
    if (room !== 0) return room;
    const retainedDonor = retainedByRoom.get(left.remote)?.donorColonyId;
    const leftRank = left.donor.name === retainedDonor ? 0 : 1;
    const rightRank = right.donor.name === retainedDonor ? 0 : 1;
    return leftRank - rightRank || compare(left.donor.name, right.donor.name);
  })) {
    if (!byRemote.has(pair.remote)) byRemote.set(pair.remote, pair);
  }
  const retentionRank = (roomName: string): number => {
    const state = retainedByRoom.get(roomName)?.state;
    if (state === undefined) return 2;
    return state === "candidate" ? 1 : 0;
  };
  return [...byRemote.values()]
    .sort(
      (left, right) =>
        retentionRank(left.remote) - retentionRank(right.remote) ||
        compare(left.remote, right.remote) ||
        compare(left.donor.name, right.donor.name),
    )
    .slice(0, REMOTE_RUNTIME_LIMITS.maximumCandidatesPerTick);
}

function planRoute(
  planner: RoutePlanner,
  tick: number,
  originRoomName: string,
  destinationRoomName: string,
  rooms: readonly RouteRoomEvidence[],
  direction: string,
  availableCpuMilli: number,
): RoutePlanResult {
  return planner.plan({
    id: `remote-runtime/${direction}/${originRoomName}/${destinationRoomName}`,
    originRoomName,
    destinationRoomName,
    tick,
    deadline: safeAdd(tick, REMOTE_RUNTIME_LIMITS.objectiveLifetimeTicks),
    availableCpuMilli,
    topologyRevision: revisionOf(
      rooms.map(({ roomName, exits, status }) => [roomName, exits, status]),
    ),
    intelRevision: revisionOf(
      rooms.map(({ roomName, freshness, quality, terrain }) => [
        roomName,
        freshness,
        quality,
        terrain,
      ]),
    ),
    diplomacyRevision: revisionOf(rooms.map(({ roomName, relation }) => [roomName, relation])),
    threatRevision: revisionOf(rooms.map(({ roomName, threatRisk }) => [roomName, threatRisk])),
    policy: DEFAULT_ROUTE_POLICY_V1,
    body: REMOTE_ROUTE_BODY,
    budget: {
      maximumExpandedRooms: ROUTE_PLANNER_LIMITS.maximumEvidenceRooms,
      maximumRouteRooms: ROUTE_PLANNER_LIMITS.maximumRouteRooms,
      maximumTotalCost: 1_000_000_000,
      maximumRisk: 0,
      maximumPlanCodeUnits: ROUTE_PLANNER_LIMITS.maximumPlanCodeUnits,
    },
    rooms,
  });
}

const REMOTE_ROUTE_BODY: RouteBodyProfile = Object.freeze({
  moveParts: 25,
  carryParts: 25,
  nonMoveNonCarryParts: 0,
  outboundLoadedCarryParts: 0,
  returnLoadedCarryParts: 25,
  initialFatigue: 0,
});

function commitmentFor(
  sourceCount: number,
  route: RoutePlanResult,
): RemoteCandidateEvidence["commitment"] {
  const roundTripTicks = route.plan?.estimate.roundTripTicks ?? 0;
  const carryPerSource = Math.min(25, Math.ceil(((3_000 / 300) * roundTripTicks) / 50));
  const miningEnergy = sourceCount * 750;
  const haulingEnergy = sourceCount * carryPerSource * 100;
  return {
    energy: 1_300 + miningEnergy + haulingEnergy,
    spawnTicks: 12 + sourceCount * 30 + sourceCount * carryPerSource * 6,
    cpuMilli: 100 + sourceCount * 100,
    memoryCodeUnits: 256 + sourceCount * 2_048,
  };
}

function costsFor(
  commitment: RemoteCandidateEvidence["commitment"],
  route: RoutePlanResult,
): RemoteCandidateEvidence["costs"] {
  const estimate = route.plan?.estimate;
  return {
    latency: (estimate?.outboundTicks ?? 0) * 20,
    spawn: commitment.spawnTicks * 10,
    body: Math.ceil((commitment.energy * 1_000) / 1_500),
    hauling: (estimate?.roundTripTicks ?? 0) * 20,
    reservation: Math.ceil((1_300 * 1_000) / 600),
    roads: 0,
    repair: 0,
    expectedLoss: 0,
    cpu: commitment.cpuMilli,
  };
}

function costsFromPrior(total: number): RemoteCandidateEvidence["costs"] {
  return {
    latency: total,
    spawn: 0,
    body: 0,
    hauling: 0,
    reservation: 0,
    roads: 0,
    repair: 0,
    expectedLoss: 0,
    cpu: 0,
  };
}

function remoteCapacity(
  snapshot: WorldSnapshot,
  cpuCapacityMilli: number,
): RemotePortfolioCapacity {
  const donors = snapshot.ownedRooms.filter((room) => donorHealthy(room, null));
  const storedEnergy = donors.reduce(
    (total, room) =>
      total +
      room.storedStructures
        .filter(
          ({ ownership, structureType }) =>
            ownership === "owned" && (structureType === "storage" || structureType === "terminal"),
        )
        .reduce(
          (sum, structure) =>
            sum +
            (structure.store.resources.find(({ resourceType }) => resourceType === "energy")
              ?.amount ?? 0),
          0,
        ),
    0,
  );
  const activeSpawns = donors.reduce(
    (total, room) => total + room.ownedSpawns.filter(({ active }) => active).length,
    0,
  );
  return {
    activeRemotes: Math.min(activeSpawns, REMOTE_RUNTIME_LIMITS.maximumCandidatesPerTick),
    cpuMilli: Math.max(0, cpuCapacityMilli),
    energy: Math.max(
      0,
      storedEnergy - activeSpawns * REMOTE_RUNTIME_LIMITS.donorStorageReserveEnergy,
    ),
    memoryCodeUnits: activeSpawns * REMOTE_RUNTIME_LIMITS.memoryCodeUnitsPerCandidate,
    spawnTicks: activeSpawns * 1_500,
  };
}

function donorHealthy(room: RoomSnapshot, config: RuntimeConfig | null): boolean {
  return (
    room.controller?.ownership === "owned" &&
    room.ownedSpawns.some(({ active }) => active) &&
    room.ownedCreeps.some(
      ({ body, spawning, ticksToLive }) =>
        !spawning &&
        ticksToLive !== null &&
        body.work.active > 0 &&
        body.carry.active > 0 &&
        body.move.active > 0,
    ) &&
    !credibleThreat(room, config)
  );
}

function credibleThreat(room: RoomSnapshot | undefined, config: RuntimeConfig | null): boolean {
  if (room === undefined) return false;
  return room.hostileCreeps.some((creep) => {
    if (config !== null && config.relations.allies.includes(creep.ownerUsername)) return false;
    if (config !== null && config.relations.naps.includes(creep.ownerUsername)) return false;
    if (config !== null && config.relations.self.includes(creep.ownerUsername)) return false;
    return (
      creep.body.attack.active +
        creep.body.claim.active +
        creep.body.rangedAttack.active +
        creep.body.work.active >
      0
    );
  });
}

function controllerDisposition(
  room: RoomSnapshot | undefined,
  config: RuntimeConfig,
): RemoteCandidateEvidence["controller"] {
  const controller = room?.controller;
  if (controller === undefined || controller === null) return "unknown";
  if (controller.ownership === "neutral") return "available";
  if (
    controller.ownership === "reserved" &&
    controller.reservationUsername !== null &&
    config.relations.self.includes(controller.reservationUsername)
  )
    return "self-reserved";
  return "blocked";
}

function relationForController(
  room: RoomSnapshot | undefined,
  config: RuntimeConfig,
): RouteRoomEvidence["relation"] {
  const username = room?.controller?.ownerUsername ?? room?.controller?.reservationUsername ?? null;
  if (username === null) return "neutral";
  if (config.relations.self.includes(username)) return "self";
  if (config.relations.allies.includes(username)) return "ally";
  if (config.relations.naps.includes(username)) return "nap";
  return "neutral";
}

function unavailableRoute(): RoutePlanResult {
  return freeze({
    metrics: {
      cacheHits: 0,
      consideredEdges: 0,
      expandedRooms: 0,
      reason: "no-path",
      risk: 0,
      routeRooms: 0,
      totalCost: 0,
    },
    plan: null,
    reason: "no-path",
    source: "none",
    status: "no-route",
  });
}

function compareBudgetRequest(left: BudgetRequest, right: BudgetRequest): number {
  return compare(left.colonyId, right.colonyId) || compare(left.issuer, right.issuer);
}

function runtimeRevision(
  tick: number,
  roomName: string,
  observedAt: number,
  route: RoutePlanResult,
): string {
  return `remote-runtime-v1/${roomName}/${String(tick)}/${String(observedAt)}/${route.plan?.requestId ?? route.reason}`;
}

function revisionOf(value: unknown): string {
  return `remote-runtime-${hash(JSON.stringify(value))}`;
}
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function safeAdd(left: number, right: number): number {
  return left <= Number.MAX_SAFE_INTEGER - right ? left + right : Number.MAX_SAFE_INTEGER;
}
function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
