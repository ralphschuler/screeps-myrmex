import type { ColonyView } from "../colony";
import type {
  ConstructionSiteSnapshot,
  MineralSnapshot,
  PositionSnapshot,
  StructureSnapshot,
  TerrainSnapshot,
} from "../world/snapshot";

export const LAYOUT_ALGORITHM_REVISION = "owned-room-layout-v2-source-services" as const;
export const LAYOUT_OWNER_SCHEMA_VERSION = 24 as const;
export const MAX_LAYOUT_ROOMS_PER_TICK = 2 as const;
export const MAX_LAYOUT_CANDIDATES = 256 as const;
export const MAX_LAYOUT_TRANSFORMS = 8 as const;
export const MAX_LAYOUT_FLOOD_CELLS = 2_500 as const;
export const MAX_LAYOUT_RECORDS = 64 as const;
export const MAX_LAYOUT_BLOCKERS = 8 as const;
export const MAX_CONSTRUCTION_SITE_RECEIPTS_PER_ROOM = 32 as const;
export const MAX_LAYOUT_EXTENSION_ENERGY = 200 as const;
export const MAX_LAYOUT_SPAWN_ENERGY = 300 as const;
export const MAX_LAYOUT_LAB_ENERGY = 2_000 as const;
export const MAX_LAYOUT_LAB_MINERAL = 3_000 as const;
export const MAX_LAYOUT_LAB_EVACUATION_FLOWS = 64 as const;
export const MAX_LAYOUT_STORAGE_CAPACITY = 1_000_000 as const;
export const MAX_LAYOUT_TERMINAL_CAPACITY = 300_000 as const;
export const MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT = 3_000 as const;
export const MAX_LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_AMOUNT = 6_000 as const;
export const MAX_LAYOUT_STORAGE_EVACUATION_RESOURCES = 8 as const;
export const MAX_LAYOUT_STORAGE_EVACUATION_FLOWS = 64 as const;
export const MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT = 3_000 as const;
export const MAX_LAYOUT_TERMINAL_EVACUATION_RESOURCES = 8 as const;
export const MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS = 64 as const;
export const MAX_LAYOUT_STORAGE_RESOURCES = 64 as const;
export const MAX_LAYOUT_LINK_ENERGY = 800 as const;
export const MAX_LAYOUT_TOWER_ENERGY = 1_000 as const;
/** Official energy cost of one tower attack, heal, or repair action. */
export const MINIMUM_OPERATIONAL_TOWER_ENERGY = 10 as const;
export const MAX_LAYOUT_CONTAINER_ENERGY = 2_000 as const;
export const MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES = 8 as const;
export const MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS = 64 as const;
export const MAX_LAYOUT_CONTAINER_STORE_RESOURCES = 64 as const;
export const MAX_LAYOUT_CONTAINER_FLOW_ID_LENGTH = 128 as const;
export const LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_LINK_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_SPAWN_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_STORAGE_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_TIMEOUT_TICKS = 300 as const;
export const LAYOUT_TERMINAL_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS = 150 as const;
export const LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS = 150 as const;
export const CONSTRUCTION_SITE_LIMITS = Object.freeze({
  officialHardCap: 100,
  reservedGlobalHeadroom: 5,
  acceptedGloballyPerTick: 2,
  acceptedPerRoomPerTick: 1,
  inspectedProposalsPerRoom: 64,
  activeSitesPerRoom: 10,
} as const);
export const STRUCTURE_REMOVAL_LIMITS = Object.freeze({
  acceptedGloballyPerTick: 1,
  inspectedCandidatesPerTick: 128,
} as const);

export type LayoutTransform = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type LayoutLayer = "primary" | "road" | "rampart";
export type LayoutAdoption = "planned" | "exact" | "matching-site" | "compatible-external";
export interface LayoutSemanticService {
  /** Absent is the initial issuance; explicit values begin at the first handoff sequence (2). */
  readonly issuerSequence?: number;
  readonly kind: "source-container";
  readonly sourceId: string;
}
export type LayoutBlocker =
  | "budget-exhausted"
  | "invalid-input"
  | "no-anchor"
  | "terrain-conflict"
  | "occupancy-conflict"
  | "access-blocked"
  | "policy-unavailable";

export interface LayoutPlacement {
  readonly adoption: LayoutAdoption;
  readonly layer: LayoutLayer;
  readonly minimumRcl: number;
  readonly pos: PositionSnapshot;
  readonly structureType: string;
  readonly service?: LayoutSemanticService;
}
export type SourceServiceBlockerReason = "missing-source-id" | "no-legal-position";
export interface SourceServiceBlocker {
  readonly kind: "source-container";
  readonly pos: PositionSnapshot;
  readonly reason: SourceServiceBlockerReason;
  readonly sourceId: string;
}
export interface LayoutCommitment {
  /** Persistence validates this against LAYOUT_ALGORITHM_REVISION; older values are stale rebuild inputs. */
  readonly algorithmRevision: string;
  readonly anchor: PositionSnapshot;
  readonly blockers: readonly LayoutBlocker[];
  readonly committedAt: number;
  readonly fingerprint: string;
  readonly serviceBlockers?: readonly SourceServiceBlocker[];
  readonly transform: LayoutTransform;
}
export interface LayoutExtensionEvacuation {
  readonly amount: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly sourceId: string;
  readonly startedAt: number;
}
export interface LayoutTowerEvacuation {
  readonly amount: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly sourceId: string;
  readonly startedAt: number;
}
export type LayoutStorageEvacuationResource = readonly [
  resourceType: string,
  amount: number,
  terminalInitialAmount: number,
];
interface LayoutStorageEvacuationCommon {
  readonly expiresAt: number;
  readonly sourceId: string;
  readonly startedAt: number;
  readonly terminalId: string;
}
export interface LayoutStorageSingleResourceEvacuation extends LayoutStorageEvacuationCommon {
  readonly amount: number;
  readonly resourceManifest?: never;
  readonly resourceType: string;
  readonly settledAmount?: never;
  readonly terminalInitialAmount: number;
}
export interface LayoutStorageSequentialEvacuation extends LayoutStorageEvacuationCommon {
  readonly amount: number;
  readonly resourceManifest?: never;
  readonly resourceType: string;
  /** Exact completed first-batch amount; zero while the first batch is current. */
  readonly settledAmount: number;
  readonly terminalInitialAmount: number;
}
export interface LayoutStorageResourceManifestEvacuation extends LayoutStorageEvacuationCommon {
  readonly amount?: never;
  /** Canonical binary-ordered tuples for two through eight resource kinds. */
  readonly resourceManifest: readonly LayoutStorageEvacuationResource[];
  readonly resourceType?: never;
  readonly settledAmount?: never;
  readonly terminalInitialAmount?: never;
}
export interface LayoutStorageSequentialResourceManifestEvacuation extends LayoutStorageEvacuationCommon {
  readonly amount?: never;
  /** Original canonical manifest; the settled cursor partitions it without storing batch arrays. */
  readonly resourceManifest: readonly LayoutStorageEvacuationResource[];
  readonly resourceType?: never;
  /** Exact completed first-batch amount; zero while the first batch is current. */
  readonly settledAmount: number;
  readonly terminalInitialAmount?: never;
}
export type LayoutStorageEvacuation =
  | LayoutStorageSingleResourceEvacuation
  | LayoutStorageSequentialEvacuation
  | LayoutStorageResourceManifestEvacuation
  | LayoutStorageSequentialResourceManifestEvacuation;
export type LayoutTerminalEvacuationResource = readonly [
  resourceType: string,
  amount: number,
  replacementInitialAmount: number,
];
interface LayoutTerminalEvacuationCommon {
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly sourceId: string;
  readonly startedAt: number;
}
export interface LayoutTerminalSingleResourceEvacuation extends LayoutTerminalEvacuationCommon {
  readonly amount: number;
  readonly replacementInitialAmount: number;
  readonly resourceManifest?: never;
  readonly resourceType: string;
}
export interface LayoutTerminalResourceManifestEvacuation extends LayoutTerminalEvacuationCommon {
  readonly amount?: never;
  readonly replacementInitialAmount?: never;
  /** Canonical binary-ordered tuples for two through eight resource kinds. */
  readonly resourceManifest: readonly LayoutTerminalEvacuationResource[];
  readonly resourceType?: never;
}
export type LayoutTerminalEvacuation =
  LayoutTerminalSingleResourceEvacuation | LayoutTerminalResourceManifestEvacuation;
export interface LayoutSpawnEvacuation {
  readonly amount: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly sourceId: string;
  readonly startedAt: number;
}
export interface LayoutLabEnergyEvacuation {
  readonly amount: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly sourceId: string;
  readonly startedAt: number;
}
export interface LayoutLabMineralEvacuation {
  readonly amount: number;
  readonly destinationId: string;
  readonly destinationInitialAmount: number;
  /** Absent preserves V12/V13 storage semantics; terminal is the only V14 alternative. */
  readonly destinationStructureType?: "terminal";
  readonly expiresAt: number;
  /** Canonical post-removal cluster member retained for safe structure removal. */
  readonly replacementId: string;
  readonly resourceType: string;
  readonly sourceId: string;
  readonly startedAt: number;
}
export interface LayoutLabMixedEvacuation {
  readonly destinationId: string;
  readonly destinationInitialAmount: number;
  /** Absent preserves V13 storage semantics; terminal is the only V14 alternative. */
  readonly destinationStructureType?: "terminal";
  readonly energyAmount: number;
  readonly expiresAt: number;
  readonly mineralAmount: number;
  /** Canonical post-removal cluster member retained for safe structure removal. */
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly resourceType: string;
  readonly sourceId: string;
  readonly startedAt: number;
}
export type LayoutLabEvacuation =
  LayoutLabEnergyEvacuation | LayoutLabMineralEvacuation | LayoutLabMixedEvacuation;
export interface LayoutLinkEvacuation {
  readonly amount: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy: number;
  readonly sourceId: string;
  readonly startedAt: number;
}
export type LayoutContainerMigrationResource = readonly [
  resourceType: string,
  amount: number,
  replacementInitialAmount: number,
];
export interface LayoutStructureRemovalReceipt {
  readonly attempt: number;
  readonly code: StructureDestroyExecutionCode;
  readonly nextEligibleTick: number;
  readonly observedAt: number;
  readonly replacementId: string;
  readonly targetId: string;
  readonly targetStructureType:
    "container" | "extension" | "lab" | "link" | "spawn" | "storage" | "terminal" | "tower";
}
export interface LayoutContainerMigration {
  /** Legacy paired fields remain valid for one exact energy transfer. */
  readonly energyAmount?: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy?: number;
  /** Canonical binary-ordered tuples for one non-energy or bounded multi-resource evacuation. */
  readonly resourceManifest?: readonly LayoutContainerMigrationResource[];
  /** Present only when the target is an unselected redundant container for this source. */
  readonly sourceId?: string;
  readonly startedAt: number;
  readonly targetId: string;
}

export interface LayoutRecord extends LayoutCommitment {
  readonly containerMigration?: LayoutContainerMigration;
  readonly extensionEvacuation?: LayoutExtensionEvacuation;
  readonly labEvacuation?: LayoutLabEvacuation;
  readonly linkEvacuation?: LayoutLinkEvacuation;
  readonly spawnEvacuation?: LayoutSpawnEvacuation;
  readonly storageEvacuation?: LayoutStorageEvacuation;
  readonly terminalEvacuation?: LayoutTerminalEvacuation;
  readonly towerEvacuation?: LayoutTowerEvacuation;
  /** One exact bounded receipt for the latest irreversible removal attempt in this room. */
  readonly removalReceipt?: LayoutStructureRemovalReceipt;
  readonly roomName: string;
  readonly sourceServices?: readonly LayoutPlacement[];
  readonly siteReceipts?: readonly ConstructionSiteAttemptReceipt[];
}

export function layoutContainerMigrationFlowId(
  roomName: string,
  migration: Pick<LayoutContainerMigration, "replacementId" | "targetId">,
): string {
  return `layout-container-evacuation:${roomName}:${migration.targetId}:${migration.replacementId}`;
}

export function layoutContainerMigrationBudgetIssuer(
  roomName: string,
  migration: Pick<LayoutContainerMigration, "replacementId" | "targetId">,
): string | null {
  return boundedContainerMigrationIdentity(roomName, migration, null);
}

export function layoutContainerMigrationResourceFlowId(
  roomName: string,
  migration: Pick<LayoutContainerMigration, "replacementId" | "targetId">,
  resourceType: string,
): string | null {
  const flowId = `${layoutContainerMigrationFlowId(roomName, migration)}:${String(resourceType.length)}:${resourceType}`;
  return flowId.length <= MAX_LAYOUT_CONTAINER_FLOW_ID_LENGTH ? flowId : null;
}

export function layoutContainerMigrationResourceBudgetIssuer(
  roomName: string,
  migration: Pick<LayoutContainerMigration, "replacementId" | "targetId">,
  resourceType: string,
): string | null {
  return boundedContainerMigrationIdentity(roomName, migration, resourceType);
}

function boundedContainerMigrationIdentity(
  roomName: string,
  migration: Pick<LayoutContainerMigration, "replacementId" | "targetId">,
  resourceType: string | null,
): string | null {
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(migration.targetId.length)}:${migration.targetId}`,
    `${String(migration.replacementId.length)}:${migration.replacementId}`,
    ...(resourceType === null ? [] : [`${String(resourceType.length)}:${resourceType}`]),
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export function layoutExtensionEvacuationFlowId(
  roomName: string,
  evacuation: Pick<LayoutExtensionEvacuation, "replacementId" | "sourceId">,
): string {
  return `layout-extension-evacuation:${roomName}:${evacuation.sourceId}:${evacuation.replacementId}`;
}

export function layoutExtensionEvacuationBudgetIssuer(
  roomName: string,
  evacuation: Pick<LayoutExtensionEvacuation, "replacementId" | "sourceId">,
): string | null {
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

interface LayoutLabEvacuationIdentity {
  readonly destinationId?: string;
  readonly replacementId: string;
  readonly resourceType?: string;
  readonly sourceId: string;
}

export function layoutLabEvacuationFlowId(
  roomName: string,
  evacuation: LayoutLabEvacuationIdentity,
): string | null {
  const mineralIdentity =
    evacuation.destinationId === undefined && evacuation.resourceType === undefined
      ? ""
      : evacuation.destinationId !== undefined && evacuation.resourceType !== undefined
        ? `:${String(evacuation.resourceType.length)}:${evacuation.resourceType}:${String(evacuation.destinationId.length)}:${evacuation.destinationId}`
        : null;
  if (mineralIdentity === null) return null;
  const flowId = `layout-lab-evacuation:${roomName}:${evacuation.sourceId}:${evacuation.replacementId}${mineralIdentity}`;
  return flowId.length <= 128 ? flowId : null;
}

export function layoutLabEvacuationBudgetIssuer(
  roomName: string,
  evacuation: LayoutLabEvacuationIdentity,
): string | null {
  if ((evacuation.destinationId === undefined) !== (evacuation.resourceType === undefined))
    return null;
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
    ...(evacuation.resourceType === undefined || evacuation.destinationId === undefined
      ? []
      : [
          `${String(evacuation.resourceType.length)}:${evacuation.resourceType}`,
          `${String(evacuation.destinationId.length)}:${evacuation.destinationId}`,
        ]),
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export function layoutLabEvacuationFlowIds(
  roomName: string,
  evacuation: LayoutLabEvacuation,
): readonly string[] | null {
  const ids = labEvacuationIdentities(evacuation).map((identity) =>
    layoutLabEvacuationFlowId(roomName, identity),
  );
  return ids.some((id) => id === null) ? null : (ids as readonly string[]);
}

export function layoutLabEvacuationBudgetIssuers(
  roomName: string,
  evacuation: LayoutLabEvacuation,
): readonly string[] | null {
  const issuers = labEvacuationIdentities(evacuation).map((identity) =>
    layoutLabEvacuationBudgetIssuer(roomName, identity),
  );
  return issuers.some((issuer) => issuer === null) ? null : (issuers as readonly string[]);
}

function labEvacuationIdentities(
  evacuation: LayoutLabEvacuation,
): readonly LayoutLabEvacuationIdentity[] {
  const energy = {
    replacementId: evacuation.replacementId,
    sourceId: evacuation.sourceId,
  } as const;
  if (!("resourceType" in evacuation)) return [energy];
  const mineral = {
    destinationId: evacuation.destinationId,
    replacementId: evacuation.replacementId,
    resourceType: evacuation.resourceType,
    sourceId: evacuation.sourceId,
  } as const;
  return "energyAmount" in evacuation ? [energy, mineral] : [mineral];
}

const LAYOUT_SPAWN_EVACUATION_FLOW_PREFIX = "layout-spawn-evacuation:" as const;

export function layoutSpawnEvacuationFlowId(
  roomName: string,
  evacuation: Pick<LayoutSpawnEvacuation, "replacementId" | "sourceId">,
): string | null {
  const flowId = `${LAYOUT_SPAWN_EVACUATION_FLOW_PREFIX}${roomName}:${evacuation.sourceId}:${evacuation.replacementId}`;
  return flowId.length <= 128 ? flowId : null;
}

export function isLayoutSpawnEvacuationFlowId(flowId: string): boolean {
  return flowId.startsWith(LAYOUT_SPAWN_EVACUATION_FLOW_PREFIX) && flowId.length <= 128;
}

export function layoutSpawnEvacuationBudgetIssuer(
  roomName: string,
  evacuation: Pick<LayoutSpawnEvacuation, "replacementId" | "sourceId">,
): string | null {
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

const LAYOUT_STORAGE_EVACUATION_FLOW_PREFIX = "layout-storage-evacuation:" as const;

interface LayoutStorageEvacuationIdentity {
  readonly resourceType: string;
  readonly settledAmount?: number;
  readonly sourceId: string;
  readonly terminalId: string;
}

export function layoutStorageEvacuationFlowId(
  roomName: string,
  evacuation: LayoutStorageEvacuationIdentity | LayoutStorageEvacuation,
): string | null {
  if (typeof evacuation.resourceType !== "string") return null;
  const batch = storageEvacuationBatchSuffix(evacuation);
  if (batch === null) return null;
  const flowId = `${LAYOUT_STORAGE_EVACUATION_FLOW_PREFIX}${roomName}:${evacuation.sourceId}:${evacuation.terminalId}:${String(evacuation.resourceType.length)}:${evacuation.resourceType}${batch}`;
  return flowId.length <= 128 ? flowId : null;
}

export function isLayoutStorageEvacuationFlowId(flowId: string): boolean {
  return flowId.startsWith(LAYOUT_STORAGE_EVACUATION_FLOW_PREFIX) && flowId.length <= 128;
}

export function layoutStorageEvacuationBudgetIssuer(
  roomName: string,
  evacuation: LayoutStorageEvacuationIdentity | LayoutStorageEvacuation,
): string | null {
  if (typeof evacuation.resourceType !== "string") return null;
  const batch = storageEvacuationBatchSuffix(evacuation);
  if (batch === null) return null;
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.terminalId.length)}:${evacuation.terminalId}`,
    `${String(evacuation.resourceType.length)}:${evacuation.resourceType}${batch}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export function layoutStorageEvacuationResources(
  evacuation: LayoutStorageEvacuation,
): readonly LayoutStorageEvacuationResource[] {
  const manifest = (evacuation as { readonly resourceManifest?: unknown }).resourceManifest;
  if (Array.isArray(manifest)) return manifest as readonly LayoutStorageEvacuationResource[];
  if (
    typeof evacuation.resourceType !== "string" ||
    typeof evacuation.amount !== "number" ||
    typeof evacuation.terminalInitialAmount !== "number"
  )
    return [];
  return [[evacuation.resourceType, evacuation.amount, evacuation.terminalInitialAmount]];
}

export function layoutStorageEvacuationCurrentBatchResources(
  evacuation: LayoutStorageEvacuation,
): readonly LayoutStorageEvacuationResource[] {
  const resources = layoutStorageEvacuationResources(evacuation);
  if (!("settledAmount" in evacuation)) return resources;
  const batchStart = evacuation.settledAmount;
  const totalAmount = resources.reduce((total, [, amount]) => total + amount, 0);
  const batchEnd = Math.min(totalAmount, batchStart + MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT);
  const current: LayoutStorageEvacuationResource[] = [];
  let resourceStart = 0;
  for (const [resourceType, amount, terminalInitialAmount] of resources) {
    const resourceEnd = resourceStart + amount;
    const currentAmount = Math.max(
      0,
      Math.min(resourceEnd, batchEnd) - Math.max(resourceStart, batchStart),
    );
    if (currentAmount > 0) {
      const priorAmount = Math.max(0, Math.min(amount, batchStart - resourceStart));
      current.push([resourceType, currentAmount, terminalInitialAmount + priorAmount]);
    }
    resourceStart = resourceEnd;
  }
  return current;
}

export function layoutStorageEvacuationFlowIds(
  roomName: string,
  evacuation: LayoutStorageEvacuation,
): readonly string[] | null {
  const ids = layoutStorageEvacuationCurrentBatchResources(evacuation).map(([resourceType]) =>
    layoutStorageEvacuationFlowId(roomName, { ...evacuation, resourceType }),
  );
  return ids.some((id) => id === null) ? null : (ids as readonly string[]);
}

export function layoutStorageEvacuationBudgetIssuers(
  roomName: string,
  evacuation: LayoutStorageEvacuation,
): readonly string[] | null {
  const issuers = layoutStorageEvacuationCurrentBatchResources(evacuation).map(([resourceType]) =>
    layoutStorageEvacuationBudgetIssuer(roomName, { ...evacuation, resourceType }),
  );
  return issuers.some((issuer) => issuer === null) ? null : (issuers as readonly string[]);
}

function storageEvacuationBatchSuffix(evacuation: {
  readonly settledAmount?: number;
}): "" | ":b1" | ":b2" | null {
  if (evacuation.settledAmount === undefined) return "";
  if (evacuation.settledAmount === 0) return ":b1";
  return evacuation.settledAmount === MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT ? ":b2" : null;
}

interface LayoutTerminalEvacuationIdentity {
  readonly replacementId: string;
  readonly resourceType: string;
  readonly sourceId: string;
}

export function layoutTerminalEvacuationFlowId(
  roomName: string,
  evacuation: LayoutTerminalEvacuationIdentity | LayoutTerminalEvacuation,
): string | null {
  if (typeof evacuation.resourceType !== "string") return null;
  const flowId = `layout-terminal-evacuation:${roomName}:${evacuation.sourceId}:${evacuation.replacementId}:${String(evacuation.resourceType.length)}:${evacuation.resourceType}`;
  return flowId.length <= 128 ? flowId : null;
}

export function layoutTerminalEvacuationBudgetIssuer(
  roomName: string,
  evacuation: LayoutTerminalEvacuationIdentity | LayoutTerminalEvacuation,
): string | null {
  if (typeof evacuation.resourceType !== "string") return null;
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
    `${String(evacuation.resourceType.length)}:${evacuation.resourceType}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export function layoutTerminalEvacuationResources(
  evacuation: LayoutTerminalEvacuation,
): readonly LayoutTerminalEvacuationResource[] {
  return "resourceManifest" in evacuation
    ? evacuation.resourceManifest
    : [[evacuation.resourceType, evacuation.amount, evacuation.replacementInitialAmount]];
}

export function layoutTerminalEvacuationFlowIds(
  roomName: string,
  evacuation: LayoutTerminalEvacuation,
): readonly string[] | null {
  const ids = layoutTerminalEvacuationResources(evacuation).map(([resourceType]) =>
    layoutTerminalEvacuationFlowId(roomName, { ...evacuation, resourceType }),
  );
  return ids.some((id) => id === null) ? null : (ids as readonly string[]);
}

export function layoutTerminalEvacuationBudgetIssuers(
  roomName: string,
  evacuation: LayoutTerminalEvacuation,
): readonly string[] | null {
  const issuers = layoutTerminalEvacuationResources(evacuation).map(([resourceType]) =>
    layoutTerminalEvacuationBudgetIssuer(roomName, { ...evacuation, resourceType }),
  );
  return issuers.some((issuer) => issuer === null) ? null : (issuers as readonly string[]);
}

export function layoutTowerEvacuationFlowId(
  roomName: string,
  evacuation: Pick<LayoutTowerEvacuation, "replacementId" | "sourceId">,
): string | null {
  const flowId = `layout-tower-evacuation:${roomName}:${evacuation.sourceId}:${evacuation.replacementId}`;
  return flowId.length <= 128 ? flowId : null;
}

export function layoutTowerEvacuationBudgetIssuer(
  roomName: string,
  evacuation: Pick<LayoutTowerEvacuation, "replacementId" | "sourceId">,
): string | null {
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export function layoutLinkEvacuationFlowId(
  roomName: string,
  evacuation: Pick<LayoutLinkEvacuation, "replacementId" | "sourceId">,
): string | null {
  const flowId = `layout-link-evacuation:${roomName}:${evacuation.sourceId}:${evacuation.replacementId}`;
  return flowId.length <= 128 ? flowId : null;
}

export function layoutLinkEvacuationBudgetIssuer(
  roomName: string,
  evacuation: Pick<LayoutLinkEvacuation, "replacementId" | "sourceId">,
): string | null {
  const issuer = [
    "layout-migration",
    `${String(roomName.length)}:${roomName}`,
    `${String(evacuation.sourceId.length)}:${evacuation.sourceId}`,
    `${String(evacuation.replacementId.length)}:${evacuation.replacementId}`,
  ].join("/");
  return issuer.length <= 128 ? issuer : null;
}

export type LayoutDiffRejectionReason =
  | "room-unknown"
  | "room-lost"
  | "policy-disabled"
  | "commitment-conflict"
  | "different-structure"
  | "foreign-site"
  | "different-site"
  | "rcl-locked"
  | "over-allowance";
export type LayoutDiffSuppressionReason = "existing-structure" | "existing-owned-site";
export interface LayoutSiteProposal {
  readonly colonyId: string;
  readonly layoutFingerprint: string;
  readonly observationFingerprint: string;
  readonly placementOrder: number;
  readonly policyFingerprint: string;
  readonly policyPriority: number;
  readonly pos: PositionSnapshot;
  readonly stableId: string;
  readonly structureType: string;
}
export interface LayoutDiffDecision {
  readonly placement: LayoutPlacement;
  readonly reason: LayoutDiffRejectionReason | LayoutDiffSuppressionReason;
  readonly stableId: string;
  readonly status: "rejected" | "suppressed";
}
export interface LayoutDiffInput {
  readonly colonyId: string;
  readonly commitment: LayoutCommitment;
  readonly commitmentConflicted: boolean;
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly observationFingerprint: string;
  readonly placements: readonly LayoutPlacement[];
  readonly policy: ColonyView["rclPolicy"];
  readonly policyEnabled: boolean;
  readonly policyFingerprint: string;
  readonly roomName: string;
  readonly roomStatus: "owned" | "unknown" | "lost";
  readonly structures: readonly StructureSnapshot[];
}
export interface LayoutDiffResult {
  readonly proposals: readonly LayoutSiteProposal[];
  readonly rejected: readonly LayoutDiffDecision[];
  readonly suppressed: readonly LayoutDiffDecision[];
}
export type ConstructionSiteAttemptCode =
  | "OK"
  | "ERR_FULL"
  | "ERR_RCL_NOT_ENOUGH"
  | "ERR_INVALID_TARGET"
  | "ERR_INVALID_ARGS"
  | "ERR_NOT_OWNER"
  | "UNEXPECTED";
export interface ConstructionSiteAttemptReceipt {
  readonly attempt: number;
  readonly code: ConstructionSiteAttemptCode;
  readonly layoutFingerprint: string;
  readonly nextEligibleTick: number;
  readonly observationFingerprint: string;
  readonly observedAt: number;
  readonly policyFingerprint: string;
  readonly proposalId: string;
  readonly roomName: string;
}
export interface ConstructionSiteAttemptResult {
  readonly code: ConstructionSiteAttemptCode;
  readonly proposal: LayoutSiteProposal;
  readonly tick: number;
}
export interface CreateConstructionSiteIntent {
  readonly colonyId: string;
  readonly kind: "create-construction-site";
  readonly layoutFingerprint: string;
  readonly observationFingerprint: string;
  readonly policyFingerprint: string;
  readonly proposalId: string;
  readonly roomName: string;
  readonly structureType: string;
  readonly x: number;
  readonly y: number;
}
export interface ConstructionSiteLimits {
  readonly officialHardCap: number;
  readonly reservedGlobalHeadroom: number;
  readonly acceptedGloballyPerTick: number;
  readonly acceptedPerRoomPerTick: number;
  readonly inspectedProposalsPerRoom: number;
  readonly activeSitesPerRoom: number;
}
export interface RoomConstructionSiteCount {
  readonly count: number;
  readonly roomName: string;
}
export interface ConstructionProgressionAuthorization {
  readonly authorized: boolean;
  readonly colonyId: string;
  readonly roomName: string;
}
export type ConstructionSiteDeferredReason =
  | "global-headroom"
  | "global-tick-limit"
  | "room-tick-limit"
  | "room-active-limit"
  | "inspection-limit"
  | "receipt-ok-expectation"
  | "receipt-full-backoff"
  | "receipt-rcl-policy"
  | "receipt-invalid-target"
  | "receipt-not-owner"
  | "receipt-unexpected-backoff";
export type ConstructionSiteRejectedReason = "progression-not-authorized" | "receipt-invalid-args";
export interface ConstructionSiteArbitrationRecord {
  readonly proposal: LayoutSiteProposal;
  readonly reason?: ConstructionSiteDeferredReason | ConstructionSiteRejectedReason;
  readonly status: "accepted" | "deferred" | "rejected";
}
export interface ConstructionSiteArbitrationInput {
  readonly globalOwnedSiteCount: number;
  readonly limits: ConstructionSiteLimits;
  readonly perRoomSiteCounts: readonly RoomConstructionSiteCount[];
  readonly priorReceipts: readonly ConstructionSiteAttemptReceipt[];
  readonly progressionAuthorizations: readonly ConstructionProgressionAuthorization[];
  readonly proposals: readonly LayoutSiteProposal[];
  readonly tick: number;
}
export interface ConstructionSiteArbitrationResult {
  readonly accepted: readonly ConstructionSiteArbitrationRecord[];
  readonly deferred: readonly ConstructionSiteArbitrationRecord[];
  readonly intents: readonly CreateConstructionSiteIntent[];
  readonly rejected: readonly ConstructionSiteArbitrationRecord[];
}
export interface ConstructionSiteExecutionResult {
  readonly called: boolean;
  readonly code: ConstructionSiteAttemptCode;
  readonly fault:
    "adapter-fault" | "room-not-owned" | "room-unavailable" | "stale-commitment" | null;
  readonly intent: CreateConstructionSiteIntent;
}
export interface LayoutRuntimePlanRecord {
  readonly blocker: LayoutBlocker | null;
  readonly fingerprint: string | null;
  readonly roomName: string;
  readonly status: "complete" | "degraded";
}

export type LayoutMigrationBlocker =
  | "allowance-full"
  | "candidate-cap"
  | "colony-unsafe"
  | "controller-risk"
  | "global-site-headroom"
  | "industry-active"
  | "industry-unavailable"
  | "lab-cluster-invalid"
  | "evacuation-capacity"
  | "evacuation-expired"
  | "evacuation-incomplete"
  | "evacuation-pending"
  | "layout-blocked"
  | "logistics-active"
  | "logistics-unavailable"
  | "migration-expired"
  | "migration-pending"
  | "progression-blocked"
  | "replacement-pending"
  | "removal-backoff"
  | "removal-failed"
  | "removal-pending"
  | "reserve-unrestored"
  | "room-site-cap"
  | "site-conflict"
  | "spawn-selected"
  | "target-shared"
  | "target-stocked"
  | "target-unavailable"
  | "threat"
  | "workforce-unavailable";
interface LayoutMigrationProposalBase {
  readonly colonyId: string;
  readonly layoutFingerprint: string;
  readonly observationFingerprint: string;
  readonly policyFingerprint: string;
  readonly pos: PositionSnapshot;
  readonly stableId: string;
  readonly targetId: string;
}
export type LayoutMigrationProposal =
  | (LayoutMigrationProposalBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "container";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "container";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "extension";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "extension";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementId: string;
      /** Present only after a stocked-spawn handoff; freshly revalidated before destroy. */
      readonly replacementMinimumEnergy?: number;
      readonly replacementRequiresIdle: true;
      readonly replacementStructureType: "spawn";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresIdle: true;
      readonly targetStructureType: "spawn";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "tower";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "tower";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementExpectedStoreCapacity: typeof MAX_LAYOUT_TERMINAL_CAPACITY;
      readonly replacementId: string;
      readonly replacementStructureType: "terminal";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "storage";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementExpectedStoreCapacity: typeof MAX_LAYOUT_STORAGE_CAPACITY;
      readonly replacementId: string;
      readonly replacementStructureType: "storage";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "terminal";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "lab";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "lab";
    })
  | (LayoutMigrationProposalBase & {
      readonly replacementExpectedEnergy: number;
      readonly replacementId: string;
      readonly replacementRequiresZeroCooldown: true;
      readonly replacementStructureType: "link";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "link";
    });
export interface LayoutMigrationBlockerRecord {
  readonly reason: LayoutMigrationBlocker;
  readonly roomName: string;
  readonly targetId: string | null;
}
export interface LayoutMigrationAuthorization {
  readonly colonyId: string;
  readonly layoutFingerprint: string;
  readonly observationFingerprint: string;
  readonly policyFingerprint: string;
  readonly roomName: string;
}
export interface LayoutMigrationPlanningResult {
  readonly authorization: LayoutMigrationAuthorization | null;
  readonly blockers: readonly LayoutMigrationBlockerRecord[];
  readonly containerMigration: LayoutContainerMigration | null;
  readonly extensionEvacuation: LayoutExtensionEvacuation | null;
  readonly labEvacuation: LayoutLabEvacuation | null;
  readonly linkEvacuation: LayoutLinkEvacuation | null;
  readonly spawnEvacuation: LayoutSpawnEvacuation | null;
  readonly storageEvacuation: LayoutStorageEvacuation | null;
  readonly terminalEvacuation: LayoutTerminalEvacuation | null;
  readonly towerEvacuation: LayoutTowerEvacuation | null;
  readonly proposals: readonly LayoutMigrationProposal[];
  readonly removalReceipt: LayoutStructureRemovalReceipt | null;
  readonly scannedCandidates: number;
  readonly truncatedCandidates: number;
}
export interface StructureRemovalLimits {
  readonly acceptedGloballyPerTick: number;
  readonly inspectedCandidatesPerTick: number;
}
export type StructureRemovalArbitrationReason =
  | "authorization-missing"
  | "duplicate-proposal"
  | "duplicate-target"
  | "global-tick-limit"
  | "invalid-proposal";
export interface StructureRemovalArbitrationRecord {
  readonly proposal: LayoutMigrationProposal;
  readonly reason?: StructureRemovalArbitrationReason;
  readonly status: "accepted" | "deferred" | "rejected";
}
interface DestroyOwnedStructureIntentBase {
  readonly colonyId: string;
  readonly kind: "destroy-owned-structure";
  readonly layoutFingerprint: string;
  readonly observationFingerprint: string;
  readonly policyFingerprint: string;
  readonly roomName: string;
  readonly stableId: string;
  readonly targetId: string;
  readonly x: number;
  readonly y: number;
}
export type DestroyOwnedStructureIntent =
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "container";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "container";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "extension";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "extension";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementId: string;
      readonly replacementMinimumEnergy?: number;
      readonly replacementRequiresIdle: true;
      readonly replacementStructureType: "spawn";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresIdle: true;
      readonly targetStructureType: "spawn";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "tower";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "tower";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementExpectedStoreCapacity: typeof MAX_LAYOUT_TERMINAL_CAPACITY;
      readonly replacementId: string;
      readonly replacementStructureType: "terminal";
      readonly targetRequiresEmptyStore: true;
      readonly targetStructureType: "storage";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementExpectedStoreCapacity: typeof MAX_LAYOUT_STORAGE_CAPACITY;
      readonly replacementId: string;
      readonly replacementStructureType: "storage";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "terminal";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementId: string;
      readonly replacementStructureType: "lab";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "lab";
    })
  | (DestroyOwnedStructureIntentBase & {
      readonly replacementExpectedEnergy: number;
      readonly replacementId: string;
      readonly replacementRequiresZeroCooldown: true;
      readonly replacementStructureType: "link";
      readonly targetRequiresEmptyStore: true;
      readonly targetRequiresZeroCooldown: true;
      readonly targetStructureType: "link";
    });
export interface StructureRemovalArbitrationInput {
  readonly authorizations: readonly LayoutMigrationAuthorization[];
  readonly limits: StructureRemovalLimits;
  readonly proposals: readonly LayoutMigrationProposal[];
}
export interface StructureRemovalArbitrationResult {
  readonly accepted: readonly StructureRemovalArbitrationRecord[];
  readonly deferred: readonly StructureRemovalArbitrationRecord[];
  readonly intents: readonly DestroyOwnedStructureIntent[];
  readonly rejected: readonly StructureRemovalArbitrationRecord[];
  readonly truncatedCandidates: number;
}
export type StructureDestroyExecutionCode =
  "OK" | "ERR_NOT_OWNER" | "ERR_BUSY" | "TARGET_ABSENT" | "ERR_INVALID_TARGET" | "UNEXPECTED";
export interface StructureDestroyExecutionResult {
  readonly called: boolean;
  readonly code: StructureDestroyExecutionCode;
  readonly fault:
    | "adapter-fault"
    | "hostiles-present"
    | "room-not-owned"
    | "replacement-absent"
    | "replacement-cooldown"
    | "replacement-energy-mismatch"
    | "replacement-busy"
    | "replacement-mismatch"
    | "replacement-store-mismatch"
    | "replacement-underfunded"
    | "room-unavailable"
    | "stale-commitment"
    | "target-absent"
    | "target-busy"
    | "target-cooldown"
    | "target-mismatch"
    | "target-not-empty"
    | null;
  readonly intent: DestroyOwnedStructureIntent;
}
export interface LayoutMigrationRuntimeResult {
  readonly arbitration: StructureRemovalArbitrationResult | null;
  readonly blockers: readonly LayoutMigrationBlockerRecord[];
  readonly execution: readonly StructureDestroyExecutionResult[];
  readonly proposals: readonly LayoutMigrationProposal[];
  readonly scannedCandidates: number;
  readonly truncatedCandidates: number;
}
export interface LayoutRuntimeResult {
  readonly arbitration: ConstructionSiteArbitrationResult | null;
  readonly execution: readonly ConstructionSiteExecutionResult[];
  readonly migration: LayoutMigrationRuntimeResult;
  readonly planning: readonly LayoutRuntimePlanRecord[];
  readonly receiptsWritten: number;
  readonly status: "disabled" | "not-run" | "planned";
}
export interface LayoutsOwnerV24 {
  readonly schemaVersion: typeof LAYOUT_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly LayoutRecord[];
}

export interface LayoutPlanningInput {
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly controller: PositionSnapshot;
  readonly exits: readonly PositionSnapshot[];
  readonly mineral: MineralSnapshot | null;
  readonly policy: ColonyView["rclPolicy"];
  readonly priorCommitment: LayoutCommitment | null;
  readonly priorSourceServices?: readonly LayoutPlacement[];
  readonly roomName: string;
  readonly sourceServiceHandoffAuthorized?: boolean;
  readonly sources: readonly PositionSnapshot[];
  readonly structures: readonly StructureSnapshot[];
  readonly terrain: TerrainSnapshot;
  readonly tick: number;
}
export interface SourceServicePlanningInput {
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly placements: readonly LayoutPlacement[];
  readonly priorSourceServices?: readonly LayoutPlacement[];
  readonly roomName: string;
  readonly sourceServiceHandoffAuthorized?: boolean;
  readonly sources: readonly PositionSnapshot[];
  readonly structures: readonly StructureSnapshot[];
  readonly terrain: TerrainSnapshot;
}
export interface SourceServicePlanningResult {
  readonly blockers: readonly SourceServiceBlocker[];
  readonly candidatesInspected: number;
  readonly placements: readonly LayoutPlacement[];
}
export type LayoutPlanningResult =
  | {
      readonly status: "complete";
      readonly commitment: LayoutCommitment;
      readonly placements: readonly LayoutPlacement[];
      readonly candidatesInspected: number;
      readonly transformsInspected: number;
      readonly floodCellsInspected: number;
    }
  | {
      readonly status: "degraded";
      readonly blocker: LayoutBlocker;
      readonly commitment: LayoutCommitment | null;
      readonly placements: readonly [];
      readonly candidatesInspected: number;
      readonly transformsInspected: number;
      readonly floodCellsInspected: number;
    };
