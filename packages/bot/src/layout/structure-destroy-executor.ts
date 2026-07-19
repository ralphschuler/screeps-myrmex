import {
  MAX_LAYOUT_LINK_ENERGY,
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
      if (intent.targetStructureType === "link" && !hasZeroCooldown(target))
        return result(intent, false, "ERR_INVALID_TARGET", "target-cooldown");
      const replacement = adapter.resolveStructure(intent.replacementId);
      if (replacement === null)
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-absent");
      if (!matchesReplacement(intent, replacement))
        return result(intent, false, "ERR_INVALID_TARGET", "replacement-mismatch");
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
  if (intent.replacementStructureType !== "tower") return true;
  const store = (
    replacement as Structure & {
      readonly store?: { getUsedCapacity(resource?: string): number | null };
    }
  ).store;
  const energy = store?.getUsedCapacity("energy");
  return (
    typeof energy === "number" &&
    Number.isSafeInteger(energy) &&
    energy >= MINIMUM_OPERATIONAL_TOWER_ENERGY
  );
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
