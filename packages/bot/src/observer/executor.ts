import {
  executeAcceptedIntentBatch,
  type ArbitrationBatch,
  type CommandCpuMeter,
  type CommandExecutionResult,
  type IntentData,
  type IntentEnvelope,
} from "../execution";
import type { ObserverIntent } from "./authority";

export interface ObserverCommand {
  readonly capabilityFingerprint: string;
  readonly mechanicsFingerprint: string;
  readonly observerId: string;
  readonly observerRange: number;
  readonly operateObserverPower: number;
  readonly originRoomName: string;
  readonly targetRoomName: string;
}

export interface ObserverExecutionAdapter {
  readonly currentCapabilityFingerprint: (observerId: string) => string | null;
  readonly currentMechanicsFingerprint: () => string | null;
  readonly resolveObserver: (observerId: string) => StructureObserver | null;
}

/** Sole boundary allowed to call StructureObserver.observeRoom. */
export function executeObserverIntents(
  arbitration: ArbitrationBatch,
  tick: number,
  adapter: ObserverExecutionAdapter,
  cpu?: CommandCpuMeter,
): readonly CommandExecutionResult<ObserverCommand>[] {
  const accepted = arbitration.accepted.filter(isObserverIntent);
  if (!validObserverBatch(accepted)) return Object.freeze([]);
  return executeAcceptedIntentBatch<
    ObserverCommand,
    ObserverIntent["kind"],
    ObserverIntent["payload"]
  >({
    arbitration: { ...arbitration, accepted, decisions: [] },
    tick,
    commandFor,
    adapter: { issue: (command) => issueObserverCommand(command, adapter) },
    ...(cpu === undefined ? {} : { cpu }),
  });
}

function validObserverBatch(intents: readonly ObserverIntent[]): boolean {
  const intentIds = new Set<string>();
  const observers = new Set<string>();
  for (const intent of intents) {
    if (
      intent.target !== intent.payload.observerId ||
      intent.exclusiveResourceKey !== `observer/${intent.payload.observerId}` ||
      intentIds.has(intent.id) ||
      observers.has(intent.payload.observerId)
    )
      return false;
    intentIds.add(intent.id);
    observers.add(intent.payload.observerId);
  }
  return true;
}

function commandFor(intent: ObserverIntent): ObserverCommand {
  return Object.freeze({
    capabilityFingerprint: intent.payload.capabilityFingerprint,
    mechanicsFingerprint: intent.payload.mechanicsFingerprint,
    observerId: intent.payload.observerId,
    observerRange: intent.payload.observerRange,
    operateObserverPower: intent.payload.operateObserverPower,
    originRoomName: intent.payload.originRoomName,
    targetRoomName: intent.payload.targetRoomName,
  });
}

function issueObserverCommand(command: ObserverCommand, adapter: ObserverExecutionAdapter): number {
  if (
    adapter.currentMechanicsFingerprint() !== command.mechanicsFingerprint ||
    adapter.currentCapabilityFingerprint(command.observerId) !== command.capabilityFingerprint ||
    !roomName(command.originRoomName) ||
    !roomName(command.targetRoomName) ||
    !positiveInteger(command.observerRange) ||
    !positiveInteger(command.operateObserverPower)
  )
    return -7;
  const observer = adapter.resolveObserver(command.observerId);
  if (
    observer === null ||
    String(observer.id) !== command.observerId ||
    !observer.my ||
    !observer.isActive() ||
    observer.room.name !== command.originRoomName ||
    observer.pos.roomName !== command.originRoomName ||
    observer.room.controller?.my !== true ||
    observer.room.controller.level < 8 ||
    (!hasOperateObserverEffect(observer, command.operateObserverPower) &&
      roomDistance(command.originRoomName, command.targetRoomName) > command.observerRange)
  )
    return -7;
  return observer.observeRoom(command.targetRoomName);
}

function hasOperateObserverEffect(observer: StructureObserver, power: number): boolean {
  return (observer.effects ?? []).some(
    (effect) => effect.effect === power && effect.ticksRemaining > 0,
  );
}

function isObserverIntent(intent: IntentEnvelope): intent is ObserverIntent {
  if (
    intent.kind !== "observer.observe-room" ||
    intent.payload === null ||
    typeof intent.payload !== "object" ||
    Array.isArray(intent.payload)
  )
    return false;
  const payload = intent.payload as Readonly<Record<string, IntentData>>;
  return (
    typeof payload["observerId"] === "string" &&
    typeof payload["originRoomName"] === "string" &&
    typeof payload["targetRoomName"] === "string"
  );
}

function roomDistance(left: string, right: string): number {
  const a = roomCoordinates(left);
  const b = roomCoordinates(right);
  return a === null || b === null
    ? Number.POSITIVE_INFINITY
    : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
function roomCoordinates(value: string): { readonly x: number; readonly y: number } | null {
  const match = /^(W|E)(\d+)(N|S)(\d+)$/u.exec(value);
  if (match === null) return null;
  const horizontal = Number(match[2]);
  const vertical = Number(match[4]);
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical)) return null;
  return {
    x: match[1] === "W" ? -horizontal - 1 : horizontal,
    y: match[3] === "N" ? -vertical - 1 : vertical,
  };
}
function roomName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16 &&
    /^(W|E)\d+(N|S)\d+$/u.test(value)
  );
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
