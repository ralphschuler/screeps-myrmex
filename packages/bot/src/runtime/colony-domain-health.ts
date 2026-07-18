import {
  COLONY_DOMAIN_HEALTH_DOMAINS,
  type ColonyDomainHealthDomain,
  type ColonyDomainHealthStatus,
} from "../colony";
import { LAYOUT_ALGORITHM_REVISION } from "../layout";

interface ActiveStructure {
  readonly active?: boolean;
  readonly id: string;
}

interface RuntimeHealthRoom {
  readonly name: string;
  readonly observedAt: number;
  readonly controller: { readonly level: number; readonly ownership: string } | null;
  readonly sources: readonly { readonly id: string }[];
  readonly ownedSpawns: readonly ActiveStructure[];
  readonly ownedExtensions: readonly ActiveStructure[];
  readonly ownedTowers: readonly ActiveStructure[];
  readonly ownedLinks?: readonly ActiveStructure[];
  readonly ownedLabs?: readonly ActiveStructure[];
}

interface LayoutHealthRecord {
  readonly algorithmRevision: string;
  readonly blockers: readonly unknown[];
  readonly roomName: string;
  readonly serviceBlockers?: readonly unknown[];
}

interface MiningHealthProjection {
  readonly blocker: string | null;
  readonly colonyId: string;
  readonly sourceId: string;
}

interface DirectDomainHealthStatus {
  readonly colonyId: string;
  readonly observedAt: number;
  readonly status: "healthy" | "failed";
}

interface ResourceHealthProjection {
  readonly extractorActive: boolean;
  readonly hasMineral: boolean;
  readonly hasStorage: boolean;
  readonly hasTerminal: boolean;
  readonly roomName: string;
}

interface MatureHealthProjection {
  readonly catalogAvailable: boolean;
  readonly capabilities: readonly {
    readonly active: boolean;
    readonly kind: string;
    readonly roomName: string;
  }[];
  readonly status: "ready" | "deferred";
}

export interface RuntimeColonyDomainHealthInput {
  readonly tick: number;
  readonly enabledDomains: ReadonlySet<ColonyDomainHealthDomain>;
  readonly rooms: readonly RuntimeHealthRoom[];
  readonly layoutRecords: readonly LayoutHealthRecord[];
  readonly miningProjections: readonly MiningHealthProjection[];
  readonly activeHarvestTargetIds: ReadonlySet<string>;
  readonly logisticsHealth: readonly DirectDomainHealthStatus[];
  readonly linkHealth: readonly DirectDomainHealthStatus[];
  readonly maintenanceHealth: readonly DirectDomainHealthStatus[];
  readonly resources: readonly ResourceHealthProjection[];
  readonly labAssignments: readonly { readonly roomName: string }[];
  readonly mature: MatureHealthProjection;
}

const REQUIRED_MATURE_KINDS = new Set(["factory", "nuker", "observer", "power-spawn"]);

/**
 * Adapts bounded direct owner outputs into the sole lifecycle authority's fixed health contract.
 * It reads no telemetry and retains no state.
 */
export function deriveRuntimeColonyDomainHealth(
  input: RuntimeColonyDomainHealthInput,
): readonly ColonyDomainHealthStatus[] {
  const statuses: ColonyDomainHealthStatus[] = [];
  const rooms = [...input.rooms]
    .filter(({ controller }) => controller?.ownership === "owned" && controller.level === 8)
    .sort((left, right) => compare(left.name, right.name));

  for (const room of rooms) {
    const logistics = directStatus(room, input.logisticsHealth);
    const links = directStatus(room, input.linkHealth);
    const maintenance = directStatus(room, input.maintenanceHealth);
    const checks: Readonly<Record<ColonyDomainHealthDomain, boolean>> = {
      layout: layoutHealthy(room, input.layoutRecords),
      mining: miningHealthy(room, input.miningProjections, input.activeHarvestTargetIds),
      logistics: logistics?.status === "healthy",
      links: links?.status === "healthy",
      maintenance: maintenance?.status === "healthy",
      resources: resourcesHealthy(room.name, input.resources),
      labs:
        activeCount(room.ownedLabs ?? []) >= 10 &&
        input.labAssignments.some(({ roomName }) => roomName === room.name),
      industry: industryHealthy(room.name, input.mature),
    };
    for (const domain of COLONY_DOMAIN_HEALTH_DOMAINS) {
      statuses.push(
        freeze({
          colonyId: room.name,
          domain,
          observedAt:
            domain === "logistics"
              ? (logistics?.observedAt ?? room.observedAt)
              : domain === "links"
                ? (links?.observedAt ?? room.observedAt)
                : domain === "maintenance"
                  ? (maintenance?.observedAt ?? room.observedAt)
                  : room.observedAt,
          status:
            input.enabledDomains.has(domain) && checks[domain]
              ? ("healthy" as const)
              : ("failed" as const),
        }),
      );
    }
  }
  return freeze(statuses);
}

function layoutHealthy(room: RuntimeHealthRoom, records: readonly LayoutHealthRecord[]): boolean {
  const record = records.find(({ roomName }) => roomName === room.name);
  return (
    record?.algorithmRevision === LAYOUT_ALGORITHM_REVISION &&
    record.blockers.length === 0 &&
    (record.serviceBlockers?.length ?? 0) === 0 &&
    activeCount(room.ownedSpawns) >= 3 &&
    activeCount(room.ownedExtensions) >= 60 &&
    activeCount(room.ownedTowers) >= 6
  );
}

function miningHealthy(
  room: RuntimeHealthRoom,
  projections: readonly MiningHealthProjection[],
  activeTargets: ReadonlySet<string>,
): boolean {
  if (room.sources.length === 0) return false;
  return room.sources.every(({ id }) => {
    const matches = projections.filter(
      ({ colonyId, sourceId }) => colonyId === room.name && sourceId === id,
    );
    return matches.length === 1 && matches[0]?.blocker === null && activeTargets.has(id);
  });
}

function directStatus(
  room: RuntimeHealthRoom,
  statuses: readonly DirectDomainHealthStatus[],
): DirectDomainHealthStatus | null {
  const matches = statuses.filter(({ colonyId }) => colonyId === room.name);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resourcesHealthy(
  roomName: string,
  projections: readonly ResourceHealthProjection[],
): boolean {
  const matches = projections.filter((projection) => projection.roomName === roomName);
  return (
    matches.length === 1 &&
    matches[0]?.extractorActive === true &&
    matches[0].hasMineral &&
    matches[0].hasStorage &&
    matches[0].hasTerminal
  );
}

function industryHealthy(roomName: string, mature: MatureHealthProjection): boolean {
  if (mature.status !== "ready" || !mature.catalogAvailable) return false;
  const kinds = new Set(
    mature.capabilities
      .filter(({ active, roomName: capabilityRoom }) => active && capabilityRoom === roomName)
      .map(({ kind }) => kind),
  );
  return [...REQUIRED_MATURE_KINDS].every((kind) => kinds.has(kind));
}

function activeCount(structures: readonly ActiveStructure[]): number {
  return structures.filter(({ active }) => active !== false).length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
