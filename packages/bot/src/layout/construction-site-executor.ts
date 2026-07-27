import type {
  ConstructionSiteAttemptCode,
  ConstructionSiteExecutionResult,
  CreateConstructionSiteIntent,
} from "./contracts";

export interface ConstructionSiteExecutionAdapter {
  isCurrentCommitment(roomName: string, fingerprint: string): boolean;
  readonly isSelfUsername?: (username: string) => boolean;
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
      if (intent.remoteAuthorization === undefined) {
        if (room.controller?.my !== true)
          return result(intent, false, "ERR_NOT_OWNER", "room-not-owned");
      } else if (intent.structureType !== "container" && intent.structureType !== "road") {
        return result(intent, false, "ERR_INVALID_TARGET", "remote-structure-forbidden");
      } else if (
        !remoteControllerMatches(
          room.controller,
          intent.remoteAuthorization,
          adapter.isSelfUsername,
        )
      ) {
        return result(intent, false, "ERR_NOT_OWNER", "remote-controller-mismatch");
      }
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

function remoteControllerMatches(
  controller: StructureController | undefined,
  authorization: NonNullable<CreateConstructionSiteIntent["remoteAuthorization"]>,
  isSelfUsername: ConstructionSiteExecutionAdapter["isSelfUsername"],
): boolean {
  if (controller === undefined || controller.owner !== undefined) return false;
  if (authorization.controller === "neutral")
    return authorization.reservationUsername === null && controller.reservation === undefined;
  return (
    authorization.reservationUsername !== null &&
    controller.reservation?.username === authorization.reservationUsername &&
    isSelfUsername?.(authorization.reservationUsername) === true
  );
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
