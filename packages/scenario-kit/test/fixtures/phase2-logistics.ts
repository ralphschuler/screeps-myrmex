import {
  planLogistics,
  projectLogisticsContracts,
  type LogisticsCommitmentProjection,
  type LogisticsCommitmentState,
  type LogisticsContractEndpoint,
  type LogisticsEdge,
  type LogisticsFlowProgress,
  type LogisticsNode,
} from "../../../bot/src/logistics";
import {
  reduceLogisticsTelemetry,
  type LogisticsFlowObservation,
} from "../../../bot/src/telemetry";
import { canonicalSerialize } from "../../src";

const ROOM = "W1N1";
const TICK = 1_000;
const MAXIMUM_NODE_AGE = 1;
const PLANNING_HORIZON = 20;
const TELEMETRY_FLOW_CAP = 8;

const NODES: readonly LogisticsNode[] = Object.freeze([
  node("container/source/energy", "source", "energy", 300, 0, "normal", 10, 10),
  node("drop/source/energy", "source", "energy", 50, 0, "normal", 12, 10),
  node("extension/sink/energy", "sink", "energy", 0, 50, "mandatory", 20, 20),
  node("factory/sink/O", "sink", "O", 0, 30, "normal", 24, 20),
  node("lab/sink/H", "sink", "H", 0, 40, "normal", 23, 20),
  node("ruin/source/O", "source", "O", 30, 0, "normal", 14, 10),
  node("spawn/sink/energy", "sink", "energy", 0, 200, "mandatory", 19, 20),
  node("storage/buffer/energy", "buffer", "energy", 400, 600, "normal", 21, 20),
  node("terminal/sink/energy", "sink", "energy", 0, 100, "normal", 22, 20),
  node("tombstone/source/H", "source", "H", 40, 0, "normal", 13, 10),
]);

const EDGES: readonly LogisticsEdge[] = Object.freeze([
  edge("flow/container-extension", "container/source/energy", "extension/sink/energy", 4),
  edge("flow/container-spawn", "container/source/energy", "spawn/sink/energy", 6),
  edge("flow/container-storage", "container/source/energy", "storage/buffer/energy", 8),
  edge("flow/drop-storage", "drop/source/energy", "storage/buffer/energy", 4),
  edge("flow/ruin-factory", "ruin/source/O", "factory/sink/O", 8),
  edge("flow/storage-terminal", "storage/buffer/energy", "terminal/sink/energy", 10),
  edge("flow/tombstone-lab", "tombstone/source/H", "lab/sink/H", 6),
]);

export function collectLogisticsEvidence() {
  const warm = runVariant(false, false);
  const reset = runVariant(true, false);
  const reordered = runVariant(true, true);
  const equivalent =
    canonicalSerialize(warm.semantic) === canonicalSerialize(reset.semantic) &&
    canonicalSerialize(reset.semantic) === canonicalSerialize(reordered.semantic);
  const pressure = pressureOutcome();
  const recovery = recoveryOutcome();
  const telemetry = telemetryOutcome(reset.plan.projections.map(({ id }) => id));

  return Object.freeze({
    schemaVersion: 1,
    issue: 47,
    status: "complete",
    deterministicScenario: {
      admittedFlowOrder: reset.semantic.flowOrder,
      boundedWork: {
        edgeCount: EDGES.length,
        nodeCount: NODES.length,
        telemetryFlowCap: TELEMETRY_FLOW_CAP,
      },
      equivalentAfterWarmResetAndReorder: equivalent,
      haulerDemand: reset.semantic.haulerDemand,
      mandatoryUnderPressure: pressure,
      noDoubleReservation: reset.semantic.noDoubleReservation,
      observedEndpoints: [
        "container",
        "drop",
        "extension",
        "factory",
        "lab",
        "ruin",
        "spawn",
        "storage",
        "terminal",
        "tombstone",
      ],
      reservations: reset.semantic.reservations,
    },
    recovery,
    telemetry,
    boundaries: {
      commandsIssued: 0,
      nonGoals: ["#48 link commands", "#49 container repair", "terminal sends", "market"],
      observerOnly: telemetry.planUnchanged,
    },
  });
}

function runVariant(reset: boolean, reorder: boolean) {
  const nodes = reorder ? [...NODES].reverse() : NODES;
  const edges = reorder ? [...EDGES].reverse() : EDGES;
  let logisticsPlan = plan(nodes, edges);
  let previous: readonly LogisticsCommitmentState[] = [];
  if (reset) {
    logisticsPlan = roundTrip(logisticsPlan);
    previous = roundTrip(previous);
  }
  const contracts = projectLogisticsContracts({
    endpoints: endpoints(nodes),
    nodes,
    plan: logisticsPlan,
    previous,
    progress: [],
    tick: TICK,
  });
  const body = logisticsPlan.recommendations[0];
  const repeated = [
    logisticsPlan,
    planLogistics(input(nodes, edges)),
    planLogistics(input(nodes, edges)),
  ];
  return {
    plan: logisticsPlan,
    semantic: {
      contractIds: contracts.commitments.map(({ request }) => request?.issuer ?? null),
      flowOrder: contracts.commitments.map(({ flowId }) => flowId),
      haulerDemand: {
        admittedAmount: body?.admittedAmount ?? 0,
        carry: body?.carry ?? 0,
        converged: repeated.every(
          ({ recommendations }) =>
            recommendations[0]?.carry === body?.carry && recommendations[0]?.move === body?.move,
        ),
        move: body?.move ?? 0,
      },
      noDoubleReservation: reservationBounds(logisticsPlan, nodes),
      reservations: logisticsPlan.reservations,
    },
  };
}

function pressureOutcome() {
  const mandatorySinkIds = new Set(["extension/sink/energy", "spawn/sink/energy"]);
  const edges = EDGES.filter(({ sinkNodeId }) => mandatorySinkIds.has(sinkNodeId));
  const constrained = plan(NODES, edges);
  return {
    admittedAmount: constrained.recommendations[0]?.admittedAmount ?? 0,
    admittedFlows: constrained.projections
      .filter(({ admittedAmount }) => admittedAmount > 0)
      .map(({ id }) => id),
    carry: constrained.recommendations[0]?.carry ?? 0,
    optionalFlowsScheduled: constrained.projections.filter(
      ({ sinkNodeId, admittedAmount }) => admittedAmount > 0 && !mandatorySinkIds.has(sinkNodeId),
    ).length,
    protectedRecoveryEnergy: 300,
  };
}

function recoveryOutcome() {
  const initialPlan = plan(NODES, EDGES);
  const initial = project(initialPlan, [], []);
  const selected = required(
    initial.commitments.find(({ flowId }) => flowId === "flow/container-spawn"),
  );
  const acquired = project(initialPlan, [durable(selected)], [progress("alive", 50, 0)]);
  const delivering = required(
    acquired.commitments.find(({ flowId }) => flowId === selected.flowId),
  );
  const partial = project(initialPlan, [durable(delivering)], [progress("alive", 20, 30)]);
  const partialState = required(
    partial.commitments.find(({ flowId }) => flowId === selected.flowId),
  );
  const afterDeath = project(initialPlan, [durable(partialState)], [progress("dead", 0, 30)]);
  const deadState = required(
    afterDeath.commitments.find(({ flowId }) => flowId === selected.flowId),
  );
  const reset = project(
    roundTrip(initialPlan),
    roundTrip([durable(deadState)]),
    roundTrip([progress("unleased", 0, 30)]),
  );
  const resetState = required(reset.commitments.find(({ flowId }) => flowId === selected.flowId));

  const withoutSpawnNodes = NODES.filter(({ id }) => id !== "spawn/sink/energy").map((value) => ({
    ...value,
    observedAt: TICK + 4,
  }));
  const vanishedPlan = plan(withoutSpawnNodes, EDGES);
  const vanished = projectLogisticsContracts({
    endpoints: endpoints(withoutSpawnNodes),
    nodes: withoutSpawnNodes,
    plan: vanishedPlan,
    previous: [durable(resetState)],
    progress: [progress("unleased", 0, 30)],
    tick: TICK + 4,
  });
  const vanishedState = required(
    vanished.commitments.find(({ flowId }) => flowId === selected.flowId),
  );

  const decayedNodes = NODES.map((value) =>
    value.id === "drop/source/energy"
      ? { ...value, observedAmount: 20, observedAt: TICK + 5 }
      : value,
  );
  const decayedPlan = planLogistics({ ...input(decayedNodes, EDGES), tick: TICK + 5 });
  const emptySourceNodes = NODES.map((value) =>
    value.id === "container/source/energy" ? { ...value, observedAmount: 0 } : value,
  );
  const fullSinkNodes = NODES.map((value) =>
    value.id === "spawn/sink/energy" ? { ...value, freeCapacity: 0 } : value,
  );
  const emptySourcePlan = plan(emptySourceNodes, [
    required(EDGES.find(({ id }) => id === "flow/container-spawn")),
  ]);
  const fullSinkPlan = plan(fullSinkNodes, [
    required(EDGES.find(({ id }) => id === "flow/container-spawn")),
  ]);
  return {
    actorDeath: {
      cycle: deadState.cycle,
      delivered: deadState.deliveredAmount,
      reacquireAmount: resetState.request?.quantity ?? 0,
      reason: deadState.reason,
    },
    droppedDecay: {
      observed: 20,
      reserved: reservation(decayedPlan, "drop/source/energy").sourceAmount,
    },
    fullAndEmptyStores: {
      emptySourceReason: projection(emptySourcePlan, "flow/container-spawn").blocker,
      emptySourceReservations: emptySourcePlan.reservations.length,
      fullSinkReason: projection(fullSinkPlan, "flow/container-spawn").blocker,
      fullSinkReservations: fullSinkPlan.reservations.length,
    },
    partialDelivery: {
      cargo: 20,
      delivered: partialState.deliveredAmount,
      remaining: partialState.reservedAmount - partialState.deliveredAmount,
      stage: partialState.stage,
    },
    resetRecovery: {
      cycle: resetState.cycle,
      delivered: resetState.deliveredAmount,
      flowId: resetState.flowId,
      reserved: resetState.reservedAmount,
    },
    vanishedEndpoint: {
      admittedAfterVanishing: projection(vanishedPlan, selected.flowId).admittedAmount,
      ghostSinkReservations: vanishedPlan.reservations.filter(
        ({ nodeId }) => nodeId === "spawn/sink/energy",
      ).length,
      reason: vanishedState.reason,
      requestActive: vanishedState.request !== null,
      retirements: vanished.retirements.length,
    },
  };
}

function telemetryOutcome(flowIds: readonly string[]) {
  const baselinePlan = plan(NODES, EDGES);
  const observations = flowIds.map((flowId): LogisticsFlowObservation => {
    const admitted = projection(baselinePlan, flowId).admittedAmount;
    return observation(flowId, admitted, admitted, 0, 0, 0, true);
  });
  const first = reduceLogisticsTelemetry({
    tick: TICK,
    cpuUsed: 0.75,
    observations: [
      ...observations,
      observation("flow/overflow-a", 1, 0, 0, 0, 0, false),
      observation("flow/overflow-b", 1, 0, 0, 0, 0, false),
    ],
    maximumFlows: TELEMETRY_FLOW_CAP,
  });
  const advanced = observations.map((value) =>
    value.flowId === "flow/container-spawn" ? { ...value, pickedUp: 50, delivered: 30 } : value,
  );
  const second = reduceLogisticsTelemetry({
    tick: TICK + 1,
    cpuUsed: 0.5,
    observations: advanced,
    previous: roundTrip(first.state),
    maximumFlows: TELEMETRY_FLOW_CAP,
  });
  const loss = advanced.map((value) =>
    value.flowId === "flow/container-spawn" ? { ...value, loss: 20, active: false } : value,
  );
  const third = reduceLogisticsTelemetry({
    tick: TICK + 2,
    cpuUsed: 0.25,
    observations: loss,
    previous: roundTrip(second.state),
    maximumFlows: TELEMETRY_FLOW_CAP,
  });
  const reset = reduceLogisticsTelemetry({
    tick: TICK + 3,
    cpuUsed: 0.25,
    observations: roundTrip(loss),
    previous: roundTrip(third.state),
    maximumFlows: TELEMETRY_FLOW_CAP,
  });
  const planAfterTelemetry = plan(NODES, EDGES);
  return {
    activeContracts: second.telemetry.activeContracts,
    cpuUsed: reset.telemetry.cpuUsed,
    deliveredDelta: second.telemetry.delivered,
    droppedAtCap: first.telemetry.droppedFlows,
    latencyTicks: second.telemetry.latencyTicks,
    lossDelta: third.telemetry.loss,
    persistedBytes: canonicalSerialize(reset.state).length,
    pickedUpDelta: second.telemetry.pickedUp,
    planUnchanged: canonicalSerialize(baselinePlan) === canonicalSerialize(planAfterTelemetry),
    resetDeltas: {
      delivered: reset.telemetry.delivered,
      loss: reset.telemetry.loss,
      pickedUp: reset.telemetry.pickedUp,
    },
    schemaVersion: reset.state.schemaVersion,
    requested: second.telemetry.requested,
    scheduled: second.telemetry.scheduled,
    shortfall: second.telemetry.shortfall,
  };
}

function plan(nodes: readonly LogisticsNode[], edges: readonly LogisticsEdge[]) {
  return planLogistics(input(nodes, edges));
}

function input(nodes: readonly LogisticsNode[], edges: readonly LogisticsEdge[]) {
  return {
    nodes,
    edges,
    tick: TICK,
    maximumNodeAge: MAXIMUM_NODE_AGE,
    planningHorizon: PLANNING_HORIZON,
  };
}

function project(
  logisticsPlan: ReturnType<typeof planLogistics>,
  previous: readonly LogisticsCommitmentState[],
  flowProgress: readonly LogisticsFlowProgress[],
) {
  return projectLogisticsContracts({
    endpoints: endpoints(NODES),
    nodes: NODES,
    plan: logisticsPlan,
    previous,
    progress: flowProgress,
    tick: TICK,
  });
}

function endpoints(nodes: readonly LogisticsNode[]): readonly LogisticsContractEndpoint[] {
  return nodes.map((value) => ({
    ...(value.id.startsWith("drop/") ? { acquireAction: "pickup" as const } : {}),
    freeCapacity: value.freeCapacity,
    nodeId: value.id,
    observedAmount: value.observedAmount,
    observedAt: value.observedAt,
    position: value.position,
    resourceType: value.resourceType,
    targetId: value.id.split("/")[0] ?? value.id,
  }));
}

function node(
  id: string,
  kind: LogisticsNode["kind"],
  resourceType: string,
  observedAmount: number,
  freeCapacity: number,
  priorityClass: LogisticsNode["priority"]["class"],
  x: number,
  y: number,
): LogisticsNode {
  return {
    id,
    colonyId: ROOM,
    resourceType,
    kind,
    observedAmount,
    freeCapacity,
    observedAt: TICK,
    priority: {
      class: priorityClass,
      deadline: priorityClass === "mandatory" ? TICK + 5 : TICK + 50,
    },
    position: { roomName: ROOM, x, y },
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sinkNodeId: string,
  roundTripTicks: number,
): LogisticsEdge {
  return { id, sourceNodeId, sinkNodeId, roundTripTicks };
}

function progress(
  actorState: LogisticsFlowProgress["actorState"],
  cargoAmount: number,
  deliveredAmount: number,
): LogisticsFlowProgress {
  return { actorState, cargoAmount, deliveredAmount, flowId: "flow/container-spawn" };
}

function observation(
  flowId: string,
  requested: number,
  scheduled: number,
  pickedUp: number,
  delivered: number,
  loss: number,
  active: boolean,
): LogisticsFlowObservation {
  return {
    flowId,
    contractId: active ? `contract/${flowId}` : null,
    requested,
    scheduled,
    pickedUp,
    delivered,
    loss,
    firstRequestedAt: TICK,
    active,
  };
}

function durable(value: LogisticsCommitmentProjection): LogisticsCommitmentState {
  const { reason: _reason, request: _request, ...state } = value;
  void _reason;
  void _request;
  return state;
}

function reservationBounds(
  logisticsPlan: ReturnType<typeof planLogistics>,
  nodes: readonly LogisticsNode[],
): boolean {
  const byId = new Map(nodes.map((value) => [value.id, value]));
  return logisticsPlan.reservations.every((value) => {
    const observed = byId.get(value.nodeId);
    return (
      observed !== undefined &&
      value.sourceAmount <= observed.observedAmount &&
      value.sinkCapacity <= observed.freeCapacity
    );
  });
}

function reservation(logisticsPlan: ReturnType<typeof planLogistics>, nodeId: string) {
  return (
    logisticsPlan.reservations.find((value) => value.nodeId === nodeId) ?? {
      nodeId,
      sinkCapacity: 0,
      sourceAmount: 0,
    }
  );
}

function projection(logisticsPlan: ReturnType<typeof planLogistics>, flowId: string) {
  const value = logisticsPlan.projections.find(({ id }) => id === flowId);
  if (value === undefined) throw new TypeError(`missing logistics projection ${flowId}`);
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required logistics evidence value is missing");
  return value;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
