import {
  contractIdFor,
  type CapabilityVector,
  type ContractExecutionTermsV3,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "../contracts";
import type {
  LogisticsNode,
  LogisticsPlan,
  LogisticsPriorityClass,
  LogisticsProjection,
} from "./planner";

export const MAX_LOGISTICS_COMMITMENTS = 128;

export type LogisticsAcquireAction = "pickup" | "withdraw";
export type LogisticsCommitmentStage = "acquire" | "deliver";
export type LogisticsActorState = "alive" | "dead" | "lease-expired" | "unleased";
export type LogisticsCommitmentReason =
  | "active"
  | "actor-dead"
  | "complete"
  | "duplicate-flow"
  | "lease-expired"
  | "planner-not-admitted"
  | "resource-mismatch"
  | "sink-full"
  | "sink-vanished"
  | "source-empty"
  | "source-vanished";

export interface LogisticsContractEndpoint {
  readonly acquireAction?: LogisticsAcquireAction;
  readonly freeCapacity: number;
  readonly nodeId: string;
  readonly observedAmount: number;
  readonly observedAt: number;
  readonly position: { readonly roomName: string; readonly x: number; readonly y: number };
  readonly resourceType: string;
  readonly targetId: string | null;
}

export interface LogisticsFlowProgress {
  readonly actorState: LogisticsActorState;
  readonly cargoAmount: number;
  readonly deliveredAmount: number;
  readonly flowId: string;
}

export interface LogisticsCommitmentState {
  readonly colonyId: string;
  readonly cycle: number;
  readonly cycleAmount: number;
  readonly deliveredAmount: number;
  readonly flowId: string;
  readonly priorityClass: LogisticsPriorityClass;
  readonly recommendedCarry: number;
  readonly recommendedMove: number;
  readonly reservedAmount: number;
  readonly resourceType: string;
  readonly roundTripTicks: number;
  readonly sinkNodeId: string;
  readonly sourceNodeId: string;
  readonly stage: LogisticsCommitmentStage;
  readonly stageStartedAt: number;
}

export interface LogisticsCommitmentProjection extends LogisticsCommitmentState {
  readonly reason: LogisticsCommitmentReason;
  readonly request: WorkContractRequest | null;
}

export interface LogisticsContractProjectionInput {
  readonly endpoints: readonly LogisticsContractEndpoint[];
  readonly nodes: readonly LogisticsNode[];
  readonly plan: LogisticsPlan;
  readonly previous: readonly LogisticsCommitmentState[];
  readonly progress: readonly LogisticsFlowProgress[];
  readonly tick: number;
}

export interface LogisticsContractProjection {
  readonly commitments: readonly LogisticsCommitmentProjection[];
  readonly retirements: readonly ContractTransitionRequest[];
}

/** Pure projection from admitted flows to one current acquire-or-deliver contract per flow. */
export function projectLogisticsContracts(
  input: LogisticsContractProjectionInput,
): LogisticsContractProjection {
  const endpoints = uniqueMap(input.endpoints, ({ nodeId }) => nodeId);
  const nodes = uniqueMap(input.nodes, ({ id }) => id);
  const progress = uniqueMap(input.progress, ({ flowId }) => flowId);
  const previousCounts = counts(input.previous, ({ flowId }) => flowId);
  const previous = new Map(
    [...input.previous]
      .sort((left, right) => left.flowId.localeCompare(right.flowId))
      .filter(({ flowId }) => previousCounts.get(flowId) === 1)
      .map((state) => [state.flowId, state]),
  );
  const admitted = input.plan.projections
    .filter((flow) => flow.blocker === null && flow.admittedAmount > 0)
    .sort((left, right) => compareFlows(left, right, nodes));
  const admittedById = uniqueMap(admitted, ({ id }) => id);
  const recommendations = allocateRecommendations(admitted, input.plan);
  const flowIds = [...new Set([...previous.keys(), ...admittedById.keys()])]
    .sort()
    .slice(0, MAX_LOGISTICS_COMMITMENTS);
  const commitments: LogisticsCommitmentProjection[] = [];
  const retirements: ContractTransitionRequest[] = [];

  for (const flowId of flowIds) {
    const old = previous.get(flowId);
    const flow = admittedById.get(flowId);
    if (old === undefined && flow === undefined) continue;
    if ((previousCounts.get(flowId) ?? 0) > 1) {
      if (old !== undefined) commitments.push({ ...old, reason: "duplicate-flow", request: null });
      continue;
    }
    const source = endpoints.get(old?.sourceNodeId ?? flow?.sourceNodeId ?? "");
    const sink = endpoints.get(old?.sinkNodeId ?? flow?.sinkNodeId ?? "");
    const observed = progress.get(flowId);
    const deliveredAmount = Math.min(
      old?.reservedAmount ?? flow?.admittedAmount ?? 0,
      Math.max(old?.deliveredAmount ?? 0, observed?.deliveredAmount ?? 0),
    );
    const cargoAmount = Math.min(
      Math.max(0, (old?.reservedAmount ?? flow?.admittedAmount ?? 0) - deliveredAmount),
      Math.max(0, observed?.cargoAmount ?? 0),
    );
    let state =
      old ??
      createState(
        flow as LogisticsProjection,
        recommendations.get(flowId),
        nodes.get((flow as LogisticsProjection).sinkNodeId)?.priority.class ?? "normal",
        input.tick,
      );
    if (deliveredAmount >= state.reservedAmount) {
      if (old !== undefined)
        retirements.push(retirement(old, input.tick, "logistics-flow-complete", "completed"));
      commitments.push({ ...state, deliveredAmount, reason: "complete", request: null });
      continue;
    }
    const nextStage: LogisticsCommitmentStage = cargoAmount > 0 ? "deliver" : "acquire";
    const stageChanged = old !== undefined && old.stage !== nextStage;
    const lostDelivery =
      old?.stage === "deliver" && nextStage === "acquire" && deliveredAmount < old.reservedAmount;
    if (stageChanged) {
      retirements.push(
        retirement(
          old,
          input.tick,
          observed?.actorState === "dead" ? "logistics-actor-died" : "logistics-stage-complete",
          observed?.actorState === "dead" ? "failed" : "completed",
        ),
      );
    }
    const cycle = state.cycle + (lostDelivery ? 1 : 0);
    const stageStartedAt = stageChanged || lostDelivery ? input.tick : state.stageStartedAt;
    const cycleAmount = lostDelivery ? state.reservedAmount - deliveredAmount : state.cycleAmount;
    state = { ...state, cycle, cycleAmount, deliveredAmount, stage: nextStage, stageStartedAt };
    const reason = blocker(state, flow, source, sink, observed, input.tick);
    if (
      old !== undefined &&
      !stageChanged &&
      [
        "planner-not-admitted",
        "resource-mismatch",
        "sink-full",
        "sink-vanished",
        "source-empty",
        "source-vanished",
      ].includes(reason)
    ) {
      const completed = reason === "source-empty" || reason === "sink-full";
      retirements.push(
        retirement(old, input.tick, `logistics-${reason}`, completed ? "completed" : "failed"),
      );
    }
    commitments.push({
      ...state,
      reason,
      request:
        reason === "active" || reason === "actor-dead" || reason === "lease-expired"
          ? requestFor(
              state,
              source as LogisticsContractEndpoint,
              sink as LogisticsContractEndpoint,
            )
          : null,
    });
  }
  return freeze({
    commitments,
    retirements: retirements.sort((a, b) => a.contractId.localeCompare(b.contractId)),
  });
}

function createState(
  flow: LogisticsProjection,
  recommendation: { carry: number; move: number } | undefined,
  priorityClass: LogisticsPriorityClass,
  tick: number,
): LogisticsCommitmentState {
  return {
    colonyId: flow.colonyId ?? "",
    cycle: 0,
    cycleAmount: flow.admittedAmount,
    deliveredAmount: 0,
    flowId: flow.id,
    priorityClass,
    recommendedCarry: recommendation?.carry ?? 0,
    recommendedMove: recommendation?.move ?? 0,
    reservedAmount: flow.admittedAmount,
    resourceType: flow.resourceType ?? "",
    roundTripTicks: flow.roundTripTicks,
    sinkNodeId: flow.sinkNodeId,
    sourceNodeId: flow.sourceNodeId,
    stage: "acquire",
    stageStartedAt: tick,
  };
}

function blocker(
  state: LogisticsCommitmentState,
  flow: LogisticsProjection | undefined,
  source: LogisticsContractEndpoint | undefined,
  sink: LogisticsContractEndpoint | undefined,
  progress: LogisticsFlowProgress | undefined,
  tick: number,
): LogisticsCommitmentReason {
  if (source === undefined || source.targetId === null || source.observedAt !== tick)
    return "source-vanished";
  if (sink === undefined || sink.targetId === null || sink.observedAt !== tick)
    return "sink-vanished";
  if (source.resourceType !== state.resourceType || sink.resourceType !== state.resourceType)
    return "resource-mismatch";
  if (state.stage === "acquire" && source.observedAmount <= 0) return "source-empty";
  if (state.stage === "deliver" && sink.freeCapacity <= 0) return "sink-full";
  if (flow === undefined && state.stage === "acquire") return "planner-not-admitted";
  if (progress?.actorState === "dead") return "actor-dead";
  if (progress?.actorState === "lease-expired") return "lease-expired";
  return "active";
}

function requestFor(
  state: LogisticsCommitmentState,
  source: LogisticsContractEndpoint,
  sink: LogisticsContractEndpoint,
): WorkContractRequest {
  const acquire = state.stage === "acquire";
  const endpoint = acquire ? source : sink;
  const counterpart = acquire ? sink : source;
  const action = acquire ? (source.acquireAction ?? "withdraw") : "transfer";
  const execution: ContractExecutionTermsV3 = {
    action,
    completion: acquire ? "target-depleted" : "target-full",
    counterpartId: counterpart.targetId as string,
    flowId: state.flowId,
    recommendedCarry: state.recommendedCarry,
    recommendedMove: state.recommendedMove,
    reservedAmount: state.cycleAmount,
    resourceType: state.resourceType as ResourceConstant,
    stage: state.stage,
    version: 3,
  };
  const mandatory = state.priorityClass === "mandatory";
  const identity = flowIssuer(state.flowId);
  return {
    budgetBinding: {
      category: mandatory ? "harvesting-filling" : "optional-growth",
      issuer: `${identity}/${String(state.cycle)}/${state.stage}`,
    },
    conditions: {
      cancellation: "endpoint-invalid",
      failure: "bounded-retry",
      success: "stage-complete",
    },
    deadline: state.stageStartedAt + Math.max(1, state.roundTripTicks) + 50,
    earliestStart: state.stageStartedAt,
    estimatedWorkTicks: Math.max(1, state.roundTripTicks),
    execution,
    expiresAt: state.stageStartedAt + Math.max(1, state.roundTripTicks) + 51,
    issuer: identity,
    issuerKey: `${String(state.cycle)}/${state.stage}`,
    issuerSequence: state.cycle * 2 + (acquire ? 0 : 1),
    kind: "haul",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 3 },
    maxAssignmentCost: Math.max(1, state.roundTripTicks),
    owner: { id: state.colonyId, kind: "colony" },
    preconditionKeys: ["fresh-source-reservation", "fresh-sink-reservation"],
    priority: { class: mandatory ? "survival" : "growth", value: mandatory ? 850 : 350 },
    quantity: state.cycleAmount,
    range: 1,
    requiredCapability: carryMoveCapability(),
    target: { ...endpoint.position },
    targetId: endpoint.targetId,
  };
}

function retirement(
  state: LogisticsCommitmentState,
  tick: number,
  reason: string,
  to: "completed" | "failed",
): ContractTransitionRequest {
  return {
    contractId: contractIdFor(
      flowIssuer(state.flowId),
      `${String(state.cycle)}/${state.stage}`,
      state.cycle * 2 + (state.stage === "acquire" ? 0 : 1),
    ),
    reason,
    tick,
    to,
  };
}

function allocateRecommendations(
  flows: readonly LogisticsProjection[],
  plan: LogisticsPlan,
): ReadonlyMap<string, { carry: number; move: number }> {
  const result = new Map(flows.map(({ id }) => [id, { carry: 0, move: 0 }]));
  for (const recommendation of plan.recommendations) {
    const colonyFlows = flows.filter(({ colonyId }) => colonyId === recommendation.colonyId);
    for (let slot = 0; slot < recommendation.carry; slot += 1) {
      const flow = colonyFlows[slot % Math.max(1, colonyFlows.length)];
      if (flow !== undefined) (result.get(flow.id) as { carry: number; move: number }).carry += 1;
    }
    for (let slot = 0; slot < recommendation.move; slot += 1) {
      const flow = colonyFlows[slot % Math.max(1, colonyFlows.length)];
      if (flow !== undefined) (result.get(flow.id) as { carry: number; move: number }).move += 1;
    }
  }
  return result;
}

function compareFlows(
  left: LogisticsProjection,
  right: LogisticsProjection,
  nodes: ReadonlyMap<string, LogisticsNode>,
): number {
  return (
    priority(nodes.get(left.sinkNodeId)?.priority.class) -
      priority(nodes.get(right.sinkNodeId)?.priority.class) || left.id.localeCompare(right.id)
  );
}
function priority(value: LogisticsPriorityClass | undefined): number {
  return value === "mandatory" ? 0 : 1;
}
function flowIssuer(flowId: string): string {
  return `logistics/${hash(flowId)}`;
}
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function carryMoveCapability(): CapabilityVector {
  return { attack: 0, carry: 1, claim: 0, heal: 0, move: 1, rangedAttack: 0, tough: 0, work: 0 };
}
function counts<T>(values: readonly T[], key: (value: T) => string): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    const id = key(value);
    result.set(id, (result.get(id) ?? 0) + 1);
  }
  return result;
}
function uniqueMap<T>(values: readonly T[], key: (value: T) => string): ReadonlyMap<string, T> {
  const itemCounts = counts(values, key);
  return new Map(
    [...values]
      .sort((a, b) => key(a).localeCompare(key(b)))
      .filter((value) => itemCounts.get(key(value)) === 1)
      .map((value) => [key(value), value]),
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
