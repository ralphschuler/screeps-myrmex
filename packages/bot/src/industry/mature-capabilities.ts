import type {
  OwnedFactorySnapshot,
  OwnedNukerSnapshot,
  OwnedObserverSnapshot,
  OwnedPowerSpawnSnapshot,
  StoreSnapshot,
  StructureEffectSnapshot,
} from "../world/snapshot";

export interface MatureMechanicsLimits {
  readonly maximumCommodities: number;
  readonly maximumComponentsPerCommodity: number;
  readonly maximumResourceTypes: number;
  readonly maximumStringLength: number;
}

export interface MatureMechanicsConstants {
  readonly factoryCapacity: number;
  readonly nukerCooldown: number;
  readonly nukerEnergyCapacity: number;
  readonly nukerGhodiumCapacity: number;
  readonly nukerRange: number;
  readonly observerRange: number;
  readonly operateFactoryPower: number;
  readonly operateObserverPower: number;
  readonly powerSpawnEnergyCapacity: number;
  readonly powerSpawnEnergyPerPower: number;
  readonly powerSpawnPowerCapacity: number;
}

export interface CommodityComponent {
  readonly amount: number;
  readonly resourceType: string;
}

export interface CommodityRecipe {
  readonly amount: number;
  readonly components: readonly CommodityComponent[];
  readonly cooldown: number;
  readonly level: number | null;
  readonly product: string;
}

export interface MatureMechanicsCatalog {
  readonly constants: MatureMechanicsConstants;
  readonly fingerprint: string;
  readonly recipes: readonly CommodityRecipe[];
  readonly resources: readonly string[];
}

export type MatureMechanicsResult =
  | { readonly catalog: MatureMechanicsCatalog; readonly reason: null; readonly status: "ready" }
  | {
      readonly catalog: null;
      readonly reason: "invalid-input" | "limit-exceeded";
      readonly status: "deferred";
    };

export interface MatureCapabilityLimits {
  readonly maximumEffectsPerStructure: number;
  readonly maximumStructures: number;
}

export interface MatureStructureCapability {
  readonly active: boolean;
  readonly availableProducts: readonly string[];
  readonly cooldown: number;
  readonly effectLevels: readonly string[];
  readonly fingerprint: string;
  readonly id: string;
  readonly kind: "factory" | "nuker" | "observer" | "power-spawn";
  readonly level: number | null;
  readonly processablePower: number;
  readonly range: number;
  readonly roomName: string;
  readonly stocked: boolean;
  readonly storeFingerprint: string;
}

export type MatureCapabilitiesResult =
  | {
      readonly capabilities: readonly MatureStructureCapability[];
      readonly fingerprint: string;
      readonly reason: null;
      readonly status: "ready";
    }
  | {
      readonly capabilities: null;
      readonly fingerprint: null;
      readonly reason: "invalid-input" | "limit-exceeded";
      readonly status: "deferred";
    };

export function normalizeMatureMechanics(input: {
  readonly commodities: unknown;
  readonly constants: unknown;
  readonly limits: MatureMechanicsLimits;
  readonly resourceTypes: unknown;
}): MatureMechanicsResult {
  const { limits } = input;
  if (
    !positiveInteger(limits.maximumCommodities, 512) ||
    !positiveInteger(limits.maximumComponentsPerCommodity, 64) ||
    !positiveInteger(limits.maximumResourceTypes, 512) ||
    !positiveInteger(limits.maximumStringLength, 128) ||
    !record(input.commodities) ||
    !record(input.constants) ||
    !Array.isArray(input.resourceTypes)
  )
    return mechanicsDeferred("invalid-input");
  const rawResources: unknown[] = input.resourceTypes;
  if (rawResources.length > limits.maximumResourceTypes) return mechanicsDeferred("limit-exceeded");
  if (
    rawResources.some((resource) => !identity(resource, limits.maximumStringLength)) ||
    new Set(rawResources).size !== rawResources.length
  )
    return mechanicsDeferred("invalid-input");
  const resources = rawResources.map(String).sort(compare);
  const resourceSet = new Set(resources);
  const productKeys = Object.keys(input.commodities).sort(compare);
  if (productKeys.length > limits.maximumCommodities) return mechanicsDeferred("limit-exceeded");

  const recipes: CommodityRecipe[] = [];
  for (const product of productKeys) {
    const raw: unknown = input.commodities[product];
    if (!resourceSet.has(product) || !record(raw) || raw === input.commodities)
      return mechanicsDeferred("invalid-input");
    const components: unknown = raw.components;
    if (!record(components) || components === raw || components === input.commodities)
      return mechanicsDeferred("invalid-input");
    const componentKeys = Object.keys(components).sort(compare);
    if (componentKeys.length === 0) return mechanicsDeferred("invalid-input");
    if (componentKeys.length > limits.maximumComponentsPerCommodity)
      return mechanicsDeferred("limit-exceeded");
    const normalizedComponents: CommodityComponent[] = [];
    for (const resourceType of componentKeys) {
      const amount = components[resourceType];
      if (!resourceSet.has(resourceType) || !positiveInteger(amount, 1_000_000))
        return mechanicsDeferred("invalid-input");
      normalizedComponents.push(freeze({ amount, resourceType }));
    }
    const level = raw.level === undefined ? null : raw.level;
    if (
      !positiveInteger(raw.amount, 1_000_000) ||
      !positiveInteger(raw.cooldown, 100_000) ||
      (level !== null && !positiveInteger(level, 5))
    )
      return mechanicsDeferred("invalid-input");
    recipes.push(
      freeze({
        amount: raw.amount,
        components: freeze(normalizedComponents),
        cooldown: raw.cooldown,
        level,
        product,
      }),
    );
  }

  const constants = normalizeConstants(input.constants);
  if (constants === null) return mechanicsDeferred("invalid-input");
  const fingerprint = fingerprintOf([
    ...resources,
    ...Object.entries(constants).flatMap(([key, value]) => [key, String(value)]),
    ...recipes.flatMap((recipe) => [
      recipe.product,
      String(recipe.amount),
      String(recipe.cooldown),
      String(recipe.level ?? 0),
      ...recipe.components.flatMap(({ amount, resourceType }) => [resourceType, String(amount)]),
    ]),
  ]);
  return freeze({
    catalog: freeze({
      constants,
      fingerprint,
      recipes: freeze(recipes),
      resources: freeze(resources),
    }),
    reason: null,
    status: "ready",
  });
}

export function deriveMatureCapabilities(input: {
  readonly catalog: MatureMechanicsCatalog;
  readonly factories: readonly OwnedFactorySnapshot[];
  readonly limits: MatureCapabilityLimits;
  readonly nukers: readonly OwnedNukerSnapshot[];
  readonly observers: readonly OwnedObserverSnapshot[];
  readonly powerSpawns: readonly OwnedPowerSpawnSnapshot[];
  readonly roomName: string;
}): MatureCapabilitiesResult {
  if (
    !identity(input.roomName, 16) ||
    !positiveInteger(input.limits.maximumEffectsPerStructure, 32) ||
    !positiveInteger(input.limits.maximumStructures, 32)
  )
    return capabilitiesDeferred("invalid-input");
  const total =
    input.factories.length +
    input.nukers.length +
    input.observers.length +
    input.powerSpawns.length;
  if (total > input.limits.maximumStructures) return capabilitiesDeferred("limit-exceeded");

  const capabilities: MatureStructureCapability[] = [];
  for (const factory of input.factories) {
    if (!validStructure(factory, input.roomName, input.limits.maximumEffectsPerStructure, true))
      return capabilitiesDeferred("invalid-input");
    const operated = factory.effects.some(
      ({ effect, ticksRemaining }) =>
        effect === input.catalog.constants.operateFactoryPower && ticksRemaining > 0,
    );
    const availableProducts = input.catalog.recipes
      .filter(({ level }) => level === null || (operated && level === factory.level))
      .map(({ product }) => product);
    capabilities.push(
      capability({
        active: factory.active,
        availableProducts,
        cooldown: factory.cooldown,
        effects: factory.effects,
        id: factory.id,
        kind: "factory",
        level: factory.level,
        processablePower: 0,
        range: 0,
        roomName: input.roomName,
        stocked: false,
        store: factory.store,
      }),
    );
  }
  for (const powerSpawn of input.powerSpawns) {
    if (!validStructure(powerSpawn, input.roomName, input.limits.maximumEffectsPerStructure, false))
      return capabilitiesDeferred("invalid-input");
    const processablePower = Math.min(
      resourceAmount(powerSpawn.store, "power"),
      Math.floor(
        resourceAmount(powerSpawn.store, "energy") /
          input.catalog.constants.powerSpawnEnergyPerPower,
      ),
    );
    capabilities.push(
      capability({
        active: powerSpawn.active,
        availableProducts: [],
        cooldown: 0,
        effects: powerSpawn.effects,
        id: powerSpawn.id,
        kind: "power-spawn",
        level: null,
        processablePower,
        range: 0,
        roomName: input.roomName,
        stocked: false,
        store: powerSpawn.store,
      }),
    );
  }
  for (const observer of input.observers) {
    if (!validStructure(observer, input.roomName, input.limits.maximumEffectsPerStructure, false))
      return capabilitiesDeferred("invalid-input");
    capabilities.push(
      capability({
        active: observer.active,
        availableProducts: [],
        cooldown: 0,
        effects: observer.effects,
        id: observer.id,
        kind: "observer",
        level: null,
        processablePower: 0,
        range: input.catalog.constants.observerRange,
        roomName: input.roomName,
        stocked: false,
        store: null,
      }),
    );
  }
  for (const nuker of input.nukers) {
    if (!validStructure(nuker, input.roomName, input.limits.maximumEffectsPerStructure, false))
      return capabilitiesDeferred("invalid-input");
    capabilities.push(
      capability({
        active: nuker.active,
        availableProducts: [],
        cooldown: nuker.cooldown,
        effects: nuker.effects,
        id: nuker.id,
        kind: "nuker",
        level: null,
        processablePower: 0,
        range: input.catalog.constants.nukerRange,
        roomName: input.roomName,
        stocked:
          resourceAmount(nuker.store, "energy") >= input.catalog.constants.nukerEnergyCapacity &&
          resourceAmount(nuker.store, "G") >= input.catalog.constants.nukerGhodiumCapacity,
        store: nuker.store,
      }),
    );
  }
  capabilities.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  const fingerprint = fingerprintOf([
    input.catalog.fingerprint,
    input.roomName,
    ...capabilities.map(({ fingerprint }) => fingerprint),
  ]);
  return freeze({ capabilities: freeze(capabilities), fingerprint, reason: null, status: "ready" });
}

function normalizeConstants(value: Record<string, unknown>): MatureMechanicsConstants | null {
  const keys = [
    "factoryCapacity",
    "nukerCooldown",
    "nukerEnergyCapacity",
    "nukerGhodiumCapacity",
    "nukerRange",
    "observerRange",
    "operateFactoryPower",
    "operateObserverPower",
    "powerSpawnEnergyCapacity",
    "powerSpawnEnergyPerPower",
    "powerSpawnPowerCapacity",
  ] as const;
  if (keys.some((key) => !positiveInteger(value[key], 1_000_000))) return null;
  return freeze(
    Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as MatureMechanicsConstants,
  );
}

function validStructure(
  structure: {
    readonly active: boolean;
    readonly effects: readonly StructureEffectSnapshot[];
    readonly hits: number;
    readonly hitsMax: number;
    readonly id: string;
    readonly pos: { readonly roomName: string; readonly x: number; readonly y: number };
    readonly store?: StoreSnapshot;
  },
  roomName: string,
  maximumEffects: number,
  factory: boolean,
): boolean {
  return (
    identity(structure.id, 128) &&
    structure.pos.roomName === roomName &&
    coordinate(structure.pos.x) &&
    coordinate(structure.pos.y) &&
    typeof structure.active === "boolean" &&
    nonnegativeInteger(structure.hits) &&
    positiveInteger(structure.hitsMax, 1_000_000_000) &&
    structure.hits <= structure.hitsMax &&
    structure.effects.length <= maximumEffects &&
    structure.effects.every(validEffect) &&
    (!factory || structure.store !== undefined) &&
    (structure.store === undefined || validStore(structure.store))
  );
}

function validEffect(effect: StructureEffectSnapshot): boolean {
  return (
    positiveInteger(effect.effect, 10_000) &&
    (effect.level === null || positiveInteger(effect.level, 100)) &&
    nonnegativeInteger(effect.ticksRemaining)
  );
}

function validStore(store: StoreSnapshot): boolean {
  return (
    nonnegativeInteger(store.usedCapacity) &&
    (store.capacity === null || nonnegativeInteger(store.capacity)) &&
    (store.freeCapacity === null || nonnegativeInteger(store.freeCapacity)) &&
    store.resources.length <= 512 &&
    store.resources.every(
      ({ amount, resourceType }) => nonnegativeInteger(amount) && identity(resourceType, 64),
    ) &&
    new Set(store.resources.map(({ resourceType }) => resourceType)).size === store.resources.length
  );
}

function capability(input: {
  readonly active: boolean;
  readonly availableProducts: readonly string[];
  readonly cooldown: number;
  readonly effects: readonly StructureEffectSnapshot[];
  readonly id: string;
  readonly kind: MatureStructureCapability["kind"];
  readonly level: number | null;
  readonly processablePower: number;
  readonly range: number;
  readonly roomName: string;
  readonly stocked: boolean;
  readonly store: StoreSnapshot | null;
}): MatureStructureCapability {
  const effectLevels = input.effects
    .map(
      ({ effect, level, ticksRemaining }) =>
        `${String(effect)}:${String(level ?? 0)}:${String(ticksRemaining)}`,
    )
    .sort(compare);
  const storeFingerprint =
    input.store === null
      ? "none"
      : fingerprintOf(
          input.store.resources.flatMap(({ amount, resourceType }) => [
            resourceType,
            String(amount),
          ]),
        );
  const availableProducts = [...input.availableProducts].sort(compare);
  const parts = [
    input.kind,
    input.id,
    input.roomName,
    String(input.active),
    String(input.cooldown),
    String(input.level ?? 0),
    String(input.processablePower),
    String(input.range),
    String(input.stocked),
    storeFingerprint,
    ...effectLevels,
    ...availableProducts,
  ];
  return freeze({
    ...input,
    availableProducts: freeze(availableProducts),
    effectLevels: freeze(effectLevels),
    fingerprint: fingerprintOf(parts),
    storeFingerprint,
    store: undefined,
  } as unknown as MatureStructureCapability);
}

function resourceAmount(store: StoreSnapshot, resourceType: string): number {
  return store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0;
}

function mechanicsDeferred(reason: "invalid-input" | "limit-exceeded"): MatureMechanicsResult {
  return freeze({ catalog: null, reason, status: "deferred" });
}

function capabilitiesDeferred(
  reason: "invalid-input" | "limit-exceeded",
): MatureCapabilitiesResult {
  return freeze({ capabilities: null, fingerprint: null, reason, status: "deferred" });
}

function fingerprintOf(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16_777_619);
  }
  return `mature-capability-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function identity(value: unknown, maximum: number): value is string {
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
