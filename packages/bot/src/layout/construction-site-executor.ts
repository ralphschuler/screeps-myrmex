import type {
  ConstructionSiteAttemptCode,
  ConstructionSiteExecutionResult,
  CreateConstructionSiteIntent,
} from "./contracts";

export interface ConstructionSiteExecutionAdapter {
  isCurrentCommitment(roomName: string, fingerprint: string): boolean;
  resolveRoom(roomName: string): Room | null;
}

export class ConstructionSiteExecutor {
  execute(
    intents: readonly CreateConstructionSiteIntent[],
    adapter: ConstructionSiteExecutionAdapter,
  ): readonly ConstructionSiteExecutionResult[] {
    return Object.freeze(intents.map((intent) => this.executeOne(intent, adapter)));
  }

  private executeOne(
    intent: CreateConstructionSiteIntent,
    adapter: ConstructionSiteExecutionAdapter,
  ): ConstructionSiteExecutionResult {
    try {
      if (!adapter.isCurrentCommitment(intent.roomName, intent.layoutFingerprint))
        return result(intent, false, "ERR_INVALID_TARGET", "stale-commitment");
      const room = adapter.resolveRoom(intent.roomName);
      if (room === null) return result(intent, false, "ERR_NOT_OWNER", "room-unavailable");
      if (room.controller?.my !== true)
        return result(intent, false, "ERR_NOT_OWNER", "room-not-owned");
      const code = normalizeReturnCode(
        room.createConstructionSite(
          intent.x,
          intent.y,
          intent.structureType as BuildableStructureConstant,
        ),
      );
      return result(intent, true, code, code === "UNEXPECTED" ? "adapter-fault" : null);
    } catch {
      return result(intent, false, "UNEXPECTED", "adapter-fault");
    }
  }
}

function normalizeReturnCode(code: number): ConstructionSiteAttemptCode {
  if (code === 0) return "OK";
  if (code === -1) return "ERR_NOT_OWNER";
  if (code === -7) return "ERR_INVALID_TARGET";
  if (code === -8) return "ERR_FULL";
  if (code === -10) return "ERR_INVALID_ARGS";
  if (code === -14) return "ERR_RCL_NOT_ENOUGH";
  return "UNEXPECTED";
}
function result(
  intent: CreateConstructionSiteIntent,
  called: boolean,
  code: ConstructionSiteAttemptCode,
  fault: ConstructionSiteExecutionResult["fault"],
): ConstructionSiteExecutionResult {
  return Object.freeze({ called, code, fault, intent });
}
