import type { ColonyView } from "../colony";
import type {
  ConstructionSiteSnapshot,
  MineralSnapshot,
  PositionSnapshot,
  StructureSnapshot,
  TerrainSnapshot,
} from "../world/snapshot";

export const LAYOUT_ALGORITHM_REVISION = "owned-room-layout-v2-source-services" as const;
export const LAYOUT_OWNER_SCHEMA_VERSION = 4 as const;
export const MAX_LAYOUT_ROOMS_PER_TICK = 2 as const;
export const MAX_LAYOUT_CANDIDATES = 256 as const;
export const MAX_LAYOUT_TRANSFORMS = 8 as const;
export const MAX_LAYOUT_FLOOD_CELLS = 2_500 as const;
export const MAX_LAYOUT_RECORDS = 64 as const;
export const MAX_LAYOUT_BLOCKERS = 8 as const;
export const MAX_CONSTRUCTION_SITE_RECEIPTS_PER_ROOM = 32 as const;
export const MAX_LAYOUT_EXTENSION_ENERGY = 200 as const;
export const MAX_LAYOUT_CONTAINER_ENERGY = 2_000 as const;
export const MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES = 8 as const;
export const MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS = 64 as const;
export const MAX_LAYOUT_CONTAINER_STORE_RESOURCES = 64 as const;
export const MAX_LAYOUT_CONTAINER_FLOW_ID_LENGTH = 128 as const;
export const LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS = 150 as const;
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
export type LayoutContainerMigrationResource = readonly [
  resourceType: string,
  amount: number,
  replacementInitialAmount: number,
];
export interface LayoutContainerRemovalReceipt {
  readonly attempt: number;
  readonly code: StructureDestroyExecutionCode;
  readonly nextEligibleTick: number;
  readonly observedAt: number;
}
export interface LayoutContainerMigration {
  /** Legacy paired fields remain valid for one exact energy transfer. */
  readonly energyAmount?: number;
  readonly expiresAt: number;
  readonly replacementId: string;
  readonly replacementInitialEnergy?: number;
  /** Canonical binary-ordered tuples for one non-energy or bounded multi-resource evacuation. */
  readonly resourceManifest?: readonly LayoutContainerMigrationResource[];
  /** Bounded destroy retry evidence; valid only for a source-specific evacuation. */
  readonly removalReceipt?: LayoutContainerRemovalReceipt;
  /** Present only when the target is an unselected redundant container for this source. */
  readonly sourceId?: string;
  readonly startedAt: number;
  readonly targetId: string;
}

export interface LayoutRecord extends LayoutCommitment {
  readonly containerMigration?: LayoutContainerMigration;
  readonly extensionEvacuation?: LayoutExtensionEvacuation;
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
      readonly replacementId: null;
      readonly replacementStructureType: "tower";
      readonly targetRequiresEmptyStore: false;
      readonly targetStructureType: "road";
    })
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
  readonly proposals: readonly LayoutMigrationProposal[];
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
      readonly replacementId: null;
      readonly replacementStructureType: "tower";
      readonly targetRequiresEmptyStore: false;
      readonly targetStructureType: "road";
    })
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
    | "replacement-mismatch"
    | "room-unavailable"
    | "stale-commitment"
    | "target-absent"
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
export interface LayoutsOwnerV4 {
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
