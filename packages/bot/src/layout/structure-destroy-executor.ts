import type {
  DestroyOwnedStructureIntent,
  StructureDestroyExecutionCode,
  StructureDestroyExecutionResult,
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
