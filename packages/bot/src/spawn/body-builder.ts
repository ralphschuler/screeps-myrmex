export const CREEP_SPAWN_TICKS_PER_PART = 3;
export const ENGINE_MAX_BODY_PARTS = 50;

/** Canonical body order, independent of object insertion order and Screeps globals. */
export const OFFICIAL_BODY_PARTS = Object.freeze([
  "tough",
  "work",
  "carry",
  "attack",
  "ranged_attack",
  "heal",
  "claim",
  "move",
] as const);

export type SpawnBodyPart = (typeof OFFICIAL_BODY_PARTS)[number];

export const BODY_PART_ENERGY_COSTS = Object.freeze({
  tough: 10,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  move: 50,
} satisfies Readonly<Record<SpawnBodyPart, number>>);

export type SpawnBodyPartCounts = Readonly<Record<SpawnBodyPart, number>>;

export interface SpawnBodyBuildRequest {
  readonly availableEnergy: number;
  readonly energyCapacity: number;
  readonly maximumBodyEnergy: number;
  readonly maximumBodyParts: number;
  readonly maximumNonMovePartsPerMovePart: number;
  readonly requiredPartCounts: SpawnBodyPartCounts;
}

export type SpawnBodyInvalidReason =
  | "available-energy-exceeds-capacity"
  | "empty-capabilities"
  | "invalid-available-energy"
  | "invalid-energy-capacity"
  | "invalid-maximum-body-energy"
  | "invalid-maximum-body-parts"
  | "invalid-movement-ratio"
  | "invalid-request"
  | "invalid-required-part-counts"
  | "maximum-body-parts-exceeds-engine-limit";

export type SpawnBodyImpossibleReason =
  | "energy-capacity-exceeded"
  | "energy-policy-limit-exceeded"
  | "engine-part-limit-exceeded"
  | "movement-engine-limit-exceeded"
  | "movement-policy-limit-exceeded"
  | "policy-part-limit-exceeded";

export interface SpawnBodyBuiltResult {
  readonly body: readonly SpawnBodyPart[];
  readonly energyCost: number;
  readonly partCount: number;
  readonly requiredEnergy: number;
  readonly spawnTicks: number;
  readonly status: "built";
}

export interface SpawnBodyDeferredResult {
  readonly reason: "insufficient-available-energy";
  readonly requiredEnergy: number;
  readonly requiredParts: number;
  readonly status: "deferred";
}

export interface SpawnBodyImpossibleResult {
  readonly reason: SpawnBodyImpossibleReason;
  readonly requiredEnergy: number | null;
  readonly requiredParts: number;
  readonly status: "impossible";
}

export interface SpawnBodyInvalidResult {
  readonly reason: SpawnBodyInvalidReason;
  readonly requiredEnergy: number | null;
  readonly requiredParts: number | null;
  readonly status: "invalid";
}

export type SpawnBodyBuildResult =
  | SpawnBodyBuiltResult
  | SpawnBodyDeferredResult
  | SpawnBodyImpossibleResult
  | SpawnBodyInvalidResult;

/** Pure, bounded body construction policy. It never reads Screeps globals or mutates its input. */
export function buildSpawnBody(request: SpawnBodyBuildRequest): SpawnBodyBuildResult {
  try {
    return buildValidatedSpawnBody(request);
  } catch {
    return invalidResult("invalid-request");
  }
}

function buildValidatedSpawnBody(requestValue: unknown): SpawnBodyBuildResult {
  const request = recordOf(requestValue);
  if (request === null) {
    return invalidResult("invalid-request");
  }

  const requiredPartCounts = normalizePartCounts(request.requiredPartCounts);
  if (requiredPartCounts === null) {
    return invalidResult("invalid-required-part-counts");
  }
  if (!isNonnegativeSafeInteger(request.availableEnergy)) {
    return invalidResult("invalid-available-energy");
  }
  if (!isNonnegativeSafeInteger(request.energyCapacity)) {
    return invalidResult("invalid-energy-capacity");
  }
  if (!isNonnegativeSafeInteger(request.maximumBodyEnergy)) {
    return invalidResult("invalid-maximum-body-energy");
  }
  if (!isNonnegativeSafeInteger(request.maximumBodyParts)) {
    return invalidResult("invalid-maximum-body-parts");
  }
  if (request.maximumBodyParts > ENGINE_MAX_BODY_PARTS) {
    return invalidResult("maximum-body-parts-exceeds-engine-limit");
  }
  if (!isPositiveSafeInteger(request.maximumNonMovePartsPerMovePart)) {
    return invalidResult("invalid-movement-ratio");
  }
  if (request.availableEnergy > request.energyCapacity) {
    return invalidResult("available-energy-exceeds-capacity");
  }

  let explicitPartCount = 0;
  let nonMovePartCount = 0;
  let explicitEnergy = 0;

  for (const part of OFFICIAL_BODY_PARTS) {
    const count = requiredPartCounts[part];
    if (count > ENGINE_MAX_BODY_PARTS - explicitPartCount) {
      return impossibleResult("engine-part-limit-exceeded", null, ENGINE_MAX_BODY_PARTS + 1);
    }
    explicitPartCount += count;
    explicitEnergy += count * BODY_PART_ENERGY_COSTS[part];
    if (part !== "move") {
      nonMovePartCount += count;
    }
  }

  if (explicitPartCount === 0) {
    return invalidResult("empty-capabilities", 0, 0);
  }

  const movementPartCount = Math.max(
    requiredPartCounts.move,
    Math.ceil(nonMovePartCount / request.maximumNonMovePartsPerMovePart),
  );
  const addedMovementParts = movementPartCount - requiredPartCounts.move;
  const requiredParts = explicitPartCount + addedMovementParts;
  const requiredEnergy = explicitEnergy + addedMovementParts * BODY_PART_ENERGY_COSTS.move;

  if (requiredParts > ENGINE_MAX_BODY_PARTS) {
    return impossibleResult("movement-engine-limit-exceeded", requiredEnergy, requiredParts);
  }
  if (requiredParts > request.maximumBodyParts) {
    const reason =
      explicitPartCount > request.maximumBodyParts
        ? "policy-part-limit-exceeded"
        : "movement-policy-limit-exceeded";
    return impossibleResult(reason, requiredEnergy, requiredParts);
  }
  if (requiredEnergy > request.energyCapacity) {
    return impossibleResult("energy-capacity-exceeded", requiredEnergy, requiredParts);
  }
  if (requiredEnergy > request.maximumBodyEnergy) {
    return impossibleResult("energy-policy-limit-exceeded", requiredEnergy, requiredParts);
  }
  if (requiredEnergy > request.availableEnergy) {
    return Object.freeze({
      reason: "insufficient-available-energy",
      requiredEnergy,
      requiredParts,
      status: "deferred",
    });
  }

  const body: SpawnBodyPart[] = [];
  for (const part of OFFICIAL_BODY_PARTS) {
    const count = part === "move" ? movementPartCount : requiredPartCounts[part];
    for (let index = 0; index < count; index += 1) {
      body.push(part);
    }
  }

  return Object.freeze({
    body: Object.freeze(body),
    energyCost: requiredEnergy,
    partCount: requiredParts,
    requiredEnergy,
    spawnTicks: requiredParts * CREEP_SPAWN_TICKS_PER_PART,
    status: "built",
  });
}

function normalizePartCounts(value: unknown): SpawnBodyPartCounts | null {
  const record = recordOf(value);
  if (record === null) {
    return null;
  }

  const keys = Object.keys(record);
  if (
    keys.length !== OFFICIAL_BODY_PARTS.length ||
    keys.some((key) => !(OFFICIAL_BODY_PARTS as readonly string[]).includes(key))
  ) {
    return null;
  }

  for (const part of OFFICIAL_BODY_PARTS) {
    if (
      !Object.prototype.hasOwnProperty.call(record, part) ||
      !isNonnegativeSafeInteger(record[part])
    ) {
      return null;
    }
  }

  return Object.freeze({
    tough: record.tough as number,
    work: record.work as number,
    carry: record.carry as number,
    attack: record.attack as number,
    ranged_attack: record.ranged_attack as number,
    heal: record.heal as number,
    claim: record.claim as number,
    move: record.move as number,
  });
}

function invalidResult(
  reason: SpawnBodyInvalidReason,
  requiredEnergy: number | null = null,
  requiredParts: number | null = null,
): SpawnBodyInvalidResult {
  return Object.freeze({ reason, requiredEnergy, requiredParts, status: "invalid" });
}

function impossibleResult(
  reason: SpawnBodyImpossibleReason,
  requiredEnergy: number | null,
  requiredParts: number,
): SpawnBodyImpossibleResult {
  return Object.freeze({ reason, requiredEnergy, requiredParts, status: "impossible" });
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
