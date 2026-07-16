import type { MovementRuntimeResult } from "../movement";
import type { StoreSnapshot, WorldSnapshot } from "../world/snapshot";
import type { EnergyFlowTelemetry } from "./metrics";

const UNBOOSTED_HARVEST_ENERGY_PER_WORK = 2;

/**
 * Measures current energy stocks and successfully scheduled Phase 1 flow in energy units. The
 * harvest amount is exact for the unboosted recovery workforce; boosted WORK is reported at its
 * mechanically guaranteed base yield because the bounded body projection omits boost compounds.
 */
export function measureSurvivalEnergyFlow(
  snapshot: WorldSnapshot,
  movement: MovementRuntimeResult,
): EnergyFlowTelemetry {
  const ownedRooms = snapshot.ownedRooms;
  const actors = new Map(
    ownedRooms.flatMap((room) => room.ownedCreeps).map((actor) => [actor.id, actor]),
  );
  const sources = new Map(
    ownedRooms.flatMap((room) => room.sources).map((source) => [source.id, source]),
  );
  const sinkFree = new Map<string, number>();
  for (const room of ownedRooms) {
    for (const sink of [
      ...room.ownedSpawns.filter(({ active }) => active),
      ...room.ownedExtensions.filter(({ active }) => active),
    ]) {
      if (sink.store.freeCapacity !== null) sinkFree.set(sink.id, amount(sink.store.freeCapacity));
    }
  }

  const actorEnergy = new Map(
    [...actors].map(([id, actor]) => [id, resourceAmount(actor.store, "energy")]),
  );
  const actorFree = new Map(
    [...actors].map(([id, actor]) => [id, nullableAmount(actor.store.freeCapacity)]),
  );
  const sourceEnergy = new Map([...sources].map(([id, source]) => [id, amount(source.energy)]));
  let harvested = 0;
  let harvestedIsLowerBound = false;
  let delivered = 0;

  const scheduled = movement.actionExecution
    .filter(
      ({ outcome, reason, status }) =>
        reason === "executed" && status === "executed" && outcome?.state === "scheduled",
    )
    .slice()
    .sort((left, right) => left.intent.id.localeCompare(right.intent.id));
  for (const { intent } of scheduled) {
    const actor = actors.get(intent.actorId);
    if (actor === undefined) continue;
    if (intent.kind === "harvest") {
      const free = actorFree.get(actor.id) ?? null;
      const available = sourceEnergy.get(intent.targetId);
      if (free === null || available === undefined) continue;
      const scheduledAmount = Math.min(
        free,
        available,
        amount(actor.body.work.active) * UNBOOSTED_HARVEST_ENERGY_PER_WORK,
      );
      harvested = saturatingAdd(harvested, scheduledAmount);
      harvestedIsLowerBound ||= actor.body.work.boosted > 0;
      actorFree.set(actor.id, free - scheduledAmount);
      actorEnergy.set(actor.id, (actorEnergy.get(actor.id) ?? 0) + scheduledAmount);
      sourceEnergy.set(intent.targetId, available - scheduledAmount);
      continue;
    }
    if (intent.kind !== "transfer" || intent.resourceType !== "energy") continue;
    const carried = actorEnergy.get(actor.id) ?? 0;
    const free = sinkFree.get(intent.targetId);
    if (free === undefined) continue;
    const authorized = intent.amount === null ? carried : amount(intent.amount);
    const scheduledAmount = Math.min(carried, free, authorized);
    delivered = saturatingAdd(delivered, scheduledAmount);
    actorEnergy.set(actor.id, carried - scheduledAmount);
    sinkFree.set(intent.targetId, free - scheduledAmount);
  }

  const carried = ownedRooms
    .flatMap((room) => room.ownedCreeps)
    .reduce((total, actor) => saturatingAdd(total, resourceAmount(actor.store, "energy")), 0);
  const dropped = ownedRooms
    .flatMap((room) => room.droppedResources ?? [])
    .filter(({ resourceType }) => resourceType === "energy")
    .reduce((total, resource) => saturatingAdd(total, amount(resource.amount)), 0);
  const requested = ownedRooms.reduce(
    (total, room) =>
      saturatingAdd(
        total,
        Math.max(0, amount(room.energyCapacityAvailable) - amount(room.energyAvailable)),
      ),
    0,
  );

  return Object.freeze({
    carried,
    delivered,
    dropped,
    harvested,
    harvestedIsLowerBound,
    requested,
    unmet: Math.max(0, requested - delivered),
  });
}

function resourceAmount(store: StoreSnapshot, resourceType: string): number {
  return amount(
    store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0,
  );
}

function nullableAmount(value: number | null): number | null {
  return value === null ? null : amount(value);
}

function amount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
