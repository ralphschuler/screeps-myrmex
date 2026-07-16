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
  planLogistics,
  type LogisticsEdge,
  type LogisticsNode,
  type LogisticsPlan,
} from "./planner";

const LOGISTICS_RECOVERY_RESERVE = 300;
const LOGISTICS_MAXIMUM_NODE_AGE = 0;
const LOGISTICS_PLANNING_HORIZON = 50;

export interface LogisticsGraphObservation {
  readonly edges: readonly LogisticsEdge[];
  readonly endpoints: readonly LogisticsContractEndpoint[];
  readonly nodes: readonly LogisticsNode[];
}

export interface LogisticsRuntimeProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly contracts: LogisticsContractProjection;
  readonly graph: LogisticsGraphObservation;
  readonly plan: LogisticsPlan;
}

export function emptyLogisticsRuntimeProjection(): LogisticsRuntimeProjection {
  return freeze({
    budgets: [],
    contracts: { commitments: [], retirements: [] },
    graph: { edges: [], endpoints: [], nodes: [] },
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
    for (const resource of [...(room.droppedResources ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      addEndpoint(nodes, endpoints, {
        acquireAction: "pickup",
        amount: resource.amount,
        colonyId: room.name,
        freeCapacity: 0,
        id: `drop:${resource.id}:${resource.resourceType}`,
        kind: "source",
        mandatory: true,
        observedAt: room.observedAt,
        position: resource.pos,
        resourceType: resource.resourceType,
        targetId: resource.id,
      });
    }
    for (const structure of [...room.storedStructures].sort((a, b) => a.id.localeCompare(b.id))) {
      if (structure.ownership === "foreign" || !LOGISTICS_STORE_TYPES.has(structure.structureType))
        continue;
      for (const resource of structure.store.resources) {
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

export function planLogisticsRuntime(input: {
  readonly execution: ContractExecutionView;
  readonly includeOptional: boolean;
  readonly planning: ContractPlanningView;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LogisticsRuntimeProjection {
  if (input.execution.status !== "ready" || input.planning.status !== "ready")
    return emptyLogisticsRuntimeProjection();
  const graph = observeLogisticsGraph(input.snapshot, input.includeOptional);
  const plan = planLogistics({
    edges: graph.edges,
    maximumNodeAge: LOGISTICS_MAXIMUM_NODE_AGE,
    nodes: graph.nodes,
    planningHorizon: LOGISTICS_PLANNING_HORIZON,
    tick: input.tick,
  });
  const previous = previousCommitments(input, graph, plan);
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
  return freeze({ budgets, contracts, graph, plan });
}

/** Renews terminal logistics authority without making the planner own ledger revisions. */
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
): readonly LogisticsCommitmentState[] {
  const projections = new Map(plan.projections.map((flow) => [flow.id, flow]));
  const leases = new Map(
    input.execution.leases
      .filter(({ execution }) => execution.version === 3)
      .map((lease) => [lease.execution.version === 3 ? lease.execution.flowId : "", lease]),
  );
  return input.planning.contracts.flatMap((contract): readonly LogisticsCommitmentState[] => {
    if (contract.execution.version !== 3 || !contract.issuer.startsWith("logistics/")) return [];
    const execution = contract.execution;
    const flow = projections.get(execution.flowId);
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
      },
    ];
  });
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
