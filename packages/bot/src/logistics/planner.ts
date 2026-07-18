export const MAX_LOGISTICS_NODES = 128;
export const MAX_LOGISTICS_EDGES = 256;
export const MAX_ADMITTED_LOGISTICS_FLOWS = 128;
export const MAX_LOGISTICS_BODY_PARTS = 50;

export type LogisticsNodeKind = "source" | "sink" | "buffer";
export type LogisticsPriorityClass = "mandatory" | "normal";

export interface LogisticsPosition {
  readonly roomName: string;
  readonly x: number;
  readonly y: number;
}

export interface LogisticsPriority {
  readonly class: LogisticsPriorityClass;
  readonly deadline: number;
}

export interface LogisticsBudgetBinding {
  readonly category: "industry" | "optional-growth";
  readonly issuer: string;
}

export interface LogisticsNode {
  readonly id: string;
  readonly colonyId: string;
  readonly resourceType: string;
  readonly kind: LogisticsNodeKind;
  readonly observedAmount: number;
  readonly freeCapacity: number;
  readonly observedAt: number;
  readonly priority: LogisticsPriority;
  readonly position: LogisticsPosition;
  readonly capacityReservationKey?: string;
}

export interface LogisticsEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly sinkNodeId: string;
  readonly roundTripTicks: number;
  readonly maximumAmount?: number;
  readonly budgetBinding?: LogisticsBudgetBinding;
}

export interface LogisticsPlanningInput {
  readonly nodes: readonly LogisticsNode[];
  readonly edges: readonly LogisticsEdge[];
  readonly tick: number;
  readonly maximumNodeAge: number;
  readonly planningHorizon: number;
}

export type LogisticsBlockerReason =
  | "duplicate-id"
  | "edge-cap"
  | "empty-source"
  | "flow-cap"
  | "full-sink"
  | "invalid-edge"
  | "invalid-node"
  | "node-cap"
  | "resource-mismatch"
  | "stale-node"
  | "vanished-node"
  | "wrong-colony";

export interface LogisticsBlocker {
  readonly subject: "edge" | "node";
  readonly id: string;
  readonly reason: LogisticsBlockerReason;
}

export interface LogisticsProjection {
  readonly id: string;
  readonly colonyId: string | null;
  readonly resourceType: string | null;
  readonly sourceNodeId: string;
  readonly sinkNodeId: string;
  readonly admittedAmount: number;
  readonly roundTripTicks: number;
  readonly blocker: LogisticsBlockerReason | null;
  readonly budgetBinding?: LogisticsBudgetBinding;
}

export interface LogisticsReservation {
  readonly nodeId: string;
  readonly sourceAmount: number;
  readonly sinkCapacity: number;
}

export interface LogisticsBodyRecommendation {
  readonly colonyId: string;
  readonly carry: number;
  readonly move: number;
  readonly admittedAmount: number;
}

export interface LogisticsPlan {
  readonly projections: readonly LogisticsProjection[];
  readonly reservations: readonly LogisticsReservation[];
  readonly blockers: readonly LogisticsBlocker[];
  readonly recommendations: readonly LogisticsBodyRecommendation[];
}

interface Candidate {
  readonly edge: LogisticsEdge;
  readonly source: LogisticsNode;
  readonly sink: LogisticsNode;
}

/** Pure logistics projection. It observes no world state and emits no executable demand. */
export function planLogistics(input: LogisticsPlanningInput): LogisticsPlan {
  const blockers: LogisticsBlocker[] = [];
  const nodes = admitNodes(input.nodes, blockers);
  const edges = admitEdges(input.edges, blockers);
  const sourceRemaining = new Map<string, number>();
  const sinkRemaining = new Map<string, number>();
  const sinkInitial = new Map<string, number>();
  const candidates: Candidate[] = [];
  const projections: LogisticsProjection[] = [];

  for (const edge of edges) {
    const source = nodes.get(edge.sourceNodeId);
    const sink = nodes.get(edge.sinkNodeId);
    const reason = edgeBlocker(edge, source, sink, input);
    if (reason !== null || source === undefined || sink === undefined) {
      const blocker = reason ?? "vanished-node";
      projections.push(blockedProjection(edge, source, sink, blocker));
      blockers.push({ subject: "edge", id: edge.id, reason: blocker });
      continue;
    }
    sourceRemaining.set(source.id, source.observedAmount);
    const sinkKey = capacityKey(sink);
    const sharedCapacity = Math.min(
      sinkRemaining.get(sinkKey) ?? sink.freeCapacity,
      sink.freeCapacity,
    );
    sinkRemaining.set(sinkKey, sharedCapacity);
    sinkInitial.set(sinkKey, sharedCapacity);
    candidates.push({ edge, source, sink });
  }

  candidates.sort(compareCandidates);
  let admittedFlows = 0;
  const admittedByColony = new Map<string, { amount: number; carryLoad: number }>();
  for (const candidate of candidates) {
    const { edge, source, sink } = candidate;
    const available = sourceRemaining.get(source.id) ?? 0;
    const sinkKey = capacityKey(sink);
    const capacity = sinkRemaining.get(sinkKey) ?? 0;
    let blocker: LogisticsBlockerReason | null = null;
    if (available === 0) blocker = "empty-source";
    else if (capacity === 0) blocker = "full-sink";
    else if (admittedFlows >= MAX_ADMITTED_LOGISTICS_FLOWS) blocker = "flow-cap";
    const admittedAmount =
      blocker === null
        ? Math.min(available, capacity, edge.maximumAmount ?? Number.MAX_SAFE_INTEGER)
        : 0;
    if (admittedAmount > 0) {
      admittedFlows += 1;
      sourceRemaining.set(source.id, available - admittedAmount);
      sinkRemaining.set(sinkKey, capacity - admittedAmount);
      const colony = admittedByColony.get(source.colonyId) ?? { amount: 0, carryLoad: 0 };
      colony.amount += admittedAmount;
      colony.carryLoad +=
        (admittedAmount * Math.min(edge.roundTripTicks, input.planningHorizon)) /
        input.planningHorizon;
      admittedByColony.set(source.colonyId, colony);
    } else {
      blocker ??= edge.maximumAmount === 0 ? "invalid-edge" : "empty-source";
      blockers.push({ subject: "edge", id: edge.id, reason: blocker });
    }
    projections.push({
      id: edge.id,
      colonyId: source.colonyId,
      resourceType: source.resourceType,
      sourceNodeId: source.id,
      sinkNodeId: sink.id,
      admittedAmount,
      roundTripTicks: edge.roundTripTicks,
      blocker,
      ...(edge.budgetBinding === undefined ? {} : { budgetBinding: edge.budgetBinding }),
    });
  }

  const reservationById = new Map<string, LogisticsReservation>();
  for (const node of nodes.values()) {
    const sourceAmount =
      node.observedAmount - (sourceRemaining.get(node.id) ?? node.observedAmount);
    if (sourceAmount <= 0) continue;
    reservationById.set(node.id, { nodeId: node.id, sourceAmount, sinkCapacity: 0 });
  }
  for (const [nodeId, initial] of sinkInitial) {
    const sinkCapacity = initial - (sinkRemaining.get(nodeId) ?? initial);
    if (sinkCapacity <= 0) continue;
    const existing = reservationById.get(nodeId);
    reservationById.set(nodeId, {
      nodeId,
      sourceAmount: existing?.sourceAmount ?? 0,
      sinkCapacity,
    });
  }
  const reservations = [...reservationById.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );

  const recommendations = [...admittedByColony.entries()]
    .map(([colonyId, flow]): LogisticsBodyRecommendation => {
      const usefulCarry = Math.ceil(flow.amount / 50);
      const carry = Math.min(
        MAX_LOGISTICS_BODY_PARTS / 2,
        usefulCarry,
        Math.ceil(flow.carryLoad / 50),
      );
      return { colonyId, carry, move: carry, admittedAmount: flow.amount };
    })
    .sort((left, right) => left.colonyId.localeCompare(right.colonyId));

  return freeze({
    projections: projections.sort((left, right) => left.id.localeCompare(right.id)),
    reservations,
    blockers: blockers.sort(compareBlockers),
    recommendations,
  });
}

function admitNodes(
  input: readonly LogisticsNode[],
  blockers: LogisticsBlocker[],
): ReadonlyMap<string, LogisticsNode> {
  const counts = countIds(input);
  const unique = [...input]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((node) => {
      if ((counts.get(node.id) ?? 0) === 1) return true;
      if (!blockers.some((item) => item.subject === "node" && item.id === node.id))
        blockers.push({ subject: "node", id: node.id, reason: "duplicate-id" });
      return false;
    });
  for (const node of unique.slice(MAX_LOGISTICS_NODES))
    blockers.push({ subject: "node", id: node.id, reason: "node-cap" });
  return new Map(unique.slice(0, MAX_LOGISTICS_NODES).map((node) => [node.id, node]));
}

function admitEdges(
  input: readonly LogisticsEdge[],
  blockers: LogisticsBlocker[],
): readonly LogisticsEdge[] {
  const counts = countIds(input);
  const unique = [...input]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((edge) => {
      if ((counts.get(edge.id) ?? 0) === 1) return true;
      if (!blockers.some((item) => item.subject === "edge" && item.id === edge.id))
        blockers.push({ subject: "edge", id: edge.id, reason: "duplicate-id" });
      return false;
    });
  for (const edge of unique.slice(MAX_LOGISTICS_EDGES))
    blockers.push({ subject: "edge", id: edge.id, reason: "edge-cap" });
  return unique.slice(0, MAX_LOGISTICS_EDGES);
}

function edgeBlocker(
  edge: LogisticsEdge,
  source: LogisticsNode | undefined,
  sink: LogisticsNode | undefined,
  input: LogisticsPlanningInput,
): LogisticsBlockerReason | null {
  if (!validInput(input) || !validEdge(edge)) return "invalid-edge";
  if (source === undefined || sink === undefined) return "vanished-node";
  if (!validNode(source) || !validNode(sink)) return "invalid-node";
  if (
    input.tick - source.observedAt > input.maximumNodeAge ||
    input.tick - sink.observedAt > input.maximumNodeAge
  )
    return "stale-node";
  if (source.kind === "sink" || sink.kind === "source") return "invalid-edge";
  if (source.colonyId !== sink.colonyId) return "wrong-colony";
  if (source.resourceType !== sink.resourceType) return "resource-mismatch";
  if (source.observedAmount === 0) return "empty-source";
  if (sink.freeCapacity === 0) return "full-sink";
  return null;
}

function validInput(input: LogisticsPlanningInput): boolean {
  return (
    nonnegativeInteger(input.tick) &&
    nonnegativeInteger(input.maximumNodeAge) &&
    positiveInteger(input.planningHorizon)
  );
}

function validNode(node: LogisticsNode): boolean {
  return (
    node.id.length > 0 &&
    node.colonyId.length > 0 &&
    node.resourceType.length > 0 &&
    nonnegativeInteger(node.observedAmount) &&
    nonnegativeInteger(node.freeCapacity) &&
    nonnegativeInteger(node.observedAt) &&
    nonnegativeInteger(node.priority.deadline) &&
    node.position.roomName.length > 0 &&
    Number.isInteger(node.position.x) &&
    node.position.x >= 0 &&
    node.position.x <= 49 &&
    Number.isInteger(node.position.y) &&
    node.position.y >= 0 &&
    node.position.y <= 49
  );
}

function validEdge(edge: LogisticsEdge): boolean {
  return (
    edge.id.length > 0 &&
    edge.sourceNodeId.length > 0 &&
    edge.sinkNodeId.length > 0 &&
    edge.sourceNodeId !== edge.sinkNodeId &&
    positiveInteger(edge.roundTripTicks) &&
    (edge.maximumAmount === undefined || positiveInteger(edge.maximumAmount))
  );
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    priorityRank(left.sink.priority.class) - priorityRank(right.sink.priority.class) ||
    left.sink.priority.deadline - right.sink.priority.deadline ||
    priorityRank(left.source.priority.class) - priorityRank(right.source.priority.class) ||
    left.source.priority.deadline - right.source.priority.deadline ||
    left.sink.id.localeCompare(right.sink.id) ||
    left.source.id.localeCompare(right.source.id) ||
    left.edge.id.localeCompare(right.edge.id)
  );
}

function blockedProjection(
  edge: LogisticsEdge,
  source: LogisticsNode | undefined,
  sink: LogisticsNode | undefined,
  blocker: LogisticsBlockerReason,
): LogisticsProjection {
  return {
    id: edge.id,
    colonyId: source?.colonyId ?? sink?.colonyId ?? null,
    resourceType: source?.resourceType ?? sink?.resourceType ?? null,
    sourceNodeId: edge.sourceNodeId,
    sinkNodeId: edge.sinkNodeId,
    admittedAmount: 0,
    roundTripTicks: edge.roundTripTicks,
    blocker,
    ...(edge.budgetBinding === undefined ? {} : { budgetBinding: edge.budgetBinding }),
  };
}

function capacityKey(node: LogisticsNode): string {
  return node.capacityReservationKey ?? node.id;
}

function countIds(items: readonly { readonly id: string }[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return counts;
}

function compareBlockers(left: LogisticsBlocker, right: LogisticsBlocker): number {
  return (
    left.subject.localeCompare(right.subject) ||
    left.id.localeCompare(right.id) ||
    left.reason.localeCompare(right.reason)
  );
}

function priorityRank(priority: LogisticsPriorityClass): number {
  return priority === "mandatory" ? 0 : 1;
}

function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
