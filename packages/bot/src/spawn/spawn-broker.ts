import {
  ENGINE_MAX_BODY_PARTS,
  OFFICIAL_BODY_PARTS,
  buildSpawnBody,
  type SpawnBodyBuildResult,
  type SpawnBodyPart,
  type SpawnBodyPartCounts,
} from "./body-builder";
import type {
  CreepSnapshot,
  OwnedRoomSnapshot,
  OwnedSpawnSnapshot,
  WorldSnapshot,
} from "../world/snapshot";

export const MAX_RAW_SPAWN_DEMANDS = 128;
export const MAX_LOGICAL_SPAWN_DEMANDS = 64;
export const MAX_BROKER_SPAWNS = 64;
export const MAX_BROKER_PAIR_WORK = 4_096;
export const MAX_SPAWN_EXPECTATIONS = 128;
export const MAX_OBSERVED_CREEP_NAMES = 4_096;
export const MAX_CREEP_NAME_CODE_UNITS = 100;
export const MAX_NAME_COLLISION_RETRIES = 10;

const MAX_ID_CODE_UNITS = 256;

export const SPAWN_DEMAND_CATEGORIES = Object.freeze([
  "emergency-recovery",
  "replacement",
  "upgrading",
  "construction",
] as const);

export type SpawnDemandCategory = (typeof SPAWN_DEMAND_CATEGORIES)[number];

/** A detached, data-only request. The broker never owns or persists a demand queue. */
export interface SpawnDemand {
  readonly id: string;
  readonly issuer: string;
  readonly colonyId: string;
  readonly revision: number;
  readonly category: SpawnDemandCategory;
  readonly priorityValue: number;
  readonly deadline: number;
  readonly earliestTick: number;
  readonly destinationRoomName: string;
  readonly replacementCreepName: string | null;
  readonly budgetId: string;
  readonly requiredPartCounts: SpawnBodyPartCounts;
  readonly energyCap: number;
  /** An exact caller-selected base, or null to use the self-identifying generated base. */
  readonly nameBasis: string | null;
}

export interface SpawnExpectation {
  readonly demandId: string;
  readonly revision: number;
  readonly spawnId: string;
  /** Exact name acknowledged by a successful spawn command. */
  readonly creepName: string;
  readonly scheduledAt: number;
  readonly expectedReadyAt: number;
  readonly retryAt: number;
}

export type SpawnDemandNameIdentity = Pick<
  SpawnDemand,
  "id" | "issuer" | "colonyId" | "revision" | "category"
>;

export interface SpawnBrokerPolicy {
  readonly maximumBodyParts: number;
  readonly maximumBodyEnergy: number;
  readonly maximumNonMovePartsPerMovePart: number;
  /** Number of suffix attempts after the unsuffixed base. */
  readonly nameCollisionRetryLimit: number;
  readonly retryDelayTicks: number;
}

export interface SpawnBrokerInput {
  readonly tick: number;
  readonly snapshot: WorldSnapshot;
  readonly demands: readonly SpawnDemand[];
  readonly expectations: readonly SpawnExpectation[];
  readonly policy: SpawnBrokerPolicy;
}

export type SpawnBrokerBatchReason =
  | "planned"
  | "invalid-input"
  | "invalid-policy"
  | "invalid-expectation"
  | "raw-demand-cap-exceeded"
  | "logical-demand-cap-exceeded"
  | "spawn-cap-exceeded"
  | "pair-work-cap-exceeded"
  | "observed-name-cap-exceeded";

export type SpawnDecisionStatus = "selected" | "satisfied" | "deferred" | "impossible" | "invalid";

export type SpawnDecisionReason =
  | "selected"
  | "observed-creep"
  | "observed-spawning"
  | "expectation-pending"
  | "not-before"
  | "deadline-expired"
  | "deadline-before-earliest"
  | "remote-destination-unsupported"
  | "local-room-unobserved"
  | "no-idle-spawn"
  | "insufficient-energy"
  | "body-impossible"
  | "body-invalid"
  | "name-collision-exhausted"
  | "identity-conflict"
  | "invalid-demand"
  | "invalid-name-basis"
  | "tick-overflow";

export type SpawnBodyFailureReason = Exclude<
  SpawnBodyBuildResult,
  { readonly status: "built" }
>["reason"];

export interface SpawnBrokerDecision {
  readonly demandId: string;
  readonly revision: number | null;
  readonly status: SpawnDecisionStatus;
  readonly reason: SpawnDecisionReason;
  readonly retryAt: number | null;
  readonly bodyReason: SpawnBodyFailureReason | null;
  readonly energyCost: number | null;
  readonly spawnId: string | null;
  readonly name: string | null;
}

export interface SpawnClaim {
  readonly spawnId: string;
  readonly startTick: number;
  readonly endTick: number;
}

export interface SpawnSelection {
  readonly demandId: string;
  readonly revision: number;
  readonly issuer: string;
  readonly colonyId: string;
  readonly category: SpawnDemandCategory;
  readonly destinationRoomName: string;
  readonly replacementCreepName: string | null;
  readonly budgetId: string;
  readonly spawnId: string;
  readonly spawnName: string;
  readonly nameBasis: string;
  readonly name: string;
  readonly body: readonly SpawnBodyPart[];
  readonly energyCost: number;
  readonly spawnTicks: number;
  readonly spawnClaim: SpawnClaim;
}

export interface SpawnBrokerResult {
  readonly status: "planned" | "invalid";
  readonly reason: SpawnBrokerBatchReason;
  readonly decisions: readonly SpawnBrokerDecision[];
  readonly selections: readonly SpawnSelection[];
}

interface DemandGroupResult {
  readonly conflicts: readonly SpawnBrokerDecision[];
  readonly demands: readonly SpawnDemand[];
  readonly logicalCount: number;
}

interface PreparedDemand {
  readonly demand: SpawnDemand;
  readonly room: OwnedRoomSnapshot | null;
  readonly bodyResult: SpawnBodyBuildResult | null;
  readonly sortCost: number;
}

interface ObservedNames {
  readonly creeps: ReadonlyMap<string, readonly CreepSnapshot[]>;
  readonly spawningRetryAt: ReadonlyMap<string, number>;
}

const CATEGORY_RANK = new Map(
  SPAWN_DEMAND_CATEGORIES.map((category, index) => [category, index] as const),
);

/** The sole pure spawn-slot arbiter. All state is supplied and returned as frozen plain data. */
export class SpawnBroker {
  public arbitrate(input: SpawnBrokerInput): SpawnBrokerResult {
    return arbitrateSpawnDemands(input);
  }
}

export function arbitrateSpawnDemands(input: SpawnBrokerInput): SpawnBrokerResult {
  try {
    return arbitrateValidated(input);
  } catch {
    return invalidBatch("invalid-input");
  }
}

function arbitrateValidated(input: SpawnBrokerInput): SpawnBrokerResult {
  if (!isNonnegativeSafeInteger(input.tick)) {
    return invalidBatch("invalid-input");
  }
  if (!isValidPolicy(input.policy)) {
    return invalidBatch("invalid-policy");
  }
  if (input.demands.length > MAX_RAW_SPAWN_DEMANDS) {
    return invalidBatch("raw-demand-cap-exceeded");
  }
  if (input.expectations.length > MAX_SPAWN_EXPECTATIONS) {
    return invalidBatch("invalid-expectation");
  }
  if (input.expectations.some((expectation) => !isValidExpectation(expectation))) {
    return invalidBatch("invalid-expectation");
  }

  const grouped = groupDemands(input.demands);
  if (grouped.logicalCount > MAX_LOGICAL_SPAWN_DEMANDS) {
    return invalidBatch("logical-demand-cap-exceeded");
  }

  const spawns = collectOwnedSpawns(input.snapshot);
  if (spawns === null) {
    return invalidBatch("spawn-cap-exceeded");
  }
  if (grouped.logicalCount * spawns.length > MAX_BROKER_PAIR_WORK) {
    return invalidBatch("pair-work-cap-exceeded");
  }

  const observedNames = collectObservedNames(input.snapshot, input.tick);
  if (observedNames === null) {
    return invalidBatch("observed-name-cap-exceeded");
  }

  const rooms = canonicalOwnedRooms(input.snapshot.ownedRooms);
  const roomByName = new Map(rooms.map((room) => [room.name, room] as const));
  const prepared = grouped.demands.map((demand) =>
    prepareDemand(demand, roomByName.get(demand.colonyId) ?? null, input.policy),
  );
  prepared.sort(comparePreparedDemands);

  const idleByRoom = collectIdleSpawns(rooms);
  const remainingEnergy = new Map(rooms.map((room) => [room.name, room.energyAvailable] as const));
  const expectations = indexExpectations(input.expectations);
  const reservedNames = new Set<string>();
  const decisions: SpawnBrokerDecision[] = [];
  const selections: SpawnSelection[] = [];

  for (const candidate of prepared) {
    const outcome = arbitrateDemand({
      candidate,
      tick: input.tick,
      policy: input.policy,
      observedNames,
      expectations,
      idleByRoom,
      remainingEnergy,
      reservedNames,
    });
    decisions.push(outcome.decision);
    if (outcome.selection !== null) {
      selections.push(outcome.selection);
    }
  }

  decisions.push(...grouped.conflicts);
  return deepFreeze({
    status: "planned",
    reason: "planned",
    decisions,
    selections,
  });
}

function groupDemands(demands: readonly SpawnDemand[]): DemandGroupResult {
  const groups = new Map<string, SpawnDemand[]>();
  const malformed: SpawnBrokerDecision[] = [];

  for (const demand of demands) {
    if (!isBoundedText(demand.id)) {
      malformed.push(decision(demandIdOf(demand), null, "invalid", "invalid-demand"));
      continue;
    }
    const group = groups.get(demand.id) ?? [];
    group.push(demand);
    groups.set(demand.id, group);
  }

  const unique: SpawnDemand[] = [];
  const conflicts = [...malformed];
  for (const [id, group] of [...groups].sort(compareMapEntries)) {
    const byteForms = new Set(group.map(canonicalDemandBytes));
    if (byteForms.size !== 1) {
      conflicts.push(decision(id, null, "invalid", "identity-conflict"));
      continue;
    }
    const first = group[0];
    if (first !== undefined) {
      unique.push(first);
    }
  }
  conflicts.sort(compareDecisionsByIdentity);
  return { conflicts, demands: unique, logicalCount: groups.size + malformed.length };
}

function prepareDemand(
  demand: SpawnDemand,
  room: OwnedRoomSnapshot | null,
  policy: SpawnBrokerPolicy,
): PreparedDemand {
  if (!isValidDemand(demand) || room === null) {
    return { demand, room, bodyResult: null, sortCost: Number.MAX_SAFE_INTEGER };
  }
  const bodyResult = buildSpawnBody({
    availableEnergy: room.energyAvailable,
    energyCapacity: room.energyCapacityAvailable,
    maximumBodyEnergy: Math.min(demand.energyCap, policy.maximumBodyEnergy),
    maximumBodyParts: policy.maximumBodyParts,
    maximumNonMovePartsPerMovePart: policy.maximumNonMovePartsPerMovePart,
    requiredPartCounts: demand.requiredPartCounts,
  });
  return {
    demand,
    room,
    bodyResult,
    sortCost: bodyRequiredEnergy(bodyResult),
  };
}

function arbitrateDemand(input: {
  readonly candidate: PreparedDemand;
  readonly tick: number;
  readonly policy: SpawnBrokerPolicy;
  readonly observedNames: ObservedNames;
  readonly expectations: ReadonlyMap<string, readonly SpawnExpectation[]>;
  readonly idleByRoom: Map<string, OwnedSpawnSnapshot[]>;
  readonly remainingEnergy: Map<string, number>;
  readonly reservedNames: Set<string>;
}): { readonly decision: SpawnBrokerDecision; readonly selection: SpawnSelection | null } {
  const { demand } = input.candidate;
  const invalidReason = demandInvalidReason(demand);
  if (invalidReason !== null) {
    return noSelection(decision(demand.id, demand.revision, "invalid", invalidReason));
  }

  const matchingExpectations = input.expectations.get(demand.id) ?? [];
  if (
    matchingExpectations.some((expectation) =>
      observedCreepSatisfiesDemand(
        input.observedNames.creeps.get(expectation.creepName),
        demand.requiredPartCounts,
        input.policy.maximumNonMovePartsPerMovePart,
        demand.replacementCreepName,
      ),
    )
  ) {
    return noSelection(decision(demand.id, demand.revision, "satisfied", "observed-creep"));
  }
  const expectedCreepSpawningRetryAt = maximumExpectedCreepSpawningRetryAt(
    matchingExpectations,
    input.observedNames.spawningRetryAt,
  );
  if (expectedCreepSpawningRetryAt !== null) {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "observed-spawning",
        expectedCreepSpawningRetryAt,
      ),
    );
  }
  const inadequateExpectedCreepObserved = matchingExpectations.some((expectation) =>
    input.observedNames.creeps.has(expectation.creepName),
  );
  const expectedRetryAt = maximumExpectationRetryAt(matchingExpectations);
  if (
    !inadequateExpectedCreepObserved &&
    expectedRetryAt !== null &&
    input.tick < expectedRetryAt
  ) {
    return noSelection(
      decision(demand.id, demand.revision, "deferred", "expectation-pending", expectedRetryAt),
    );
  }

  const nameBasis = demand.nameBasis ?? generatedSpawnCreepName(demand);
  const names =
    demand.nameBasis === null
      ? [nameBasis]
      : candidateNames(nameBasis, input.policy.nameCollisionRetryLimit);
  if (demand.nameBasis === null) {
    const spawningRetryAt = input.observedNames.spawningRetryAt.get(nameBasis);
    if (spawningRetryAt !== undefined) {
      return noSelection(
        decision(demand.id, demand.revision, "deferred", "observed-spawning", spawningRetryAt),
      );
    }
    if (
      observedCreepSatisfiesDemand(
        input.observedNames.creeps.get(nameBasis),
        demand.requiredPartCounts,
        input.policy.maximumNonMovePartsPerMovePart,
        demand.replacementCreepName,
      )
    ) {
      return noSelection(decision(demand.id, demand.revision, "satisfied", "observed-creep"));
    }
  }
  if (input.tick > demand.deadline) {
    return noSelection(decision(demand.id, demand.revision, "impossible", "deadline-expired"));
  }
  if (demand.earliestTick > demand.deadline) {
    return noSelection(
      decision(demand.id, demand.revision, "impossible", "deadline-before-earliest"),
    );
  }
  if (input.tick < demand.earliestTick) {
    return noSelection(
      decision(demand.id, demand.revision, "deferred", "not-before", demand.earliestTick),
    );
  }
  if (demand.destinationRoomName !== demand.colonyId) {
    return noSelection(
      decision(demand.id, demand.revision, "impossible", "remote-destination-unsupported"),
    );
  }
  if (input.candidate.room === null) {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "local-room-unobserved",
        retryAt(input.tick, input.policy.retryDelayTicks),
      ),
    );
  }

  const bodyResult = input.candidate.bodyResult;
  if (bodyResult === null || bodyResult.status === "invalid") {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "invalid",
        "body-invalid",
        null,
        bodyResult?.reason ?? null,
        bodyResult?.requiredEnergy ?? null,
      ),
    );
  }
  if (bodyResult.status === "impossible") {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "impossible",
        "body-impossible",
        null,
        bodyResult.reason,
        bodyResult.requiredEnergy,
      ),
    );
  }
  if (bodyResult.status === "deferred") {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "insufficient-energy",
        retryAt(input.tick, input.policy.retryDelayTicks),
        bodyResult.reason,
        bodyResult.requiredEnergy,
      ),
    );
  }

  const unavailableNames = new Set<string>([
    ...input.observedNames.creeps.keys(),
    ...input.observedNames.spawningRetryAt.keys(),
    ...input.reservedNames,
  ]);
  const name = names.find((candidate) => !unavailableNames.has(candidate));
  if (name === undefined) {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "name-collision-exhausted",
        retryAt(input.tick, input.policy.retryDelayTicks),
        null,
        bodyResult.energyCost,
      ),
    );
  }

  const idle = input.idleByRoom.get(demand.colonyId) ?? [];
  const spawn = idle[0];
  if (spawn === undefined) {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "no-idle-spawn",
        retryAt(input.tick, input.policy.retryDelayTicks),
        null,
        bodyResult.energyCost,
      ),
    );
  }

  const roomEnergy = input.remainingEnergy.get(demand.colonyId) ?? 0;
  if (bodyResult.energyCost > roomEnergy) {
    return noSelection(
      decision(
        demand.id,
        demand.revision,
        "deferred",
        "insufficient-energy",
        retryAt(input.tick, input.policy.retryDelayTicks),
        null,
        bodyResult.energyCost,
      ),
    );
  }

  const endTick = checkedAdd(input.tick, bodyResult.spawnTicks);
  if (endTick === null) {
    return noSelection(decision(demand.id, demand.revision, "impossible", "tick-overflow"));
  }

  idle.shift();
  input.remainingEnergy.set(demand.colonyId, roomEnergy - bodyResult.energyCost);
  input.reservedNames.add(name);
  const selection: SpawnSelection = {
    demandId: demand.id,
    revision: demand.revision,
    issuer: demand.issuer,
    colonyId: demand.colonyId,
    category: demand.category,
    destinationRoomName: demand.destinationRoomName,
    replacementCreepName: demand.replacementCreepName,
    budgetId: demand.budgetId,
    spawnId: spawn.id,
    spawnName: spawn.name,
    nameBasis,
    name,
    body: [...bodyResult.body],
    energyCost: bodyResult.energyCost,
    spawnTicks: bodyResult.spawnTicks,
    spawnClaim: {
      spawnId: spawn.id,
      startTick: input.tick,
      endTick,
    },
  };
  return {
    decision: decision(
      demand.id,
      demand.revision,
      "selected",
      "selected",
      null,
      null,
      bodyResult.energyCost,
      spawn.id,
      name,
    ),
    selection,
  };
}

function demandInvalidReason(demand: SpawnDemand): SpawnDecisionReason | null {
  if (demand.nameBasis !== null && !isValidCreepName(demand.nameBasis)) {
    return "invalid-name-basis";
  }
  return isValidDemand(demand) ? null : "invalid-demand";
}

function isValidDemand(demand: SpawnDemand): boolean {
  return (
    isBoundedText(demand.id) &&
    isBoundedText(demand.issuer) &&
    isBoundedText(demand.colonyId) &&
    isNonnegativeSafeInteger(demand.revision) &&
    SPAWN_DEMAND_CATEGORIES.includes(demand.category) &&
    Number.isSafeInteger(demand.priorityValue) &&
    isNonnegativeSafeInteger(demand.deadline) &&
    isNonnegativeSafeInteger(demand.earliestTick) &&
    isBoundedText(demand.destinationRoomName) &&
    (demand.replacementCreepName === null || isValidCreepName(demand.replacementCreepName)) &&
    isBoundedText(demand.budgetId) &&
    isNonnegativeSafeInteger(demand.energyCap) &&
    (demand.nameBasis === null || isValidCreepName(demand.nameBasis))
  );
}

function isValidPolicy(policy: SpawnBrokerPolicy): boolean {
  return (
    isPositiveSafeInteger(policy.maximumBodyParts) &&
    policy.maximumBodyParts <= ENGINE_MAX_BODY_PARTS &&
    isNonnegativeSafeInteger(policy.maximumBodyEnergy) &&
    isPositiveSafeInteger(policy.maximumNonMovePartsPerMovePart) &&
    isNonnegativeSafeInteger(policy.nameCollisionRetryLimit) &&
    policy.nameCollisionRetryLimit <= MAX_NAME_COLLISION_RETRIES &&
    isPositiveSafeInteger(policy.retryDelayTicks)
  );
}

function isValidExpectation(expectation: SpawnExpectation): boolean {
  return (
    isBoundedText(expectation.demandId) &&
    isNonnegativeSafeInteger(expectation.revision) &&
    isBoundedText(expectation.spawnId) &&
    isValidCreepName(expectation.creepName) &&
    isNonnegativeSafeInteger(expectation.scheduledAt) &&
    isNonnegativeSafeInteger(expectation.expectedReadyAt) &&
    isNonnegativeSafeInteger(expectation.retryAt) &&
    expectation.scheduledAt <= expectation.expectedReadyAt &&
    expectation.expectedReadyAt <= expectation.retryAt
  );
}

function canonicalDemandBytes(demand: SpawnDemand): string {
  return JSON.stringify([
    demand.id,
    demand.issuer,
    demand.colonyId,
    demand.revision,
    demand.category,
    demand.priorityValue,
    demand.deadline,
    demand.earliestTick,
    demand.destinationRoomName,
    demand.replacementCreepName,
    demand.budgetId,
    [
      demand.requiredPartCounts.tough,
      demand.requiredPartCounts.work,
      demand.requiredPartCounts.carry,
      demand.requiredPartCounts.attack,
      demand.requiredPartCounts.ranged_attack,
      demand.requiredPartCounts.heal,
      demand.requiredPartCounts.claim,
      demand.requiredPartCounts.move,
    ],
    demand.energyCap,
    demand.nameBasis,
  ]);
}

function comparePreparedDemands(left: PreparedDemand, right: PreparedDemand): number {
  return (
    rank(left.demand.category) - rank(right.demand.category) ||
    compareNumbersDescending(left.demand.priorityValue, right.demand.priorityValue) ||
    compareNumbers(left.demand.deadline, right.demand.deadline) ||
    compareNumbers(left.sortCost, right.sortCost) ||
    compareStrings(left.demand.id, right.demand.id)
  );
}

function rank(category: SpawnDemandCategory): number {
  return CATEGORY_RANK.get(category) ?? SPAWN_DEMAND_CATEGORIES.length;
}

function bodyRequiredEnergy(result: SpawnBodyBuildResult): number {
  return result.status === "built"
    ? result.energyCost
    : (result.requiredEnergy ?? Number.MAX_SAFE_INTEGER);
}

function collectOwnedSpawns(snapshot: WorldSnapshot): readonly OwnedSpawnSnapshot[] | null {
  const spawns: OwnedSpawnSnapshot[] = [];
  for (const room of snapshot.ownedRooms) {
    for (const spawn of room.ownedSpawns) {
      spawns.push(spawn);
      if (spawns.length > MAX_BROKER_SPAWNS) {
        return null;
      }
    }
  }
  return spawns;
}

function collectObservedNames(snapshot: WorldSnapshot, tick: number): ObservedNames | null {
  const creeps = new Map<string, CreepSnapshot[]>();
  const spawningRetryAt = new Map<string, number>();
  const observedCreepNames = new Set<string>();
  for (const room of snapshot.rooms) {
    for (const creep of room.ownedCreeps) {
      observedCreepNames.add(creep.name);
      if (observedCreepNames.size > MAX_OBSERVED_CREEP_NAMES) {
        return null;
      }
      if (creep.spawning) {
        spawningRetryAt.set(
          creep.name,
          Math.max(spawningRetryAt.get(creep.name) ?? 0, retryAt(tick, 1)),
        );
      } else {
        const matching = creeps.get(creep.name) ?? [];
        matching.push(creep);
        creeps.set(creep.name, matching);
      }
    }
    for (const spawn of room.ownedSpawns) {
      if (spawn.spawning === null) {
        continue;
      }
      const observedRetryAt = retryAt(tick, Math.max(1, spawn.spawning.remainingTime));
      const current = spawningRetryAt.get(spawn.spawning.creepName) ?? 0;
      spawningRetryAt.set(spawn.spawning.creepName, Math.max(current, observedRetryAt));
    }
  }
  return { creeps, spawningRetryAt };
}

function observedCreepSatisfiesDemand(
  creeps: readonly CreepSnapshot[] | undefined,
  requiredPartCounts: SpawnBodyPartCounts,
  maximumNonMovePartsPerMovePart: number,
  replacementCreepName: string | null,
): boolean {
  const nonMoveParts = OFFICIAL_BODY_PARTS.filter((part) => part !== "move").reduce(
    (total, part) => total + requiredPartCounts[part],
    0,
  );
  const requiredMoveParts = Math.max(
    requiredPartCounts.move,
    Math.ceil(nonMoveParts / maximumNonMovePartsPerMovePart),
  );
  return (
    creeps?.some(
      (creep) =>
        creep.name !== replacementCreepName &&
        OFFICIAL_BODY_PARTS.every(
          (part) =>
            activeBodyPartCount(creep, part) >=
            (part === "move" ? requiredMoveParts : requiredPartCounts[part]),
        ),
    ) ?? false
  );
}

function activeBodyPartCount(creep: CreepSnapshot, part: SpawnBodyPart): number {
  return part === "ranged_attack" ? creep.body.rangedAttack.active : creep.body[part].active;
}

function canonicalOwnedRooms(rooms: readonly OwnedRoomSnapshot[]): readonly OwnedRoomSnapshot[] {
  return [...rooms].sort((left, right) => compareStrings(left.name, right.name));
}

function collectIdleSpawns(rooms: readonly OwnedRoomSnapshot[]): Map<string, OwnedSpawnSnapshot[]> {
  const byRoom = new Map<string, OwnedSpawnSnapshot[]>();
  for (const room of rooms) {
    const idle = room.ownedSpawns
      .filter((spawn) => spawn.active && spawn.spawning === null)
      .sort(
        (left, right) => compareStrings(left.id, right.id) || compareStrings(left.name, right.name),
      );
    byRoom.set(room.name, idle);
  }
  return byRoom;
}

function indexExpectations(
  expectations: readonly SpawnExpectation[],
): ReadonlyMap<string, readonly SpawnExpectation[]> {
  const indexed = new Map<string, SpawnExpectation[]>();
  for (const expectation of expectations) {
    const current = indexed.get(expectation.demandId) ?? [];
    current.push(expectation);
    indexed.set(expectation.demandId, current);
  }
  for (const values of indexed.values()) {
    values.sort(compareExpectations);
  }
  return indexed;
}

function compareExpectations(left: SpawnExpectation, right: SpawnExpectation): number {
  return (
    compareNumbers(left.scheduledAt, right.scheduledAt) ||
    compareNumbers(left.expectedReadyAt, right.expectedReadyAt) ||
    compareNumbers(left.retryAt, right.retryAt) ||
    compareNumbers(left.revision, right.revision) ||
    compareStrings(left.spawnId, right.spawnId) ||
    compareStrings(left.creepName, right.creepName)
  );
}

function maximumExpectationRetryAt(expectations: readonly SpawnExpectation[]): number | null {
  let maximum: number | null = null;
  for (const expectation of expectations) {
    maximum = Math.max(maximum ?? 0, expectation.retryAt);
  }
  return maximum;
}

function maximumExpectedCreepSpawningRetryAt(
  expectations: readonly SpawnExpectation[],
  spawningRetryAt: ReadonlyMap<string, number>,
): number | null {
  let maximum: number | null = null;
  for (const expectation of expectations) {
    const observedRetryAt = spawningRetryAt.get(expectation.creepName);
    if (observedRetryAt !== undefined) {
      maximum = Math.max(maximum ?? 0, observedRetryAt);
    }
  }
  return maximum;
}

/**
 * Deterministic identities recoverable from a terminal durable demand record. Recovery attempts
 * are revision-qualified so a declared predecessor cannot occupy its successor's identity. Other
 * producers retain their logical identity across budget-only revisions.
 */
export function generatedSpawnCreepName(identity: SpawnDemandNameIdentity): string {
  return generatedSpawnCreepNameCandidates(identity)[0];
}

/**
 * Current identity followed by the one bounded pre-revision recovery identity accepted while a
 * deployed spawn command is still observable. Callers must never treat the fallback as a fresh
 * name candidate.
 */
export function generatedSpawnCreepNameCandidates(
  identity: SpawnDemandNameIdentity,
): readonly [string, ...string[]] {
  const logicalIdentity = fnv1a32(
    JSON.stringify([identity.id, identity.issuer, identity.colonyId]),
  );
  const logicalName = `mx-${logicalIdentity}`;
  return identity.category === "emergency-recovery"
    ? Object.freeze([`${logicalName}-${identity.revision.toString(36)}`, logicalName])
    : Object.freeze([logicalName]);
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function candidateNames(base: string, retryLimit: number): readonly string[] {
  const names = [base];
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    const suffix = `~${attempt.toString(36)}`;
    names.push(`${base.slice(0, MAX_CREEP_NAME_CODE_UNITS - suffix.length)}${suffix}`);
  }
  return names;
}

function decision(
  demandId: string,
  revision: number | null,
  status: SpawnDecisionStatus,
  reason: SpawnDecisionReason,
  retryAtValue: number | null = null,
  bodyReason: SpawnBodyFailureReason | null = null,
  energyCost: number | null = null,
  spawnId: string | null = null,
  name: string | null = null,
): SpawnBrokerDecision {
  return {
    demandId,
    revision,
    status,
    reason,
    retryAt: retryAtValue,
    bodyReason,
    energyCost,
    spawnId,
    name,
  };
}

function noSelection(value: SpawnBrokerDecision): {
  readonly decision: SpawnBrokerDecision;
  readonly selection: null;
} {
  return { decision: value, selection: null };
}

function invalidBatch(reason: Exclude<SpawnBrokerBatchReason, "planned">): SpawnBrokerResult {
  return deepFreeze({ status: "invalid", reason, decisions: [], selections: [] });
}

function retryAt(tick: number, delay: number): number {
  return tick <= Number.MAX_SAFE_INTEGER - delay ? tick + delay : Number.MAX_SAFE_INTEGER;
}

function checkedAdd(left: number, right: number): number | null {
  return left <= Number.MAX_SAFE_INTEGER - right ? left + right : null;
}

function isValidCreepName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CREEP_NAME_CODE_UNITS;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CODE_UNITS;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function demandIdOf(demand: SpawnDemand): string {
  return typeof demand.id === "string" ? demand.id : "";
}

function compareMapEntries(
  left: readonly [string, readonly SpawnDemand[]],
  right: readonly [string, readonly SpawnDemand[]],
): number {
  return compareStrings(left[0], right[0]);
}

function compareDecisionsByIdentity(left: SpawnBrokerDecision, right: SpawnBrokerDecision): number {
  return compareStrings(left.demandId, right.demandId);
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbersDescending(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
