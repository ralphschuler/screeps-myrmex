import type { LayoutPlacement } from "../layout";
import type {
  PositionSnapshot,
  RoomSnapshot,
  StructureSnapshot,
  WorldSnapshot,
} from "../world/snapshot";

const REPAIR_HITS_PER_ENERGY = 100;

export type MaintenanceStructureClass = "road" | "container" | "ordinary" | "wall" | "rampart";
export type MaintenanceReason =
  "critical-flow-decay" | "fortification-band" | "layout-asset-damage" | "ordinary-damage";
export type MaintenanceDeferralReason =
  "energy-cap" | "proposal-cap" | "protected-reserve" | "scan-cap";

export interface ConstructionMaintenancePolicy {
  readonly containerFloorBasisPoints: number;
  readonly containerTargetBasisPoints: number;
  readonly fortificationHitsByRcl: readonly number[];
  readonly maximumDeferredRecords: number;
  readonly maximumEnergyPerRoom: number;
  readonly maximumEnergyPerTarget: number;
  readonly maximumProposalsPerRoom: number;
  readonly maximumScannedStructuresPerRoom: number;
  readonly ordinaryFloorBasisPoints: number;
  readonly ordinaryTargetBasisPoints: number;
  readonly roadDecayHorizon: number;
  readonly roadFloorBasisPoints: number;
  readonly roadTargetBasisPoints: number;
  readonly surplusFortificationMultiplier: number;
  readonly threatFortificationMultiplier: number;
}

export const DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY: ConstructionMaintenancePolicy = Object.freeze(
  {
    containerFloorBasisPoints: 5_000,
    containerTargetBasisPoints: 9_000,
    fortificationHitsByRcl: Object.freeze([
      0, 0, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000,
    ]),
    maximumDeferredRecords: 32,
    maximumEnergyPerRoom: 400,
    maximumEnergyPerTarget: 200,
    maximumProposalsPerRoom: 8,
    maximumScannedStructuresPerRoom: 128,
    ordinaryFloorBasisPoints: 7_500,
    ordinaryTargetBasisPoints: 9_500,
    roadDecayHorizon: 1_000,
    roadFloorBasisPoints: 4_000,
    roadTargetBasisPoints: 9_000,
    surplusFortificationMultiplier: 2,
    threatFortificationMultiplier: 2,
  },
);

export interface MaintenanceReserveObservation {
  readonly roomName: string;
  readonly state: "protected" | "surplus";
}

export interface MaintenanceTrafficObservation {
  readonly score: number;
  readonly targetId: string;
}

export interface MaintenanceProposal {
  readonly energyCost: number;
  readonly id: string;
  readonly layoutPlanned: boolean;
  readonly priority: number;
  readonly reason: MaintenanceReason;
  readonly roomName: string;
  readonly structureClass: MaintenanceStructureClass;
  readonly targetHits: number;
  readonly targetId: string;
  readonly targetPos: PositionSnapshot;
  readonly towerEligible: boolean;
  readonly trafficScore: number;
}

export interface MaintenanceDeferral {
  readonly reason: MaintenanceDeferralReason;
  readonly targetId: string;
}

export interface MaintenanceDomainHealth {
  readonly colonyId: string;
  readonly observedAt: number;
  readonly status: "healthy" | "failed";
}

export interface ConstructionPlanningResult {
  readonly deferred: readonly MaintenanceDeferral[];
  readonly deferredCount: number;
  readonly health: readonly MaintenanceDomainHealth[];
  readonly proposals: readonly MaintenanceProposal[];
  readonly scannedStructures: number;
  readonly truncatedStructures: number;
}

/** Sole pure policy owner for mature local structure-maintenance demand. */
export class ConstructionPlanner {
  plan(input: {
    readonly layouts: ReadonlyMap<string, readonly LayoutPlacement[]>;
    readonly policy?: ConstructionMaintenancePolicy;
    readonly reserves: readonly MaintenanceReserveObservation[];
    readonly snapshot: WorldSnapshot;
    readonly traffic: readonly MaintenanceTrafficObservation[];
  }): ConstructionPlanningResult {
    const policy = input.policy ?? DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY;
    const proposals: MaintenanceProposal[] = [];
    const deferred: MaintenanceDeferral[] = [];
    const health: MaintenanceDomainHealth[] = [];
    let deferredCount = 0;
    let scannedStructures = 0;
    let truncatedStructures = 0;
    for (const room of [...input.snapshot.rooms].sort((a, b) => a.name.localeCompare(b.name))) {
      if (room.controller?.ownership !== "owned") continue;
      const structures = repairableStructures(room);
      const considered = structures.slice(0, policy.maximumScannedStructuresPerRoom);
      let roomHealth: MaintenanceDomainHealth["status"] = "healthy";
      scannedStructures += considered.length;
      truncatedStructures += Math.max(0, structures.length - considered.length);
      if (structures.length > considered.length) {
        roomHealth = "failed";
        pushDeferral(deferred, policy, { reason: "scan-cap", targetId: room.name });
      }
      const reserve =
        input.reserves.find(({ roomName }) => roomName === room.name)?.state ?? "protected";
      const layout = input.layouts.get(room.name) ?? [];
      const roomCandidates = considered
        .flatMap((structure) => {
          const candidate = candidateFor(room, structure, layout, input.traffic, reserve, policy);
          if (candidate.proposal !== null) return [candidate.proposal];
          if (candidate.deferral !== null) {
            deferredCount += 1;
            pushDeferral(deferred, policy, candidate.deferral);
          }
          return [];
        })
        .sort(compareProposal);
      let energy = 0;
      for (const proposal of roomCandidates) {
        if (
          proposals.filter(({ roomName }) => roomName === room.name).length >=
          policy.maximumProposalsPerRoom
        ) {
          roomHealth = "failed";
          deferredCount += 1;
          pushDeferral(deferred, policy, { reason: "proposal-cap", targetId: proposal.targetId });
          continue;
        }
        if (energy + proposal.energyCost > policy.maximumEnergyPerRoom) {
          deferredCount += 1;
          pushDeferral(deferred, policy, { reason: "energy-cap", targetId: proposal.targetId });
          continue;
        }
        energy += proposal.energyCost;
        proposals.push(proposal);
      }
      health.push({
        colonyId: room.name,
        observedAt: room.observedAt,
        status: roomHealth,
      });
    }
    deferredCount += truncatedStructures;
    return freeze({
      deferred,
      deferredCount,
      health,
      proposals,
      scannedStructures,
      truncatedStructures,
    });
  }
}

function candidateFor(
  room: RoomSnapshot,
  structure: StructureSnapshot,
  layout: readonly LayoutPlacement[],
  traffic: readonly MaintenanceTrafficObservation[],
  reserve: MaintenanceReserveObservation["state"],
  policy: ConstructionMaintenancePolicy,
): { proposal: MaintenanceProposal | null; deferral: MaintenanceDeferral | null } {
  const structureClass = classify(structure.structureType);
  if (structureClass === null || structure.hitsMax <= 0) return none();
  const layoutPlanned = layout.some(
    ({ pos, structureType }) =>
      structureType === structure.structureType && samePosition(pos, structure.pos),
  );
  const trafficScore = Math.max(
    0,
    traffic.find(({ targetId }) => targetId === structure.id)?.score ?? 0,
  );
  const threat = room.hostileCreeps.length > 0;
  const band = targetBand(
    room.controller?.level ?? 0,
    structure,
    structureClass,
    reserve,
    threat,
    policy,
  );
  if (band === null)
    return reserve === "protected" && (structureClass === "wall" || structureClass === "rampart")
      ? { proposal: null, deferral: { reason: "protected-reserve", targetId: structure.id } }
      : none();
  const decaying =
    structure.ticksToDecay !== null &&
    structure.ticksToDecay !== undefined &&
    structure.ticksToDecay <= policy.roadDecayHorizon;
  const criticalFlow =
    trafficScore > 0 ||
    (layoutPlanned && (structureClass === "road" || structureClass === "container"));
  if (structure.hits >= band.floor && !decaying) return none();
  const missing = Math.max(0, band.target - structure.hits);
  if (missing <= 0) return none();
  const energyCost = Math.min(
    policy.maximumEnergyPerTarget,
    Math.max(1, Math.ceil(missing / REPAIR_HITS_PER_ENERGY)),
  );
  const reason: MaintenanceReason =
    structureClass === "wall" || structureClass === "rampart"
      ? "fortification-band"
      : criticalFlow && (decaying || trafficScore > 0)
        ? "critical-flow-decay"
        : layoutPlanned
          ? "layout-asset-damage"
          : "ordinary-damage";
  return {
    deferral: null,
    proposal: {
      energyCost,
      id: `maintenance/${room.name}/${structure.id}/${String(band.target)}`,
      layoutPlanned,
      priority: priorityFor(structureClass, layoutPlanned, trafficScore, decaying && criticalFlow),
      reason,
      roomName: room.name,
      structureClass,
      targetHits: band.target,
      targetId: structure.id,
      targetPos: structure.pos,
      towerEligible: !threat && reserve === "surplus" && structureClass !== "wall",
      trafficScore,
    },
  };
}

function targetBand(
  rcl: number,
  structure: StructureSnapshot,
  structureClass: MaintenanceStructureClass,
  reserve: MaintenanceReserveObservation["state"],
  threat: boolean,
  policy: ConstructionMaintenancePolicy,
): { floor: number; target: number } | null {
  if (structureClass === "wall" || structureClass === "rampart") {
    if (reserve !== "surplus") return null;
    const base = policy.fortificationHitsByRcl[Math.max(0, Math.min(8, rcl))] ?? 0;
    const multiplier =
      policy.surplusFortificationMultiplier * (threat ? policy.threatFortificationMultiplier : 1);
    const target = Math.min(structure.hitsMax, Math.max(0, base * multiplier));
    return target <= 0 ? null : { floor: Math.floor(target / 2), target };
  }
  const [floorBasisPoints, targetBasisPoints] =
    structureClass === "road"
      ? [policy.roadFloorBasisPoints, policy.roadTargetBasisPoints]
      : structureClass === "container"
        ? [policy.containerFloorBasisPoints, policy.containerTargetBasisPoints]
        : [policy.ordinaryFloorBasisPoints, policy.ordinaryTargetBasisPoints];
  return {
    floor: Math.floor((structure.hitsMax * floorBasisPoints) / 10_000),
    target: Math.floor((structure.hitsMax * targetBasisPoints) / 10_000),
  };
}

function repairableStructures(room: RoomSnapshot): StructureSnapshot[] {
  const byId = new Map<string, StructureSnapshot>();
  for (const structure of room.structures ?? []) byId.set(structure.id, structure);
  for (const road of room.roads ?? [])
    byId.set(road.id, {
      ...road,
      isPublic: null,
      ownerUsername: null,
      ownership: "unowned",
      structureType: "road",
    });
  for (const structure of room.storedStructures)
    if (structure.structureType === "container")
      byId.set(structure.id, { ...structure, isPublic: null });
  return [...byId.values()]
    .filter(
      ({ ownership, structureType }) => ownership !== "foreign" && structureType !== "controller",
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function classify(structureType: string): MaintenanceStructureClass | null {
  if (structureType === "road") return "road";
  if (structureType === "container") return "container";
  if (structureType === "constructedWall") return "wall";
  if (structureType === "rampart") return "rampart";
  return ["controller", "keeperLair", "portal", "powerBank", "invaderCore"].includes(structureType)
    ? null
    : "ordinary";
}

function priorityFor(
  structureClass: MaintenanceStructureClass,
  layoutPlanned: boolean,
  trafficScore: number,
  decaying: boolean,
): number {
  const classValue =
    structureClass === "road"
      ? 500
      : structureClass === "container"
        ? 450
        : structureClass === "ordinary"
          ? 400
          : 100;
  return (
    classValue +
    (layoutPlanned ? 200 : 0) +
    Math.min(200, Math.floor(trafficScore)) +
    (decaying ? 100 : 0)
  );
}

function compareProposal(a: MaintenanceProposal, b: MaintenanceProposal): number {
  return (
    b.priority - a.priority || a.targetId.localeCompare(b.targetId) || a.id.localeCompare(b.id)
  );
}
function samePosition(a: PositionSnapshot, b: PositionSnapshot): boolean {
  return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
}
function none() {
  return { proposal: null, deferral: null };
}
function pushDeferral(
  deferred: MaintenanceDeferral[],
  policy: ConstructionMaintenancePolicy,
  value: MaintenanceDeferral,
): void {
  if (deferred.length < policy.maximumDeferredRecords) deferred.push(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
