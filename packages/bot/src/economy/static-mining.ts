import type { BudgetRequest } from "../colony";
import type {
  CapabilityVector,
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { LayoutPlacement } from "../layout";
import type { PositionSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";

export type StaticMiningOffloadState =
  | "rcl-locked"
  | "site-needed"
  | "site-pending"
  | "container-ready"
  | "container-full"
  | "container-decaying"
  | "container-destroyed"
  | "link-candidate";

export interface StaticMiningProjection {
  readonly blocker: "layout-missing" | "room-lost" | "source-missing" | null;
  readonly budgetRequest: BudgetRequest | null;
  readonly colonyId: string;
  readonly contractRequest: WorkContractRequest | null;
  readonly identity: string;
  readonly offloadState: StaticMiningOffloadState | null;
  readonly sourceId: string;
  readonly workPosition: PositionSnapshot | null;
}

export interface StaticMiningPlan {
  readonly projections: readonly StaticMiningProjection[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

export function emptyStaticMiningPlan(): StaticMiningPlan {
  return freeze({ projections: [], requests: [], transitions: [] });
}

const EXPIRY = 1_000_000_000;

/** Sole projection of owned-source extraction. It emits data and owns no command or cache. */
export function planStaticMining(input: {
  readonly layouts: ReadonlyMap<string, readonly LayoutPlacement[]>;
  readonly planning?: ContractPlanningView;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): StaticMiningPlan {
  const projections: StaticMiningProjection[] = [];
  const requests: WorkContractRequest[] = [];
  const visibleColonies = new Set<string>();
  for (const room of [...input.snapshot.rooms].sort((a, b) => a.name.localeCompare(b.name))) {
    if (room.controller?.ownership !== "owned") continue;
    visibleColonies.add(room.name);
    const placements = input.layouts.get(room.name) ?? [];
    for (const source of [...room.sources].sort((a, b) => a.id.localeCompare(b.id))) {
      const identity = `mining/${room.name}/${source.id}`;
      const placement = placements.find(
        (item) => item.service?.kind === "source-container" && item.service.sourceId === source.id,
      );
      if (placement === undefined) {
        projections.push(blocked(room.name, source.id, identity, "layout-missing"));
        continue;
      }
      const capability = minerCapability(room.energyCapacityAvailable);
      const budgetRequest: BudgetRequest = {
        colonyId: room.name,
        category: "harvesting-filling",
        issuer: identity,
        revision: 1,
        expiresAt: EXPIRY,
        energy: null,
        cpu: { minimum: 1, desired: 1 },
        spawn: null,
      };
      const contractRequest = contract(
        identity,
        room.name,
        source.id,
        { roomName: source.pos.roomName, x: source.pos.x, y: source.pos.y },
        placement.pos,
        capability,
      );
      projections.push({
        blocker: null,
        budgetRequest,
        colonyId: room.name,
        contractRequest,
        identity,
        offloadState: offload(room, placement),
        sourceId: source.id,
        workPosition: placement.pos,
      });
      requests.push(contractRequest);
    }
  }
  const transitions: ContractTransitionRequest[] = [];
  if (input.planning?.status === "ready") {
    for (const existing of input.planning.contracts) {
      if (!existing.issuer.startsWith("mining/")) continue;
      const [, colonyId, sourceId] = existing.issuer.split("/");
      const room = input.snapshot.rooms.find((item) => item.name === colonyId);
      const current = projections.find((item) => item.identity === existing.issuer);
      if (room !== undefined && room.controller?.ownership !== "owned") {
        transitions.push({
          contractId: existing.contractId,
          reason: "static-room-lost",
          tick: input.tick,
          to: "suspended",
        });
      } else if (room !== undefined && !room.sources.some((source) => source.id === sourceId)) {
        transitions.push({
          contractId: existing.contractId,
          reason: "static-source-missing",
          tick: input.tick,
          to: "suspended",
        });
      } else if (visibleColonies.has(colonyId ?? "") && current?.blocker !== null) {
        transitions.push({
          contractId: existing.contractId,
          reason: "static-layout-unavailable",
          tick: input.tick,
          to: "suspended",
        });
      }
    }
  }
  return freeze({
    projections: projections.sort((a, b) => a.identity.localeCompare(b.identity)),
    requests: requests.sort((a, b) => a.issuer.localeCompare(b.issuer)),
    transitions: transitions.sort((a, b) => a.contractId.localeCompare(b.contractId)),
  });
}

export function minerCapability(energyCapacity: number): CapabilityVector {
  const work = energyCapacity >= 800 ? 5 : energyCapacity >= 550 ? 4 : 2;
  const move = work >= 5 ? 3 : work >= 4 ? 2 : 1;
  return { attack: 0, carry: 0, claim: 0, heal: 0, move, rangedAttack: 0, tough: 0, work };
}

function contract(
  identity: string,
  colonyId: string,
  sourceId: string,
  target: PositionSnapshot,
  workPosition: PositionSnapshot,
  capability: CapabilityVector,
): WorkContractRequest {
  return {
    budgetBinding: { category: "harvesting-filling", issuer: identity },
    conditions: {
      cancellation: "source-replaced",
      failure: "bounded-suspension",
      success: "continuous",
    },
    deadline: EXPIRY - 1,
    earliestStart: 0,
    estimatedWorkTicks: 50,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: null,
      version: 2,
      workPosition,
    },
    expiresAt: EXPIRY,
    issuer: identity,
    issuerKey: sourceId,
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 3 },
    maxAssignmentCost: 150,
    owner: { id: colonyId, kind: "colony" },
    preconditionKeys: ["visible-source", "fresh-source-service"],
    priority: { class: "survival", value: 950 },
    quantity: 50,
    range: 1,
    requiredCapability: capability,
    target,
    targetId: sourceId,
  };
}

function offload(room: RoomSnapshot, placement: LayoutPlacement): StaticMiningOffloadState {
  const rcl = room.controller?.level ?? 0;
  const at = (position: PositionSnapshot) =>
    position.x === placement.pos.x && position.y === placement.pos.y;
  const link = (room.structures ?? []).some(
    (item) =>
      item.structureType === "link" &&
      Math.max(Math.abs(item.pos.x - placement.pos.x), Math.abs(item.pos.y - placement.pos.y)) <= 1,
  );
  if (link) return "link-candidate";
  if (rcl < placement.minimumRcl) return "rcl-locked";
  const container = room.storedStructures.find(
    (item) => item.structureType === "container" && at(item.pos),
  );
  if (container !== undefined) {
    if (container.store.freeCapacity === 0) return "container-full";
    if (container.hits < container.hitsMax) return "container-decaying";
    return "container-ready";
  }
  if (room.constructionSites.some((item) => item.structureType === "container" && at(item.pos)))
    return "site-pending";
  return placement.adoption === "exact" ? "container-destroyed" : "site-needed";
}

function blocked(
  colonyId: string,
  sourceId: string,
  identity: string,
  blocker: StaticMiningProjection["blocker"],
): StaticMiningProjection {
  return {
    blocker,
    budgetRequest: null,
    colonyId,
    contractRequest: null,
    identity,
    offloadState: null,
    sourceId,
    workPosition: null,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
