import type { OwnedLabSnapshot } from "../world/snapshot";

export interface LabClusterLimits {
  readonly maximumBoostLabs: number;
  readonly maximumLabsScanned: number;
  readonly maximumOutputLabs: number;
}

export interface LabClusterAssignment {
  readonly boostLabIds: readonly string[];
  readonly fingerprint: string;
  readonly layoutFingerprint: string;
  readonly productLabIds: readonly string[];
  readonly reagentLabIds: readonly [string, string];
  readonly roomName: string;
}

export type LabClusterDeferralReason =
  | "inactive-labs"
  | "insufficient-labs"
  | "invalid-input"
  | "limit-exceeded"
  | "no-adjacent-cluster";

export interface LabClusterResult {
  readonly assignment: LabClusterAssignment | null;
  readonly pairCandidates: number;
  readonly reason: LabClusterDeferralReason | null;
  readonly scannedLabs: number;
  readonly status: "assigned" | "deferred";
}

export interface ReactionRecipe {
  readonly cooldown: number;
  readonly product: string;
  readonly reagents: readonly [string, string];
}

export interface ReactionCatalog {
  readonly fingerprint: string;
  readonly recipes: readonly ReactionRecipe[];
}

export type ReactionCatalogReason = "invalid-input" | "limit-exceeded";

export type ReactionCatalogResult =
  | { readonly catalog: ReactionCatalog; readonly reason: null; readonly status: "ready" }
  | { readonly catalog: null; readonly reason: ReactionCatalogReason; readonly status: "deferred" };

export function assignLabCluster(input: {
  readonly labs: readonly OwnedLabSnapshot[];
  readonly layoutFingerprint: string;
  readonly limits: LabClusterLimits;
  readonly roomName: string;
}): LabClusterResult {
  if (!validIdentity(input.roomName, 16) || !validIdentity(input.layoutFingerprint, 160))
    return deferred("invalid-input", 0, 0);
  if (!validLimits(input.limits)) return deferred("invalid-input", 0, 0);
  if (input.labs.length > input.limits.maximumLabsScanned) return deferred("limit-exceeded", 0, 0);
  const labs = [...input.labs].sort((a, b) => compare(a.id, b.id));
  if (!validLabs(labs, input.roomName)) return deferred("invalid-input", labs.length, 0);
  if (new Set(labs.map(({ id }) => id)).size !== labs.length)
    return deferred("invalid-input", labs.length, 0);
  if (labs.length < 3) return deferred("insufficient-labs", labs.length, 0);
  const active = labs.filter(({ active }) => active);
  if (active.length < 3) return deferred("inactive-labs", labs.length, 0);

  const candidates: {
    readonly outputs: readonly OwnedLabSnapshot[];
    readonly reagents: readonly [OwnedLabSnapshot, OwnedLabSnapshot];
  }[] = [];
  for (let left = 0; left < active.length - 1; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const reagentA = active[left];
      const reagentB = active[right];
      if (reagentA === undefined || reagentB === undefined) continue;
      const outputs = active.filter(
        (lab) =>
          lab.id !== reagentA.id &&
          lab.id !== reagentB.id &&
          range(lab, reagentA) <= 2 &&
          range(lab, reagentB) <= 2,
      );
      if (outputs.length > 0) candidates.push({ outputs, reagents: [reagentA, reagentB] });
    }
  }
  candidates.sort(
    (a, b) =>
      b.outputs.length - a.outputs.length ||
      compare(a.reagents[0].id, b.reagents[0].id) ||
      compare(a.reagents[1].id, b.reagents[1].id),
  );
  const selected = candidates[0];
  if (selected === undefined)
    return deferred("no-adjacent-cluster", labs.length, candidates.length);
  const productLabIds = selected.outputs
    .map(({ id }) => id)
    .sort(compare)
    .slice(0, input.limits.maximumOutputLabs);
  const boostLabIds = productLabIds.slice(
    Math.max(0, productLabIds.length - input.limits.maximumBoostLabs),
  );
  const reagentLabIds = [selected.reagents[0].id, selected.reagents[1].id] as const;
  const fingerprint = compactFingerprint([
    input.roomName,
    input.layoutFingerprint,
    ...reagentLabIds,
    ...productLabIds,
    "boost",
    ...boostLabIds,
  ]);
  return freeze({
    assignment: freeze({
      boostLabIds: freeze(boostLabIds),
      fingerprint,
      layoutFingerprint: input.layoutFingerprint,
      productLabIds: freeze(productLabIds),
      reagentLabIds: freeze(reagentLabIds),
      roomName: input.roomName,
    }),
    pairCandidates: candidates.length,
    reason: null,
    scannedLabs: labs.length,
    status: "assigned",
  });
}

export function normalizeReactionCatalog(input: {
  readonly maximumReagentsScanned: number;
  readonly maximumRecipes: number;
  readonly reactionTimes: unknown;
  readonly reactions: unknown;
}): ReactionCatalogResult {
  if (
    !positiveInteger(input.maximumReagentsScanned, 64) ||
    !positiveInteger(input.maximumRecipes, 256) ||
    !record(input.reactions) ||
    !record(input.reactionTimes)
  )
    return catalogDeferred("invalid-input");
  const reagentAKeys = Object.keys(input.reactions).sort(compare);
  if (reagentAKeys.length > input.maximumReagentsScanned) return catalogDeferred("limit-exceeded");
  const byProduct = new Map<string, ReactionRecipe>();
  let traversed = 0;
  for (const reagentA of reagentAKeys) {
    if (!validIdentity(reagentA, 64)) return catalogDeferred("invalid-input");
    const row = input.reactions[reagentA];
    if (!record(row)) return catalogDeferred("invalid-input");
    const reagentBKeys = Object.keys(row).sort(compare);
    if (reagentBKeys.length > input.maximumReagentsScanned)
      return catalogDeferred("limit-exceeded");
    for (const reagentB of reagentBKeys) {
      traversed += 1;
      if (traversed > input.maximumRecipes * 2) return catalogDeferred("limit-exceeded");
      const product = row[reagentB];
      if (!validIdentity(reagentB, 64) || !validIdentity(product, 64))
        return catalogDeferred("invalid-input");
      const cooldown = input.reactionTimes[product];
      if (!positiveInteger(cooldown, 1_000)) return catalogDeferred("invalid-input");
      const reagents = [reagentA, reagentB].sort(compare) as [string, string];
      const recipe = freeze({ cooldown, product, reagents: freeze(reagents) });
      const previous = byProduct.get(product);
      if (
        previous !== undefined &&
        (previous.cooldown !== recipe.cooldown ||
          previous.reagents[0] !== recipe.reagents[0] ||
          previous.reagents[1] !== recipe.reagents[1])
      )
        return catalogDeferred("invalid-input");
      byProduct.set(product, recipe);
      if (byProduct.size > input.maximumRecipes) return catalogDeferred("limit-exceeded");
    }
  }
  const recipes = [...byProduct.values()].sort((a, b) => compare(a.product, b.product));
  return freeze({
    catalog: freeze({
      fingerprint: compactFingerprint(
        recipes.flatMap(({ cooldown, product, reagents }) => [
          product,
          reagents[0],
          reagents[1],
          String(cooldown),
        ]),
      ),
      recipes: freeze(recipes),
    }),
    reason: null,
    status: "ready",
  });
}

function validLabs(labs: readonly OwnedLabSnapshot[], roomName: string): boolean {
  return labs.every(
    (lab) =>
      validIdentity(lab.id, 128) &&
      lab.pos.roomName === roomName &&
      coordinate(lab.pos.x) &&
      coordinate(lab.pos.y) &&
      typeof lab.active === "boolean" &&
      nonnegativeInteger(lab.cooldown) &&
      nonnegativeInteger(lab.energy) &&
      nonnegativeInteger(lab.energyCapacity) &&
      lab.energy <= lab.energyCapacity &&
      nonnegativeInteger(lab.mineralAmount) &&
      nonnegativeInteger(lab.mineralCapacity) &&
      lab.mineralAmount <= lab.mineralCapacity &&
      (lab.mineralType === null || validIdentity(lab.mineralType, 64)),
  );
}

function validLimits(limits: LabClusterLimits): boolean {
  return (
    positiveInteger(limits.maximumLabsScanned, 10) &&
    positiveInteger(limits.maximumOutputLabs, 8) &&
    nonnegativeInteger(limits.maximumBoostLabs) &&
    limits.maximumBoostLabs <= limits.maximumOutputLabs
  );
}

function range(a: OwnedLabSnapshot, b: OwnedLabSnapshot): number {
  return Math.max(Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y));
}

function deferred(
  reason: LabClusterDeferralReason,
  scannedLabs: number,
  pairCandidates: number,
): LabClusterResult {
  return freeze({ assignment: null, pairCandidates, reason, scannedLabs, status: "deferred" });
}

function catalogDeferred(reason: ReactionCatalogReason): ReactionCatalogResult {
  return freeze({ catalog: null, reason, status: "deferred" });
}

function compactFingerprint(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16_777_619);
  }
  return `lab-cluster-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return nonnegativeInteger(value) && value > 0 && value <= maximum;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function coordinate(value: unknown): value is number {
  return nonnegativeInteger(value) && value <= 49;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
