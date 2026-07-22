import {
  MAX_LAYOUT_LAB_ENERGY,
  MAX_LAYOUT_LAB_MINERAL,
  MAX_LAYOUT_LINK_ENERGY,
  MAX_LAYOUT_SPAWN_ENERGY,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  MINIMUM_OPERATIONAL_TOWER_ENERGY,
  type DestroyOwnedStructureIntent,
  type StructureDestroyExecutionCode,
  type StructureDestroyExecutionResult,
} from "./contracts";

export interface StructureDestroyExecutionAdapter {
  hasCurrentHostiles(roomName: string): boolean;
  isCurrentCommitment(roomName: string, fingerprint: string): boolean;
  resolveRoom(roomName: string): Room | null;
  resolveStructure(structureId: string): Structure | null;
}

/** Sole direct `Structure.destroy` command boundary. */
export class StructureDestroyExecutor {
  execute(
    intents: readonly DestroyOwnedStructureIntent[],
    adapter: StructureDestroyExecutionAdapter,
  ): readonly StructureDestroyExecutionResult[] {
    return Object.freeze(intents.map((intent) => this.executeOne(intent, adapter)));
  }

  private executeOne(
    intent: DestroyOwnedStructureIntent,
    adapter: StructureDestroyExecutionAdapter,
  ): StructureDestroyExecutionResult {
    let target: Structure;
    try {
      if (!adapter.isCurrentCommitment(intent.roomName, intent.layoutFingerprint))
        return result(intent, false, "ERR_INVALID_TARGET", "stale-commitment");
      const room = adapter.resolveRoom(intent.roomName);
      if (room === null) return result(intent, false, "ERR_NOT_OWNER", "room-unavailable");
      if (room.controller?.my !== true)
        return result(intent, false, "ERR_NOT_OWNER", "room-not-owned");
      if (adapter.hasCurrentHostiles(intent.roomName))
        return result(intent, false, "ERR_BUSY", "hostiles-present");
      const resolved = adapter.resolveStructure(intent.targetId);
      if (resolved === null) return result(intent, false, "TARGET_ABSENT", "target-absent");
      target = resolved;
      if (!matches(intent, target))
        return result(intent, false, "ERR_INVALID_TARGET", "target-mismatch");
      if (!hasEmptyCurrentStore(target, intent.targetStructureType))
        return result(intent, false, "ERR_INVALID_TARGET", "target-not-empty");
      if (intent.targetStructureType === "spawn" && !isIdleSpawn(target))
        return result(intent, false, "ERR_BUSY", "target-busy");
      if (
        (intent.targetStructureType === "lab" ||
          intent.targetStructureType === "link" ||
          intent.targetStructureType === "terminal") &&
        !hasZeroCooldown(target)
      )
        return result(intent, false, "ERR_INVALID_TARGET", "target-cooldown");
      const replacement = adapter.resolveStructure(intent.replacementId);
      if (replacement === null)
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-absent");
      if (!matchesReplacement(intent, replacement))
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-mismatch");
      if (intent.replacementStructureType === "spawn" && !hasExactSpawnStore(replacement, false))
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-store-mismatch");
      if (
        intent.replacementStructureType === "storage" &&
        !hasExactGeneralStore(replacement, MAX_LAYOUT_STORAGE_CAPACITY)
      )
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-store-mismatch");
      if (intent.replacementStructureType === "spawn" && !isIdleSpawn(replacement))
        return result(intent, false, "ERR_BUSY", "replacement-busy");
      if (
        intent.replacementStructureType === "link" &&
        !hasExpectedLinkEnergy(replacement, intent.replacementExpectedEnergy)
      )
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-energy-mismatch");
      if (intent.replacementStructureType === "link" && !hasZeroCooldown(replacement))
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-cooldown");
      if (!hasOperationalReplacementEnergy(intent, replacement))
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-underfunded");
    } catch {
      return result(intent, false, "UNEXPECTED", "adapter-fault");
    }

    try {
      const code = normalizeReturnCode(target.destroy());
      return result(intent, true, code, code === "UNEXPECTED" ? "adapter-fault" : null);
    } catch {
      return result(intent, true, "UNEXPECTED", "adapter-fault");
    }
  }
}

function matches(intent: DestroyOwnedStructureIntent, target: Structure): boolean {
  const candidate = target as Structure & {
    readonly id?: string;
    readonly structureType?: string;
  };
  return (
    String(candidate.id) === intent.targetId &&
    candidate.structureType === intent.targetStructureType &&
    target.pos.roomName === intent.roomName &&
    target.pos.x === intent.x &&
    target.pos.y === intent.y &&
    target.room.name === intent.roomName
  );
}
function hasEmptyCurrentStore(
  target: Structure,
  targetStructureType: DestroyOwnedStructureIntent["targetStructureType"],
): boolean {
  const candidate = target as Structure & {
    readonly my?: boolean;
    readonly store?: { getUsedCapacity(): number | null };
  };
  const used = candidate.store?.getUsedCapacity();
  const removableInOwnedRoom = targetStructureType === "container" || candidate.my === true;
  if (!removableInOwnedRoom || !candidate.isActive() || used !== 0) return false;
  if (targetStructureType === "lab") return hasExactEmptyLabStore(target);
  if (targetStructureType === "spawn") return hasExactSpawnStore(target, true);
  if (targetStructureType === "terminal")
    return hasExactGeneralStore(target, MAX_LAYOUT_TERMINAL_CAPACITY, true);
  if (targetStructureType !== "link") return true;
  const store = candidate.store as
    | {
        getCapacity(resource?: string): number | null;
        getFreeCapacity(resource?: string): number | null;
        getUsedCapacity(resource?: string): number | null;
      }
    | undefined;
  return (
    store?.getCapacity() === MAX_LAYOUT_LINK_ENERGY &&
    store.getCapacity("energy") === MAX_LAYOUT_LINK_ENERGY &&
    store.getFreeCapacity() === MAX_LAYOUT_LINK_ENERGY &&
    store.getFreeCapacity("energy") === MAX_LAYOUT_LINK_ENERGY &&
    store.getUsedCapacity("energy") === 0
  );
}
function hasExactSpawnStore(structure: Structure, requireEmpty: boolean): boolean {
  const store = (
    structure as Structure & {
      readonly store?: {
        getCapacity(resource?: string): number | null;
        getFreeCapacity(resource?: string): number | null;
        getUsedCapacity(resource?: string): number | null;
      };
    }
  ).store;
  const used = store?.getUsedCapacity("energy");
  return (
    typeof used === "number" &&
    Number.isSafeInteger(used) &&
    used >= 0 &&
    used <= MAX_LAYOUT_SPAWN_ENERGY &&
    (!requireEmpty || used === 0) &&
    store?.getCapacity() === MAX_LAYOUT_SPAWN_ENERGY &&
    store.getCapacity("energy") === MAX_LAYOUT_SPAWN_ENERGY &&
    store.getFreeCapacity() === MAX_LAYOUT_SPAWN_ENERGY - used &&
    store.getFreeCapacity("energy") === MAX_LAYOUT_SPAWN_ENERGY - used &&
    store.getUsedCapacity() === used
  );
}
function isIdleSpawn(structure: Structure): boolean {
  return (structure as Structure & { readonly spawning?: unknown }).spawning === null;
}
function hasExactGeneralStore(
  structure: Structure,
  expectedCapacity: number,
  requireEmpty = false,
): boolean {
  const store = (
    structure as Structure & {
      readonly store?: {
        getCapacity(): number | null;
        getFreeCapacity(): number | null;
        getUsedCapacity(): number | null;
      };
    }
  ).store;
  const used = store?.getUsedCapacity();
  const free = store?.getFreeCapacity();
  return (
    typeof used === "number" &&
    typeof free === "number" &&
    Number.isSafeInteger(used) &&
    Number.isSafeInteger(free) &&
    used >= 0 &&
    free >= 0 &&
    used + free === expectedCapacity &&
    store?.getCapacity() === expectedCapacity &&
    (!requireEmpty || used === 0)
  );
}
function hasExactEmptyLabStore(structure: Structure): boolean {
  const candidate = structure as Structure & {
    readonly mineralType?: string | null;
    readonly store?: {
      getCapacity(resource?: string): number | null;
      getFreeCapacity(resource?: string): number | null;
      getUsedCapacity(resource?: string): number | null;
    };
  };
  const store = candidate.store;
  return (
    candidate.mineralType === null &&
    store?.getCapacity("energy") === MAX_LAYOUT_LAB_ENERGY &&
    store.getFreeCapacity("energy") === MAX_LAYOUT_LAB_ENERGY &&
    store.getUsedCapacity("energy") === 0 &&
    store.getCapacity("H") === MAX_LAYOUT_LAB_MINERAL &&
    store.getFreeCapacity("H") === MAX_LAYOUT_LAB_MINERAL &&
    store.getUsedCapacity("H") === 0
  );
}
function hasExpectedLinkEnergy(structure: Structure, expectedEnergy: number): boolean {
  if (
    !Number.isSafeInteger(expectedEnergy) ||
    expectedEnergy < 0 ||
    expectedEnergy > MAX_LAYOUT_LINK_ENERGY
  )
    return false;
  const store = (
    structure as Structure & {
      readonly store?: {
        getCapacity(resource?: string): number | null;
        getFreeCapacity(resource?: string): number | null;
        getUsedCapacity(resource?: string): number | null;
      };
    }
  ).store;
  const free = MAX_LAYOUT_LINK_ENERGY - expectedEnergy;
  return (
    store?.getCapacity() === MAX_LAYOUT_LINK_ENERGY &&
    store.getCapacity("energy") === MAX_LAYOUT_LINK_ENERGY &&
    store.getFreeCapacity() === free &&
    store.getFreeCapacity("energy") === free &&
    store.getUsedCapacity() === expectedEnergy &&
    store.getUsedCapacity("energy") === expectedEnergy
  );
}
function hasZeroCooldown(structure: Structure): boolean {
  const cooldown = (structure as Structure & { readonly cooldown?: number }).cooldown;
  return cooldown === 0;
}
function matchesReplacement(intent: DestroyOwnedStructureIntent, replacement: Structure): boolean {
  const candidate = replacement as Structure & { readonly my?: boolean };
  const currentInOwnedRoom =
    intent.replacementStructureType === "container" || candidate.my === true;
  return (
    String(candidate.id) === intent.replacementId &&
    candidate.structureType === intent.replacementStructureType &&
    currentInOwnedRoom &&
    candidate.isActive() &&
    candidate.room.name === intent.roomName &&
    candidate.pos.roomName === intent.roomName
  );
}
function hasOperationalReplacementEnergy(
  intent: DestroyOwnedStructureIntent,
  replacement: Structure,
): boolean {
  const required =
    intent.replacementStructureType === "tower"
      ? MINIMUM_OPERATIONAL_TOWER_ENERGY
      : intent.replacementStructureType === "spawn"
        ? (intent.replacementMinimumEnergy ?? 0)
        : 0;
  if (required === 0) return true;
  const store = (
    replacement as Structure & {
      readonly store?: { getUsedCapacity(resource?: string): number | null };
    }
  ).store;
  const energy = store?.getUsedCapacity("energy");
  return typeof energy === "number" && Number.isSafeInteger(energy) && energy >= required;
}
function normalizeReturnCode(code: number): StructureDestroyExecutionCode {
  if (code === 0) return "OK";
  if (code === -1) return "ERR_NOT_OWNER";
  if (code === -4) return "ERR_BUSY";
  return "UNEXPECTED";
}
function result(
  intent: DestroyOwnedStructureIntent,
  called: boolean,
  code: StructureDestroyExecutionCode,
  fault: StructureDestroyExecutionResult["fault"],
): StructureDestroyExecutionResult {
  return Object.freeze({ called, code, fault, intent });
}
