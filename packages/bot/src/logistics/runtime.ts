import type { BudgetCategory, BudgetRequest } from "../colony";
import type { ContractExecutionView, ContractPlanningView } from "../contracts";
import type { WorldSnapshot } from "../world/snapshot";
import {
  projectLogisticsContracts,
  type LogisticsCommitmentState,
  type LogisticsContractEndpoint,
  type LogisticsContractProjection,
  type LogisticsFlowProgress,
} from "./contracts";
import {
  MAX_LOGISTICS_EDGES,
  MAX_LOGISTICS_NODES,
  planLogistics,
  type LogisticsEdge,
  type LogisticsNode,
  type LogisticsPlan,
  type LogisticsProjection,
} from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

const LOGISTICS_RECOVERY_RESERVE = 300;
const LOGISTICS_MAXIMUM_NODE_AGE = 0;
const LOGISTICS_PLANNING_HORIZON = 50;

export interface LogisticsGraphObservation {
  readonly edges: readonly LogisticsEdge[];
  readonly endpoints: readonly LogisticsContractEndpoint[];
  readonly nodes: readonly LogisticsNode[];
}

export interface LogisticsDomainHealth {
  readonly colonyId: string;
  readonly observedAt: number;
  readonly status: "healthy" | "failed";
}

export interface LogisticsRuntimeProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly contracts: LogisticsContractProjection;
  readonly graph: LogisticsGraphObservation;
  readonly health: readonly LogisticsDomainHealth[];
  readonly plan: LogisticsPlan;
}

export function emptyLogisticsRuntimeProjection(
  health: readonly LogisticsDomainHealth[] = [],
): LogisticsRuntimeProjection {
  return freeze({
    budgets: [],
    contracts: { commitments: [], retirements: [] },
    graph: { edges: [], endpoints: [], nodes: [] },
    health,
    plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
  });
}

/** Converts the current immutable observation into the bounded local-room flow graph. */
export function observeLogisticsGraph(
  snapshot: WorldSnapshot,
  includeOptional: boolean,
): LogisticsGraphObservation {
  const nodes: LogisticsNode[] = [];
  const endpoints: LogisticsContractEndpoint[] = [];
  for (const room of [...snapshot.rooms].sort((a, b) => a.name.localeCompare(b.name))) {
    if (room.controller?.ownership !== "owned") continue;
    const hasDedicatedHauler = room.ownedCreeps.some(
      ({ body }) => body.work.active === 0 && body.carry.active > 0 && body.move.active > 0,
    );
    if (hasDedicatedHauler) {
      for (const resource of [...(room.droppedResources ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        addEndpoint(nodes, endpoints, {
          acquireAction: "pickup",
          amount: resource.amount,
          colonyId: room.name,
          freeCapacity: 0,
          id: `drop:${resource.id}:source:${resource.resourceType}`,
          kind: "source",
          mandatory: true,
          observedAt: room.observedAt,
          position: resource.pos,
          resourceType: resource.resourceType,
          targetId: resource.id,
        });
      }
      for (const [kind, stores] of [
        ["ruin", room.ruins ?? []],
        ["tombstone", room.tombstones ?? []],
      ] as const) {
        for (const looseStore of [...stores].sort((a, b) => a.id.localeCompare(b.id))) {
          for (const resource of looseStore.store.resources) {
            if (resource.amount <= 0) continue;
            addEndpoint(nodes, endpoints, {
              acquireAction: "withdraw",
              amount: resource.amount,
              colonyId: room.name,
              freeCapacity: 0,
              id: `${kind}:${looseStore.id}:source:${resource.resourceType}`,
              kind: "source",
              mandatory: true,
              observedAt: room.observedAt,
              position: looseStore.pos,
              resourceType: resource.resourceType,
              targetId: looseStore.id,
            });
          }
        }
      }
    }
    for (const structure of [...room.storedStructures].sort((a, b) => a.id.localeCompare(b.id))) {
      if (structure.ownership === "foreign" || !LOGISTICS_STORE_TYPES.has(structure.structureType))
        continue;
      for (const resource of structure.store.resources) {
        if (structure.structureType === "nuker") continue;
        const reserve = structure.structureType === "storage" ? LOGISTICS_RECOVERY_RESERVE : 0;
        const amount = Math.max(0, resource.amount - reserve);
        if (amount <= 0) continue;
        addEndpoint(nodes, endpoints, {
          acquireAction: "withdraw",
          amount,
          colonyId: room.name,
          freeCapacity: 0,
          id: `store:${structure.id}:source:${resource.resourceType}`,
          kind: "source",
          mandatory: true,
          observedAt: room.observedAt,
          position: structure.pos,
          resourceType: resource.resourceType,
          targetId: structure.id,
        });
      }
      if (
        includeOptional &&
        !MATURE_DEMAND_STORE_TYPES.has(structure.structureType) &&
        structure.store.freeCapacity !== null &&
        structure.store.freeCapacity > 0
      ) {
        addEndpoint(nodes, endpoints, {
          amount: 0,
          colonyId: room.name,
          freeCapacity: structure.store.freeCapacity,
          id: `store:${structure.id}:sink:energy`,
          kind: "sink",
          mandatory: false,
          observedAt: room.observedAt,
          position: structure.pos,
          resourceType: "energy",
          targetId: structure.id,
        });
      }
    }
    const mandatorySinks = [...room.ownedSpawns, ...room.ownedExtensions, ...room.ownedTowers].sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    for (const sink of mandatorySinks) {
      if (sink.store.freeCapacity === null || sink.store.freeCapacity <= 0) continue;
      addEndpoint(nodes, endpoints, {
        amount: 0,
        colonyId: room.name,
        freeCapacity: sink.store.freeCapacity,
        id: `store:${sink.id}:sink:energy`,
        kind: "sink",
        mandatory: true,
        observedAt: room.observedAt,
        position: sink.pos,
        resourceType: "energy",
        targetId: sink.id,
      });
    }
  }
  const sources = nodes.filter(({ kind }) => kind === "source");
  const sinks = nodes.filter(({ kind }) => kind === "sink");
  const edges = sources.flatMap((source) =>
    sinks.flatMap((sink): readonly LogisticsEdge[] => {
      if (
        source.colonyId !== sink.colonyId ||
        source.resourceType !== sink.resourceType ||
        endpointTarget(endpoints, source.id) === endpointTarget(endpoints, sink.id)
      )
        return [];
      return [
        {
          id: `flow:${source.id}->${sink.id}`,
          roundTripTicks: Math.max(1, range(source.position, sink.position) * 2),
          sinkNodeId: sink.id,
          sourceNodeId: source.id,
        },
      ];
    }),
  );
  return freeze({ edges, endpoints, nodes });
}

const LOGISTICS_STORE_TYPES = new Set([
  "container",
  "factory",
  "lab",
  "nuker",
  "powerSpawn",
  "storage",
  "terminal",
]);

const MATURE_DEMAND_STORE_TYPES = new Set(["factory", "nuker", "powerSpawn"]);

export function planLogisticsRuntime(input: {
  readonly execution: ContractExecutionView;
  readonly includeOptional: boolean;
  readonly planning: ContractPlanningView;
  readonly resourceDemands?: LogisticsResourceDemandProjection;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LogisticsRuntimeProjection {
  if (input.execution.status !== "ready" || input.planning.status !== "ready") {
    return emptyLogisticsRuntimeProjection(logisticsHealth(input.snapshot, null, null));
  }
  const observed = observeLogisticsGraph(input.snapshot, input.includeOptional);
  const graph = mergeDemandGraph(observed, input.resourceDemands);
  const plan = planLogistics({
    edges: graph.edges,
    maximumNodeAge: LOGISTICS_MAXIMUM_NODE_AGE,
    nodes: graph.nodes,
    planningHorizon: LOGISTICS_PLANNING_HORIZON,
    tick: input.tick,
  });
  const previous = previousCommitments(input, graph, plan, observed);
  const progress = flowProgress(input, previous);
  const contracts = projectLogisticsContracts({
    endpoints: graph.endpoints,
    nodes: graph.nodes,
    plan,
    previous,
    progress,
    tick: input.tick,
  });
  const budgets = contracts.commitments.flatMap((commitment) => {
    if (commitment.budgetBinding !== undefined) return [];
    const { request, priorityClass } = commitment;
    const persisted = input.planning.contracts.find(
      ({ execution }) =>
        execution.version === 3 &&
        execution.flowId === commitment.flowId &&
        execution.stage === commitment.stage,
    );
    if (request?.execution?.version !== 3 && persisted === undefined) return [];
    const budgetBinding = request?.budgetBinding ?? persisted?.budgetBinding;
    const colonyId = request?.owner.id ?? persisted?.owner.id;
    if (budgetBinding === undefined || colonyId === undefined) return [];
    return [
      {
        colonyId,
        category: (priorityClass === "mandatory"
          ? "harvesting-filling"
          : "optional-growth") satisfies BudgetCategory,
        cpu: { minimum: priorityClass === "mandatory" ? 100 : 0, desired: 100 },
        energy: null,
        expiresAt:
          request?.expiresAt ??
          commitment.stageStartedAt + Math.max(1, commitment.roundTripTicks) + 51,
        issuer: budgetBinding.issuer,
        revision:
          request?.issuerSequence === undefined
            ? commitment.cycle * 2 + (commitment.stage === "acquire" ? 1 : 2)
            : request.issuerSequence + 1,
        spawn: null,
      } satisfies BudgetRequest,
    ];
  });
  return freeze({
    budgets,
    contracts,
    graph,
    health: logisticsHealth(input.snapshot, graph, plan),
    plan,
  });
}

const LOGISTICS_HEALTH_FAILURES = new Set([
  "duplicate-id",
  "edge-cap",
  "flow-cap",
  "invalid-edge",
  "invalid-node",
  "node-cap",
  "resource-mismatch",
  "stale-node",
  "vanished-node",
  "wrong-colony",
]);

function logisticsHealth(
  snapshot: WorldSnapshot,
  graph: LogisticsGraphObservation | null,
  plan: LogisticsPlan | null,
): readonly LogisticsDomainHealth[] {
  const rooms = snapshot.rooms
    .filter(({ controller }) => controller?.ownership === "owned")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (graph === null || plan === null) {
    return rooms.map(({ name, observedAt }) => ({
      colonyId: name,
      observedAt,
      status: "failed" as const,
    }));
  }
  const failed = new Set<string>();
  for (const projection of plan.projections) {
    if (
      projection.colonyId !== null &&
      projection.blocker !== null &&
      LOGISTICS_HEALTH_FAILURES.has(projection.blocker)
    ) {
      failed.add(projection.colonyId);
    }
  }
  for (const blocker of plan.blockers) {
    if (!LOGISTICS_HEALTH_FAILURES.has(blocker.reason)) continue;
    const colonies = blockerColonies(blocker.subject, blocker.id, graph);
    if (colonies.length === 0) {
      for (const room of rooms) failed.add(room.name);
    } else {
      for (const colonyId of colonies) failed.add(colonyId);
    }
  }
  return rooms.map(({ name, observedAt }) => ({
    colonyId: name,
    observedAt,
    status: failed.has(name) ? ("failed" as const) : ("healthy" as const),
  }));
}

function blockerColonies(
  subject: "edge" | "node",
  id: string,
  graph: LogisticsGraphObservation,
): readonly string[] {
  if (subject === "node") {
    return [
      ...new Set(graph.nodes.filter((node) => node.id === id).map(({ colonyId }) => colonyId)),
    ];
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return [
    ...new Set(
      graph.edges
        .filter((edge) => edge.id === id)
        .flatMap((edge) => [nodeById.get(edge.sourceNodeId), nodeById.get(edge.sinkNodeId)])
        .flatMap((node) => (node === undefined ? [] : [node.colonyId])),
    ),
  ];
}

/** Renews terminal logistics authority without making the planner own ledger revisions. */
export function executableLogisticsView(
  execution: ContractExecutionView,
  blockedFlowIds: ReadonlySet<string>,
): ContractExecutionView {
  if (execution.status !== "ready" || blockedFlowIds.size === 0) return execution;
  return freeze({
    leases: execution.leases.filter(
      ({ execution: terms }) => terms.version !== 3 || !blockedFlowIds.has(terms.flowId),
    ),
    status: execution.status,
  });
}

export function renewLogisticsBudgets(
  projection: LogisticsRuntimeProjection,
  existing: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[],
): LogisticsRuntimeProjection {
  const budgets = projection.budgets.map((budget) => {
    const prior = existing.find(
      (entry) =>
        entry.colonyId === budget.colonyId &&
        entry.category === budget.category &&
        entry.issuer === budget.issuer,
    );
    const reservable = prior?.status === "active" || prior?.status === "pending";
    const revision =
      prior === undefined
        ? budget.revision
        : reservable
          ? Math.max(budget.revision, prior.revision)
          : Math.max(budget.revision, prior.revision + 1);
    return freeze({ ...budget, revision });
  });
  return freeze({ ...projection, budgets: freeze(budgets) });
}

function previousCommitments(
  input: Pick<
    Parameters<typeof planLogisticsRuntime>[0],
    "execution" | "planning" | "snapshot" | "tick"
  >,
  graph: LogisticsGraphObservation,
  plan: LogisticsPlan,
  observed: LogisticsGraphObservation,
): readonly LogisticsCommitmentState[] {
  const projections = new Map(plan.projections.map((flow) => [flow.id, flow]));
  const observedEdges = uniqueById(observed.edges);
  const observedNodes = uniqueById(observed.nodes);
  const leases = new Map(
    input.execution.leases
      .filter(({ execution }) => execution.version === 3)
      .map((lease) => [lease.execution.version === 3 ? lease.execution.flowId : "", lease]),
  );
  return input.planning.contracts.flatMap((contract): readonly LogisticsCommitmentState[] => {
    if (contract.execution.version !== 3 || !contract.issuer.startsWith("logistics/")) return [];
    const execution = contract.execution;
    const flow =
      projections.get(execution.flowId) ??
      observedFlowProjection(execution.flowId, observedEdges, observedNodes);
    if (flow === undefined || flow.colonyId === null || flow.resourceType === null) return [];
    const lease = leases.get(execution.flowId);
    const cargo =
      lease === undefined ? 0 : actorCargo(input, lease.actorId, execution.resourceType);
    return [
      {
        colonyId: flow.colonyId,
        cycle: 0,
        cycleAmount: execution.stage === "deliver" ? Math.max(1, cargo) : execution.reservedAmount,
        deliveredAmount:
          execution.stage === "deliver" ? Math.max(0, execution.reservedAmount - cargo) : 0,
        flowId: execution.flowId,
        priorityClass:
          graph.nodes.find(({ id }) => id === flow.sinkNodeId)?.priority.class ?? "normal",
        recommendedCarry: execution.recommendedCarry,
        recommendedMove: execution.recommendedMove,
        reservedAmount: execution.reservedAmount,
        resourceType: execution.resourceType,
        roundTripTicks: flow.roundTripTicks,
        sinkNodeId: flow.sinkNodeId,
        sourceNodeId: flow.sourceNodeId,
        stage: execution.stage,
        stageStartedAt: input.tick,
        ...(contract.budgetBinding.category === "industry" ||
        (contract.budgetBinding.category === "optional-growth" &&
          contract.budgetBinding.issuer.startsWith("layout-migration/"))
          ? {
              budgetBinding: {
                category: contract.budgetBinding.category,
                issuer: contract.budgetBinding.issuer,
              },
            }
          : {}),
      },
    ];
  });
}

function observedFlowProjection(
  flowId: string,
  edges: ReadonlyMap<string, LogisticsEdge>,
  nodes: ReadonlyMap<string, LogisticsNode>,
): LogisticsProjection | undefined {
  const edge = edges.get(flowId);
  if (edge === undefined) return undefined;
  const source = nodes.get(edge.sourceNodeId);
  const sink = nodes.get(edge.sinkNodeId);
  if (
    source === undefined ||
    sink === undefined ||
    source.colonyId !== sink.colonyId ||
    source.resourceType !== sink.resourceType
  )
    return undefined;
  return {
    admittedAmount: 0,
    blocker: "vanished-node",
    colonyId: source.colonyId,
    id: edge.id,
    resourceType: source.resourceType,
    roundTripTicks: edge.roundTripTicks,
    sinkNodeId: edge.sinkNodeId,
    sourceNodeId: edge.sourceNodeId,
  };
}

function uniqueById<Value extends { readonly id: string }>(
  values: readonly Value[],
): ReadonlyMap<string, Value> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  return new Map(values.filter(({ id }) => counts.get(id) === 1).map((value) => [value.id, value]));
}

function mergeDemandGraph(
  observed: LogisticsGraphObservation,
  demands: LogisticsResourceDemandProjection | undefined,
): LogisticsGraphObservation {
  if (demands === undefined) return observed;
  const suppressedSinkTargets = validSuppressionSet(demands.suppressedSinkTargetIds ?? []);
  const suppressedSourceTargets = validSuppressionSet(demands.suppressedSourceTargetIds ?? []);
  const suppressedNodeIds = new Set(
    observed.endpoints.flatMap((endpoint) => {
      if (endpoint.targetId === null) return [];
      const node = observed.nodes.find(({ id }) => id === endpoint.nodeId);
      if (node?.kind === "sink" && suppressedSinkTargets.has(endpoint.targetId))
        return [endpoint.nodeId];
      if (node?.kind === "source" && suppressedSourceTargets.has(endpoint.targetId))
        return [endpoint.nodeId];
      return [];
    }),
  );
  const edges = [
    ...observed.edges.filter(
      ({ sinkNodeId, sourceNodeId }) =>
        !suppressedNodeIds.has(sinkNodeId) && !suppressedNodeIds.has(sourceNodeId),
    ),
    ...demands.edges,
  ];
  const endpoints = [
    ...observed.endpoints.filter(({ nodeId }) => !suppressedNodeIds.has(nodeId)),
    ...demands.endpoints,
  ];
  const nodes = [
    ...observed.nodes.filter(({ id }) => !suppressedNodeIds.has(id)),
    ...demands.nodes,
  ];
  if (
    edges.length > MAX_LOGISTICS_EDGES ||
    endpoints.length > MAX_LOGISTICS_NODES ||
    nodes.length > MAX_LOGISTICS_NODES
  )
    return observed;
  return freeze({ edges, endpoints, nodes });
}

function validSuppressionSet(values: readonly string[]): ReadonlySet<string> {
  return values.length <= 128 &&
    values.every((id) => id.length > 0 && id.length <= 128) &&
    new Set(values).size === values.length
    ? new Set(values)
    : new Set();
}

function flowProgress(
  input: Pick<
    Parameters<typeof planLogisticsRuntime>[0],
    "execution" | "planning" | "snapshot" | "tick"
  >,
  previous: readonly LogisticsCommitmentState[],
): readonly LogisticsFlowProgress[] {
  const actors = new Map(
    input.snapshot.rooms.flatMap((room) => room.ownedCreeps).map((actor) => [actor.id, actor]),
  );
  return previous.map((state): LogisticsFlowProgress => {
    const activeStage = input.planning.contracts.some(
      ({ execution, state: contractState }) =>
        contractState === "active" &&
        execution.version === 3 &&
        execution.flowId === state.flowId &&
        execution.stage === state.stage,
    );
    const lease = activeStage
      ? input.execution.leases.find(
          ({ execution }) =>
            execution.version === 3 &&
            execution.flowId === state.flowId &&
            execution.stage === state.stage,
        )
      : undefined;
    const actor = lease === undefined ? undefined : actors.get(lease.actorId);
    const cargoAmount =
      actor?.store.resources.find(({ resourceType }) => resourceType === state.resourceType)
        ?.amount ?? 0;
    return {
      actorState:
        lease === undefined
          ? "unleased"
          : actor === undefined
            ? "dead"
            : lease.leaseExpiresAt <= input.tick
              ? "lease-expired"
              : "alive",
      cargoAmount,
      deliveredAmount:
        state.stage === "deliver"
          ? Math.max(state.deliveredAmount, state.reservedAmount - cargoAmount)
          : state.deliveredAmount,
      flowId: state.flowId,
    };
  });
}

function actorCargo(
  input: Pick<Parameters<typeof planLogisticsRuntime>[0], "snapshot">,
  actorId: string,
  resourceType: string,
): number {
  const actor = input.snapshot.rooms
    .flatMap((room) => room.ownedCreeps)
    .find(({ id }) => id === actorId);
  return (
    actor?.store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0
  );
}

function addEndpoint(
  nodes: LogisticsNode[],
  endpoints: LogisticsContractEndpoint[],
  input: {
    readonly acquireAction?: "pickup" | "withdraw";
    readonly amount: number;
    readonly colonyId: string;
    readonly freeCapacity: number;
    readonly id: string;
    readonly kind: "sink" | "source";
    readonly mandatory: boolean;
    readonly observedAt: number;
    readonly position: LogisticsNode["position"];
    readonly resourceType: string;
    readonly targetId: string;
  },
): void {
  nodes.push({
    colonyId: input.colonyId,
    freeCapacity: input.freeCapacity,
    id: input.id,
    kind: input.kind,
    observedAmount: input.amount,
    observedAt: input.observedAt,
    position: input.position,
    priority: { class: input.mandatory ? "mandatory" : "normal", deadline: input.observedAt + 50 },
    resourceType: input.resourceType,
  });
  endpoints.push({
    ...(input.acquireAction === undefined ? {} : { acquireAction: input.acquireAction }),
    freeCapacity: input.freeCapacity,
    nodeId: input.id,
    observedAmount: input.amount,
    observedAt: input.observedAt,
    position: input.position,
    resourceType: input.resourceType,
    targetId: input.targetId,
  });
}

function endpointTarget(
  endpoints: readonly LogisticsContractEndpoint[],
  nodeId: string,
): string | null {
  return endpoints.find((endpoint) => endpoint.nodeId === nodeId)?.targetId ?? null;
}
function range(left: LogisticsNode["position"], right: LogisticsNode["position"]): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
