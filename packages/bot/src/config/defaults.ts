import { deepFreeze } from "./canonical";
import type { ConfiguredRelations, SurvivalPolicy } from "./contracts";

/** Bump whenever defaults, validation meaning, or the source gate manifest changes. */
export const RUNTIME_CONFIG_SOURCE_REVISION = "runtime-config-source-v4" as const;

export const DEFAULT_SURVIVAL_POLICY: SurvivalPolicy = deepFreeze({
  recovery: {
    protectedSpawnEnergy: 300,
    emergencyWorkerEnergyBudget: 300,
    controllerRiskWindowTicks: 3_000,
  },
  leases: {
    durationTicks: 50,
    renewalWindowTicks: 10,
  },
  retries: {
    maximumAttempts: 5,
    initialDelayTicks: 2,
    maximumDelayTicks: 64,
  },
  movement: {
    maximumSearchOperations: 2_000,
    maximumPathCost: 200,
    stuckReplanTicks: 3,
    blockedReleaseTicks: 10,
  },
  spawn: {
    maximumBodyParts: 50,
    maximumBodyEnergy: 3_000,
    maximumNonMovePartsPerMovePart: 2,
    replacementSafetyMarginTicks: 50,
    nameCollisionRetryLimit: 3,
  },
  repair: {
    criticalHitsBasisPoints: 2_500,
    completionHitsBasisPoints: 8_000,
    maximumActiveContractsPerRoom: 2,
    maximumEnergyPerTick: 200,
  },
  tower: {
    emergencyReserveEnergy: 400,
    repairMinimumEnergy: 800,
  },
  safeMode: {
    enabled: true,
    criticalAssetHitsBasisPoints: 2_000,
    lossPredictionHorizonTicks: 20,
    minimumHostileOffenseParts: 1,
    retryDelayTicks: 10,
  },
});

export const DEFAULT_CONFIGURED_RELATIONS: ConfiguredRelations = deepFreeze({
  self: [],
  allies: [],
  naps: [],
});
