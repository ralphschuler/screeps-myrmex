import { classifyPlayerRelation, type RuntimeConfig } from "../config";
import { defineIntent, type IntentEnvelope } from "../execution";
import type {
  ControllerSnapshot,
  CreepSnapshot,
  OwnedSpawnSnapshot,
  OwnedTowerSnapshot,
  WorldSnapshot,
} from "../world/snapshot";

export type DefenseIntentKind = "tower.attack" | "tower.heal" | "tower.repair" | "safe-mode";
export type DefenseIntent = IntentEnvelope<DefenseIntentKind>;

const TOWER_ACTION_ENERGY = 10;
const ATTACK_PART_DAMAGE = 30;
const RANGED_PART_DAMAGE = 10;

/**
 * Pure, tick-local defense selection. It owns neither a queue nor diplomacy: configured relations
 * are resolved before every possible target, and only execution owns the live Screeps commands.
 */
export function planDefense(
  snapshot: WorldSnapshot,
  config: RuntimeConfig,
): readonly DefenseIntent[] {
  const intents: DefenseIntent[] = [];
  const revision = `${snapshot.observation.shard}:${String(snapshot.observation.tick)}:${String(
    snapshot.stats.estimatedPayloadBytes,
  )}`;
  for (const room of snapshot.rooms) {
    if (room.controller?.ownership !== "owned") continue;
    const hostile = eligibleHostiles(room.hostileCreeps, config, snapshot.observedAt);
    const criticalHeal = room.ownedCreeps
      .filter((creep) => creep.hits < creep.hitsMax && hitRatioBasisPoints(creep) <= 2_500)
      .sort(compareCreepThreat)[0];
    const attackTarget = hostile.sort(compareCreepThreat)[0];
    const criticalRepair = room.ownedSpawns
      .filter(
        (spawn) =>
          hitRatioBasisPoints(spawn) <= config.policy.safeMode.criticalAssetHitsBasisPoints,
      )
      .sort(compareById)[0];

    for (const tower of room.ownedTowers) {
      if (energy(tower) < TOWER_ACTION_ENERGY) continue;
      const action =
        criticalHeal !== undefined
          ? towerIntent(
              "tower.heal",
              tower,
              criticalHeal.id,
              room.name,
              revision,
              snapshot.observedAt,
              3_000,
            )
          : attackTarget !== undefined
            ? towerIntent(
                "tower.attack",
                tower,
                attackTarget.id,
                room.name,
                revision,
                snapshot.observedAt,
                2_000,
              )
            : canRepair(tower, config) && criticalRepair !== undefined
              ? towerIntent(
                  "tower.repair",
                  tower,
                  criticalRepair.id,
                  room.name,
                  revision,
                  snapshot.observedAt,
                  1_000,
                )
              : null;
      if (action !== null) intents.push(action);
    }

    if (qualifiesSafeMode(room.controller, room.ownedSpawns, room.ownedTowers, hostile, config)) {
      intents.push(
        defineIntent({
          id: `defense/${room.name}/safe-mode/${String(snapshot.observedAt)}`,
          kind: "safe-mode",
          issuer: `defense/${room.name}`,
          tick: snapshot.observedAt,
          target: room.controller.id,
          snapshotRevision: revision,
          exclusiveResourceKey: `safe-mode/${room.controller.id}`,
          priority: { class: "safety", value: 4_000 },
          deadline: snapshot.observedAt,
          budget: { id: `defense/${room.name}/safe-mode`, cost: 1 },
          preconditions: [],
          payload: { roomName: room.name },
        }),
      );
    }
  }
  return Object.freeze(intents.sort((left, right) => left.id.localeCompare(right.id)));
}

function towerIntent(
  kind: Exclude<DefenseIntentKind, "safe-mode">,
  tower: OwnedTowerSnapshot,
  target: string,
  roomName: string,
  revision: string,
  tick: number,
  priority: number,
): DefenseIntent {
  return defineIntent({
    id: `defense/${roomName}/${tower.id}/${kind}/${target}/${String(tick)}`,
    kind,
    issuer: `defense/${roomName}`,
    tick,
    target,
    snapshotRevision: revision,
    exclusiveResourceKey: `tower/${tower.id}`,
    priority: { class: "safety", value: priority },
    deadline: tick,
    budget: { id: `defense/${roomName}/${tower.id}`, cost: 1 },
    preconditions: [],
    payload: { towerId: tower.id },
  });
}

function eligibleHostiles(
  creeps: readonly CreepSnapshot[],
  config: RuntimeConfig,
  tick: number,
): CreepSnapshot[] {
  return creeps.filter(
    (creep) =>
      classifyPlayerRelation(config, { username: creep.ownerUsername, tick }).targetingCeiling ===
      "local-defense",
  );
}

function qualifiesSafeMode(
  controller: ControllerSnapshot,
  spawns: readonly OwnedSpawnSnapshot[],
  towers: readonly OwnedTowerSnapshot[],
  hostile: readonly CreepSnapshot[],
  config: RuntimeConfig,
): boolean {
  if (
    !config.policy.safeMode.enabled ||
    controller.safeMode !== null ||
    controller.safeModeAvailable <= 0 ||
    controller.safeModeCooldown !== null ||
    controller.upgradeBlocked !== null ||
    hostileOffense(hostile) < config.policy.safeMode.minimumHostileOffenseParts
  )
    return false;
  const predictedDamage = hostile.reduce(
    (total, creep) =>
      total +
      (creep.body.attack.active * ATTACK_PART_DAMAGE +
        creep.body.rangedAttack.active * RANGED_PART_DAMAGE) *
        config.policy.safeMode.lossPredictionHorizonTicks,
    0,
  );
  return [...spawns, ...towers].some(
    (asset) =>
      hitRatioBasisPoints(asset) <= config.policy.safeMode.criticalAssetHitsBasisPoints &&
      predictedDamage >= asset.hits,
  );
}

function hostileOffense(hostiles: readonly CreepSnapshot[]): number {
  return hostiles.reduce(
    (total, creep) =>
      total + creep.body.attack.active + creep.body.rangedAttack.active + creep.body.work.active,
    0,
  );
}

function canRepair(tower: OwnedTowerSnapshot, config: RuntimeConfig): boolean {
  return (
    energy(tower) >= config.policy.tower.repairMinimumEnergy &&
    energy(tower) - TOWER_ACTION_ENERGY >= config.policy.tower.emergencyReserveEnergy
  );
}

function energy(value: {
  readonly store: {
    readonly resources: readonly { readonly resourceType: string; readonly amount: number }[];
  };
}): number {
  return value.store.resources.find((resource) => resource.resourceType === "energy")?.amount ?? 0;
}

function hitRatioBasisPoints(value: { readonly hits: number; readonly hitsMax: number }): number {
  return value.hitsMax === 0 ? 10_000 : Math.floor((value.hits * 10_000) / value.hitsMax);
}

function compareCreepThreat(left: CreepSnapshot, right: CreepSnapshot): number {
  return hostilePower(right) - hostilePower(left) || left.id.localeCompare(right.id);
}

function hostilePower(creep: CreepSnapshot): number {
  return (
    creep.body.attack.active +
    creep.body.rangedAttack.active +
    creep.body.heal.active +
    creep.body.work.active
  );
}

function compareById<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
