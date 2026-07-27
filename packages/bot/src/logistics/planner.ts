export const MAX_LOGISTICS_NODES = 128;
export const MAX_LOGISTICS_EDGES = 256;
export const MAX_ADMITTED_LOGISTICS_FLOWS = 128;

/** One physical Store capacity identity shared by every resource-specific sink projection. */
export function aggregateStoreCapacityReservationKey(colonyId: string, targetId: string): string {
  return `store-capacity/${String(colonyId.length)}:${colonyId}/${String(targetId.length)}:${targetId}`;
}
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
  readonly category: "harvesting-filling" | "industry" | "optional-growth";
  readonly issuer: string;
}

export interface LogisticsRouteLeg {
  readonly originRoomName: string;
  readonly roomNames: readonly string[];
  readonly travelTicks: number;
}

export interface RoutedLogisticsEdge {
  readonly acquire: LogisticsRouteLeg;
  readonly deliver: LogisticsRouteLeg;
  readonly predictedLossBasisPoints: number;
  readonly productionMilliPerTick: number;
}

export interface RoutedLogisticsBodySize {
  readonly carry: number;
  readonly move: number;
  readonly predictedTransitLoss: number;
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
  readonly routed?: RoutedLogisticsEdge;
}

export interface LogisticsPlanningInput {
  readonly nodes: readonly LogisticsNode[];
  readonly edges: readonly LogisticsEdge[];
  readonly tick: number;
  readonly maximumNodeAge: number;
  readonly planningHorizon: number;
}

export type LogisticsBlockerReason =
  | "capacity-limit"
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
  readonly recommendedCarry?: number;
  readonly recommendedMove?: number;
  readonly routed?: RoutedLogisticsEdge;
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
  const admittedByColony = new Map<
    string,
    { amount: number; carryLoad: number; minimumCarry: number }
  >();
  for (const candidate of candidates) {
    const { edge, source, sink } = candidate;
    const available = sourceRemaining.get(source.id) ?? 0;
    const sinkKey = capacityKey(sink);
    const capacity = sinkRemaining.get(sinkKey) ?? 0;
    const routedBody = edge.routed === undefined ? null : sizeRoutedLogisticsEdge(edge);
    let blocker: LogisticsBlockerReason | null = null;
    if (edge.routed !== undefined && routedBody === null) blocker = "capacity-limit";
    else if (available === 0) blocker = "empty-source";
    else if (capacity === 0) blocker = "full-sink";
    else if (admittedFlows >= MAX_ADMITTED_LOGISTICS_FLOWS) blocker = "flow-cap";
    const admittedAmount =
      blocker === null
        ? Math.min(
            available,
            capacity,
            edge.maximumAmount ?? Number.MAX_SAFE_INTEGER,
            routedBody === null ? Number.MAX_SAFE_INTEGER : routedBody.carry * 50,
          )
        : 0;
    if (admittedAmount > 0) {
      admittedFlows += 1;
      sourceRemaining.set(source.id, available - admittedAmount);
      sinkRemaining.set(sinkKey, capacity - admittedAmount);
      const colony = admittedByColony.get(source.colonyId) ?? {
        amount: 0,
        carryLoad: 0,
        minimumCarry: 0,
      };
      colony.amount += admittedAmount;
      colony.carryLoad +=
        routedBody === null
          ? (admittedAmount * Math.min(edge.roundTripTicks, input.planningHorizon)) /
            input.planningHorizon
          : routedBody.carry * 50;
      colony.minimumCarry += routedBody?.carry ?? 0;
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
      ...(routedBody === null
        ? {}
        : { recommendedCarry: routedBody.carry, recommendedMove: routedBody.move }),
      ...(edge.routed === undefined ? {} : { routed: edge.routed }),
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
        Math.max(flow.minimumCarry, Math.min(usefulCarry, Math.ceil(flow.carryLoad / 50))),
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
  if (edge.routed !== undefined && !routedEndpointsMatch(edge.routed, source, sink))
    return "invalid-edge";
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
    (edge.maximumAmount === undefined || positiveInteger(edge.maximumAmount)) &&
    (edge.routed === undefined || validRoutedEdge(edge.routed, edge.roundTripTicks))
  );
}

export function sizeRoutedLogisticsEdge(
  edge: Pick<LogisticsEdge, "roundTripTicks" | "routed">,
): RoutedLogisticsBodySize | null {
  const routed = edge.routed;
  if (routed === undefined || !validRoutedEdge(routed, edge.roundTripTicks)) return null;
  const denominator = 1_000 * (10_000 - routed.predictedLossBasisPoints);
  const numerator = routed.productionMilliPerTick * edge.roundTripTicks * 10_000;
  if (!Number.isSafeInteger(numerator) || numerator <= 0 || denominator <= 0) return null;
  const grossAmount = Math.ceil(numerator / denominator);
  const expectedAmount = Math.ceil((routed.productionMilliPerTick * edge.roundTripTicks) / 1_000);
  const carry = Math.ceil(grossAmount / 50);
  if (!positiveInteger(carry) || carry > MAX_LOGISTICS_BODY_PARTS / 2) return null;
  return { carry, move: carry, predictedTransitLoss: Math.max(0, grossAmount - expectedAmount) };
}

function validRoutedEdge(routed: RoutedLogisticsEdge, roundTripTicks: number): boolean {
  return (
    validRouteLeg(routed.acquire) &&
    validRouteLeg(routed.deliver) &&
    routed.acquire.travelTicks + routed.deliver.travelTicks === roundTripTicks &&
    positiveInteger(routed.productionMilliPerTick) &&
    nonnegativeInteger(routed.predictedLossBasisPoints) &&
    routed.predictedLossBasisPoints < 10_000
  );
}

function validRouteLeg(route: LogisticsRouteLeg): boolean {
  return (
    route.originRoomName.length > 0 &&
    route.roomNames.length > 0 &&
    route.roomNames.length <= 16 &&
    route.roomNames.every((room) => room.length > 0) &&
    new Set(route.roomNames).size === route.roomNames.length &&
    !route.roomNames.includes(route.originRoomName) &&
    positiveInteger(route.travelTicks)
  );
}

function routedEndpointsMatch(
  routed: RoutedLogisticsEdge,
  source: LogisticsNode,
  sink: LogisticsNode,
): boolean {
  return (
    routed.acquire.originRoomName === sink.position.roomName &&
    routed.acquire.roomNames[routed.acquire.roomNames.length - 1] === source.position.roomName &&
    routed.deliver.originRoomName === source.position.roomName &&
    routed.deliver.roomNames[routed.deliver.roomNames.length - 1] === sink.position.roomName
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
