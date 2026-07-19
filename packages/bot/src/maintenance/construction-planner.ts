import type { ColonyView } from "../colony";
import {
  CONSTRUCTION_SITE_LIMITS,
  LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_CONTAINER_ENERGY,
  MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES,
  MAX_LAYOUT_CONTAINER_STORE_RESOURCES,
  MAX_LAYOUT_EXTENSION_ENERGY,
  STRUCTURE_REMOVAL_LIMITS,
  layoutContainerMigrationBudgetIssuer,
  layoutContainerMigrationFlowId,
  layoutContainerMigrationResourceBudgetIssuer,
  layoutContainerMigrationResourceFlowId,
  layoutExtensionEvacuationFlowId,
  type LayoutCommitment,
  type LayoutContainerMigration,
  type LayoutContainerMigrationResource,
  type LayoutExtensionEvacuation,
  type LayoutMigrationBlocker,
  type LayoutMigrationBlockerRecord,
  type LayoutMigrationPlanningResult,
  type LayoutMigrationProposal,
  type LayoutPlacement,
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

  /** Plans bounded road, container, and extension convergence. */
  planMigration(input: {
    readonly activeLogisticsFlowIds?: ReadonlySet<string>;
    readonly activeLogisticsTargetIds?: ReadonlySet<string>;
    readonly colony: ColonyView;
    readonly commitment: LayoutCommitment;
    readonly containerMigration?: LayoutContainerMigration | null;
    readonly currentPlacements?: readonly LayoutPlacement[];
    readonly extensionEvacuation?: LayoutExtensionEvacuation | null;
    readonly globalOwnedSiteCount: number;
    readonly logisticsEvidenceReady?: boolean;
    readonly observationFingerprint: string;
    readonly placements: readonly LayoutPlacement[];
    readonly policyFingerprint: string;
    readonly room: RoomSnapshot;
  }): LayoutMigrationPlanningResult {
    const blockers: LayoutMigrationBlockerRecord[] = [];
    const proposals: LayoutMigrationProposal[] = [];
    const towerCandidates = input.placements.filter(
      (placement) =>
        placement.adoption === "planned" &&
        placement.layer === "primary" &&
        placement.structureType === "tower",
    );
    const desiredExtensions = input.placements
      .filter(
        (placement) => placement.layer === "primary" && placement.structureType === "extension",
      )
      .sort(comparePlacement);
    const extensionCandidates = (input.room.structures ?? []).filter(
      (structure) =>
        structure.ownership === "owned" &&
        structure.structureType === "extension" &&
        !desiredExtensions.some(({ pos }) => samePosition(pos, structure.pos)),
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
      ...towerCandidates.map((placement) => ({ kind: "road" as const, placement })),
      ...sourceContainerCandidates.map((target) => ({
        kind: "source-container" as const,
        target,
      })),
      ...generalContainerCandidates.map((target) => ({
        kind: "general-container" as const,
        target,
      })),
      ...extensionCandidates.map((target) => ({ kind: "extension" as const, target })),
    ].sort((left, right) => {
      const activeSourceId = input.extensionEvacuation?.sourceId;
      const leftActive = left.kind === "extension" && left.target.id === activeSourceId;
      const rightActive = right.kind === "extension" && right.target.id === activeSourceId;
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
    if (considered.length === 0)
      return freeze({
        authorization: null,
        blockers,
        containerMigration,
        extensionEvacuation: null,
        proposals,
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
        proposals,
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
    const towerCount = observedStructureCount(input.room, "tower");
    const towerAllowance = input.colony.rclPolicy.unlocks?.towers ?? 0;
    let extensionEvacuation: LayoutExtensionEvacuation | null = null;
    for (const candidate of considered) {
      if (candidate.kind === "road") {
        const occupying = [...(input.room.structures ?? [])]
          .filter(({ pos }) => samePosition(pos, candidate.placement.pos))
          .sort((a, b) => a.id.localeCompare(b.id));
        const road = occupying[0];
        if (
          occupying.length !== 1 ||
          road?.structureType !== "road" ||
          road.ownership === "foreign"
        )
          continue;
        const reason = migrationCandidateBlocker(
          input.room,
          candidate.placement,
          towerCount,
          towerAllowance,
        );
        if (reason !== null) {
          pushMigrationBlocker(blockers, {
            reason,
            roomName: input.room.name,
            targetId: road.id,
          });
          continue;
        }
        proposals.push({
          colonyId: input.colony.id,
          layoutFingerprint: input.commitment.fingerprint,
          observationFingerprint: input.observationFingerprint,
          policyFingerprint: input.policyFingerprint,
          pos: candidate.placement.pos,
          replacementId: null,
          replacementStructureType: "tower",
          stableId: [
            "remove-road-v1",
            input.colony.id,
            input.commitment.fingerprint,
            road.id,
            candidate.placement.pos.y,
            candidate.placement.pos.x,
          ].join(":"),
          targetId: road.id,
          targetRequiresEmptyStore: false,
          targetStructureType: "road",
        });
        continue;
      }

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
        proposals.push({
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
        });
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
        proposals.push({
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
      proposals.push({
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
      });
      if (extensionEvacuation !== null) break;
    }
    return freeze({
      authorization,
      blockers,
      containerMigration,
      extensionEvacuation,
      proposals: proposals.sort((a, b) => a.stableId.localeCompare(b.stableId)),
      scannedCandidates: considered.length,
      truncatedCandidates,
    });
  }
}

type MigrationCandidate =
  | { readonly kind: "road"; readonly placement: LayoutPlacement }
  | { readonly kind: "source-container"; readonly target: StoredStructureSnapshot }
  | { readonly kind: "general-container"; readonly target: StoredStructureSnapshot }
  | { readonly kind: "extension"; readonly target: StructureSnapshot };

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
  const receipt = migration.removalReceipt;
  if (receipt !== undefined) {
    if (
      !Number.isSafeInteger(receipt.attempt) ||
      receipt.attempt < 1 ||
      receipt.attempt > 3 ||
      !Number.isSafeInteger(receipt.observedAt) ||
      !Number.isSafeInteger(receipt.nextEligibleTick) ||
      receipt.nextEligibleTick <= receipt.observedAt
    )
      return { blocker: "removal-failed", migration };
    if (receipt.code === "OK" || receipt.code === "TARGET_ABSENT")
      return { blocker: "removal-pending", migration };
    if (receipt.attempt >= 3) return { blocker: "removal-failed", migration };
    if (input.tick < receipt.nextEligibleTick) return { blocker: "removal-backoff", migration };
  }
  return { blocker: null, migration };
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
  const aPos = a.kind === "road" ? a.placement.pos : a.target.pos;
  const bPos = b.kind === "road" ? b.placement.pos : b.target.pos;
  const aId = a.kind === "road" ? a.placement.structureType : a.target.id;
  const bId = b.kind === "road" ? b.placement.structureType : b.target.id;
  return (
    aPos.y - bPos.y || aPos.x - bPos.x || a.kind.localeCompare(b.kind) || aId.localeCompare(bId)
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
function migrationCandidateBlocker(
  room: RoomSnapshot,
  placement: LayoutPlacement,
  towerCount: number,
  towerAllowance: number,
): LayoutMigrationBlocker | null {
  if (room.constructionSites.some(({ pos }) => samePosition(pos, placement.pos)))
    return "site-conflict";
  if (placement.minimumRcl > (room.controller?.level ?? 0)) return "progression-blocked";
  if (towerCount >= towerAllowance) return "allowance-full";
  return null;
}
function observedStructureCount(room: RoomSnapshot, structureType: string): number {
  const structures = new Set(
    (room.structures ?? [])
      .filter((structure) => structure.structureType === structureType)
      .map(({ id }) => id),
  );
  for (const site of room.constructionSites)
    if (site.ownership === "owned" && site.structureType === structureType)
      structures.add(`site/${site.id}`);
  return structures.size;
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
