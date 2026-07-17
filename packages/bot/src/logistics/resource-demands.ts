import type { LabClusterAssignment } from "../industry/lab-cluster";
import type { WorldSnapshot } from "../world/snapshot";
import type { LogisticsContractEndpoint } from "./contracts";
import type { LogisticsEdge, LogisticsNode, LogisticsPriorityClass } from "./planner";

export type LabResourceDemandMode = "drain" | "fill";

/** Data-only industry request. Logistics remains responsible for admission and execution. */
export interface LabResourceDemand {
  readonly amount: number;
  readonly clusterFingerprint: string;
  readonly colonyId: string;
  readonly deadline: number;
  readonly endpointId: string;
  readonly id: string;
  readonly industryBudgetId: string;
  readonly labId: string;
  readonly mode: LabResourceDemandMode;
  readonly priority: LogisticsPriorityClass;
  readonly resourceType: string;
  readonly revision: number;
}

export interface LabResourceDemandLimits {
  readonly maximumAmountPerDemand: number;
  readonly maximumDemands: number;
  readonly maximumEdges: number;
  readonly maximumLabs: number;
  readonly maximumNodes: number;
  /** Bounds inventory exposed by any one source node without changing physical store facts. */
  readonly maximumSourceStockPerNode: number;
}

export type LabResourceDemandBlockerReason =
  | "demand-cap"
  | "duplicate-demand-id"
  | "duplicate-demand-revision"
  | "edge-cap"
  | "expired-deadline"
  | "inactive-endpoint"
  | "inactive-lab"
  | "invalid-assignment"
  | "invalid-demand"
  | "lab-cap"
  | "missing-endpoint"
  | "missing-lab"
  | "node-cap"
  | "non-cluster-lab"
  | "resource-mismatch"
  | "stale-cluster-fingerprint";

export interface LabResourceDemandBlocker {
  readonly demandId: string;
  readonly reason: LabResourceDemandBlockerReason;
  readonly revision: number;
}

export interface LabResourceDemandDisposition {
  readonly demandId: string;
  readonly effectiveMode: LabResourceDemandMode;
  readonly effectiveResourceType: string;
  readonly remainingAmount: number;
  readonly revision: number;
  readonly status: "blocked" | "projected" | "satisfied";
}

export interface LabResourceDemandProjection {
  readonly blockers: readonly LabResourceDemandBlocker[];
  readonly dispositions: readonly LabResourceDemandDisposition[];
  readonly edges: readonly LogisticsEdge[];
  readonly endpoints: readonly LogisticsContractEndpoint[];
  readonly nodes: readonly LogisticsNode[];
}

export interface ProjectLabResourceDemandsInput {
  readonly assignment: LabClusterAssignment;
  readonly demands: readonly LabResourceDemand[];
  readonly limits: LabResourceDemandLimits;
  readonly world: WorldSnapshot;
}

interface InventoryEndpoint {
  readonly active: boolean;
  readonly id: string;
  readonly pos: { readonly roomName: string; readonly x: number; readonly y: number };
  readonly store: {
    readonly freeCapacity: number | null;
    readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
  };
}

interface LabFact {
  readonly active: boolean;
  readonly energy: number;
  readonly energyCapacity: number;
  readonly id: string;
  readonly mineralAmount: number;
  readonly mineralCapacity: number;
  readonly mineralType: string | null;
  readonly pos: { readonly roomName: string; readonly x: number; readonly y: number };
}

export function projectLabResourceDemands(
  input: ProjectLabResourceDemandsInput,
): LabResourceDemandProjection {
  const blockers: LabResourceDemandBlocker[] = [];
  const dispositions: LabResourceDemandDisposition[] = [];
  const edges: LogisticsEdge[] = [];
  const endpoints = new Map<string, LogisticsContractEndpoint>();
  const nodes = new Map<string, LogisticsNode>();
  const ordered = [...input.demands].sort(compareDemands);
  const limitsValid = validLimits(input.limits);
  const assignmentValid = validAssignment(input.assignment);
  const room = input.world.ownedRooms.find(({ name }) => name === input.assignment.roomName);
  const labs = room?.ownedLabs ?? [];
  const clusterIds = assignmentValid ? clusterLabIds(input.assignment) : new Set<string>();
  const duplicateIds = counts(ordered, ({ id }) => id);
  const duplicateRevisions = counts(
    ordered,
    ({ id, revision }) => `${id}\u0000${String(revision)}`,
  );

  for (const [index, demand] of ordered.entries()) {
    let reason: LabResourceDemandBlockerReason | null = null;
    if (!limitsValid || !validDemand(demand, input.limits)) reason = "invalid-demand";
    else if ((duplicateRevisions.get(`${demand.id}\u0000${String(demand.revision)}`) ?? 0) > 1)
      reason = "duplicate-demand-revision";
    else if ((duplicateIds.get(demand.id) ?? 0) > 1) reason = "duplicate-demand-id";
    else if (index >= input.limits.maximumDemands) reason = "demand-cap";
    else if (!assignmentValid) reason = "invalid-assignment";
    else if (clusterIds.size > input.limits.maximumLabs) reason = "lab-cap";
    else if (demand.colonyId !== input.assignment.roomName) reason = "invalid-demand";
    else if (demand.clusterFingerprint !== input.assignment.fingerprint)
      reason = "stale-cluster-fingerprint";
    else if (demand.deadline < input.world.observedAt) reason = "expired-deadline";
    else if (!clusterIds.has(demand.labId)) reason = "non-cluster-lab";

    const lab = labs.find(({ id }) => id === demand.labId);
    if (reason === null && lab === undefined) reason = "missing-lab";
    else if (reason === null && lab?.active !== true) reason = "inactive-lab";

    const inventoryEndpoints: readonly InventoryEndpoint[] = [
      ...(room?.ownedStorages ?? []),
      ...(room?.ownedTerminals ?? []),
    ];
    const endpoint = inventoryEndpoints.find(({ id }) => id === demand.endpointId);
    if (reason === null && endpoint === undefined) reason = "missing-endpoint";
    else if (reason === null && endpoint?.active !== true) reason = "inactive-endpoint";

    if (reason !== null || lab === undefined || endpoint === undefined) {
      block(demand, reason ?? "invalid-demand", blockers, dispositions);
      continue;
    }

    const effective = effectiveTransfer(demand, lab);
    if (effective.reason !== null) {
      block(demand, effective.reason, blockers, dispositions);
      continue;
    }
    if (effective.amount === 0) {
      dispositions.push(
        disposition(demand, effective.mode, effective.resourceType, 0, "satisfied"),
      );
      continue;
    }

    const sourceIsLab = effective.mode === "drain";
    const labNode = makeLabNode(
      demand,
      lab,
      effective.mode,
      effective.resourceType,
      input.world.observedAt,
    );
    const endpointNode = makeEndpointNode(
      demand,
      endpoint,
      effective.mode,
      effective.resourceType,
      input.world.observedAt,
      input.limits.maximumSourceStockPerNode,
    );
    const source = sourceIsLab ? labNode : endpointNode;
    const sink = sourceIsLab ? endpointNode : labNode;
    const edge: LogisticsEdge = freeze({
      budgetBinding: freeze({ category: "industry", issuer: demand.industryBudgetId }),
      id: edgeId(demand, effective.mode, effective.resourceType),
      maximumAmount: effective.amount,
      roundTripTicks: roundTripTicks(source.position, sink.position),
      sinkNodeId: sink.id,
      sourceNodeId: source.id,
    });
    const newNodeCount = Number(!nodes.has(source.id)) + Number(!nodes.has(sink.id));
    if (nodes.size + newNodeCount > input.limits.maximumNodes) {
      block(demand, "node-cap", blockers, dispositions);
      continue;
    }
    if (edges.length >= input.limits.maximumEdges) {
      block(demand, "edge-cap", blockers, dispositions);
      continue;
    }
    nodes.set(source.id, source);
    nodes.set(sink.id, sink);
    endpoints.set(source.id, contractEndpoint(source, sourceIsLab ? lab.id : endpoint.id, true));
    endpoints.set(sink.id, contractEndpoint(sink, sourceIsLab ? endpoint.id : lab.id, false));
    edges.push(edge);
    dispositions.push(
      disposition(demand, effective.mode, effective.resourceType, effective.amount, "projected"),
    );
  }

  return freeze({
    blockers: freeze(blockers.sort(compareBlockers)),
    dispositions: freeze(dispositions.sort(compareDispositions)),
    edges: freeze(edges.sort((left, right) => compare(left.id, right.id))),
    endpoints: freeze(
      [...endpoints.values()].sort((left, right) => compare(left.nodeId, right.nodeId)),
    ),
    nodes: freeze([...nodes.values()].sort((left, right) => compare(left.id, right.id))),
  });
}

function effectiveTransfer(
  demand: LabResourceDemand,
  lab: LabFact,
): {
  readonly amount: number;
  readonly mode: LabResourceDemandMode;
  readonly reason: LabResourceDemandBlockerReason | null;
  readonly resourceType: string;
} {
  if (
    demand.mode === "fill" &&
    demand.resourceType !== "energy" &&
    lab.mineralAmount > 0 &&
    lab.mineralType !== null &&
    lab.mineralType !== demand.resourceType
  ) {
    return {
      amount: lab.mineralAmount,
      mode: "drain",
      reason: null,
      resourceType: lab.mineralType,
    };
  }
  if (demand.resourceType === "energy") {
    const amount =
      demand.mode === "fill"
        ? Math.max(0, demand.amount - lab.energy)
        : Math.min(demand.amount, lab.energy);
    return { amount, mode: demand.mode, reason: null, resourceType: demand.resourceType };
  }
  if (demand.mode === "drain" && lab.mineralAmount > 0 && lab.mineralType !== demand.resourceType) {
    return {
      amount: 0,
      mode: demand.mode,
      reason: "resource-mismatch",
      resourceType: demand.resourceType,
    };
  }
  const amount =
    demand.mode === "fill"
      ? Math.max(
          0,
          demand.amount - (lab.mineralType === demand.resourceType ? lab.mineralAmount : 0),
        )
      : Math.min(demand.amount, lab.mineralAmount);
  return { amount, mode: demand.mode, reason: null, resourceType: demand.resourceType };
}

function makeLabNode(
  demand: LabResourceDemand,
  lab: LabFact,
  mode: LabResourceDemandMode,
  resourceType: string,
  observedAt: number,
): LogisticsNode {
  const energy = resourceType === "energy";
  const amount = energy ? lab.energy : lab.mineralType === resourceType ? lab.mineralAmount : 0;
  const capacity = energy ? lab.energyCapacity : lab.mineralCapacity;
  return freeze({
    capacityReservationKey: `lab:${demand.colonyId}:${lab.id}:${energy ? "energy" : "mineral"}-capacity`,
    colonyId: demand.colonyId,
    freeCapacity: mode === "fill" ? Math.max(0, capacity - amount) : 0,
    id: labNodeId(demand.colonyId, lab.id, energy ? "energy" : "mineral", resourceType),
    kind: mode === "fill" ? "sink" : "source",
    observedAmount: mode === "drain" ? amount : 0,
    observedAt,
    position: freeze({ ...lab.pos }),
    priority: freeze({ class: demand.priority, deadline: demand.deadline }),
    resourceType,
  });
}

function makeEndpointNode(
  demand: LabResourceDemand,
  endpoint: InventoryEndpoint,
  mode: LabResourceDemandMode,
  resourceType: string,
  observedAt: number,
  maximumSourceStock: number,
): LogisticsNode {
  const amount = resourceAmount(endpoint, resourceType);
  return freeze({
    ...(mode === "drain"
      ? { capacityReservationKey: `inventory:${demand.colonyId}:${endpoint.id}:aggregate-capacity` }
      : {}),
    colonyId: demand.colonyId,
    freeCapacity: mode === "drain" ? Math.max(0, endpoint.store.freeCapacity ?? 0) : 0,
    id: endpointNodeId(demand.colonyId, endpoint.id, resourceType),
    kind: mode === "fill" ? "source" : "sink",
    observedAmount: mode === "fill" ? Math.min(amount, maximumSourceStock) : 0,
    observedAt,
    position: freeze({ ...endpoint.pos }),
    priority: freeze({ class: demand.priority, deadline: demand.deadline }),
    resourceType,
  });
}

function contractEndpoint(
  node: LogisticsNode,
  targetId: string,
  source: boolean,
): LogisticsContractEndpoint {
  return freeze({
    ...(source ? { acquireAction: "withdraw" as const } : {}),
    freeCapacity: node.freeCapacity,
    nodeId: node.id,
    observedAmount: node.observedAmount,
    observedAt: node.observedAt,
    position: node.position,
    resourceType: node.resourceType,
    targetId,
  });
}

function resourceAmount(endpoint: InventoryEndpoint, resourceType: string): number {
  return endpoint.store.resources
    .filter((resource) => resource.resourceType === resourceType)
    .reduce((total, resource) => total + resource.amount, 0);
}

function validAssignment(assignment: LabClusterAssignment): boolean {
  if (
    !identity(assignment.roomName, 16) ||
    !identity(assignment.fingerprint, 160) ||
    !identity(assignment.layoutFingerprint, 160)
  )
    return false;
  const ids = [...assignment.reagentLabIds, ...assignment.productLabIds, ...assignment.boostLabIds];
  return (
    ids.every((id) => identity(id, 128)) &&
    new Set([...assignment.reagentLabIds, ...assignment.productLabIds]).size ===
      assignment.reagentLabIds.length + assignment.productLabIds.length &&
    assignment.boostLabIds.every((id) => assignment.productLabIds.includes(id))
  );
}

function clusterLabIds(assignment: LabClusterAssignment): Set<string> {
  return new Set([...assignment.reagentLabIds, ...assignment.productLabIds]);
}

function validDemand(demand: LabResourceDemand, limits: LabResourceDemandLimits): boolean {
  return (
    identity(demand.id, 160) &&
    identity(demand.colonyId, 16) &&
    identity(demand.endpointId, 128) &&
    identity(demand.industryBudgetId, 160) &&
    identity(demand.labId, 128) &&
    identity(demand.resourceType, 64) &&
    identity(demand.clusterFingerprint, 160) &&
    positiveInteger(demand.revision, Number.MAX_SAFE_INTEGER) &&
    positiveInteger(demand.amount, limits.maximumAmountPerDemand) &&
    nonnegativeInteger(demand.deadline)
  );
}

function validLimits(limits: LabResourceDemandLimits): boolean {
  return (
    positiveInteger(limits.maximumAmountPerDemand, 100_000) &&
    positiveInteger(limits.maximumDemands, 128) &&
    positiveInteger(limits.maximumEdges, 256) &&
    positiveInteger(limits.maximumLabs, 10) &&
    positiveInteger(limits.maximumNodes, 128) &&
    positiveInteger(limits.maximumSourceStockPerNode, 1_000_000)
  );
}

function block(
  demand: LabResourceDemand,
  reason: LabResourceDemandBlockerReason,
  blockers: LabResourceDemandBlocker[],
  dispositions: LabResourceDemandDisposition[],
): void {
  blockers.push(freeze({ demandId: demand.id, reason, revision: demand.revision }));
  dispositions.push(disposition(demand, demand.mode, demand.resourceType, 0, "blocked"));
}

function disposition(
  demand: LabResourceDemand,
  effectiveMode: LabResourceDemandMode,
  effectiveResourceType: string,
  remainingAmount: number,
  status: LabResourceDemandDisposition["status"],
): LabResourceDemandDisposition {
  return freeze({
    demandId: demand.id,
    effectiveMode,
    effectiveResourceType,
    remainingAmount,
    revision: demand.revision,
    status,
  });
}

function edgeId(demand: LabResourceDemand, mode: LabResourceDemandMode, resource: string): string {
  return `lab-demand:${demand.id}:r${String(demand.revision)}:${mode}:${resource}`;
}

function labNodeId(
  colonyId: string,
  labId: string,
  capacity: "energy" | "mineral",
  resource: string,
): string {
  return `lab:${colonyId}:${labId}:${capacity}:${resource}`;
}

function endpointNodeId(colonyId: string, endpointId: string, resource: string): string {
  return `inventory:${colonyId}:${endpointId}:${resource}`;
}

function roundTripTicks(
  source: { readonly roomName: string; readonly x: number; readonly y: number },
  sink: { readonly roomName: string; readonly x: number; readonly y: number },
): number {
  if (source.roomName !== sink.roomName) return 100;
  return Math.max(1, 2 * Math.max(Math.abs(source.x - sink.x), Math.abs(source.y - sink.y)));
}

function counts<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function compareDemands(left: LabResourceDemand, right: LabResourceDemand): number {
  return compare(left.id, right.id) || left.revision - right.revision;
}

function compareBlockers(left: LabResourceDemandBlocker, right: LabResourceDemandBlocker): number {
  return (
    compare(left.demandId, right.demandId) ||
    left.revision - right.revision ||
    compare(left.reason, right.reason)
  );
}

function compareDispositions(
  left: LabResourceDemandDisposition,
  right: LabResourceDemandDisposition,
): number {
  return compare(left.demandId, right.demandId) || left.revision - right.revision;
}

function identity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return nonnegativeInteger(value) && value > 0 && value <= maximum;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
