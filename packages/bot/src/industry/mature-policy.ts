import type { BudgetRequest } from "../colony";
import type {
  MatureResourceDemandDisposition,
  MatureResourceObjective,
} from "../logistics/mature-resource-demands";
import type { OwnedRoomSnapshot, StoreSnapshot, WorldSnapshot } from "../world/snapshot";
import type { MatureMechanicsCatalog, MatureStructureCapability } from "./mature-capabilities";

export interface MatureFactoryCandidate {
  readonly maximumBatches: number;
  readonly product: string;
  readonly roomName: string;
  readonly targetStock: number;
  readonly valuePerBatch: number;
}

export interface MatureProtectedStock {
  readonly amount: number;
  readonly resourceType: string;
  readonly roomName: string;
}

export interface MaturePolicyLimits {
  readonly maximumBatchesPerObjective: number;
  readonly maximumCandidates: number;
  readonly maximumDeadlineHorizon: number;
  readonly maximumNukerEnergyTarget: number;
  readonly maximumNukerGhodiumTarget: number;
  readonly maximumObjectives: number;
  readonly maximumPowerProcessingUnits: number;
  readonly maximumRooms: number;
}

export type MatureCommitmentStatus =
  "blocked" | "pending-funding" | "pending-logistics" | "ready" | "retired" | "staging";

export interface MaturePolicyCommitment {
  readonly objective: MatureResourceObjective;
  readonly status: MatureCommitmentStatus;
}

export type MaturePolicyBlockerReason =
  | "candidate-cap"
  | "invalid-candidate"
  | "invalid-input"
  | "missing-capability"
  | "missing-endpoint"
  | "missing-recipe"
  | "no-positive-value"
  | "objective-cap"
  | "protected-stock"
  | "room-cap"
  | "unsupported-level";

export interface MaturePolicyBlocker {
  readonly identity: string;
  readonly reason: MaturePolicyBlockerReason;
}

export interface MaturePolicyProjection {
  readonly blockers: readonly MaturePolicyBlocker[];
  readonly budgets: readonly BudgetRequest[];
  readonly commitments: readonly MaturePolicyCommitment[];
  readonly objectives: readonly MatureResourceObjective[];
}

export function reconcileMaturePolicy(input: {
  readonly capabilities: readonly MatureStructureCapability[];
  readonly catalog: MatureMechanicsCatalog;
  readonly factoryCandidates: readonly MatureFactoryCandidate[];
  readonly fundedBudgetIds: ReadonlySet<string>;
  readonly limits: MaturePolicyLimits;
  readonly logisticsDispositions: readonly MatureResourceDemandDisposition[];
  readonly nukerEnergyTarget: number;
  readonly nukerGhodiumTarget: number;
  readonly previousCommitments: readonly MaturePolicyCommitment[];
  readonly protectedStocks: readonly MatureProtectedStock[];
  readonly tick: number;
  readonly world: WorldSnapshot;
}): MaturePolicyProjection {
  const blockers: MaturePolicyBlocker[] = [];
  if (!validLimits(input.limits) || !nonnegativeInteger(input.tick))
    return freeze({
      blockers: [freeze({ identity: "policy", reason: "invalid-input" })],
      budgets: [],
      commitments: [],
      objectives: [],
    });
  const rooms = [...input.world.ownedRooms].sort((a, b) => compare(a.name, b.name));
  if (rooms.length > input.limits.maximumRooms)
    return freeze({
      blockers: [freeze({ identity: "policy", reason: "room-cap" })],
      budgets: [],
      commitments: retireAll(input.previousCommitments),
      objectives: [],
    });
  const orderedCandidates = [...input.factoryCandidates].sort(compareCandidates);
  if (orderedCandidates.length > input.limits.maximumCandidates)
    blockers.push(freeze({ identity: "factory-candidates", reason: "candidate-cap" }));
  const candidates = orderedCandidates.slice(0, input.limits.maximumCandidates);
  const planned: MatureResourceObjective[] = [];

  for (const room of rooms) {
    const endpoint = inventoryEndpoint(room);
    if (endpoint === undefined) {
      blockers.push(freeze({ identity: room.name, reason: "missing-endpoint" }));
      continue;
    }
    const stocks = inventoryStocks(room);
    const protectedStocks = protectedForRoom(input.protectedStocks, room.name);
    const roomCandidates = candidates
      .filter(({ roomName }) => roomName === room.name)
      .sort((a, b) => b.valuePerBatch - a.valuePerBatch || compare(a.product, b.product));
    const factory = input.capabilities.find(
      ({ active, kind, roomName }) => active && kind === "factory" && roomName === room.name,
    );
    if (roomCandidates.length > 0 && factory === undefined)
      blockers.push(freeze({ identity: `factory:${room.name}`, reason: "missing-capability" }));
    if (factory !== undefined) {
      const objective = factoryObjective(
        room,
        endpoint.id,
        factory,
        roomCandidates,
        stocks,
        protectedStocks,
        input,
        blockers,
      );
      if (objective !== null) planned.push(objective);
    }
    const power = input.capabilities.find(
      ({ active, kind, roomName }) => active && kind === "power-spawn" && roomName === room.name,
    );
    if (power !== undefined) {
      const powerStock = available(stocks, protectedStocks, "power");
      const energyStock = available(stocks, protectedStocks, "energy");
      const units = Math.min(
        input.limits.maximumPowerProcessingUnits,
        powerStock,
        Math.floor(energyStock / input.catalog.constants.powerSpawnEnergyPerPower),
      );
      if (units > 0)
        planned.push(
          objectiveWithFunding(
            {
              colonyId: room.name,
              deadline: deadline(input.tick, input.limits.maximumDeadlineHorizon),
              endpointId: endpoint.id,
              funded: false,
              id: `mature:power:${room.name}:${power.id}`,
              industryBudgetId: `industry:mature:power:${room.name}:${power.id}`,
              kind: "power-processing",
              mechanicsFingerprint: input.catalog.fingerprint,
              priority: "normal",
              revision: 1,
              structureId: power.id,
              units,
            },
            input.fundedBudgetIds,
          ),
        );
    }
    const nuker = input.capabilities.find(
      ({ active, kind, roomName }) => active && kind === "nuker" && roomName === room.name,
    );
    const nukerFact = (room.ownedNukers ?? []).find(({ id }) => id === nuker?.id);
    if (nuker !== undefined && nukerFact !== undefined) {
      const energyTarget = Math.min(
        input.nukerEnergyTarget,
        input.limits.maximumNukerEnergyTarget,
        input.catalog.constants.nukerEnergyCapacity,
      );
      const ghodiumTarget = Math.min(
        input.nukerGhodiumTarget,
        input.limits.maximumNukerGhodiumTarget,
        input.catalog.constants.nukerGhodiumCapacity,
      );
      const energyNeed = Math.max(0, energyTarget - storeAmount(nukerFact.store, "energy"));
      const ghodiumNeed = Math.max(0, ghodiumTarget - storeAmount(nukerFact.store, "G"));
      if (
        (energyNeed > 0 || ghodiumNeed > 0) &&
        available(stocks, protectedStocks, "energy") >= energyNeed &&
        available(stocks, protectedStocks, "G") >= ghodiumNeed
      )
        planned.push(
          objectiveWithFunding(
            {
              colonyId: room.name,
              deadline: deadline(input.tick, input.limits.maximumDeadlineHorizon),
              endpointId: endpoint.id,
              energyTarget,
              funded: false,
              ghodiumTarget,
              id: `mature:nuker:${room.name}:${nuker.id}`,
              industryBudgetId: `industry:mature:nuker:${room.name}:${nuker.id}`,
              kind: "nuker-stock",
              mechanicsFingerprint: input.catalog.fingerprint,
              priority: "normal",
              revision: 1,
              structureId: nuker.id,
            },
            input.fundedBudgetIds,
          ),
        );
      else if (energyNeed > 0 || ghodiumNeed > 0)
        blockers.push(freeze({ identity: `nuker:${room.name}`, reason: "protected-stock" }));
    }
  }

  const admitted = planned.sort(compareObjectives).slice(0, input.limits.maximumObjectives);
  if (planned.length > admitted.length)
    blockers.push(freeze({ identity: "mature-objectives", reason: "objective-cap" }));
  const budgets = admitted.map((objective) => budgetFor(objective, input));
  const dispositions = new Map(
    input.logisticsDispositions.map((value) => [value.objectiveId, value]),
  );
  const commitments: MaturePolicyCommitment[] = admitted.map((objective) => {
    const disposition = dispositions.get(objective.id);
    const status: MatureCommitmentStatus = !objective.funded
      ? "pending-funding"
      : disposition?.status === "blocked"
        ? "blocked"
        : disposition?.status === "satisfied"
          ? "ready"
          : disposition?.status === "projected"
            ? "staging"
            : "pending-logistics";
    return freeze({ objective, status });
  });
  const activeIds = new Set(admitted.map(({ id }) => id));
  for (const previous of input.previousCommitments)
    if (!activeIds.has(previous.objective.id))
      commitments.push(freeze({ objective: previous.objective, status: "retired" }));
  commitments.sort((a, b) => compareObjectives(a.objective, b.objective));
  return freeze({
    blockers: freeze(
      blockers.sort((a, b) => compare(a.identity, b.identity) || compare(a.reason, b.reason)),
    ),
    budgets: freeze(budgets),
    commitments: freeze(commitments),
    objectives: freeze(admitted),
  });
}

function factoryObjective(
  room: OwnedRoomSnapshot,
  endpointId: string,
  capability: MatureStructureCapability,
  candidates: readonly MatureFactoryCandidate[],
  stocks: ReadonlyMap<string, number>,
  protectedStocks: ReadonlyMap<string, number>,
  input: Parameters<typeof reconcileMaturePolicy>[0],
  blockers: MaturePolicyBlocker[],
): MatureResourceObjective | null {
  for (const candidate of candidates) {
    if (!validCandidate(candidate, input.limits)) {
      blockers.push(
        freeze({
          identity: `factory:${room.name}:${candidate.product}`,
          reason: "invalid-candidate",
        }),
      );
      continue;
    }
    if (candidate.valuePerBatch <= 0) {
      blockers.push(
        freeze({
          identity: `factory:${room.name}:${candidate.product}`,
          reason: "no-positive-value",
        }),
      );
      continue;
    }
    const recipe = input.catalog.recipes.find(({ product }) => product === candidate.product);
    if (recipe === undefined) {
      blockers.push(
        freeze({ identity: `factory:${room.name}:${candidate.product}`, reason: "missing-recipe" }),
      );
      continue;
    }
    if (!capability.availableProducts.includes(candidate.product)) {
      blockers.push(
        freeze({
          identity: `factory:${room.name}:${candidate.product}`,
          reason: "unsupported-level",
        }),
      );
      continue;
    }
    const deficit = Math.max(0, candidate.targetStock - (stocks.get(candidate.product) ?? 0));
    const desiredBatches = Math.min(
      candidate.maximumBatches,
      input.limits.maximumBatchesPerObjective,
      Math.ceil(deficit / recipe.amount),
    );
    let batches = desiredBatches;
    for (const component of recipe.components)
      batches = Math.min(
        batches,
        Math.floor(available(stocks, protectedStocks, component.resourceType) / component.amount),
      );
    if (batches <= 0) {
      if (desiredBatches > 0)
        blockers.push(
          freeze({
            identity: `factory:${room.name}:${candidate.product}`,
            reason: "protected-stock",
          }),
        );
      continue;
    }
    return objectiveWithFunding(
      {
        batches,
        colonyId: room.name,
        deadline: deadline(input.tick, input.limits.maximumDeadlineHorizon),
        endpointId,
        funded: false,
        id: `mature:factory:${room.name}:${capability.id}:${candidate.product}`,
        industryBudgetId: `industry:mature:factory:${room.name}:${capability.id}:${candidate.product}`,
        kind: "factory-batch",
        mechanicsFingerprint: input.catalog.fingerprint,
        priority: "normal",
        product: candidate.product,
        revision: 1,
        structureId: capability.id,
      },
      input.fundedBudgetIds,
    );
  }
  return null;
}

function objectiveWithFunding<T extends MatureResourceObjective>(
  objective: T,
  funded: ReadonlySet<string>,
): T {
  return freeze({ ...objective, funded: funded.has(objective.industryBudgetId) });
}

function budgetFor(
  objective: MatureResourceObjective,
  input: Parameters<typeof reconcileMaturePolicy>[0],
): BudgetRequest {
  const energy = objectiveEnergy(objective, input);
  return freeze({
    category: "industry",
    colonyId: objective.colonyId,
    cpu: freeze({ desired: 0.25, minimum: 0.05 }),
    energy: freeze({ desired: energy, minimum: energy }),
    expiresAt: objective.deadline,
    issuer: objective.industryBudgetId,
    revision: objective.revision,
    spawn: null,
  });
}

function objectiveEnergy(
  objective: MatureResourceObjective,
  input: Parameters<typeof reconcileMaturePolicy>[0],
): number {
  if (objective.kind === "factory-batch") {
    const recipe = input.catalog.recipes.find(({ product }) => product === objective.product);
    return (
      (recipe?.components.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0) *
      objective.batches
    );
  }
  if (objective.kind === "power-processing")
    return objective.units * input.catalog.constants.powerSpawnEnergyPerPower;
  const room = input.world.ownedRooms.find(({ name }) => name === objective.colonyId);
  const nuker = (room?.ownedNukers ?? []).find(({ id }) => id === objective.structureId);
  return Math.max(0, objective.energyTarget - storeAmount(nuker?.store, "energy"));
}

function inventoryEndpoint(room: OwnedRoomSnapshot) {
  return [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])]
    .filter(({ active }) => active)
    .sort((a, b) => compare(a.id, b.id))[0];
}

function inventoryStocks(room: OwnedRoomSnapshot): Map<string, number> {
  const result = new Map<string, number>();
  for (const structure of [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])])
    if (structure.active)
      for (const { amount, resourceType } of structure.store.resources)
        result.set(resourceType, (result.get(resourceType) ?? 0) + amount);
  return result;
}

function protectedForRoom(
  values: readonly MatureProtectedStock[],
  roomName: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values)
    if (
      value.roomName === roomName &&
      identity(value.resourceType, 64) &&
      nonnegativeInteger(value.amount)
    )
      result.set(value.resourceType, (result.get(value.resourceType) ?? 0) + value.amount);
  return result;
}

function available(
  stocks: ReadonlyMap<string, number>,
  protectedStocks: ReadonlyMap<string, number>,
  resource: string,
): number {
  return Math.max(0, (stocks.get(resource) ?? 0) - (protectedStocks.get(resource) ?? 0));
}

function storeAmount(store: StoreSnapshot | undefined, resource: string): number {
  return store?.resources.find(({ resourceType }) => resourceType === resource)?.amount ?? 0;
}

function validCandidate(candidate: MatureFactoryCandidate, limits: MaturePolicyLimits): boolean {
  return (
    identity(candidate.roomName, 16) &&
    identity(candidate.product, 64) &&
    positiveInteger(candidate.maximumBatches, limits.maximumBatchesPerObjective) &&
    nonnegativeInteger(candidate.targetStock) &&
    Number.isFinite(candidate.valuePerBatch)
  );
}

function validLimits(limits: MaturePolicyLimits): boolean {
  return (
    positiveInteger(limits.maximumBatchesPerObjective, 1_000) &&
    positiveInteger(limits.maximumCandidates, 256) &&
    positiveInteger(limits.maximumDeadlineHorizon, 100_000) &&
    nonnegativeInteger(limits.maximumNukerEnergyTarget) &&
    limits.maximumNukerEnergyTarget <= 300_000 &&
    nonnegativeInteger(limits.maximumNukerGhodiumTarget) &&
    limits.maximumNukerGhodiumTarget <= 5_000 &&
    positiveInteger(limits.maximumObjectives, 128) &&
    positiveInteger(limits.maximumPowerProcessingUnits, 100) &&
    positiveInteger(limits.maximumRooms, 64)
  );
}

function retireAll(values: readonly MaturePolicyCommitment[]): readonly MaturePolicyCommitment[] {
  return values.map(({ objective }) => freeze({ objective, status: "retired" as const }));
}

function deadline(tick: number, horizon: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, tick + horizon);
}

function compareCandidates(a: MatureFactoryCandidate, b: MatureFactoryCandidate): number {
  return (
    compare(a.roomName, b.roomName) ||
    b.valuePerBatch - a.valuePerBatch ||
    compare(a.product, b.product)
  );
}

function compareObjectives(a: MatureResourceObjective, b: MatureResourceObjective): number {
  return compare(a.id, b.id) || a.revision - b.revision;
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
