import type { ColonyView } from "../colony";
import { fingerprintLabLayout, type LabMigrationRoomView } from "../industry/lab-composition";
import { assignLabCluster } from "../industry/lab-cluster";
import {
  classifyLinks,
  deriveLinkRoleAnchors,
  type LinkLayoutEvidence,
  type LinkRoomRuntimeResult,
  type ObservedLink,
} from "../links";
import {
  CONSTRUCTION_SITE_LIMITS,
  LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_LINK_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_CONTAINER_ENERGY,
  MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES,
  MAX_LAYOUT_CONTAINER_STORE_RESOURCES,
  MAX_LAYOUT_EXTENSION_ENERGY,
  MAX_LAYOUT_LAB_ENERGY,
  MAX_LAYOUT_LAB_MINERAL,
  MAX_LAYOUT_LINK_ENERGY,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_RESOURCES,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  MAX_LAYOUT_TOWER_ENERGY,
  MINIMUM_OPERATIONAL_TOWER_ENERGY,
  STRUCTURE_REMOVAL_LIMITS,
  layoutContainerMigrationBudgetIssuer,
  layoutContainerMigrationFlowId,
  layoutContainerMigrationResourceBudgetIssuer,
  layoutContainerMigrationResourceFlowId,
  layoutExtensionEvacuationFlowId,
  layoutLabEvacuationBudgetIssuers,
  layoutLabEvacuationFlowIds,
  layoutLinkEvacuationBudgetIssuer,
  layoutLinkEvacuationFlowId,
  layoutTowerEvacuationBudgetIssuer,
  layoutTowerEvacuationFlowId,
  type LayoutCommitment,
  type LayoutContainerMigration,
  type LayoutContainerMigrationResource,
  type LayoutExtensionEvacuation,
  type LayoutLabEvacuation,
  type LayoutLinkEvacuation,
  type LayoutMigrationBlocker,
  type LayoutMigrationBlockerRecord,
  type LayoutMigrationPlanningResult,
  type LayoutMigrationProposal,
  type LayoutPlacement,
  type LayoutStructureRemovalReceipt,
  type LayoutTowerEvacuation,
} from "../layout";
import type {
  PositionSnapshot,
  RoomSnapshot,
  StoredStructureSnapshot,
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

  /** Plans bounded container and extension convergence. */
  planMigration(input: {
    readonly activeLogisticsFlowIds?: ReadonlySet<string>;
    readonly activeLogisticsTargetIds?: ReadonlySet<string>;
    readonly colony: ColonyView;
    readonly commitment: LayoutCommitment;
    readonly containerMigration?: LayoutContainerMigration | null;
    readonly currentPlacements?: readonly LayoutPlacement[];
    readonly extensionEvacuation?: LayoutExtensionEvacuation | null;
    readonly towerEvacuation?: LayoutTowerEvacuation | null;
    readonly globalOwnedSiteCount: number;
    readonly labEvacuation?: LayoutLabEvacuation | null;
    readonly labMigration?: LabMigrationRoomView | null;
    readonly linkEvacuation?: LayoutLinkEvacuation | null;
    readonly linkRuntime?: LinkRoomRuntimeResult | null;
    readonly logisticsEvidenceReady?: boolean;
    readonly observationFingerprint: string;
    readonly placements: readonly LayoutPlacement[];
    readonly policyFingerprint: string;
    readonly removalReceipt?: LayoutStructureRemovalReceipt | null;
    readonly room: RoomSnapshot;
  }): LayoutMigrationPlanningResult {
    const blockers: LayoutMigrationBlockerRecord[] = [];
    const proposals: LayoutMigrationProposal[] = [];
    let removalReceipt = input.removalReceipt ?? null;
    if (
      removalReceipt !== null &&
      !(input.room.structures ?? []).some(
        ({ id, structureType }) =>
          id === removalReceipt?.targetId && structureType === removalReceipt.targetStructureType,
      )
    )
      removalReceipt = null;
    const desiredExtensions = input.placements
      .filter(
        (placement) => placement.layer === "primary" && placement.structureType === "extension",
      )
      .sort(comparePlacement);
    const desiredTowers = input.placements
      .filter((placement) => placement.layer === "primary" && placement.structureType === "tower")
      .sort(comparePlacement);
    const desiredLabs = input.placements
      .filter((placement) => placement.layer === "primary" && placement.structureType === "lab")
      .sort(comparePlacement);
    const desiredLinks = input.placements
      .filter((placement) => placement.layer === "primary" && placement.structureType === "link")
      .sort(comparePlacement);
    const extensionCandidates = (input.room.structures ?? []).filter(
      (structure) =>
        structure.ownership === "owned" &&
        structure.structureType === "extension" &&
        !desiredExtensions.some(({ pos }) => samePosition(pos, structure.pos)),
    );
    const towerCandidates = (input.room.structures ?? []).filter(
      (structure) =>
        structure.ownership === "owned" &&
        structure.structureType === "tower" &&
        !desiredTowers.some(({ pos }) => samePosition(pos, structure.pos)),
    );
    const labCandidates = (input.room.structures ?? []).filter(
      (structure) =>
        structure.ownership === "owned" &&
        structure.structureType === "lab" &&
        !desiredLabs.some(({ pos }) => samePosition(pos, structure.pos)),
    );
    const linkCandidates = (input.room.structures ?? []).filter(
      (structure) =>
        structure.ownership === "owned" &&
        structure.structureType === "link" &&
        !desiredLinks.some(({ pos }) => samePosition(pos, structure.pos)),
    );
    const sourceServices = input.placements.filter(
      (placement) =>
        placement.service?.kind === "source-container" && placement.structureType === "container",
    );
    const desiredGeneralContainers = input.placements.filter(
      (placement) =>
        placement.layer === "primary" &&
        placement.service === undefined &&
        placement.structureType === "container",
    );
    const sourceContainerCandidates = input.room.storedStructures.filter(
      (target) =>
        target.structureType === "container" &&
        !sourceServices.some(({ pos }) => samePosition(pos, target.pos)) &&
        input.room.sources.some(({ pos }) => inRangeOne(pos, target.pos)),
    );
    const generalContainerCandidates = (input.currentPlacements ?? []).flatMap((placement) => {
      if (
        placement.adoption !== "compatible-external" ||
        placement.service !== undefined ||
        placement.structureType !== "container" ||
        input.room.sources.some(({ pos }) => inRangeOne(pos, placement.pos))
      )
        return [];
      return input.room.storedStructures.filter(
        (target) => target.structureType === "container" && samePosition(target.pos, placement.pos),
      );
    });
    const candidates = [
      ...sourceContainerCandidates.map((target) => ({
        kind: "source-container" as const,
        target,
      })),
      ...generalContainerCandidates.map((target) => ({
        kind: "general-container" as const,
        target,
      })),
      ...extensionCandidates.map((target) => ({ kind: "extension" as const, target })),
      ...labCandidates.map((target) => ({ kind: "lab" as const, target })),
      ...linkCandidates.map((target) => ({ kind: "link" as const, target })),
      ...towerCandidates.map((target) => ({ kind: "tower" as const, target })),
    ].sort((left, right) => {
      const leftReceiptTarget = left.target.id === removalReceipt?.targetId;
      const rightReceiptTarget = right.target.id === removalReceipt?.targetId;
      const receiptOrder = Number(rightReceiptTarget) - Number(leftReceiptTarget);
      if (receiptOrder !== 0) return receiptOrder;
      const leftActive =
        (left.kind === "lab" && left.target.id === input.labEvacuation?.sourceId) ||
        (left.kind === "link" && left.target.id === input.linkEvacuation?.sourceId) ||
        (left.kind === "tower" && left.target.id === input.towerEvacuation?.sourceId) ||
        (left.kind === "extension" && left.target.id === input.extensionEvacuation?.sourceId);
      const rightActive =
        (right.kind === "lab" && right.target.id === input.labEvacuation?.sourceId) ||
        (right.kind === "link" && right.target.id === input.linkEvacuation?.sourceId) ||
        (right.kind === "tower" && right.target.id === input.towerEvacuation?.sourceId) ||
        (right.kind === "extension" && right.target.id === input.extensionEvacuation?.sourceId);
      return Number(rightActive) - Number(leftActive) || compareMigrationCandidate(left, right);
    });
    let containerMigration = input.containerMigration ?? null;
    const priorContainerTargetId = containerMigration?.targetId ?? null;
    if (priorContainerTargetId !== null) {
      const targetVisible = input.room.storedStructures.some(
        ({ id }) => id === priorContainerTargetId,
      );
      const targetStillCandidate = [
        ...sourceContainerCandidates,
        ...generalContainerCandidates,
      ].some(({ id }) => id === priorContainerTargetId);
      const targetIsSelectedSourceService = sourceServices.some(({ pos }) =>
        input.room.storedStructures.some(
          ({ id, pos: targetPos }) => id === priorContainerTargetId && samePosition(pos, targetPos),
        ),
      );
      if (
        !targetVisible ||
        targetIsSelectedSourceService ||
        (!targetStillCandidate && containerMigration?.resourceManifest === undefined)
      )
        containerMigration = null;
    }
    const considered = candidates.slice(0, STRUCTURE_REMOVAL_LIMITS.inspectedCandidatesPerTick);
    const truncatedCandidates = Math.max(0, candidates.length - considered.length);
    if (truncatedCandidates > 0)
      blockers.push({ reason: "candidate-cap", roomName: input.room.name, targetId: null });
    const receiptBlocker = removalReceiptBlocker(removalReceipt, input.room.observedAt);
    if (receiptBlocker !== null && removalReceipt !== null) {
      pushMigrationBlocker(blockers, {
        reason: receiptBlocker,
        roomName: input.room.name,
        targetId: removalReceipt.targetId,
      });
      return freeze({
        authorization: null,
        blockers,
        containerMigration,
        extensionEvacuation: input.extensionEvacuation ?? null,
        labEvacuation: input.labEvacuation ?? null,
        linkEvacuation: input.linkEvacuation ?? null,
        towerEvacuation: input.towerEvacuation ?? null,
        proposals,
        removalReceipt,
        scannedCandidates: considered.length,
        truncatedCandidates,
      });
    }
    if (considered.length === 0)
      return freeze({
        authorization: null,
        blockers,
        containerMigration,
        extensionEvacuation: null,
        labEvacuation: null,
        linkEvacuation: null,
        towerEvacuation: null,
        proposals,
        removalReceipt,
        scannedCandidates: 0,
        truncatedCandidates,
      });

    const globalBlocker = migrationGlobalBlocker(input);
    if (globalBlocker !== null) {
      pushMigrationBlocker(blockers, {
        reason: globalBlocker,
        roomName: input.room.name,
        targetId: null,
      });
      return freeze({
        authorization: null,
        blockers,
        containerMigration,
        extensionEvacuation: input.extensionEvacuation ?? null,
        labEvacuation: input.labEvacuation ?? null,
        linkEvacuation: input.linkEvacuation ?? null,
        towerEvacuation: input.towerEvacuation ?? null,
        proposals,
        removalReceipt,
        scannedCandidates: considered.length,
        truncatedCandidates,
      });
    }
    const authorization = {
      colonyId: input.colony.id,
      layoutFingerprint: input.commitment.fingerprint,
      observationFingerprint: input.observationFingerprint,
      policyFingerprint: input.policyFingerprint,
      roomName: input.room.name,
    } as const;
    let extensionEvacuation: LayoutExtensionEvacuation | null = null;
    let labEvacuation = input.labEvacuation ?? null;
    let linkEvacuation = input.linkEvacuation ?? null;
    let towerEvacuation = input.towerEvacuation ?? null;
    const admitRemoval = (proposal: LayoutMigrationProposal): boolean => {
      const assessment = assessRemovalReceipt(removalReceipt, proposal, input.room.observedAt);
      removalReceipt = assessment.receipt;
      if (assessment.blocker === null) {
        proposals.push(proposal);
        return true;
      }
      pushMigrationBlocker(blockers, {
        reason: assessment.blocker,
        roomName: input.room.name,
        targetId: proposal.targetId,
      });
      return false;
    };
    for (const candidate of considered) {
      if (candidate.kind === "source-container") {
        if (containerMigration !== null && containerMigration.targetId !== candidate.target.id)
          continue;
        const evidence = sourceContainerMigrationEvidence(
          input.room,
          candidate.target,
          sourceServices,
        );
        if (evidence.replacement === null) {
          pushMigrationBlocker(blockers, {
            reason: evidence.reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          continue;
        }
        const evacuation = planSourceContainerEvacuation({
          activeLogisticsFlowIds: input.activeLogisticsFlowIds,
          activeLogisticsTargetIds: input.activeLogisticsTargetIds,
          current: containerMigration,
          evidence,
          logisticsEvidenceReady: input.logisticsEvidenceReady === true,
          roomName: input.room.name,
          tick: input.room.observedAt,
        });
        containerMigration = evacuation.migration;
        if (evacuation.blocker !== null) {
          pushMigrationBlocker(blockers, {
            reason: evacuation.blocker,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (
          !admitRemoval({
            colonyId: input.colony.id,
            layoutFingerprint: input.commitment.fingerprint,
            observationFingerprint: input.observationFingerprint,
            policyFingerprint: input.policyFingerprint,
            pos: candidate.target.pos,
            replacementId: evidence.replacement.id,
            replacementStructureType: "container",
            stableId: [
              "remove-source-container-v1",
              input.colony.id,
              input.commitment.fingerprint,
              evidence.sourceId,
              candidate.target.id,
              evidence.replacement.id,
            ].join(":"),
            targetId: candidate.target.id,
            targetRequiresEmptyStore: true,
            targetStructureType: "container",
          })
        )
          break;
        if (containerMigration !== null) break;
        continue;
      }

      if (candidate.kind === "general-container") {
        if (containerMigration !== null && containerMigration.targetId !== candidate.target.id)
          continue;
        const evidence = generalContainerMigrationEvidence(
          input.room,
          candidate.target,
          sourceServices,
          desiredGeneralContainers,
          input.colony.rclPolicy.unlocks?.containers ?? 0,
        );
        if (evidence.replacement === null) {
          if (
            containerMigration?.targetId === candidate.target.id &&
            containerMigration.resourceManifest === undefined
          )
            containerMigration = null;
          pushMigrationBlocker(blockers, {
            reason: evidence.reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          continue;
        }
        if (input.logisticsEvidenceReady !== true || input.activeLogisticsTargetIds === undefined) {
          pushMigrationBlocker(blockers, {
            reason: "logistics-unavailable",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        const migrationIdentity = {
          replacementId: evidence.replacement.id,
          targetId: candidate.target.id,
        };
        const prospectiveManifest =
          containerMigration?.resourceManifest ??
          (evidence.targetAmount > 0 &&
          !(
            evidence.resourceManifest.length === 1 && evidence.resourceManifest[0]?.[0] === "energy"
          )
            ? evidence.resourceManifest
            : undefined);
        const budgetIdentityAvailable =
          prospectiveManifest === undefined
            ? layoutContainerMigrationBudgetIssuer(input.room.name, migrationIdentity) !== null
            : prospectiveManifest.every(
                ([resourceType]) =>
                  layoutContainerMigrationResourceBudgetIssuer(
                    input.room.name,
                    migrationIdentity,
                    resourceType,
                  ) !== null &&
                  layoutContainerMigrationResourceFlowId(
                    input.room.name,
                    migrationIdentity,
                    resourceType,
                  ) !== null,
              );
        if (
          (evidence.targetAmount > 0 ||
            (containerMigration?.energyAmount ?? 0) > 0 ||
            (containerMigration?.resourceManifest?.length ?? 0) > 0) &&
          !budgetIdentityAvailable
        ) {
          pushMigrationBlocker(blockers, {
            reason: "logistics-unavailable",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (containerMigration === null) {
          const energyOnly =
            evidence.resourceManifest.length === 1 && evidence.resourceManifest[0]?.[0] === "energy"
              ? evidence.resourceManifest[0]
              : null;
          containerMigration = {
            ...(evidence.targetAmount === 0
              ? {}
              : energyOnly === null
                ? { resourceManifest: evidence.resourceManifest }
                : {
                    energyAmount: energyOnly[1],
                    replacementInitialEnergy: energyOnly[2],
                  }),
            expiresAt: input.room.observedAt + LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
            replacementId: evidence.replacement.id,
            startedAt: input.room.observedAt,
            targetId: candidate.target.id,
          };
          pushMigrationBlocker(blockers, {
            reason: evidence.targetAmount === 0 ? "migration-pending" : "target-stocked",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (
          containerMigration.expiresAt - containerMigration.startedAt !==
            LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS ||
          input.room.observedAt <= containerMigration.startedAt
        ) {
          pushMigrationBlocker(blockers, {
            reason: "migration-pending",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (containerMigration.replacementId !== evidence.replacement.id) {
          if (containerMigration.resourceManifest === undefined) containerMigration = null;
          pushMigrationBlocker(blockers, {
            reason: "replacement-pending",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (input.room.observedAt >= containerMigration.expiresAt) {
          containerMigration = null;
          pushMigrationBlocker(blockers, {
            reason: "migration-expired",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        const resourceManifest = containerMigration.resourceManifest;
        if (resourceManifest !== undefined) {
          if (input.activeLogisticsFlowIds === undefined) {
            pushMigrationBlocker(blockers, {
              reason: "logistics-unavailable",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          const resourceMigration = containerMigration;
          const terms = validContainerMigrationResourceManifest(resourceManifest);
          const targetByResource = new Map(evidence.targetResources);
          const replacementByResource = new Map(evidence.replacementResources);
          const flowIds = terms?.map(([resourceType]) =>
            layoutContainerMigrationResourceFlowId(
              input.room.name,
              resourceMigration,
              resourceType,
            ),
          );
          const flowActive = flowIds?.some(
            (flowId) => flowId !== null && input.activeLogisticsFlowIds?.has(flowId),
          );
          let reason: LayoutMigrationBlocker | null = null;
          if (
            terms === null ||
            flowIds?.some((flowId) => flowId === null) === true ||
            [...targetByResource].some(([resourceType, amount]) => {
              const term = terms.find(([committed]) => committed === resourceType);
              return term === undefined || amount > term[1];
            }) ||
            terms.some(
              ([resourceType, , baseline]) =>
                (replacementByResource.get(resourceType) ?? 0) < baseline,
            )
          )
            reason = "evacuation-incomplete";
          else if (evidence.targetAmount > 0) reason = "target-stocked";
          else if (flowActive) reason = "evacuation-pending";
          else if (
            terms.some(
              ([resourceType, amount, baseline]) =>
                (replacementByResource.get(resourceType) ?? 0) < baseline + amount,
            )
          )
            reason = "evacuation-incomplete";
          if (reason !== null) {
            pushMigrationBlocker(blockers, {
              reason,
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
        } else {
          const evacuationAmount = containerMigration.energyAmount ?? 0;
          if (evacuationAmount === 0 && evidence.targetAmount > 0) {
            containerMigration = null;
            pushMigrationBlocker(blockers, {
              reason: "target-stocked",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          if (evacuationAmount > 0) {
            if (input.activeLogisticsFlowIds === undefined) {
              pushMigrationBlocker(blockers, {
                reason: "logistics-unavailable",
                roomName: input.room.name,
                targetId: candidate.target.id,
              });
              break;
            }
            const replacementBaseline = containerMigration.replacementInitialEnergy;
            const flowActive = input.activeLogisticsFlowIds.has(
              layoutContainerMigrationFlowId(input.room.name, containerMigration),
            );
            let reason: LayoutMigrationBlocker | null = null;
            if (
              replacementBaseline === undefined ||
              evidence.targetResources.some(([resourceType]) => resourceType !== "energy") ||
              evidence.targetEnergy > evacuationAmount ||
              evidence.replacementEnergy < replacementBaseline
            )
              reason = "evacuation-incomplete";
            else if (evidence.targetEnergy > 0) reason = "target-stocked";
            else if (flowActive) reason = "evacuation-pending";
            else if (evidence.replacementEnergy < replacementBaseline + evacuationAmount)
              reason = "evacuation-incomplete";
            if (reason !== null) {
              pushMigrationBlocker(blockers, {
                reason,
                roomName: input.room.name,
                targetId: candidate.target.id,
              });
              break;
            }
          }
        }
        if (
          input.activeLogisticsTargetIds.has(candidate.target.id) ||
          input.activeLogisticsTargetIds.has(evidence.replacement.id)
        ) {
          pushMigrationBlocker(blockers, {
            reason: "logistics-active",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        admitRemoval({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.target.pos,
          replacementId: evidence.replacement.id,
          replacementStructureType: "container",
          stableId: [
            "remove-general-container-v1",
            input.colony.id,
            input.commitment.fingerprint,
            candidate.target.id,
            evidence.replacement.id,
          ].join(":"),
          targetId: candidate.target.id,
          targetRequiresEmptyStore: true,
          targetStructureType: "container",
        });
        break;
      }

      if (candidate.kind === "lab") {
        if (labEvacuation !== null && labEvacuation.sourceId !== candidate.target.id) continue;
        const ownedEvacuationTargetIds =
          labEvacuation === null
            ? new Set<string>()
            : "resourceType" in labEvacuation && !("energyAmount" in labEvacuation)
              ? new Set([labEvacuation.sourceId])
              : new Set([labEvacuation.sourceId, labEvacuation.replacementId]);
        const lab = labMigrationEvidence({
          activeLogisticsTargetIds: input.activeLogisticsTargetIds,
          allowance: input.colony.rclPolicy.unlocks?.labs ?? 0,
          desiredLabs,
          layoutFingerprint: input.commitment.fingerprint,
          logisticsEvidenceReady: input.logisticsEvidenceReady === true,
          ownedEvacuationTargetIds,
          requiredEvacuationDestination:
            labEvacuation !== null && "resourceType" in labEvacuation
              ? {
                  id: labEvacuation.destinationId,
                  structureType:
                    "destinationStructureType" in labEvacuation
                      ? ("terminal" as const)
                      : ("storage" as const),
                }
              : null,
          room: input.room,
          target: candidate.target,
          view: input.labMigration ?? null,
        });
        if (lab.replacement === null) {
          pushMigrationBlocker(blockers, {
            reason: lab.reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          if (labEvacuation !== null) break;
          continue;
        }
        if (labEvacuation !== null && labEvacuation.replacementId !== lab.replacement.id) {
          pushMigrationBlocker(blockers, {
            reason: "replacement-pending",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (labEvacuation === null && (lab.targetEnergy > 0 || lab.targetMineralAmount > 0)) {
          const startedAt = input.room.observedAt;
          const expiresAt = startedAt + LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS;
          const prospective: LayoutLabEvacuation | null =
            lab.targetMineralAmount === 0
              ? {
                  amount: lab.targetEnergy,
                  expiresAt,
                  replacementId: lab.replacement.id,
                  replacementInitialEnergy: lab.replacementEnergy,
                  sourceId: candidate.target.id,
                  startedAt,
                }
              : lab.targetMineralType === null || lab.destination === null
                ? null
                : lab.targetEnergy === 0
                  ? {
                      amount: lab.targetMineralAmount,
                      destinationId: lab.destination.id,
                      destinationInitialAmount: lab.destinationResourceAmount,
                      ...(lab.destinationStructureType === "terminal"
                        ? { destinationStructureType: "terminal" as const }
                        : {}),
                      expiresAt,
                      replacementId: lab.replacement.id,
                      resourceType: lab.targetMineralType,
                      sourceId: candidate.target.id,
                      startedAt,
                    }
                  : {
                      destinationId: lab.destination.id,
                      destinationInitialAmount: lab.destinationResourceAmount,
                      energyAmount: lab.targetEnergy,
                      expiresAt,
                      mineralAmount: lab.targetMineralAmount,
                      replacementId: lab.replacement.id,
                      replacementInitialEnergy: lab.replacementEnergy,
                      resourceType: lab.targetMineralType,
                      sourceId: candidate.target.id,
                      startedAt,
                    };
          const flowIds =
            prospective === null ? null : layoutLabEvacuationFlowIds(input.room.name, prospective);
          const budgetIssuers =
            prospective === null
              ? null
              : layoutLabEvacuationBudgetIssuers(input.room.name, prospective);
          if (
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            flowIds === null ||
            budgetIssuers === null
          ) {
            pushMigrationBlocker(blockers, {
              reason: "logistics-unavailable",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          const capacityMissing =
            (lab.targetEnergy > 0 &&
              lab.replacementEnergy + lab.targetEnergy > MAX_LAYOUT_LAB_ENERGY) ||
            (lab.targetMineralAmount > 0 &&
              (lab.destination === null || lab.destinationFreeCapacity < lab.targetMineralAmount));
          if (capacityMissing) {
            pushMigrationBlocker(blockers, {
              reason: "evacuation-capacity",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          labEvacuation = prospective;
          pushMigrationBlocker(blockers, {
            reason: "target-stocked",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (labEvacuation !== null) {
          const flowIds = layoutLabEvacuationFlowIds(input.room.name, labEvacuation);
          const flowActive =
            flowIds?.some((flowId) => input.activeLogisticsFlowIds?.has(flowId) === true) === true;
          const mixedTerms = "energyAmount" in labEvacuation ? labEvacuation : null;
          const mineralTerms = "resourceType" in labEvacuation ? labEvacuation : null;
          const energyTerms = "replacementInitialEnergy" in labEvacuation ? labEvacuation : null;
          const singleAmount = "amount" in labEvacuation ? labEvacuation.amount : 0;
          const energyAmount =
            mixedTerms?.energyAmount ?? (mineralTerms === null ? singleAmount : 0);
          const mineralAmount =
            mixedTerms?.mineralAmount ?? (mineralTerms === null ? 0 : singleAmount);
          const destinationResourceAmount =
            mineralTerms === null
              ? 0
              : (lab.destinationResources.get(mineralTerms.resourceType) ?? 0);
          let reason: LayoutMigrationBlocker | null = null;
          if (
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            flowIds === null
          )
            reason = "logistics-unavailable";
          else if (input.room.observedAt >= labEvacuation.expiresAt) {
            reason = "evacuation-expired";
            if (lab.targetEnergy + lab.targetMineralAmount > 0 && !flowActive) labEvacuation = null;
          } else if (
            lab.targetEnergy > energyAmount ||
            lab.targetMineralAmount > mineralAmount ||
            (lab.targetMineralAmount > 0 &&
              (mineralTerms === null || lab.targetMineralType !== mineralTerms.resourceType)) ||
            (energyAmount > 0 &&
              (energyTerms === null ||
                lab.replacementEnergy < energyTerms.replacementInitialEnergy)) ||
            (mineralAmount > 0 &&
              (mineralTerms === null ||
                lab.destination?.id !== mineralTerms.destinationId ||
                destinationResourceAmount < mineralTerms.destinationInitialAmount))
          )
            reason = "evacuation-incomplete";
          else if (lab.targetEnergy > 0 || lab.targetMineralAmount > 0) reason = "target-stocked";
          else if (flowActive) reason = "evacuation-pending";
          else if (
            (energyAmount > 0 &&
              (energyTerms === null ||
                lab.replacementEnergy < energyTerms.replacementInitialEnergy + energyAmount)) ||
            (mineralAmount > 0 &&
              (mineralTerms === null ||
                destinationResourceAmount < mineralTerms.destinationInitialAmount + mineralAmount))
          )
            reason = "evacuation-incomplete";
          else if (
            input.activeLogisticsTargetIds.has(candidate.target.id) ||
            (energyAmount > 0 && input.activeLogisticsTargetIds.has(lab.replacement.id)) ||
            (mineralTerms !== null &&
              input.activeLogisticsTargetIds.has(mineralTerms.destinationId))
          )
            reason = "logistics-active";
          if (reason !== null) {
            pushMigrationBlocker(blockers, {
              reason,
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
        }
        if (lab.removalBlockedByIndustry) {
          pushMigrationBlocker(blockers, {
            reason: "industry-active",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        admitRemoval({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.target.pos,
          replacementId: lab.replacement.id,
          replacementStructureType: "lab",
          stableId: [
            lab.activeHandoff ? "remove-active-reaction-lab-v1" : "remove-quiescent-lab-v1",
            input.colony.id,
            input.commitment.fingerprint,
            candidate.target.id,
            lab.replacement.id,
          ].join(":"),
          targetId: candidate.target.id,
          targetRequiresEmptyStore: true,
          targetRequiresZeroCooldown: true,
          targetStructureType: "lab",
        });
        break;
      }

      if (candidate.kind === "link") {
        if (linkEvacuation !== null && linkEvacuation.sourceId !== candidate.target.id) continue;
        const link = reserveLinkMigrationEvidence({
          activeLogisticsTargetIds: input.activeLogisticsTargetIds,
          commitment: input.commitment,
          currentPlacements: input.currentPlacements ?? [],
          desiredLinks,
          linkRuntime: input.linkRuntime,
          logisticsEvidenceReady: input.logisticsEvidenceReady === true,
          room: input.room,
          target: candidate.target,
          allowance: input.colony.rclPolicy.unlocks?.links ?? 0,
        });
        if (link.replacement === null) {
          pushMigrationBlocker(blockers, {
            reason: link.reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          if (linkEvacuation !== null) break;
          continue;
        }
        if (linkEvacuation !== null && linkEvacuation.replacementId !== link.replacement.id) {
          pushMigrationBlocker(blockers, {
            reason: "replacement-pending",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (linkEvacuation === null && link.targetEnergy > 0) {
          const identity = {
            replacementId: link.replacement.id,
            sourceId: candidate.target.id,
          };
          if (
            input.logisticsEvidenceReady !== true ||
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            layoutLinkEvacuationBudgetIssuer(input.room.name, identity) === null ||
            layoutLinkEvacuationFlowId(input.room.name, identity) === null
          ) {
            pushMigrationBlocker(blockers, {
              reason: "logistics-unavailable",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          if (
            link.replacementEnergy + link.targetEnergy > MAX_LAYOUT_LINK_ENERGY ||
            link.replacement.store.freeCapacity === null ||
            link.replacement.store.freeCapacity < link.targetEnergy
          ) {
            pushMigrationBlocker(blockers, {
              reason: "evacuation-capacity",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          if (
            input.activeLogisticsTargetIds.has(candidate.target.id) ||
            input.activeLogisticsTargetIds.has(link.replacement.id)
          ) {
            pushMigrationBlocker(blockers, {
              reason: "logistics-active",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          linkEvacuation = {
            amount: link.targetEnergy,
            expiresAt: input.room.observedAt + LAYOUT_LINK_EVACUATION_TIMEOUT_TICKS,
            replacementId: link.replacement.id,
            replacementInitialEnergy: link.replacementEnergy,
            sourceId: candidate.target.id,
            startedAt: input.room.observedAt,
          };
        }
        if (linkEvacuation !== null) {
          const flowId = layoutLinkEvacuationFlowId(input.room.name, linkEvacuation);
          const flowActive = flowId !== null && input.activeLogisticsFlowIds?.has(flowId) === true;
          let reason: LayoutMigrationBlocker | null = null;
          if (
            input.logisticsEvidenceReady !== true ||
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            flowId === null
          )
            reason = "logistics-unavailable";
          else if (input.room.observedAt >= linkEvacuation.expiresAt) {
            reason = "evacuation-expired";
            if (link.targetEnergy > 0 && !flowActive) linkEvacuation = null;
          } else if (
            link.targetEnergy > linkEvacuation.amount ||
            link.replacementEnergy < linkEvacuation.replacementInitialEnergy
          )
            reason = "evacuation-incomplete";
          else if (link.targetEnergy > 0) reason = "target-stocked";
          else if (flowActive) reason = "evacuation-pending";
          else if (
            link.replacementEnergy !==
            linkEvacuation.replacementInitialEnergy + linkEvacuation.amount
          )
            reason = "evacuation-incomplete";
          else if (
            input.activeLogisticsTargetIds.has(candidate.target.id) ||
            input.activeLogisticsTargetIds.has(link.replacement.id)
          )
            reason = "logistics-active";
          if (reason !== null) {
            pushMigrationBlocker(blockers, {
              reason,
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
        } else if (
          input.activeLogisticsTargetIds?.has(candidate.target.id) === true ||
          input.activeLogisticsTargetIds?.has(link.replacement.id) === true
        ) {
          pushMigrationBlocker(blockers, {
            reason: "logistics-active",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        admitRemoval({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.target.pos,
          replacementExpectedEnergy: link.replacementEnergy,
          replacementId: link.replacement.id,
          replacementRequiresZeroCooldown: true,
          replacementStructureType: "link",
          stableId: [
            "remove-reserve-link-v1",
            input.colony.id,
            input.commitment.fingerprint,
            candidate.target.id,
            link.replacement.id,
          ].join(":"),
          targetId: candidate.target.id,
          targetRequiresEmptyStore: true,
          targetRequiresZeroCooldown: true,
          targetStructureType: "link",
        });
        break;
      }

      if (candidate.kind === "tower") {
        if (towerEvacuation !== null && towerEvacuation.sourceId !== candidate.target.id) continue;
        const tower = towerMigrationEvidence(
          input.room,
          candidate.target,
          desiredTowers,
          input.colony.rclPolicy.unlocks?.towers ?? 0,
          towerEvacuation?.replacementId,
        );
        if (tower.replacement === null) {
          pushMigrationBlocker(blockers, {
            reason: tower.reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          if (towerEvacuation !== null) break;
          continue;
        }
        if (towerEvacuation !== null && towerEvacuation.replacementId !== tower.replacement.id) {
          pushMigrationBlocker(blockers, {
            reason: "replacement-pending",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        if (towerEvacuation === null && tower.targetEnergy > 0) {
          const identity = {
            replacementId: tower.replacement.id,
            sourceId: candidate.target.id,
          };
          if (
            input.logisticsEvidenceReady !== true ||
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            layoutTowerEvacuationBudgetIssuer(input.room.name, identity) === null ||
            layoutTowerEvacuationFlowId(input.room.name, identity) === null
          ) {
            pushMigrationBlocker(blockers, {
              reason: "logistics-unavailable",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          if (
            tower.replacementEnergy + tower.targetEnergy > MAX_LAYOUT_TOWER_ENERGY ||
            tower.replacement.store.freeCapacity === null ||
            tower.replacement.store.freeCapacity < tower.targetEnergy
          ) {
            pushMigrationBlocker(blockers, {
              reason: "evacuation-capacity",
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
          towerEvacuation = {
            amount: tower.targetEnergy,
            expiresAt: input.room.observedAt + LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS,
            replacementId: tower.replacement.id,
            replacementInitialEnergy: tower.replacementEnergy,
            sourceId: candidate.target.id,
            startedAt: input.room.observedAt,
          };
        }
        if (towerEvacuation !== null) {
          const flowId = layoutTowerEvacuationFlowId(input.room.name, towerEvacuation);
          const flowActive = flowId !== null && input.activeLogisticsFlowIds?.has(flowId) === true;
          let reason: LayoutMigrationBlocker | null = null;
          if (
            input.logisticsEvidenceReady !== true ||
            input.activeLogisticsFlowIds === undefined ||
            input.activeLogisticsTargetIds === undefined ||
            flowId === null
          )
            reason = "logistics-unavailable";
          else if (input.room.observedAt >= towerEvacuation.expiresAt) {
            reason = "evacuation-expired";
            if (tower.targetEnergy > 0 && !flowActive) towerEvacuation = null;
          } else if (
            tower.targetEnergy > towerEvacuation.amount ||
            tower.replacementEnergy < towerEvacuation.replacementInitialEnergy
          )
            reason = "evacuation-incomplete";
          else if (tower.targetEnergy > 0) reason = "target-stocked";
          else if (flowActive) reason = "evacuation-pending";
          else if (
            tower.replacementEnergy <
            towerEvacuation.replacementInitialEnergy + towerEvacuation.amount
          )
            reason = "evacuation-incomplete";
          else if (
            input.activeLogisticsTargetIds.has(candidate.target.id) ||
            input.activeLogisticsTargetIds.has(tower.replacement.id)
          )
            reason = "logistics-active";
          if (reason !== null) {
            pushMigrationBlocker(blockers, {
              reason,
              roomName: input.room.name,
              targetId: candidate.target.id,
            });
            break;
          }
        }
        admitRemoval({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.target.pos,
          replacementId: tower.replacement.id,
          replacementStructureType: "tower",
          stableId: [
            "remove-tower-v1",
            input.colony.id,
            input.commitment.fingerprint,
            candidate.target.id,
            tower.replacement.id,
          ].join(":"),
          targetId: candidate.target.id,
          targetRequiresEmptyStore: true,
          targetStructureType: "tower",
        });
        break;
      }

      const priorEvacuation = input.extensionEvacuation ?? null;
      if (priorEvacuation !== null && priorEvacuation.sourceId !== candidate.target.id) continue;
      const extension = extensionMigrationEvidence(
        input.room,
        candidate.target,
        desiredExtensions,
        input.colony.rclPolicy.unlocks?.extensions ?? 0,
      );
      if (extension.replacement === null) {
        pushMigrationBlocker(blockers, {
          reason: extension.reason,
          roomName: input.room.name,
          targetId: candidate.target.id,
        });
        continue;
      }
      if (priorEvacuation !== null && priorEvacuation.replacementId !== extension.replacement.id) {
        pushMigrationBlocker(blockers, {
          reason: "replacement-pending",
          roomName: input.room.name,
          targetId: candidate.target.id,
        });
        continue;
      }
      const targetEnergy = exactExtensionEnergy(extension.target);
      const replacementEnergy = exactExtensionEnergy(extension.replacement);
      if (targetEnergy === null || replacementEnergy === null) {
        pushMigrationBlocker(blockers, {
          reason: "target-unavailable",
          roomName: input.room.name,
          targetId: candidate.target.id,
        });
        continue;
      }
      if (priorEvacuation !== null && targetEnergy > priorEvacuation.amount) {
        const flowId = layoutExtensionEvacuationFlowId(input.room.name, priorEvacuation);
        if (
          input.activeLogisticsFlowIds?.has(flowId) === true ||
          replacementEnergy !== priorEvacuation.replacementInitialEnergy ||
          replacementEnergy + targetEnergy > MAX_LAYOUT_EXTENSION_ENERGY ||
          (extension.replacement.store.freeCapacity ?? 0) < targetEnergy
        ) {
          extensionEvacuation = priorEvacuation;
          pushMigrationBlocker(blockers, {
            reason: "evacuation-incomplete",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
        extensionEvacuation = { ...priorEvacuation, amount: targetEnergy };
      }
      if (priorEvacuation === null && targetEnergy > 0) {
        if (
          replacementEnergy + targetEnergy > MAX_LAYOUT_EXTENSION_ENERGY ||
          (extension.replacement.store.freeCapacity ?? 0) < targetEnergy
        ) {
          pushMigrationBlocker(blockers, {
            reason: "evacuation-capacity",
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          continue;
        }
        extensionEvacuation = {
          amount: targetEnergy,
          expiresAt: input.room.observedAt + LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
          replacementId: extension.replacement.id,
          replacementInitialEnergy: replacementEnergy,
          sourceId: candidate.target.id,
          startedAt: input.room.observedAt,
        };
      } else {
        extensionEvacuation ??= priorEvacuation;
      }
      if (extensionEvacuation !== null) {
        const flowId = layoutExtensionEvacuationFlowId(input.room.name, extensionEvacuation);
        const targetEmpty = targetEnergy === 0;
        const delivered =
          replacementEnergy >=
          extensionEvacuation.replacementInitialEnergy + extensionEvacuation.amount;
        const flowActive = input.activeLogisticsFlowIds?.has(flowId) === true;
        let reason: LayoutMigrationBlocker | null = null;
        if (input.room.observedAt >= extensionEvacuation.expiresAt) {
          reason = "evacuation-expired";
          if (!targetEmpty && !flowActive) extensionEvacuation = null;
        } else if (!targetEmpty) reason = "target-stocked";
        else if (flowActive) reason = "evacuation-pending";
        else if (!delivered) reason = "evacuation-incomplete";
        if (reason !== null) {
          pushMigrationBlocker(blockers, {
            reason,
            roomName: input.room.name,
            targetId: candidate.target.id,
          });
          break;
        }
      }
      if (
        !admitRemoval({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.target.pos,
          replacementId: extension.replacement.id,
          replacementStructureType: "extension",
          stableId: [
            "remove-extension-v1",
            input.colony.id,
            input.commitment.fingerprint,
            candidate.target.id,
            extension.replacement.id,
          ].join(":"),
          targetId: candidate.target.id,
          targetRequiresEmptyStore: true,
          targetStructureType: "extension",
        })
      )
        break;
      if (extensionEvacuation !== null) break;
    }
    return freeze({
      authorization,
      blockers,
      containerMigration,
      extensionEvacuation,
      labEvacuation,
      linkEvacuation,
      towerEvacuation,
      proposals: proposals.sort((a, b) => a.stableId.localeCompare(b.stableId)),
      removalReceipt,
      scannedCandidates: considered.length,
      truncatedCandidates,
    });
  }
}

type MigrationCandidate =
  | { readonly kind: "source-container"; readonly target: StoredStructureSnapshot }
  | { readonly kind: "general-container"; readonly target: StoredStructureSnapshot }
  | { readonly kind: "extension"; readonly target: StructureSnapshot }
  | { readonly kind: "lab"; readonly target: StructureSnapshot }
  | { readonly kind: "link"; readonly target: StructureSnapshot }
  | { readonly kind: "tower"; readonly target: StructureSnapshot };

function assessRemovalReceipt(
  receipt: LayoutStructureRemovalReceipt | null,
  proposal: LayoutMigrationProposal,
  tick: number,
): {
  readonly blocker: Extract<
    LayoutMigrationBlocker,
    "removal-backoff" | "removal-failed" | "removal-pending"
  > | null;
  readonly receipt: LayoutStructureRemovalReceipt | null;
} {
  if (receipt === null) return { blocker: null, receipt: null };
  if (
    receipt.targetId !== proposal.targetId ||
    receipt.replacementId !== proposal.replacementId ||
    receipt.targetStructureType !== proposal.targetStructureType
  )
    return { blocker: null, receipt: null };
  return { blocker: removalReceiptBlocker(receipt, tick), receipt };
}

function removalReceiptBlocker(
  receipt: LayoutStructureRemovalReceipt | null,
  tick: number,
): Extract<
  LayoutMigrationBlocker,
  "removal-backoff" | "removal-failed" | "removal-pending"
> | null {
  if (receipt === null) return null;
  if (
    !Number.isSafeInteger(receipt.attempt) ||
    receipt.attempt < 1 ||
    receipt.attempt > 3 ||
    !Number.isSafeInteger(receipt.observedAt) ||
    !Number.isSafeInteger(receipt.nextEligibleTick) ||
    receipt.nextEligibleTick <= receipt.observedAt
  )
    return "removal-failed";
  if (receipt.code === "OK" || receipt.code === "TARGET_ABSENT") return "removal-pending";
  if (receipt.attempt >= 3) return "removal-failed";
  if (tick < receipt.nextEligibleTick) return "removal-backoff";
  return null;
}

function generalContainerMigrationEvidence(
  room: RoomSnapshot,
  target: StoredStructureSnapshot,
  sourceServices: readonly LayoutPlacement[],
  desiredGeneralContainers: readonly LayoutPlacement[],
  allowance: number,
):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null }
  | {
      readonly reason: null;
      readonly replacement: StoredStructureSnapshot;
      readonly replacementEnergy: number;
      readonly replacementResources: readonly (readonly [resourceType: string, amount: number])[];
      readonly resourceManifest: readonly LayoutContainerMigrationResource[];
      readonly targetAmount: number;
      readonly targetEnergy: number;
      readonly targetResources: readonly (readonly [resourceType: string, amount: number])[];
    } {
  const occupying = (room.structures ?? []).filter(({ pos }) => samePosition(pos, target.pos));
  if (
    occupying.length !== 1 ||
    occupying[0]?.id !== target.id ||
    room.constructionSites.some(({ pos }) => samePosition(pos, target.pos))
  )
    return { reason: "target-shared", replacement: null };
  const targetResources = exactContainerResources(target, MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES);
  if (target.ownership === "foreign" || targetResources === null)
    return { reason: "target-unavailable", replacement: null };
  const targetAmount = targetResources.reduce((total, [, amount]) => total + amount, 0);
  if (
    room.sources.some(({ pos }) => inRangeOne(pos, target.pos)) ||
    desiredGeneralContainers.some((placement) =>
      room.sources.some(({ pos }) => inRangeOne(pos, placement.pos)),
    )
  )
    return { reason: "replacement-pending", replacement: null };
  const committed = [...sourceServices, ...desiredGeneralContainers];
  const uniquePositions = new Set(committed.map(({ pos }) => positionKey(pos)));
  if (
    allowance <= 0 ||
    committed.length !== allowance ||
    uniquePositions.size !== committed.length ||
    committed.some(({ pos }) => samePosition(pos, target.pos)) ||
    sourceServices.some(({ adoption }) => adoption !== "exact")
  )
    return { reason: "replacement-pending", replacement: null };
  const observedContainers = room.storedStructures.filter(
    ({ ownership, structureType }) => structureType === "container" && ownership !== "foreign",
  );
  const exact = committed.flatMap((placement) => {
    const matches = observedContainers.filter(({ pos }) => samePosition(pos, placement.pos));
    return matches.length === 1 ? matches : [];
  });
  if (
    observedContainers.length !== allowance ||
    exact.length !== allowance - 1 ||
    new Set(exact.map(({ id }) => id)).size !== exact.length
  )
    return { reason: "replacement-pending", replacement: null };
  const replacements = exact
    .filter((structure) =>
      desiredGeneralContainers.some(({ pos }) => samePosition(pos, structure.pos)),
    )
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));
  const replacement = replacements[replacements.length - 1];
  if (replacement === undefined) return { reason: "replacement-pending", replacement: null };
  const replacementResources = exactContainerResources(
    replacement,
    MAX_LAYOUT_CONTAINER_STORE_RESOURCES,
  );
  if (
    replacementResources === null ||
    replacement.store.freeCapacity === null ||
    replacement.store.freeCapacity < targetAmount
  )
    return { reason: "evacuation-capacity", replacement: null };
  const replacementByResource = new Map(replacementResources.map((row) => [row[0], row[1]]));
  const resourceManifest = targetResources.map(
    ([resourceType, amount]): LayoutContainerMigrationResource => [
      resourceType,
      amount,
      replacementByResource.get(resourceType) ?? 0,
    ],
  );
  return {
    reason: null,
    replacement,
    replacementEnergy: replacementByResource.get("energy") ?? 0,
    replacementResources,
    resourceManifest,
    targetAmount,
    targetEnergy: targetResources.find(([resourceType]) => resourceType === "energy")?.[1] ?? 0,
    targetResources,
  };
}

function validContainerMigrationResourceManifest(
  value: unknown,
): readonly LayoutContainerMigrationResource[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES
  )
    return null;
  let prior = "";
  let amountTotal = 0;
  let replacementTotal = 0;
  const manifest: LayoutContainerMigrationResource[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 3) return null;
    const resourceType: unknown = row[0];
    const amount: unknown = row[1];
    const replacementAmount: unknown = row[2];
    if (
      typeof resourceType !== "string" ||
      resourceType.length === 0 ||
      resourceType.length > 64 ||
      resourceType !== resourceType.trim() ||
      (prior !== "" && compareText(prior, resourceType) >= 0) ||
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      typeof replacementAmount !== "number" ||
      !Number.isSafeInteger(replacementAmount) ||
      replacementAmount < 0
    )
      return null;
    prior = resourceType;
    amountTotal += amount;
    replacementTotal += replacementAmount;
    manifest.push([resourceType, amount, replacementAmount]);
  }
  return !(manifest.length === 1 && prior === "energy") &&
    amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY &&
    replacementTotal + amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY
    ? manifest
    : null;
}

function exactContainerResources(
  container: StoredStructureSnapshot,
  maximumResources: number,
): readonly (readonly [resourceType: string, amount: number])[] | null {
  if (
    container.store.capacity !== MAX_LAYOUT_CONTAINER_ENERGY ||
    !Number.isSafeInteger(container.store.usedCapacity) ||
    container.store.usedCapacity < 0 ||
    container.store.usedCapacity > MAX_LAYOUT_CONTAINER_ENERGY ||
    !Number.isSafeInteger(container.store.freeCapacity) ||
    (container.store.freeCapacity as number) < 0 ||
    container.store.usedCapacity + (container.store.freeCapacity as number) !==
      MAX_LAYOUT_CONTAINER_ENERGY
  )
    return null;
  const resources = container.store.resources
    .map(({ amount, resourceType }) => [resourceType, amount] as const)
    .sort((left, right) => compareText(left[0], right[0]));
  if (
    resources.length > maximumResources ||
    resources.some(
      ([resourceType, amount]) =>
        resourceType.length === 0 ||
        resourceType.length > 64 ||
        resourceType !== resourceType.trim() ||
        !Number.isSafeInteger(amount) ||
        amount <= 0,
    ) ||
    new Set(resources.map(([resourceType]) => resourceType)).size !== resources.length ||
    resources.reduce((total, [, amount]) => total + amount, 0) !== container.store.usedCapacity
  )
    return null;
  return resources;
}

interface SourceContainerMigrationEvidence {
  readonly reason: null;
  readonly replacement: StoredStructureSnapshot;
  readonly replacementEnergy: number;
  readonly replacementResources: readonly (readonly [resourceType: string, amount: number])[];
  readonly resourceManifest: readonly LayoutContainerMigrationResource[];
  readonly sourceId: string;
  readonly targetAmount: number;
  readonly targetEnergy: number;
  readonly targetId: string;
  readonly targetResources: readonly (readonly [resourceType: string, amount: number])[];
}

function sourceContainerMigrationEvidence(
  room: RoomSnapshot,
  target: StoredStructureSnapshot,
  sourceServices: readonly LayoutPlacement[],
):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null; readonly sourceId: null }
  | SourceContainerMigrationEvidence {
  const occupying = (room.structures ?? []).filter(({ pos }) => samePosition(pos, target.pos));
  if (
    occupying.length !== 1 ||
    occupying[0]?.id !== target.id ||
    room.constructionSites.some(({ pos }) => samePosition(pos, target.pos))
  )
    return { reason: "target-shared", replacement: null, sourceId: null };
  const targetResources = exactContainerResources(target, MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES);
  if (target.ownership === "foreign" || targetResources === null)
    return { reason: "target-unavailable", replacement: null, sourceId: null };
  const adjacentSources = room.sources.filter(({ pos }) => inRangeOne(pos, target.pos));
  if (adjacentSources.length !== 1)
    return { reason: "replacement-pending", replacement: null, sourceId: null };
  const source = adjacentSources[0];
  if (source === undefined)
    return { reason: "replacement-pending", replacement: null, sourceId: null };
  const services = sourceServices.filter(
    (placement) => placement.adoption === "exact" && placement.service?.sourceId === source.id,
  );
  if (services.length !== 1)
    return { reason: "replacement-pending", replacement: null, sourceId: null };
  const service = services[0];
  if (service === undefined)
    return { reason: "replacement-pending", replacement: null, sourceId: null };
  const replacements = room.storedStructures.filter(
    (structure) =>
      structure.id !== target.id &&
      structure.ownership !== "foreign" &&
      structure.structureType === "container" &&
      samePosition(structure.pos, service.pos),
  );
  const replacement = replacements.length === 1 ? replacements[0] : undefined;
  if (replacement === undefined)
    return { reason: "replacement-pending", replacement: null, sourceId: null };
  const replacementResources = exactContainerResources(
    replacement,
    MAX_LAYOUT_CONTAINER_STORE_RESOURCES,
  );
  const targetAmount = targetResources.reduce((total, [, amount]) => total + amount, 0);
  if (
    replacementResources === null ||
    replacement.store.freeCapacity === null ||
    replacement.store.freeCapacity < targetAmount
  )
    return { reason: "evacuation-capacity", replacement: null, sourceId: null };
  const replacementByResource = new Map(replacementResources.map((row) => [row[0], row[1]]));
  return {
    reason: null,
    replacement,
    replacementEnergy: replacementByResource.get("energy") ?? 0,
    replacementResources,
    resourceManifest: targetResources.map(
      ([resourceType, amount]): LayoutContainerMigrationResource => [
        resourceType,
        amount,
        replacementByResource.get(resourceType) ?? 0,
      ],
    ),
    sourceId: source.id,
    targetAmount,
    targetEnergy: targetResources.find(([resourceType]) => resourceType === "energy")?.[1] ?? 0,
    targetId: target.id,
    targetResources,
  };
}

function planSourceContainerEvacuation(input: {
  readonly activeLogisticsFlowIds: ReadonlySet<string> | undefined;
  readonly activeLogisticsTargetIds: ReadonlySet<string> | undefined;
  readonly current: LayoutContainerMigration | null;
  readonly evidence: SourceContainerMigrationEvidence;
  readonly logisticsEvidenceReady: boolean;
  readonly roomName: string;
  readonly tick: number;
}): {
  readonly blocker: LayoutMigrationBlocker | null;
  readonly migration: LayoutContainerMigration | null;
} {
  let migration = input.current;
  if (migration === null && input.evidence.targetAmount === 0)
    return { blocker: null, migration: null };
  if (
    !input.logisticsEvidenceReady ||
    input.activeLogisticsFlowIds === undefined ||
    input.activeLogisticsTargetIds === undefined
  )
    return { blocker: "logistics-unavailable", migration };

  const prospectiveManifest =
    migration?.resourceManifest ??
    (input.evidence.targetAmount > 0 &&
    !(
      input.evidence.resourceManifest.length === 1 &&
      input.evidence.resourceManifest[0]?.[0] === "energy"
    )
      ? input.evidence.resourceManifest
      : undefined);
  const boundedIdentity = {
    replacementId: input.evidence.replacement.id,
    targetId: input.evidence.targetId,
  };
  const identitiesAvailable =
    prospectiveManifest === undefined
      ? layoutContainerMigrationBudgetIssuer(input.roomName, boundedIdentity) !== null
      : prospectiveManifest.every(
          ([resourceType]) =>
            layoutContainerMigrationResourceBudgetIssuer(
              input.roomName,
              boundedIdentity,
              resourceType,
            ) !== null &&
            layoutContainerMigrationResourceFlowId(
              input.roomName,
              boundedIdentity,
              resourceType,
            ) !== null,
        );
  if (!identitiesAvailable) return { blocker: "logistics-unavailable", migration };

  if (migration === null) {
    const energyOnly =
      input.evidence.resourceManifest.length === 1 &&
      input.evidence.resourceManifest[0]?.[0] === "energy"
        ? input.evidence.resourceManifest[0]
        : null;
    migration = {
      ...(energyOnly === null
        ? { resourceManifest: input.evidence.resourceManifest }
        : { energyAmount: energyOnly[1], replacementInitialEnergy: energyOnly[2] }),
      expiresAt: input.tick + LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
      replacementId: input.evidence.replacement.id,
      sourceId: input.evidence.sourceId,
      startedAt: input.tick,
      targetId: input.evidence.targetId,
    };
    return { blocker: "target-stocked", migration };
  }
  if (
    migration.expiresAt - migration.startedAt !== LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS ||
    input.tick <= migration.startedAt
  )
    return { blocker: "migration-pending", migration };
  if (
    migration.replacementId !== input.evidence.replacement.id ||
    migration.sourceId !== input.evidence.sourceId
  )
    return { blocker: "replacement-pending", migration };
  if (input.tick >= migration.expiresAt)
    return {
      blocker: "migration-expired",
      migration: input.evidence.targetAmount > 0 ? null : migration,
    };

  let blocker: LayoutMigrationBlocker | null = null;
  const terms = migration.resourceManifest;
  if (terms !== undefined) {
    const validTerms = validContainerMigrationResourceManifest(terms);
    const targetByResource = new Map(input.evidence.targetResources);
    const replacementByResource = new Map(input.evidence.replacementResources);
    const flowIds = validTerms?.map(([resourceType]) =>
      layoutContainerMigrationResourceFlowId(input.roomName, migration, resourceType),
    );
    if (
      validTerms === null ||
      flowIds?.some((flowId) => flowId === null) === true ||
      [...targetByResource].some(([resourceType, amount]) => {
        const term = validTerms.find(([committed]) => committed === resourceType);
        return term === undefined || amount > term[1];
      }) ||
      validTerms.some(
        ([resourceType, , baseline]) => (replacementByResource.get(resourceType) ?? 0) < baseline,
      )
    )
      blocker = "evacuation-incomplete";
    else if (input.evidence.targetAmount > 0) blocker = "target-stocked";
    else if (
      flowIds?.some((flowId) => flowId !== null && input.activeLogisticsFlowIds?.has(flowId)) ===
      true
    )
      blocker = "evacuation-pending";
    else if (
      validTerms.some(
        ([resourceType, amount, baseline]) =>
          (replacementByResource.get(resourceType) ?? 0) < baseline + amount,
      )
    )
      blocker = "evacuation-incomplete";
  } else {
    const amount = migration.energyAmount ?? 0;
    const baseline = migration.replacementInitialEnergy;
    if (
      amount <= 0 ||
      baseline === undefined ||
      input.evidence.targetResources.some(([resourceType]) => resourceType !== "energy") ||
      input.evidence.targetEnergy > amount ||
      input.evidence.replacementEnergy < baseline
    )
      blocker = "evacuation-incomplete";
    else if (input.evidence.targetEnergy > 0) blocker = "target-stocked";
    else if (
      input.activeLogisticsFlowIds.has(layoutContainerMigrationFlowId(input.roomName, migration))
    )
      blocker = "evacuation-pending";
    else if (input.evidence.replacementEnergy < baseline + amount)
      blocker = "evacuation-incomplete";
  }
  if (blocker !== null) return { blocker, migration };
  if (
    input.activeLogisticsTargetIds.has(migration.targetId) ||
    input.activeLogisticsTargetIds.has(migration.replacementId)
  )
    return { blocker: "logistics-active", migration };
  return { blocker: null, migration };
}

function reserveLinkMigrationEvidence(input: {
  readonly activeLogisticsTargetIds: ReadonlySet<string> | undefined;
  readonly allowance: number;
  readonly commitment: LayoutCommitment;
  readonly currentPlacements: readonly LayoutPlacement[];
  readonly desiredLinks: readonly LayoutPlacement[];
  readonly linkRuntime: LinkRoomRuntimeResult | null | undefined;
  readonly logisticsEvidenceReady: boolean;
  readonly room: RoomSnapshot;
  readonly target: StructureSnapshot;
}):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null }
  | {
      readonly reason: null;
      readonly replacement: NonNullable<RoomSnapshot["ownedLinks"]>[number];
      readonly replacementEnergy: number;
      readonly targetEnergy: number;
    } {
  const links = input.room.ownedLinks;
  if (
    input.room.controller?.level !== 8 ||
    input.allowance !== 6 ||
    links === undefined ||
    links.length !== input.allowance ||
    input.desiredLinks.length !== input.allowance
  )
    return { reason: "replacement-pending", replacement: null };
  const occupying = (input.room.structures ?? []).filter(({ pos }) =>
    samePosition(pos, input.target.pos),
  );
  if (
    occupying.length !== 1 ||
    occupying[0]?.id !== input.target.id ||
    input.room.constructionSites.some(({ pos }) => samePosition(pos, input.target.pos))
  )
    return { reason: "target-shared", replacement: null };
  const linkRuntime = input.linkRuntime;
  if (
    !input.logisticsEvidenceReady ||
    input.activeLogisticsTargetIds === undefined ||
    linkRuntime === undefined ||
    linkRuntime === null
  )
    return { reason: "logistics-unavailable", replacement: null };

  const currentLinks = input.currentPlacements.filter(
    ({ layer, structureType }) => layer === "primary" && structureType === "link",
  );
  const sourceServices = input.currentPlacements.filter(
    (placement) => placement.service?.kind === "source-container",
  );
  const storages = input.room.storedStructures.filter(
    ({ ownership, structureType }) => ownership === "owned" && structureType === "storage",
  );
  const sourceIds = new Set(input.room.sources.map(({ id }) => id));
  if (
    currentLinks.length !== input.allowance ||
    new Set(currentLinks.map(({ pos }) => positionKey(pos))).size !== currentLinks.length ||
    new Set(input.desiredLinks.map(({ pos }) => positionKey(pos))).size !==
      input.desiredLinks.length ||
    sourceServices.length !== input.room.sources.length ||
    new Set(sourceServices.map(({ service }) => service?.sourceId)).size !==
      sourceServices.length ||
    sourceServices.some(({ service }) => !sourceIds.has(service?.sourceId ?? "")) ||
    storages.length !== 1
  )
    return { reason: "replacement-pending", replacement: null };
  const targetPlacements = currentLinks.filter(({ pos }) => samePosition(pos, input.target.pos));
  if (
    targetPlacements.length !== 1 ||
    targetPlacements[0]?.adoption !== "compatible-external" ||
    input.desiredLinks.some(({ pos }) => samePosition(pos, input.target.pos))
  )
    return { reason: "replacement-pending", replacement: null };

  const layoutRevision = `${input.commitment.algorithmRevision}:${input.commitment.fingerprint}`;
  const layoutEvidence = (placements: readonly LayoutPlacement[]): LinkLayoutEvidence => ({
    algorithmRevision: input.commitment.algorithmRevision,
    controller: input.room.controller?.pos ?? input.commitment.anchor,
    fingerprint: input.commitment.fingerprint,
    linkPlacements: placements.map(({ pos }) => pos),
    sourceServices: sourceServices.map((placement) => ({
      pos: placement.pos,
      sourceId: placement.service?.sourceId ?? "",
    })),
    storage: storages[0]?.pos ?? null,
  });
  const observed = links.map((link) => observedLink(link, input.room.observedAt));
  const currentAnchors = deriveLinkRoleAnchors(layoutEvidence(currentLinks));
  const currentClassification = classifyLinks({
    anchors: currentAnchors,
    layoutRevision,
    links: observed,
    tick: input.room.observedAt,
  });
  if (
    currentAnchors.length !== input.allowance ||
    currentAnchors.filter(({ role }) => role === "source").length !== sourceServices.length ||
    currentAnchors.filter(({ role }) => role === "hub").length !== 1 ||
    currentAnchors.filter(({ role }) => role === "controller").length !== 1 ||
    linkRuntime.roomName !== input.room.name ||
    linkRuntime.layoutRevision !== layoutRevision ||
    JSON.stringify(linkRuntime.classification) !== JSON.stringify(currentClassification) ||
    currentClassification.blockers.length !== 0 ||
    currentClassification.truncatedLinks !== 0 ||
    currentClassification.links.length !== input.allowance
  )
    return { reason: "replacement-pending", replacement: null };
  const currentTarget = currentClassification.links.find(({ id }) => id === input.target.id);
  if (currentTarget?.role !== "reserve")
    return { reason: "replacement-pending", replacement: null };

  const idealAnchors = deriveLinkRoleAnchors(layoutEvidence(input.desiredLinks));
  const exactObserved = observed.filter((link) =>
    input.desiredLinks.some(({ pos }) => samePosition(pos, link.pos)),
  );
  const idealClassification = classifyLinks({
    anchors: idealAnchors,
    layoutRevision,
    links: exactObserved,
    tick: input.room.observedAt,
  });
  const missingAnchors = idealAnchors.filter(
    (anchor) => !exactObserved.some(({ pos }) => samePosition(pos, anchor.pos)),
  );
  if (
    idealAnchors.length !== input.allowance ||
    exactObserved.length !== input.allowance - 1 ||
    idealClassification.links.length !== input.allowance - 1 ||
    idealClassification.truncatedLinks !== 0 ||
    idealClassification.blockers.length !== 1 ||
    idealClassification.blockers[0]?.reason !== "missing-link" ||
    missingAnchors.length !== 1 ||
    missingAnchors[0]?.role !== "reserve" ||
    idealAnchors.filter(({ role }) => role === "source").length !== sourceServices.length ||
    idealAnchors.filter(({ role }) => role === "hub").length !== 1 ||
    idealAnchors.filter(({ role }) => role === "controller").length !== 1 ||
    !["source", "hub", "controller"].every((role) =>
      idealAnchors
        .filter((anchor) => anchor.role === role)
        .every((anchor) =>
          idealClassification.links.some(
            (link) => link.anchorId === anchor.id && link.role === anchor.role,
          ),
        ),
    )
  )
    return { reason: "replacement-pending", replacement: null };
  const replacements = idealClassification.links
    .filter(({ role }) => role === "reserve")
    .map(({ id }) => links.find((link) => link.id === id))
    .filter((link): link is NonNullable<typeof link> => link !== undefined)
    .sort(
      (left, right) =>
        left.pos.y - right.pos.y || left.pos.x - right.pos.x || left.id.localeCompare(right.id),
    );
  const replacement = replacements[0];
  if (
    replacement === undefined ||
    currentClassification.links.find(({ id }) => id === replacement.id)?.role !== "reserve"
  )
    return { reason: "replacement-pending", replacement: null };
  const target = links.find(({ id }) => id === input.target.id);
  const targetEnergy = target === undefined ? null : exactIdleLinkEnergy(target);
  const replacementEnergy = exactIdleLinkEnergy(replacement);
  if (target === undefined || targetEnergy === null)
    return { reason: "target-unavailable", replacement: null };
  if (replacementEnergy === null) return { reason: "replacement-pending", replacement: null };
  if (
    linkRuntime.arbitration.accepted.some(
      ({ sourceLinkId, targetLinkId }) =>
        sourceLinkId === target.id ||
        targetLinkId === target.id ||
        sourceLinkId === replacement.id ||
        targetLinkId === replacement.id,
    )
  )
    return { reason: "logistics-active", replacement: null };
  return { reason: null, replacement, replacementEnergy, targetEnergy };
}

function observedLink(
  link: NonNullable<RoomSnapshot["ownedLinks"]>[number],
  observedAt: number,
): ObservedLink {
  return {
    active: link.active,
    cooldown: link.cooldown,
    energy: link.store.resources
      .filter(({ resourceType }) => resourceType === "energy")
      .reduce((total, { amount }) => total + amount, 0),
    freeCapacity: link.store.freeCapacity ?? 0,
    id: link.id,
    observedAt,
    owned: true,
    pos: link.pos,
  };
}

function exactIdleLinkEnergy(link: NonNullable<RoomSnapshot["ownedLinks"]>[number]): number | null {
  if (
    !link.active ||
    link.cooldown !== 0 ||
    link.store.capacity !== MAX_LAYOUT_LINK_ENERGY ||
    link.store.resources.length > 1 ||
    link.store.resources.some(
      ({ amount, resourceType }) =>
        resourceType !== "energy" || !Number.isSafeInteger(amount) || amount <= 0,
    )
  )
    return null;
  const energy = link.store.resources[0]?.amount ?? 0;
  return Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_LINK_ENERGY &&
    energy === link.store.usedCapacity &&
    link.store.freeCapacity === MAX_LAYOUT_LINK_ENERGY - energy
    ? energy
    : null;
}

function labMigrationEvidence(input: {
  readonly activeLogisticsTargetIds: ReadonlySet<string> | undefined;
  readonly allowance: number;
  readonly desiredLabs: readonly LayoutPlacement[];
  readonly layoutFingerprint: string;
  readonly logisticsEvidenceReady: boolean;
  readonly ownedEvacuationTargetIds: ReadonlySet<string>;
  readonly requiredEvacuationDestination: {
    readonly id: string;
    readonly structureType: "storage" | "terminal";
  } | null;
  readonly room: RoomSnapshot;
  readonly target: StructureSnapshot;
  readonly view: LabMigrationRoomView | null;
}):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null }
  | {
      readonly activeHandoff: boolean;
      readonly removalBlockedByIndustry: boolean;
      readonly destination:
        | NonNullable<RoomSnapshot["ownedStorages"]>[number]
        | NonNullable<RoomSnapshot["ownedTerminals"]>[number]
        | null;
      readonly destinationFreeCapacity: number;
      readonly destinationStructureType: "storage" | "terminal" | null;
      readonly destinationResourceAmount: number;
      readonly destinationResources: ReadonlyMap<string, number>;
      readonly reason: null;
      readonly replacement: NonNullable<RoomSnapshot["ownedLabs"]>[number];
      readonly replacementEnergy: number;
      readonly targetEnergy: number;
      readonly targetMineralAmount: number;
      readonly targetMineralType: string | null;
    } {
  const occupying = (input.room.structures ?? []).filter(({ pos }) =>
    samePosition(pos, input.target.pos),
  );
  if (
    occupying.length !== 1 ||
    occupying[0]?.id !== input.target.id ||
    input.room.constructionSites.some(({ pos }) => samePosition(pos, input.target.pos))
  )
    return { reason: "target-shared", replacement: null };
  const labs = input.room.ownedLabs;
  const target = labs?.find(({ id }) => id === input.target.id);
  const targetEnergy = target === undefined ? null : exactLabEnergy(target);
  if (target === undefined || !target.active || target.cooldown !== 0 || targetEnergy === null)
    return { reason: "target-unavailable", replacement: null };
  if (
    input.room.controller?.level !== 8 ||
    input.allowance !== 10 ||
    labs === undefined ||
    labs.length !== input.allowance ||
    input.desiredLabs.length !== input.allowance ||
    new Set(labs.map(({ id }) => id)).size !== labs.length ||
    new Set(input.desiredLabs.map(({ pos }) => positionKey(pos))).size !==
      input.desiredLabs.length ||
    !labs.every((lab) =>
      (input.room.structures ?? []).some(
        (structure) =>
          structure.id === lab.id &&
          structure.ownership === "owned" &&
          structure.structureType === "lab" &&
          samePosition(structure.pos, lab.pos),
      ),
    )
  )
    return { reason: "replacement-pending", replacement: null };
  if (
    input.view === null ||
    input.view.roomName !== input.room.name ||
    input.view.observedAt !== input.room.observedAt ||
    input.view.assignment === null
  )
    return { reason: "industry-unavailable", replacement: null };
  const currentAssignment = assignLabCluster({
    labs,
    layoutFingerprint: fingerprintLabLayout(input.room.name, labs),
    limits: input.view.limits,
    roomName: input.room.name,
  }).assignment;
  if (
    currentAssignment === null ||
    JSON.stringify(currentAssignment) !== JSON.stringify(input.view.assignment)
  )
    return { reason: "industry-unavailable", replacement: null };
  if (!input.logisticsEvidenceReady || input.activeLogisticsTargetIds === undefined)
    return { reason: "industry-unavailable", replacement: null };
  if (
    labs.some(
      ({ id }) =>
        input.activeLogisticsTargetIds?.has(id) === true && !input.ownedEvacuationTargetIds.has(id),
    )
  )
    return { reason: "logistics-active", replacement: null };
  const exact = labs
    .filter(
      (lab) =>
        lab.id !== target.id &&
        lab.active &&
        input.desiredLabs.some(({ pos }) => samePosition(pos, lab.pos)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    exact.length !== input.allowance - 1 ||
    new Set(exact.map(({ pos }) => positionKey(pos))).size !== exact.length
  )
    return { reason: "replacement-pending", replacement: null };
  const postRemoval = assignLabCluster({
    labs: exact,
    layoutFingerprint: fingerprintLabLayout(input.room.name, exact),
    limits: input.view.limits,
    roomName: input.room.name,
  }).assignment;
  if (postRemoval === null) return { reason: "lab-cluster-invalid", replacement: null };
  const handoff = input.view.assignmentHandoff;
  const activeHandoff =
    !input.view.quiescent &&
    handoff?.status === "ready" &&
    handoff.targetLabId === target.id &&
    handoff.fromFingerprint === currentAssignment.fingerprint &&
    handoff.layoutFingerprint === input.layoutFingerprint &&
    typeof handoff.objectiveId === "string" &&
    handoff.objectiveId.length > 0 &&
    handoff.objectiveId.length <= 160 &&
    Number.isSafeInteger(handoff.objectiveRevision) &&
    handoff.objectiveRevision > 0 &&
    !(handoff.kind === "reaction" && input.view.activity.includes("pending-attempt")) &&
    (target.mineralAmount === 0
      ? target.mineralType === null
      : typeof target.mineralType === "string" &&
        target.mineralType.length > 0 &&
        target.mineralType.length <= 64 &&
        target.mineralType === target.mineralType.trim() &&
        target.mineralType !== "energy") &&
    sameLabAssignmentRoles(currentAssignment, postRemoval) &&
    JSON.stringify(handoff.assignment) === JSON.stringify(postRemoval);
  if (!input.view.quiescent && !activeHandoff)
    return { reason: "industry-active", replacement: null };
  const removalBlockedByIndustry =
    activeHandoff &&
    handoff.kind === "boost" &&
    (input.view.activity.includes("pending-attempt") || input.view.activity.includes("intent"));
  const activeTerminalHandoff = activeHandoff && targetEnergy === 0;
  const clusterIds = [
    ...postRemoval.reagentLabIds,
    ...postRemoval.productLabIds,
    ...postRemoval.boostLabIds,
  ].sort(compareText);
  const replacement = exact.find(({ id }) => id === clusterIds[0]);
  const replacementEnergy = replacement === undefined ? null : exactLabEnergy(replacement);
  if (replacement === undefined || replacementEnergy === null)
    return { reason: "lab-cluster-invalid", replacement: null };
  let destination:
    | NonNullable<RoomSnapshot["ownedStorages"]>[number]
    | NonNullable<RoomSnapshot["ownedTerminals"]>[number]
    | null = null;
  let destinationFreeCapacity = 0;
  let destinationResourceAmount = 0;
  let destinationResources: ReadonlyMap<string, number> = new Map();
  let destinationStructureType: "storage" | "terminal" | null = null;
  if (target.mineralAmount > 0 || input.requiredEvacuationDestination !== null) {
    const required =
      input.requiredEvacuationDestination ??
      (typeof input.view.evacuationStorageId === "string"
        ? { id: input.view.evacuationStorageId, structureType: "storage" as const }
        : (input.view.quiescent || activeTerminalHandoff) &&
            typeof input.view.evacuationTerminalId === "string"
          ? { id: input.view.evacuationTerminalId, structureType: "terminal" as const }
          : null);
    if (
      required === null ||
      (!input.view.quiescent && required.structureType === "terminal" && !activeTerminalHandoff) ||
      (required.structureType === "terminal" &&
        (input.room.ownedStorages ?? []).some(({ active }) => active))
    )
      return { reason: "industry-unavailable", replacement: null };
    const activeDestinations =
      required.structureType === "terminal"
        ? (input.room.ownedTerminals ?? []).filter(({ active }) => active)
        : (input.room.ownedStorages ?? []).filter(({ active }) => active);
    const publishedId =
      required.structureType === "terminal"
        ? input.view.evacuationTerminalId
        : input.view.evacuationStorageId;
    destination =
      activeDestinations.length === 1 &&
      activeDestinations[0]?.id === required.id &&
      publishedId === required.id
        ? activeDestinations[0]
        : null;
    const expectedCapacity =
      required.structureType === "terminal"
        ? MAX_LAYOUT_TERMINAL_CAPACITY
        : MAX_LAYOUT_STORAGE_CAPACITY;
    const destinationStore =
      destination === null ? null : exactInventoryStore(destination, expectedCapacity);
    if (destinationStore === null) return { reason: "industry-unavailable", replacement: null };
    destinationStructureType = required.structureType;
    destinationFreeCapacity = destinationStore.freeCapacity;
    destinationResources = destinationStore.resources;
    destinationResourceAmount = destinationResources.get(target.mineralType ?? "") ?? 0;
  }
  return {
    activeHandoff,
    removalBlockedByIndustry,
    destination,
    destinationFreeCapacity,
    destinationResourceAmount,
    destinationResources,
    destinationStructureType,
    reason: null,
    replacement,
    replacementEnergy,
    targetEnergy,
    targetMineralAmount: target.mineralAmount,
    targetMineralType: target.mineralType,
  };
}

function sameLabAssignmentRoles(
  current: NonNullable<LabMigrationRoomView["assignment"]>,
  postRemoval: NonNullable<LabMigrationRoomView["assignment"]>,
): boolean {
  const same = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  return (
    same(current.reagentLabIds, postRemoval.reagentLabIds) &&
    same(current.productLabIds, postRemoval.productLabIds) &&
    same(current.boostLabIds, postRemoval.boostLabIds)
  );
}

function exactLabEnergy(lab: NonNullable<RoomSnapshot["ownedLabs"]>[number]): number | null {
  if (
    lab.energyCapacity !== MAX_LAYOUT_LAB_ENERGY ||
    lab.mineralCapacity !== MAX_LAYOUT_LAB_MINERAL ||
    !Number.isSafeInteger(lab.energy) ||
    lab.energy < 0 ||
    lab.energy > MAX_LAYOUT_LAB_ENERGY ||
    !Number.isSafeInteger(lab.mineralAmount) ||
    lab.mineralAmount < 0 ||
    lab.mineralAmount > MAX_LAYOUT_LAB_MINERAL ||
    (lab.mineralAmount === 0) !== (lab.mineralType === null) ||
    lab.mineralType === "energy" ||
    lab.store.usedCapacity !== lab.energy + lab.mineralAmount
  )
    return null;
  const resources = new Map<string, number>();
  for (const { amount, resourceType } of lab.store.resources) {
    if (
      resources.has(resourceType) ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      (resourceType !== "energy" && resourceType !== lab.mineralType)
    )
      return null;
    resources.set(resourceType, amount);
  }
  if (
    (resources.get("energy") ?? 0) !== lab.energy ||
    (lab.mineralType === null ? 0 : (resources.get(lab.mineralType) ?? 0)) !== lab.mineralAmount ||
    resources.size !== Number(lab.energy > 0) + Number(lab.mineralAmount > 0)
  )
    return null;
  return lab.energy;
}

function exactInventoryStore(
  storage:
    | NonNullable<RoomSnapshot["ownedStorages"]>[number]
    | NonNullable<RoomSnapshot["ownedTerminals"]>[number],
  expectedCapacity: number,
): {
  readonly freeCapacity: number;
  readonly resources: ReadonlyMap<string, number>;
} | null {
  if (
    storage.store.capacity !== expectedCapacity ||
    !Number.isSafeInteger(storage.store.usedCapacity) ||
    storage.store.usedCapacity < 0 ||
    !Number.isSafeInteger(storage.store.freeCapacity) ||
    storage.store.freeCapacity === null ||
    storage.store.freeCapacity < 0 ||
    storage.store.usedCapacity + storage.store.freeCapacity !== expectedCapacity ||
    storage.store.resources.length > MAX_LAYOUT_STORAGE_RESOURCES
  )
    return null;
  const resources = new Map<string, number>();
  let used = 0;
  for (const { amount, resourceType } of storage.store.resources) {
    if (
      resources.has(resourceType) ||
      resourceType.length === 0 ||
      resourceType.length > 64 ||
      resourceType !== resourceType.trim() ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    )
      return null;
    resources.set(resourceType, amount);
    used += amount;
  }
  return used === storage.store.usedCapacity
    ? { freeCapacity: storage.store.freeCapacity, resources }
    : null;
}

function towerMigrationEvidence(
  room: RoomSnapshot,
  target: StructureSnapshot,
  desiredTowers: readonly LayoutPlacement[],
  allowance: number,
  requiredReplacementId?: string,
):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null }
  | {
      readonly reason: null;
      readonly replacement: RoomSnapshot["ownedTowers"][number];
      readonly replacementEnergy: number;
      readonly targetEnergy: number;
    } {
  const occupying = (room.structures ?? []).filter(({ pos }) => samePosition(pos, target.pos));
  if (
    occupying.length !== 1 ||
    occupying[0]?.id !== target.id ||
    room.constructionSites.some(({ pos }) => samePosition(pos, target.pos))
  )
    return { reason: "target-shared", replacement: null };
  const observedTarget = room.ownedTowers.find(({ id }) => id === target.id);
  const targetEnergy = observedTarget === undefined ? null : exactTowerEnergy(observedTarget);
  if (observedTarget === undefined || !observedTarget.active || targetEnergy === null)
    return { reason: "target-unavailable", replacement: null };
  const exact = room.ownedTowers
    .filter(
      (tower) =>
        tower.active &&
        tower.id !== target.id &&
        desiredTowers.some(({ pos }) => samePosition(pos, tower.pos)),
    )
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));
  if (
    allowance < 2 ||
    room.ownedTowers.length !== allowance ||
    exact.length !== allowance - 1 ||
    desiredTowers.length < allowance
  )
    return { reason: "replacement-pending", replacement: null };
  const replacement = exact.find((tower) => {
    if (requiredReplacementId !== undefined && tower.id !== requiredReplacementId) return false;
    const energy = exactTowerEnergy(tower);
    return energy !== null && energy >= MINIMUM_OPERATIONAL_TOWER_ENERGY;
  });
  if (replacement === undefined) return { reason: "replacement-pending", replacement: null };
  const replacementEnergy = exactTowerEnergy(replacement);
  return replacementEnergy === null
    ? { reason: "replacement-pending", replacement: null }
    : { reason: null, replacement, replacementEnergy, targetEnergy };
}

function exactTowerEnergy(tower: RoomSnapshot["ownedTowers"][number]): number | null {
  if (
    tower.store.capacity !== MAX_LAYOUT_TOWER_ENERGY ||
    tower.store.resources.length > 1 ||
    tower.store.resources.some(
      ({ amount, resourceType }) =>
        resourceType !== "energy" || !Number.isSafeInteger(amount) || amount <= 0,
    )
  )
    return null;
  const energy = tower.store.resources[0]?.amount ?? 0;
  return energy === tower.store.usedCapacity &&
    tower.store.freeCapacity === MAX_LAYOUT_TOWER_ENERGY - energy &&
    Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_TOWER_ENERGY
    ? energy
    : null;
}

function extensionMigrationEvidence(
  room: RoomSnapshot,
  target: StructureSnapshot,
  desiredExtensions: readonly LayoutPlacement[],
  allowance: number,
):
  | { readonly reason: LayoutMigrationBlocker; readonly replacement: null; readonly target: null }
  | {
      readonly reason: null;
      readonly replacement: RoomSnapshot["ownedExtensions"][number];
      readonly target: RoomSnapshot["ownedExtensions"][number];
    } {
  const occupying = (room.structures ?? []).filter(({ pos }) => samePosition(pos, target.pos));
  if (
    occupying.length !== 1 ||
    room.constructionSites.some(({ pos }) => samePosition(pos, target.pos))
  )
    return { reason: "target-shared", replacement: null, target: null };
  const observedTarget = room.ownedExtensions.find(({ id }) => id === target.id);
  if (observedTarget === undefined || !observedTarget.active)
    return { reason: "target-unavailable", replacement: null, target: null };
  const exact = room.ownedExtensions
    .filter(
      (extension) =>
        extension.active &&
        extension.id !== target.id &&
        desiredExtensions.some(({ pos }) => samePosition(pos, extension.pos)),
    )
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));
  if (
    allowance <= 0 ||
    room.ownedExtensions.length !== allowance ||
    exact.length !== allowance - 1 ||
    desiredExtensions.length < allowance
  )
    return { reason: "replacement-pending", replacement: null, target: null };
  const replacement = exact[exact.length - 1];
  return replacement === undefined
    ? { reason: "replacement-pending", replacement: null, target: null }
    : { reason: null, replacement, target: observedTarget };
}

function exactExtensionEnergy(extension: RoomSnapshot["ownedExtensions"][number]): number | null {
  const energy = extension.store.resources
    .filter(({ resourceType }) => resourceType === "energy")
    .reduce((total, resource) => total + resource.amount, 0);
  return energy === extension.store.usedCapacity &&
    Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_EXTENSION_ENERGY
    ? energy
    : null;
}
function compareMigrationCandidate(a: MigrationCandidate, b: MigrationCandidate): number {
  return (
    a.target.pos.y - b.target.pos.y ||
    a.target.pos.x - b.target.pos.x ||
    a.kind.localeCompare(b.kind) ||
    a.target.id.localeCompare(b.target.id)
  );
}
function comparePlacement(a: LayoutPlacement, b: LayoutPlacement): number {
  return (
    a.minimumRcl - b.minimumRcl ||
    a.pos.y - b.pos.y ||
    a.pos.x - b.pos.x ||
    a.structureType.localeCompare(b.structureType)
  );
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function migrationGlobalBlocker(input: {
  readonly colony: ColonyView;
  readonly commitment: LayoutCommitment;
  readonly globalOwnedSiteCount: number;
  readonly room: RoomSnapshot;
}): LayoutMigrationBlocker | null {
  const { colony, commitment, globalOwnedSiteCount, room } = input;
  if (
    room.controller?.ownership !== "owned" ||
    colony.visibility !== "visible" ||
    !["developing", "mature"].includes(colony.state)
  )
    return "colony-unsafe";
  if (colony.activeThreat !== false || room.hostileCreeps.length > 0) return "threat";
  if (colony.controllerRisk !== false) return "controller-risk";
  if (colony.legalWorkforce !== true) return "workforce-unavailable";
  if (colony.rclPolicy.protectedSpawnReserve.state !== "restored") return "reserve-unrestored";
  if (
    !colony.rclPolicy.progression.authorized &&
    colony.rclPolicy.progression.status !== "sustaining"
  )
    return "progression-blocked";
  if (commitment.blockers.length > 0 || (commitment.serviceBlockers?.length ?? 0) > 0)
    return "layout-blocked";
  if (
    globalOwnedSiteCount >=
    CONSTRUCTION_SITE_LIMITS.officialHardCap - CONSTRUCTION_SITE_LIMITS.reservedGlobalHeadroom
  )
    return "global-site-headroom";
  const activeSites = room.constructionSites.filter(
    ({ ownership }) => ownership === "owned",
  ).length;
  if (activeSites >= CONSTRUCTION_SITE_LIMITS.activeSitesPerRoom) return "room-site-cap";
  return null;
}
function pushMigrationBlocker(
  blockers: LayoutMigrationBlockerRecord[],
  blocker: LayoutMigrationBlockerRecord,
): void {
  if (blockers.length < 32) blockers.push(blocker);
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
function positionKey(pos: PositionSnapshot): string {
  return `${pos.roomName}:${String(pos.x)}:${String(pos.y)}`;
}
function samePosition(a: PositionSnapshot, b: PositionSnapshot): boolean {
  return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
}
function inRangeOne(a: PositionSnapshot, b: PositionSnapshot): boolean {
  return a.roomName === b.roomName && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
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
