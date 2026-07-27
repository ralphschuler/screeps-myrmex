import type { BudgetRequest } from "../colony";
import type {
  CapabilityVector,
  ContractExecutionTermsV5,
  ContractPlanningRecord,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { LayoutSiteProposal } from "../layout";
import type { RoomIntelRecordV1, RoomIntelSource } from "../world/intel";
import type { PositionSnapshot, RoomSnapshot } from "../world/snapshot";
import {
  REMOTE_MINING_LIMITS,
  type RemoteMiningBudgetEntry,
  type RemoteMiningDisposition,
  type RemoteMiningMetrics,
  type RemoteMiningObjectiveEvidence,
  type RemoteMiningOffload,
  type RemoteMiningPlan,
  type RemoteMiningPlanInput,
  type RemoteMiningPolicyV1,
  type RemoteMiningReason,
} from "./mining-contracts";

const ISSUER_PREFIX = "remote-mining/";
const CAPITAL_PREFIX = "remote-capital/";

interface ObjectiveEvaluation {
  readonly evidence: RemoteMiningObjectiveEvidence;
  readonly reason: RemoteMiningReason | null;
  readonly routeTravelTicks: number;
  readonly sources: readonly RoomIntelSource[];
}

interface SourceProjection {
  readonly capability: CapabilityVector;
  readonly offload: RemoteMiningOffload;
  readonly source: RoomIntelSource;
  readonly workPosition: PositionSnapshot;
}

/**
 * Pure bridge from profitable active remotes into donor budgets, contracts, and site proposals.
 * Portfolio, ContractLedger, population/spawn, movement/action, and site authorities remain sole.
 */
export class RemoteMiningPlanner {
  public plan(input: RemoteMiningPlanInput): RemoteMiningPlan {
    if (!validInput(input)) return emptyPlan("invalid-input");
    if (input.contracts.status !== "ready") return emptyPlan("contracts-unavailable");
    if (
      input.objectives.length > REMOTE_MINING_LIMITS.maximumObjectivesPerTick ||
      input.objectives.some(
        ({ roadCandidates }) =>
          roadCandidates.length > REMOTE_MINING_LIMITS.maximumRoadCandidatesPerObjective,
      ) ||
      input.budgets.length > REMOTE_MINING_LIMITS.maximumBudgetEntries ||
      input.contracts.contracts.length > REMOTE_MINING_LIMITS.maximumContractRecords
    )
      return emptyPlan("limit-exceeded");

    const objectives = [...input.objectives].sort(compareObjective);
    if (
      new Set(objectives.map(({ objective }) => `${objective.donorColonyId}/${objective.roomName}`))
        .size !== objectives.length
    )
      return emptyPlan("invalid-input");
    const existingByIssuer = existingMiningContracts(input.contracts.contracts);
    if (existingByIssuer === null) return emptyPlan("invalid-input");

    const budgets: BudgetRequest[] = [];
    const requests: WorkContractRequest[] = [];
    const transitions: ContractTransitionRequest[] = [];
    const proposals: LayoutSiteProposal[] = [];
    const dispositions: RemoteMiningDisposition[] = [];
    const handledIssuers = new Set<string>();
    let sourceCount = 0;
    let retries = 0;

    for (const evidence of objectives) {
      const evaluation = evaluateObjective(evidence, input.tick, input.policy);
      const knownSources =
        evaluation.sources.length > 0
          ? evaluation.sources
          : existingSourcesForObjective(existingByIssuer, evidence);
      if (evaluation.reason !== null) {
        for (const source of knownSources) {
          const issuer = issuerFor(evidence, source.id);
          handledIssuers.add(issuer);
          stopExisting(
            existingByIssuer.get(issuer),
            reasonCode(evaluation.reason),
            input.tick,
            transitions,
          );
          dispositions.push(
            disposition(
              evidence,
              source.id,
              evaluation.reason,
              "vision-unavailable",
              0,
              "drop",
              null,
            ),
          );
        }
        continue;
      }

      const projections: SourceProjection[] = [];
      const occupiedWorkPositions = new Set<string>();
      for (const source of evaluation.sources) {
        const projection = projectSource(
          evidence,
          source,
          existingByIssuer.get(issuerFor(evidence, source.id)),
          input.policy,
          occupiedWorkPositions,
        );
        if (projection === null) continue;
        projections.push(projection);
        occupiedWorkPositions.add(positionKey(projection.workPosition));
      }
      sourceCount += evaluation.sources.length;
      const aggregate = projections.reduce(
        (total, projection) => ({
          energy: total.energy + bodyEnergy(projection.capability, input.policy),
          spawnTicks: total.spawnTicks + bodySpawnTicks(projection.capability, input.policy),
          cpuMilli: total.cpuMilli + input.policy.cpuMilliPerSource,
          memoryCodeUnits: total.memoryCodeUnits + input.policy.memoryCodeUnitsPerSource,
        }),
        { energy: 0, spawnTicks: 0, cpuMilli: 0, memoryCodeUnits: 0 },
      );
      const portfolioEnough =
        evidence.objective.commitment.energy >= aggregate.energy &&
        evidence.objective.commitment.spawnTicks >= aggregate.spawnTicks &&
        evidence.objective.commitment.cpuMilli >= aggregate.cpuMilli &&
        evidence.objective.commitment.memoryCodeUnits >= aggregate.memoryCodeUnits;
      let remainingCapitalEnergy = Math.max(
        0,
        evidence.objective.commitment.energy - aggregate.energy,
      );
      let remainingCapitalValueEnergy = Math.max(
        0,
        Math.floor(
          (evidence.objective.profit * (evidence.candidate.expiresAt - input.tick)) / 1_000,
        ),
      );
      const objectiveProposalOffset = proposals.length;

      for (const source of evaluation.sources) {
        const issuer = issuerFor(evidence, source.id);
        handledIssuers.add(issuer);
        const existing = existingByIssuer.get(issuer);
        const projection = projections.find((item) => item.source.id === source.id);
        if (issuer.length > 128) {
          stopExisting(existing, "remote-mining-memory-budget", input.tick, transitions);
          dispositions.push(
            disposition(
              evidence,
              source.id,
              "memory-budget",
              "vision-unavailable",
              0,
              projection?.offload ?? "drop",
              projection?.workPosition ?? null,
            ),
          );
          continue;
        }
        const visibleSourceMissing =
          evidence.visibleRoom !== null &&
          evidence.visibleRoom.observedAt === input.tick &&
          !evidence.visibleRoom.sources.some((visible) => visible.id === source.id);
        if (projection === undefined) {
          stopExisting(
            existing,
            visibleSourceMissing
              ? "remote-mining-source-missing"
              : "remote-mining-work-position-unavailable",
            input.tick,
            transitions,
          );
          dispositions.push(
            disposition(
              evidence,
              source.id,
              visibleSourceMissing ? "source-missing" : "invalid-work-position",
              "vision-unavailable",
              0,
              "drop",
              null,
            ),
          );
          continue;
        }
        const spawnTicks = bodySpawnTicks(projection.capability, input.policy);
        const replacementLead =
          evaluation.routeTravelTicks + spawnTicks + input.policy.replacementSafetyTicks;
        if (!portfolioEnough) {
          stopExisting(existing, "remote-mining-portfolio-budget", input.tick, transitions);
          dispositions.push(
            disposition(
              evidence,
              source.id,
              "portfolio-budget",
              infrastructureReason(evidence, projection, input.tick, input.policy),
              replacementLead,
              projection.offload,
              projection.workPosition,
            ),
          );
          continue;
        }
        if (
          evaluation.routeTravelTicks +
            input.policy.minimumOperatingTicks +
            input.policy.replacementSafetyTicks >=
            input.policy.creepLifetime ||
          evidence.candidate.expiresAt - input.tick <=
            replacementLead + input.policy.minimumOperatingTicks
        ) {
          stopExisting(existing, "remote-mining-timeout", input.tick, transitions);
          dispositions.push(
            disposition(
              evidence,
              source.id,
              "timeout",
              "capital-not-profitable",
              replacementLead,
              projection.offload,
              projection.workPosition,
            ),
          );
          continue;
        }

        const budget = miningBudget(
          evidence,
          projection,
          existing,
          input.budgets,
          input.policy,
          input.tick,
        );
        budgets.push(budget);
        const authorization = activeAuthorization(budget, input.budgets);
        let miningReason: RemoteMiningReason;
        if (authorization === null) {
          miningReason = hasActiveAuthorization(budget, input.budgets)
            ? "budget-insufficient"
            : "budget-unavailable";
          stopExisting(existing, "remote-mining-budget-unavailable", input.tick, transitions);
        } else {
          const sequence =
            existing === undefined
              ? authorization.revision
              : Math.max(authorization.revision, (existing.issuerSequence ?? 0) + 1);
          const request = miningContract(
            evidence,
            projection,
            budget,
            sequence,
            evaluation.routeTravelTicks,
            input.tick,
            input.policy,
          );
          if (JSON.stringify(request).length > REMOTE_MINING_LIMITS.maximumContractCodeUnits) {
            miningReason = "memory-budget";
            stopExisting(existing, "remote-mining-memory-budget", input.tick, transitions);
          } else if (existing === undefined) {
            requests.push(request);
            miningReason = "contract-active";
          } else if (!compatible(existing, request)) {
            if (
              cancelExisting(
                existing,
                "remote-mining-route-or-service-replaced",
                input.tick,
                transitions,
              )
            ) {
              requests.push(request);
              miningReason = "contract-active";
            } else miningReason = "transition-limit";
          } else if (existing.state === "proposed") {
            miningReason = appendTransition(
              transitions,
              transition(existing, "funded", "remote-mining-funded", input.tick),
            )
              ? "contract-active"
              : "transition-limit";
          } else if (existing.state === "suspended") {
            const retry = existing.remoteMiningRetry ?? null;
            if (retry === null) {
              miningReason = appendTransition(
                transitions,
                transition(existing, "funded", "remote-mining-work-remains", input.tick),
              )
                ? "contract-active"
                : "transition-limit";
            } else {
              retries += 1;
              if (retry.attempts >= input.policy.maximumCommandAttempts) {
                miningReason = "retry-exhausted";
              } else {
                const delay = Math.min(
                  input.policy.retryMaximumDelayTicks,
                  input.policy.retryInitialDelayTicks * 2 ** Math.max(0, retry.attempts - 1),
                );
                if (input.tick < retry.eligibleAt + delay) miningReason = "retry-wait";
                else
                  miningReason = appendTransition(
                    transitions,
                    transition(existing, "funded", "remote-mining-retry-due", input.tick),
                  )
                    ? "contract-active"
                    : "transition-limit";
              }
            }
          } else miningReason = "contract-active";
        }

        const infrastructure =
          miningReason === "contract-active"
            ? planInfrastructure(
                evidence,
                projection,
                input.tick,
                input.policy,
                input.budgets,
                budgets,
                proposals,
                remainingCapitalEnergy,
                remainingCapitalValueEnergy,
                Math.max(
                  0,
                  REMOTE_MINING_LIMITS.maximumCapitalProposalsPerObjective -
                    (proposals.length - objectiveProposalOffset),
                ),
              )
            : {
                reason: "mining-unavailable" as const,
                reservedEnergy: 0,
                reservedValueEnergy: 0,
              };
        remainingCapitalEnergy = Math.max(
          0,
          remainingCapitalEnergy - infrastructure.reservedEnergy,
        );
        remainingCapitalValueEnergy = Math.max(
          0,
          remainingCapitalValueEnergy - infrastructure.reservedValueEnergy,
        );
        dispositions.push(
          disposition(
            evidence,
            source.id,
            miningReason,
            infrastructure.reason,
            replacementLead,
            projection.offload,
            projection.workPosition,
          ),
        );
      }
    }

    for (const [issuer, existing] of [...existingByIssuer].sort(([left], [right]) =>
      compare(left, right),
    )) {
      if (handledIssuers.has(issuer)) continue;
      stopExisting(existing, "remote-mining-portfolio-unavailable", input.tick, transitions);
      const identity = parseIssuer(issuer);
      dispositions.push({
        infrastructureReason: "portfolio-unavailable",
        miningReason: "portfolio-unavailable",
        offload: "drop",
        replacementLeadTicks: 0,
        roomName: identity?.roomName ?? "unknown",
        sourceId: identity?.sourceId ?? existing.targetId,
        workPosition: existing.execution.version === 5 ? existing.execution.workPosition : null,
      });
    }

    budgets.sort(compareBudget);
    requests.sort((left, right) => compare(left.issuer, right.issuer));
    transitions.sort((left, right) => compare(left.contractId, right.contractId));
    proposals.sort(compareProposal);
    const siteAuthorizations = [
      ...new Map(
        proposals.map((proposal) => [
          `${proposal.colonyId}/${proposal.pos.roomName}`,
          {
            authorized: true as const,
            colonyId: proposal.colonyId,
            roomName: proposal.pos.roomName,
          },
        ]),
      ).values(),
    ].sort(
      (left, right) =>
        compare(left.colonyId, right.colonyId) || compare(left.roomName, right.roomName),
    );
    dispositions.sort(
      (left, right) =>
        compare(left.roomName, right.roomName) || compare(left.sourceId, right.sourceId),
    );
    return freeze({
      status: "ready",
      budgetRequests: budgets,
      contractRequests: requests,
      transitions,
      siteAuthorizations,
      siteProposals: proposals,
      dispositions,
      metrics: metrics(
        objectives.length,
        sourceCount,
        budgets,
        requests,
        transitions,
        proposals,
        dispositions,
        retries,
      ),
    });
  }
}

function evaluateObjective(
  evidence: RemoteMiningObjectiveEvidence,
  tick: number,
  policy: RemoteMiningPolicyV1,
): ObjectiveEvaluation {
  const result = (
    reason: RemoteMiningReason | null,
    sources: readonly RoomIntelSource[] = [],
    routeTravelTicks = 0,
  ): ObjectiveEvaluation => ({ evidence, reason, routeTravelTicks, sources });
  const { candidate, objective } = evidence;
  if (
    objective.roomName !== candidate.roomName ||
    objective.donorColonyId !== candidate.donorColonyId ||
    candidate.expiresAt <= tick ||
    !sameCommitment(objective.commitment, candidate.commitment)
  )
    return result("portfolio-unavailable");
  if (objective.state !== "active") return result("objective-not-active");
  if (candidate.intel.freshness === "stale" || candidate.intel.freshness === "expired")
    return result("intel-stale");
  if (candidate.intel.freshness === "unknown" || candidate.intel.record === null)
    return result("intel-unavailable");
  const record = candidate.intel.record;
  if (record.observedAt > tick || tick - record.observedAt > policy.maximumIntelAgeTicks)
    return result("intel-stale");
  if (candidate.intel.quality !== "complete" || !record.complete) return result("intel-partial");
  const sources = [...record.sources].sort((left, right) => compare(left.id, right.id));
  if (sources.length === 0) return result("source-missing");
  if (
    sources.length > REMOTE_MINING_LIMITS.maximumSourcesPerObjective ||
    sources.some(
      ({ energyCapacity }) =>
        energyCapacity <= 0 || energyCapacity > policy.maximumSourceEnergyCapacity,
    )
  )
    return result("source-unsupported", sources);
  if (!controllerAllowsMining(evidence)) return result("controller-blocked", sources);
  if (candidate.threatRisk > policy.maximumThreatRisk || candidate.donor !== "healthy")
    return result("threat-risk", sources);
  const route = candidate.route.plan;
  if (
    candidate.route.status !== "ready" ||
    route === null ||
    route.originRoomName !== objective.donorColonyId ||
    route.destinationRoomName !== objective.roomName ||
    route.roomNames.length < 1 ||
    route.roomNames.length > REMOTE_MINING_LIMITS.maximumRouteRooms ||
    route.roomNames[route.roomNames.length - 1] !== objective.roomName ||
    route.risk > policy.maximumThreatRisk ||
    route.estimate.outboundTicks <= 0
  )
    return result("route-unavailable", sources);
  return result(null, sources, route.estimate.outboundTicks);
}

function controllerAllowsMining(evidence: RemoteMiningObjectiveEvidence): boolean {
  const { controller } = evidence.candidate;
  const observed = evidence.candidate.intel.record?.controller ?? null;
  if (controller === "available")
    return (
      observed === null ||
      (observed.ownership === "neutral" && observed.reservationTicksToEnd === null)
    );
  if (controller === "self-reserved")
    return (
      observed !== null &&
      observed.ownership === "reserved" &&
      observed.reservationTicksToEnd !== null &&
      observed.reservationTicksToEnd > 0 &&
      observed.reservationUsername !== null
    );
  return false;
}

function sameCommitment(
  left: RemoteMiningObjectiveEvidence["objective"]["commitment"],
  right: RemoteMiningObjectiveEvidence["candidate"]["commitment"],
): boolean {
  return (
    left.energy === right.energy &&
    left.spawnTicks === right.spawnTicks &&
    left.cpuMilli === right.cpuMilli &&
    left.memoryCodeUnits === right.memoryCodeUnits
  );
}

function projectSource(
  evidence: RemoteMiningObjectiveEvidence,
  source: RoomIntelSource,
  existing: ContractPlanningRecord | undefined,
  policy: RemoteMiningPolicyV1,
  occupiedWorkPositions: ReadonlySet<string>,
): SourceProjection | null {
  const intel = evidence.candidate.intel.record;
  if (intel === null || intel.terrain === null) return null;
  const visibleSource = evidence.visibleRoom?.sources.find(({ id }) => id === source.id);
  if (evidence.visibleRoom !== null && visibleSource === undefined) return null;
  const preserved =
    existing?.execution.version === 5 &&
    legalWorkPosition(
      existing.execution.workPosition,
      source,
      intel,
      evidence.visibleRoom,
      occupiedWorkPositions,
    )
      ? existing.execution.workPosition
      : null;
  const workPosition =
    preserved ?? selectWorkPosition(source, intel, evidence.visibleRoom, occupiedWorkPositions);
  if (workPosition === null) return null;
  const work = Math.ceil(
    source.energyCapacity / policy.sourceRegenerationTicks / policy.harvestPower,
  );
  if (work <= 0 || work > 50) return null;
  const capability: CapabilityVector = {
    attack: 0,
    carry: 0,
    claim: 0,
    heal: 0,
    move: work,
    rangedAttack: 0,
    tough: 0,
    work,
  };
  return {
    capability,
    offload: offload(evidence.visibleRoom, intel, workPosition),
    source,
    workPosition,
  };
}

function selectWorkPosition(
  source: RoomIntelSource,
  intel: RoomIntelRecordV1,
  visibleRoom: RoomSnapshot | null,
  occupiedWorkPositions: ReadonlySet<string>,
): PositionSnapshot | null {
  const positions = adjacent(source, intel.roomName).filter((position) =>
    legalWorkPosition(position, source, intel, visibleRoom, occupiedWorkPositions),
  );
  positions.sort((left, right) => {
    const leftContainer = hasContainer(intel, visibleRoom, left) ? 0 : 1;
    const rightContainer = hasContainer(intel, visibleRoom, right) ? 0 : 1;
    return (
      leftContainer - rightContainer ||
      terrainRank(intel, left) - terrainRank(intel, right) ||
      left.y - right.y ||
      left.x - right.x
    );
  });
  return positions[0] ?? null;
}

function legalWorkPosition(
  position: PositionSnapshot,
  source: RoomIntelSource,
  intel: RoomIntelRecordV1,
  visibleRoom: RoomSnapshot | null,
  occupiedWorkPositions: ReadonlySet<string>,
): boolean {
  if (
    position.roomName !== intel.roomName ||
    Math.max(Math.abs(position.x - source.pos.x), Math.abs(position.y - source.pos.y)) !== 1 ||
    position.x <= 0 ||
    position.x >= 49 ||
    position.y <= 0 ||
    position.y >= 49 ||
    terrainAt(intel, position) === "wall" ||
    occupiedWorkPositions.has(positionKey(position))
  )
    return false;
  const structures = (visibleRoom?.structures ?? intel.structures).filter((structure) =>
    samePosition(structure.pos, position),
  );
  if (
    structures.some(
      (structure) =>
        structure.structureType !== "road" &&
        structure.structureType !== "container" &&
        structure.structureType !== "rampart",
    ) ||
    structures.some(
      (structure) =>
        structure.structureType === "rampart" &&
        structure.ownership !== "owned" &&
        structure.isPublic !== true,
    )
  )
    return false;
  return !(
    visibleRoom?.constructionSites.some(
      (site) =>
        samePosition(site.pos, position) &&
        site.structureType !== "container" &&
        site.structureType !== "road",
    ) ?? false
  );
}

function offload(
  visibleRoom: RoomSnapshot | null,
  intel: RoomIntelRecordV1,
  position: PositionSnapshot,
): RemoteMiningOffload {
  const visible = visibleRoom?.storedStructures.find(
    (structure) => structure.structureType === "container" && samePosition(structure.pos, position),
  );
  if (visible !== undefined)
    return visible.store.freeCapacity === 0 ? "container-full-drop" : "container";
  return hasStructure(intel, position, "container") ? "container" : "drop";
}

function miningBudget(
  evidence: RemoteMiningObjectiveEvidence,
  projection: SourceProjection,
  existing: ContractPlanningRecord | undefined,
  entries: readonly RemoteMiningBudgetEntry[],
  policy: RemoteMiningPolicyV1,
  tick: number,
): BudgetRequest {
  const issuer = issuerFor(evidence, projection.source.id);
  const prior = latestBudget(entries, evidence.objective.donorColonyId, issuer);
  const reusable =
    prior !== undefined &&
    (prior.status === "active" || prior.status === "pending") &&
    prior.expiresAt > tick &&
    (existing !== undefined || prior.expiresAt >= evidence.candidate.expiresAt);
  const energy = bodyEnergy(projection.capability, policy);
  return {
    colonyId: evidence.objective.donorColonyId,
    category: "harvesting-filling",
    issuer,
    revision: reusable ? prior.revision : (prior?.revision ?? 0) + 1,
    expiresAt: reusable ? prior.expiresAt : evidence.candidate.expiresAt,
    energy: { minimum: energy, desired: energy },
    cpu: { minimum: policy.cpuMilliPerSource, desired: policy.cpuMilliPerSource },
    spawn: null,
  };
}

function miningContract(
  evidence: RemoteMiningObjectiveEvidence,
  projection: SourceProjection,
  budget: BudgetRequest,
  sequence: number,
  routeTravelTicks: number,
  tick: number,
  policy: RemoteMiningPolicyV1,
): WorkContractRequest {
  const route = evidence.candidate.route.plan;
  if (route === null) throw new Error("validated remote mining route disappeared");
  const execution: ContractExecutionTermsV5 = {
    action: "harvest",
    completion: "continuous",
    counterpartId: null,
    offload: "container-or-drop",
    originRoomName: evidence.objective.donorColonyId,
    resourceType: null,
    routeRoomNames: Object.freeze([...route.roomNames]),
    routeTravelTicks,
    version: 5,
    workPosition: projection.workPosition,
  };
  return freeze({
    budgetBinding: { category: budget.category, issuer: budget.issuer },
    conditions: {
      cancellation: "portfolio-source-or-route-unavailable",
      failure: "bounded-command-retry-exhausted",
      success: "continuous-profitable-extraction",
    },
    deadline: budget.expiresAt - 1,
    earliestStart: tick,
    estimatedWorkTicks: policy.sourceRegenerationTicks,
    execution,
    expiresAt: budget.expiresAt,
    issuer: budget.issuer,
    issuerKey: projection.source.id,
    issuerSequence: sequence,
    kind: "harvest",
    leasePolicy: {
      duration: Math.min(policy.creepLifetime, budget.expiresAt - tick),
      switchingPenalty: routeTravelTicks,
      ttlSafetyMargin: policy.replacementSafetyTicks,
    },
    maxAssignmentCost: routeTravelTicks,
    owner: { id: evidence.objective.donorColonyId, kind: "colony" },
    preconditionKeys: ["active-profitable-remote", "fresh-source", "safe-ready-route"],
    priority: { class: "speculation", value: 700 },
    quantity: policy.sourceRegenerationTicks,
    range: 1,
    requiredCapability: projection.capability,
    target: { roomName: evidence.objective.roomName, ...projection.source.pos },
    targetId: projection.source.id,
  });
}

function planInfrastructure(
  evidence: RemoteMiningObjectiveEvidence,
  projection: SourceProjection,
  tick: number,
  policy: RemoteMiningPolicyV1,
  entries: readonly RemoteMiningBudgetEntry[],
  budgets: BudgetRequest[],
  proposals: LayoutSiteProposal[],
  availableCapitalEnergy: number,
  availableCapitalValueEnergy: number,
  availableProposalSlots: number,
): {
  readonly reason: RemoteMiningReason;
  readonly reservedEnergy: number;
  readonly reservedValueEnergy: number;
} {
  const result = (reason: RemoteMiningReason, reservedEnergy = 0, reservedValueEnergy = 0) => ({
    reason,
    reservedEnergy,
    reservedValueEnergy,
  });
  const room = evidence.visibleRoom;
  if (room === null || room.name !== evidence.objective.roomName || room.observedAt !== tick)
    return result("vision-unavailable");
  const atWork = (position: { readonly x: number; readonly y: number }) =>
    position.x === projection.workPosition.x && position.y === projection.workPosition.y;
  const container = room.storedStructures.find(
    (structure) => structure.structureType === "container" && atWork(structure.pos),
  );
  const containerSite = room.constructionSites.find(
    (site) => site.structureType === "container" && atWork(site.pos),
  );
  if (containerSite !== undefined) return result("container-pending");
  if (container === undefined) {
    if (availableProposalSlots === 0) return result("capital-limit");
    const remainingTicks = evidence.candidate.expiresAt - tick;
    const cost =
      policy.containerBuildEnergy +
      Math.ceil((remainingTicks * policy.containerUpkeepMilliEnergyPerTick) / 1_000);
    if (cost > availableCapitalValueEnergy || cost > availableCapitalEnergy)
      return result("capital-not-profitable");
    const issuer = capitalIssuer(
      evidence,
      projection.source.id,
      "container",
      projection.workPosition,
    );
    const budget = capitalBudget(evidence, issuer, cost, entries, policy, tick);
    budgets.push(budget);
    if (activeAuthorization(budget, entries) === null)
      return result("container-budget-unavailable", cost, cost);
    proposals.push(
      siteProposal(
        evidence,
        projection.source.id,
        projection.workPosition,
        "container",
        0,
        tick,
        policy,
      ),
    );
    return result("container-proposed", cost, cost);
  }

  const routeRevision = evidence.candidate.route.plan?.requestId;
  const roads = evidence.roadCandidates
    .filter(
      (candidate) =>
        candidate.sourceId === projection.source.id &&
        candidate.pos.roomName === evidence.objective.roomName &&
        candidate.routeRevision === routeRevision &&
        evidence.candidate.intel.record !== null &&
        terrainAt(evidence.candidate.intel.record, candidate.pos) === candidate.terrain,
    )
    .sort((left, right) => left.pos.y - right.pos.y || left.pos.x - right.pos.x)
    .slice(0, availableProposalSlots);
  if (roads.length === 0)
    return result(availableProposalSlots === 0 ? "capital-limit" : "road-evidence-unavailable");
  let sawProfitable = false;
  let sawBudget = false;
  let reservedEnergy = 0;
  let reservedValueEnergy = 0;
  const proposalsBefore = proposals.length;
  for (let index = 0; index < roads.length; index += 1) {
    const road = roads[index];
    if (road === undefined) continue;
    if (
      room.structures?.some(
        (structure) => structure.structureType === "road" && samePosition(structure.pos, road.pos),
      ) === true ||
      (evidence.candidate.intel.record !== null &&
        hasStructure(evidence.candidate.intel.record, road.pos, "road")) ||
      room.constructionSites.some((site) => samePosition(site.pos, road.pos))
    )
      continue;
    const buildEnergy =
      road.terrain === "plain" ? policy.roadPlainBuildEnergy : policy.roadSwampBuildEnergy;
    const fatigueSaved = road.terrain === "plain" ? 1 : 9;
    const benefit = road.expectedBodyPartUses * fatigueSaved * policy.roadFatigueValueMilliEnergy;
    if (
      benefit <= buildEnergy * 1_000 ||
      reservedEnergy + buildEnergy > availableCapitalEnergy ||
      reservedValueEnergy + buildEnergy > availableCapitalValueEnergy
    )
      continue;
    sawProfitable = true;
    reservedEnergy += buildEnergy;
    reservedValueEnergy += buildEnergy;
    const issuer = capitalIssuer(evidence, projection.source.id, "road", road.pos);
    const budget = capitalBudget(evidence, issuer, buildEnergy, entries, policy, tick);
    budgets.push(budget);
    if (activeAuthorization(budget, entries) === null) {
      sawBudget = true;
      continue;
    }
    proposals.push(
      siteProposal(evidence, projection.source.id, road.pos, "road", index + 1, tick, policy),
    );
  }
  if (proposals.length > proposalsBefore)
    return result("road-proposed", reservedEnergy, reservedValueEnergy);
  if (sawBudget) return result("road-budget-unavailable", reservedEnergy, reservedValueEnergy);
  return result(
    sawProfitable ? "road-budget-unavailable" : "road-not-profitable",
    reservedEnergy,
    reservedValueEnergy,
  );
}

function capitalBudget(
  evidence: RemoteMiningObjectiveEvidence,
  issuer: string,
  energy: number,
  entries: readonly RemoteMiningBudgetEntry[],
  policy: RemoteMiningPolicyV1,
  tick: number,
): BudgetRequest {
  const prior = latestBudget(entries, evidence.objective.donorColonyId, issuer);
  const reusable =
    prior !== undefined &&
    (prior.status === "active" || prior.status === "pending") &&
    prior.expiresAt > tick;
  return {
    colonyId: evidence.objective.donorColonyId,
    category: "optional-growth",
    issuer,
    revision: reusable ? prior.revision : (prior?.revision ?? 0) + 1,
    expiresAt: reusable ? prior.expiresAt : evidence.candidate.expiresAt,
    energy: { minimum: energy, desired: energy },
    cpu: { minimum: policy.infrastructureCpuMilli, desired: policy.infrastructureCpuMilli },
    spawn: null,
  };
}

function siteProposal(
  evidence: RemoteMiningObjectiveEvidence,
  sourceId: string,
  pos: PositionSnapshot,
  structureType: "container" | "road",
  order: number,
  tick: number,
  policy: RemoteMiningPolicyV1,
): LayoutSiteProposal {
  const routeRevision = evidence.candidate.route.plan?.requestId ?? "unavailable";
  const remoteAuthorization =
    evidence.candidate.controller === "available"
      ? { controller: "neutral" as const, reservationUsername: null }
      : {
          controller: "self-reserved" as const,
          reservationUsername:
            evidence.candidate.intel.record?.controller?.reservationUsername ?? null,
        };
  return freeze({
    colonyId: evidence.objective.donorColonyId,
    layoutFingerprint: `remote-mining:${String(evidence.objective.revision)}:${opaque(`${routeRevision}/${sourceId}/${structureType}/${String(pos.y)}:${String(pos.x)}`)}`,
    observationFingerprint: capitalObservationFingerprint(evidence.visibleRoom, pos, tick),
    placementOrder: order,
    policyFingerprint: policy.revision,
    policyPriority: 1_000,
    pos: { ...pos },
    stableId: `remote-site-v1:${evidence.objective.roomName}:${opaque(sourceId)}:${structureType}:${String(pos.y)}:${String(pos.x)}`,
    structureType,
    remoteAuthorization,
  });
}

function capitalObservationFingerprint(
  room: RoomSnapshot | null,
  pos: PositionSnapshot,
  tick: number,
): string {
  if (room === null) return `remote-observation:unavailable:${String(tick)}`;
  const occupants = [
    ...(room.structures ?? [])
      .filter((structure) => samePosition(structure.pos, pos))
      .map((structure) => `s:${structure.structureType}:${structure.id}`),
    ...room.constructionSites
      .filter((site) => samePosition(site.pos, pos))
      .map((site) => `c:${site.structureType}:${site.id}`),
  ].sort(compare);
  return `remote-observation:${opaque(`${room.name}/${room.traversal?.revision ?? "unavailable"}/${occupants.join("/")}`)}`;
}

function activeAuthorization(
  request: BudgetRequest,
  entries: readonly RemoteMiningBudgetEntry[],
): RemoteMiningBudgetEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.category === request.category &&
        entry.colonyId === request.colonyId &&
        entry.issuer === request.issuer &&
        entry.revision === request.revision &&
        entry.expiresAt >= request.expiresAt &&
        entry.status === "active" &&
        entry.grant !== null &&
        entry.grant.energy >= (request.energy?.minimum ?? 0) &&
        entry.grant.cpu >= (request.cpu?.minimum ?? 0),
    ) ?? null
  );
}

function hasActiveAuthorization(
  request: BudgetRequest,
  entries: readonly RemoteMiningBudgetEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.category === request.category &&
      entry.colonyId === request.colonyId &&
      entry.issuer === request.issuer &&
      entry.revision === request.revision &&
      entry.status === "active",
  );
}

function latestBudget(
  entries: readonly RemoteMiningBudgetEntry[],
  colonyId: string,
  issuer: string,
): RemoteMiningBudgetEntry | undefined {
  return entries
    .filter((entry) => entry.colonyId === colonyId && entry.issuer === issuer)
    .sort((left, right) => right.revision - left.revision)[0];
}

function existingMiningContracts(
  contracts: readonly ContractPlanningRecord[],
): Map<string, ContractPlanningRecord> | null {
  const result = new Map<string, ContractPlanningRecord>();
  for (const contract of contracts) {
    if (!contract.issuer.startsWith(ISSUER_PREFIX)) continue;
    if (result.has(contract.issuer)) return null;
    result.set(contract.issuer, contract);
  }
  return result;
}

function existingSourcesForObjective(
  existing: ReadonlyMap<string, ContractPlanningRecord>,
  evidence: RemoteMiningObjectiveEvidence,
): readonly RoomIntelSource[] {
  const prefix = `${ISSUER_PREFIX}${evidence.objective.donorColonyId}/${evidence.objective.roomName}/`;
  return [...existing]
    .filter(([issuer]) => issuer.startsWith(prefix))
    .map(([, contract]) => ({ energyCapacity: 0, id: contract.targetId, pos: { x: 0, y: 0 } }));
}

function compatible(existing: ContractPlanningRecord, desired: WorkContractRequest): boolean {
  const current = existing.execution;
  const next = desired.execution;
  return (
    current.version === 5 &&
    next?.version === 5 &&
    existing.targetId === desired.targetId &&
    existing.owner.kind === "colony" &&
    existing.owner.id === desired.owner.id &&
    current.originRoomName === next.originRoomName &&
    current.routeTravelTicks === next.routeTravelTicks &&
    samePosition(current.workPosition, next.workPosition) &&
    arraysEqual(current.routeRoomNames, next.routeRoomNames)
  );
}

function stopExisting(
  existing: ContractPlanningRecord | undefined,
  reason: string,
  tick: number,
  transitions: ContractTransitionRequest[],
): boolean {
  if (existing === undefined || existing.state === "suspended") return true;
  return appendTransition(
    transitions,
    transition(existing, existing.state === "proposed" ? "cancelled" : "suspended", reason, tick),
  );
}
function cancelExisting(
  existing: ContractPlanningRecord,
  reason: string,
  tick: number,
  transitions: ContractTransitionRequest[],
): boolean {
  return appendTransition(transitions, transition(existing, "cancelled", reason, tick));
}
function appendTransition(
  transitions: ContractTransitionRequest[],
  request: ContractTransitionRequest,
): boolean {
  if (transitions.length >= REMOTE_MINING_LIMITS.maximumTransitionsPerTick) return false;
  transitions.push(request);
  return true;
}
function transition(
  existing: ContractPlanningRecord,
  to: ContractTransitionRequest["to"],
  reason: string,
  tick: number,
): ContractTransitionRequest {
  return { contractId: existing.contractId, reason, tick, to };
}

function issuerFor(evidence: RemoteMiningObjectiveEvidence, sourceId: string): string {
  return `${ISSUER_PREFIX}${evidence.objective.donorColonyId}/${evidence.objective.roomName}/${sourceId}`;
}
function capitalIssuer(
  evidence: RemoteMiningObjectiveEvidence,
  sourceId: string,
  kind: "container" | "road",
  pos: PositionSnapshot,
): string {
  return `${CAPITAL_PREFIX}${evidence.objective.donorColonyId}/${evidence.objective.roomName}/${opaque(sourceId)}/${kind}/${String(pos.y)}:${String(pos.x)}`;
}
function parseIssuer(
  issuer: string,
): { readonly roomName: string; readonly sourceId: string } | null {
  const parts = issuer.split("/");
  return parts.length >= 5 && parts[0] === "remote-mining"
    ? { roomName: parts[2] ?? "unknown", sourceId: parts.slice(3).join("/") }
    : null;
}

function bodyEnergy(capability: CapabilityVector, policy: RemoteMiningPolicyV1): number {
  return capability.work * policy.workPartEnergy + capability.move * policy.movePartEnergy;
}
function bodySpawnTicks(capability: CapabilityVector, policy: RemoteMiningPolicyV1): number {
  return (capability.work + capability.move) * policy.spawnTicksPerPart;
}
function adjacent(source: RoomIntelSource, roomName: string): PositionSnapshot[] {
  const positions: PositionSnapshot[] = [];
  for (let y = source.pos.y - 1; y <= source.pos.y + 1; y += 1)
    for (let x = source.pos.x - 1; x <= source.pos.x + 1; x += 1)
      if (x !== source.pos.x || y !== source.pos.y) positions.push({ roomName, x, y });
  return positions;
}
function terrainAt(intel: RoomIntelRecordV1, pos: PositionSnapshot): "plain" | "swamp" | "wall" {
  const cell = intel.terrain?.cells[pos.y * 50 + pos.x];
  return cell === "1" ? "wall" : cell === "2" ? "swamp" : "plain";
}
function terrainRank(intel: RoomIntelRecordV1, pos: PositionSnapshot): number {
  return terrainAt(intel, pos) === "plain" ? 0 : 1;
}
function hasContainer(
  intel: RoomIntelRecordV1,
  visibleRoom: RoomSnapshot | null,
  pos: PositionSnapshot,
): boolean {
  return (
    visibleRoom?.storedStructures.some(
      (structure) => structure.structureType === "container" && samePosition(structure.pos, pos),
    ) ?? hasStructure(intel, pos, "container")
  );
}
function hasStructure(intel: RoomIntelRecordV1, pos: PositionSnapshot, type: string): boolean {
  return intel.structures.some(
    (structure) => structure.structureType === type && samePosition(structure.pos, pos),
  );
}
function samePosition(
  left: { readonly roomName?: string; readonly x: number; readonly y: number },
  right: { readonly roomName?: string; readonly x: number; readonly y: number },
): boolean {
  return (
    (left.roomName === undefined ||
      right.roomName === undefined ||
      left.roomName === right.roomName) &&
    left.x === right.x &&
    left.y === right.y
  );
}
function positionKey(position: PositionSnapshot): string {
  return `${position.roomName}:${String(position.y)}:${String(position.x)}`;
}
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function infrastructureReason(
  evidence: RemoteMiningObjectiveEvidence,
  projection: SourceProjection,
  tick: number,
  policy: RemoteMiningPolicyV1,
): RemoteMiningReason {
  if (evidence.visibleRoom === null || evidence.visibleRoom.observedAt !== tick)
    return "vision-unavailable";
  if (projection.offload !== "drop") return "container-active";
  const remaining = evidence.candidate.expiresAt - tick;
  const cost =
    policy.containerBuildEnergy +
    Math.ceil((remaining * policy.containerUpkeepMilliEnergyPerTick) / 1_000);
  return Math.floor((evidence.objective.profit * remaining) / 1_000) > cost
    ? "container-budget-unavailable"
    : "capital-not-profitable";
}
function disposition(
  evidence: RemoteMiningObjectiveEvidence,
  sourceId: string,
  miningReason: RemoteMiningReason,
  infrastructure: RemoteMiningReason,
  replacementLeadTicks: number,
  offloadState: RemoteMiningOffload,
  workPosition: PositionSnapshot | null,
): RemoteMiningDisposition {
  return {
    infrastructureReason: infrastructure,
    miningReason,
    offload: offloadState,
    replacementLeadTicks,
    roomName: evidence.objective.roomName,
    sourceId,
    workPosition,
  };
}
function reasonCode(reason: RemoteMiningReason): string {
  return `remote-mining-${reason}`;
}
function compareObjective(
  left: RemoteMiningObjectiveEvidence,
  right: RemoteMiningObjectiveEvidence,
): number {
  return (
    compare(left.objective.roomName, right.objective.roomName) ||
    compare(left.objective.donorColonyId, right.objective.donorColonyId)
  );
}
function compareBudget(left: BudgetRequest, right: BudgetRequest): number {
  return compare(left.colonyId, right.colonyId) || compare(left.issuer, right.issuer);
}
function compareProposal(left: LayoutSiteProposal, right: LayoutSiteProposal): number {
  return (
    left.policyPriority - right.policyPriority ||
    compare(left.colonyId, right.colonyId) ||
    left.placementOrder - right.placementOrder ||
    compare(left.stableId, right.stableId)
  );
}
function metrics(
  objectives: number,
  sources: number,
  budgets: readonly BudgetRequest[],
  requests: readonly WorkContractRequest[],
  transitions: readonly ContractTransitionRequest[],
  proposals: readonly LayoutSiteProposal[],
  dispositions: readonly RemoteMiningDisposition[],
  retries: number,
): RemoteMiningMetrics {
  return {
    objectives,
    sources,
    budgeted: budgets.length,
    contracts: requests.length,
    suspended: transitions.filter(({ to }) => to === "suspended").length,
    capitalProposals: proposals.length,
    dropFallbacks: dispositions.filter(({ offload }) => offload !== "container").length,
    retries,
  };
}
function emptyPlan(status: RemoteMiningPlan["status"]): RemoteMiningPlan {
  return freeze({
    status,
    budgetRequests: [],
    contractRequests: [],
    transitions: [],
    siteAuthorizations: [],
    siteProposals: [],
    dispositions: [],
    metrics: {
      objectives: 0,
      sources: 0,
      budgeted: 0,
      contracts: 0,
      suspended: 0,
      capitalProposals: 0,
      dropFallbacks: 0,
      retries: 0,
    },
  });
}
function validInput(input: RemoteMiningPlanInput): boolean {
  return (
    nonnegative(input.tick) &&
    Array.isArray(input.objectives) &&
    input.objectives.every(
      (evidence: RemoteMiningObjectiveEvidence) =>
        Array.isArray(evidence.roadCandidates) &&
        evidence.roadCandidates.every(
          (candidate: RemoteMiningObjectiveEvidence["roadCandidates"][number]) =>
            positive(candidate.expectedBodyPartUses) &&
            candidate.expectedBodyPartUses <=
              REMOTE_MINING_LIMITS.maximumRoadExpectedBodyPartUses &&
            candidate.routeRevision.length > 0 &&
            candidate.routeRevision.length <= 128 &&
            candidate.sourceId.length > 0 &&
            candidate.sourceId.length <= 128 &&
            validPosition(candidate.pos),
        ) &&
        (evidence.visibleRoom === null ||
          evidence.visibleRoom.name === evidence.objective.roomName),
    ) &&
    Array.isArray(input.budgets) &&
    input.budgets.every(validBudget) &&
    validPolicy(input.policy)
  );
}
function validPosition(position: PositionSnapshot): boolean {
  return (
    /^(W|E)\d+(N|S)\d+$/u.test(position.roomName) &&
    nonnegative(position.x) &&
    position.x <= 49 &&
    nonnegative(position.y) &&
    position.y <= 49
  );
}
function validBudget(entry: RemoteMiningBudgetEntry): boolean {
  return (
    entry.category.length > 0 &&
    entry.colonyId.length > 0 &&
    entry.issuer.length > 0 &&
    nonnegative(entry.revision) &&
    nonnegative(entry.expiresAt) &&
    ["active", "pending", "consumed", "released", "expired"].includes(entry.status) &&
    (entry.grant === null || (nonnegative(entry.grant.energy) && nonnegative(entry.grant.cpu)))
  );
}
function validPolicy(policy: RemoteMiningPolicyV1): boolean {
  return (
    policy.revision.length > 0 &&
    policy.sourceRegenerationTicks === 300 &&
    policy.harvestPower === 2 &&
    policy.maximumSourceEnergyCapacity === 3_000 &&
    policy.workPartEnergy === 100 &&
    policy.movePartEnergy === 50 &&
    policy.spawnTicksPerPart === 3 &&
    policy.creepLifetime === 1_500 &&
    positive(policy.replacementSafetyTicks) &&
    positive(policy.minimumOperatingTicks) &&
    positive(policy.cpuMilliPerSource) &&
    positive(policy.memoryCodeUnitsPerSource) &&
    positive(policy.maximumIntelAgeTicks) &&
    nonnegative(policy.maximumThreatRisk) &&
    positive(policy.maximumCommandAttempts) &&
    positive(policy.retryInitialDelayTicks) &&
    positive(policy.retryMaximumDelayTicks) &&
    policy.containerBuildEnergy === 5_000 &&
    positive(policy.containerUpkeepMilliEnergyPerTick) &&
    positive(policy.infrastructureCpuMilli) &&
    policy.roadPlainBuildEnergy === 300 &&
    policy.roadSwampBuildEnergy === 1_500 &&
    positive(policy.roadFatigueValueMilliEnergy)
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function opaque(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
