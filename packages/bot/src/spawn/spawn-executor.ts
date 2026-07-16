import {
  BODY_PART_ENERGY_COSTS,
  CREEP_SPAWN_TICKS_PER_PART,
  type SpawnBodyPart,
} from "./body-builder";
import { redactUntrusted } from "../security";

export const MAX_SPAWN_COMMANDS_PER_BATCH = 128;
export const MAX_SPAWN_BODY_PARTS = 50;
export const MAX_CREEP_NAME_LENGTH = 100;
export const MAX_SPAWN_COMMAND_TEXT_LENGTH = 256;

export interface SpawnCommandIntent {
  readonly intentId: string;
  readonly demandId: string;
  readonly colonyId: string;
  readonly issuer: string;
  readonly revision: number;
  readonly reservationId: string;
  readonly spawnId: string;
  readonly spawnName: string;
  readonly roomName: string;
  readonly body: readonly SpawnBodyPart[];
  readonly name: string;
  readonly energyCost: number;
  readonly spawnTicks: number;
  readonly scheduledTick: number;
}

export type ResolveSpawn = (spawnId: string) => unknown;

export interface SpawnCpuMeter {
  getUsed(): number;
}

export type SpawnMethodRejectionReason =
  | "non-owner"
  | "name-collision"
  | "busy"
  | "insufficient-energy"
  | "invalid-arguments"
  | "inactive";

export type SpawnLiveRejectionReason =
  | "spawn-missing"
  | "wrong-structure-type"
  | "spawn-id-mismatch"
  | "spawn-name-mismatch"
  | "room-mismatch"
  | "non-owner"
  | "busy"
  | "inactive";

export type SpawnExecutionReason =
  | "scheduled"
  | SpawnMethodRejectionReason
  | SpawnLiveRejectionReason
  | "unknown-code"
  | "invalid-return-code"
  | "adapter-fault";

export type SpawnExecutionOutcome =
  | {
      readonly state: "scheduled";
      readonly reason: "scheduled";
      readonly code: 0;
    }
  | {
      readonly state: "spawn-rejected";
      readonly reason: SpawnMethodRejectionReason;
      readonly code: -1 | -3 | -4 | -6 | -10 | -14;
    }
  | {
      readonly state: "live-spawn-rejected";
      readonly reason: SpawnLiveRejectionReason;
      readonly code: null;
    }
  | {
      readonly state: "invalid-return-code";
      readonly reason: "unknown-code" | "invalid-return-code";
      readonly code: number | null;
    }
  | {
      readonly state: "adapter-fault";
      readonly reason: "adapter-fault";
      readonly code: null;
      readonly error: string;
    };

export interface SpawnExecutionResult {
  readonly intentId: string;
  readonly command: SpawnCommandIntent;
  readonly status: "scheduled" | "rejected" | "failed";
  readonly reason: SpawnExecutionReason;
  readonly returnCode: number | null;
  readonly cpuUsed: number;
  readonly outcome: SpawnExecutionOutcome;
}

/**
 * The sole live spawn-command authority. The broker supplies already admitted data intents; this
 * boundary only validates the resolved live spawn and issues each command at most once.
 */
export class SpawnExecutor {
  execute(
    intents: readonly SpawnCommandIntent[],
    resolveSpawn: ResolveSpawn,
    cpu?: SpawnCpuMeter,
  ): readonly SpawnExecutionResult[] {
    const commands = validateCloneAndSortIntents(intents);
    const results: SpawnExecutionResult[] = [];

    for (const command of commands) {
      const startedAt = readCpu(cpu);
      const outcome = executeOne(command, resolveSpawn);
      const cpuUsed = cpuDelta(startedAt, readCpu(cpu));
      results.push(toResult(command, outcome, cpuUsed));
    }

    return Object.freeze(results);
  }
}

/** Normalize only return codes documented for StructureSpawn.spawnCreep. */
export function normalizeSpawnReturnCode(code: unknown): SpawnExecutionOutcome {
  switch (code) {
    case 0:
      return Object.freeze({ state: "scheduled", reason: "scheduled", code: 0 });
    case -1:
      return spawnRejected("non-owner", -1);
    case -3:
      return spawnRejected("name-collision", -3);
    case -4:
      return spawnRejected("busy", -4);
    case -6:
      return spawnRejected("insufficient-energy", -6);
    case -10:
      return spawnRejected("invalid-arguments", -10);
    case -14:
      return spawnRejected("inactive", -14);
    default:
      if (typeof code === "number" && Number.isFinite(code)) {
        return Object.freeze({
          state: "invalid-return-code",
          reason: "unknown-code",
          code,
        });
      }
      return Object.freeze({
        state: "invalid-return-code",
        reason: "invalid-return-code",
        code: null,
      });
  }
}

function executeOne(
  command: SpawnCommandIntent,
  resolveSpawn: ResolveSpawn,
): SpawnExecutionOutcome {
  try {
    const resolved = resolveSpawn(command.spawnId);
    if (resolved === undefined || resolved === null) {
      return liveRejected("spawn-missing");
    }
    const spawn = recordOf(resolved);
    if (spawn === null || spawn.structureType !== "spawn") {
      return liveRejected("wrong-structure-type");
    }
    if (spawn.id !== command.spawnId) {
      return liveRejected("spawn-id-mismatch");
    }
    if (spawn.name !== command.spawnName) {
      return liveRejected("spawn-name-mismatch");
    }

    const room = recordOf(spawn.room);
    if (room === null || room.name !== command.roomName) {
      return liveRejected("room-mismatch");
    }
    if (spawn.my !== true) {
      return liveRejected("non-owner");
    }
    if (spawn.spawning !== null) {
      return liveRejected("busy");
    }

    const isActive = spawn.isActive;
    if (isActive !== undefined) {
      if (typeof isActive !== "function") {
        throw new TypeError("resolved spawn isActive property is not callable");
      }
      if (isActive.call(resolved) !== true) {
        return liveRejected("inactive");
      }
    }

    const spawnCreep = spawn.spawnCreep;
    if (typeof spawnCreep !== "function") {
      throw new TypeError("resolved spawn spawnCreep property is not callable");
    }
    return normalizeSpawnReturnCode(spawnCreep.call(resolved, [...command.body], command.name));
  } catch (error: unknown) {
    return Object.freeze({
      state: "adapter-fault",
      reason: "adapter-fault",
      code: null,
      error: compactError(error),
    });
  }
}

function spawnRejected(
  reason: SpawnMethodRejectionReason,
  code: -1 | -3 | -4 | -6 | -10 | -14,
): SpawnExecutionOutcome {
  return Object.freeze({ state: "spawn-rejected", reason, code });
}

function liveRejected(reason: SpawnLiveRejectionReason): SpawnExecutionOutcome {
  return Object.freeze({ state: "live-spawn-rejected", reason, code: null });
}

function toResult(
  command: SpawnCommandIntent,
  outcome: SpawnExecutionOutcome,
  cpuUsed: number,
): SpawnExecutionResult {
  const status =
    outcome.state === "scheduled"
      ? "scheduled"
      : outcome.state === "spawn-rejected" || outcome.state === "live-spawn-rejected"
        ? "rejected"
        : "failed";
  return deepFreeze({
    intentId: command.intentId,
    command,
    status,
    reason: outcome.reason,
    returnCode: outcome.code,
    cpuUsed,
    outcome,
  });
}

function validateCloneAndSortIntents(
  intents: readonly SpawnCommandIntent[],
): readonly SpawnCommandIntent[] {
  if (!isUnknownArray(intents)) {
    throw new TypeError("spawn commands must be an array");
  }
  if (intents.length > MAX_SPAWN_COMMANDS_PER_BATCH) {
    throw new RangeError(
      `spawn command batch exceeds ${String(MAX_SPAWN_COMMANDS_PER_BATCH)} intents`,
    );
  }

  const intentIds = new Set<string>();
  const commands: SpawnCommandIntent[] = [];
  for (let index = 0; index < intents.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(intents, index)) {
      throw new TypeError(`spawn command at index ${String(index)} is missing`);
    }
    const command = cloneValidatedIntent(intents[index], index);
    if (intentIds.has(command.intentId)) {
      throw new TypeError(`duplicate spawn command intent id: ${command.intentId}`);
    }
    intentIds.add(command.intentId);
    commands.push(command);
  }

  commands.sort((left, right) => compareStrings(left.intentId, right.intentId));
  const spawnTargets = new Map<string, string>();
  for (const command of commands) {
    const firstIntentId = spawnTargets.get(command.spawnId);
    if (firstIntentId !== undefined) {
      throw new TypeError(
        `spawn command batch targets spawn ${command.spawnId} more than once: ${firstIntentId}, ${command.intentId}`,
      );
    }
    spawnTargets.set(command.spawnId, command.intentId);
  }
  return Object.freeze(commands);
}

function cloneValidatedIntent(value: unknown, index: number): SpawnCommandIntent {
  const command = recordOf(value);
  if (command === null) {
    throw new TypeError(`spawn command at index ${String(index)} must be a data object`);
  }

  const intentId = boundedText(command.intentId, "intentId", index);
  const demandId = boundedText(command.demandId, "demandId", index);
  const colonyId = boundedText(command.colonyId, "colonyId", index);
  const issuer = boundedText(command.issuer, "issuer", index);
  const revision = nonnegativeSafeInteger(command.revision, "revision", index);
  const reservationId = boundedText(command.reservationId, "reservationId", index);
  const spawnId = boundedText(command.spawnId, "spawnId", index);
  const spawnName = boundedText(command.spawnName, "spawnName", index);
  const roomName = boundedText(command.roomName, "roomName", index);
  const name = boundedText(command.name, "name", index, MAX_CREEP_NAME_LENGTH);

  if (!isUnknownArray(command.body)) {
    throw new TypeError(`spawn command body at index ${String(index)} must be an array`);
  }
  if (command.body.length === 0 || command.body.length > MAX_SPAWN_BODY_PARTS) {
    throw new RangeError(
      `spawn command body at index ${String(index)} must contain 1-${String(MAX_SPAWN_BODY_PARTS)} parts`,
    );
  }
  const body: SpawnBodyPart[] = [];
  for (let bodyIndex = 0; bodyIndex < command.body.length; bodyIndex += 1) {
    if (!Object.prototype.hasOwnProperty.call(command.body, bodyIndex)) {
      throw new TypeError(
        `spawn command body part at index ${String(index)}:${String(bodyIndex)} is missing`,
      );
    }
    const part = command.body[bodyIndex];
    if (!isSpawnBodyPart(part)) {
      throw new TypeError(
        `spawn command body part at index ${String(index)}:${String(bodyIndex)} is invalid`,
      );
    }
    body.push(part);
  }

  const energyCost = positiveSafeInteger(command.energyCost, "energyCost", index);
  const spawnTicks = positiveSafeInteger(command.spawnTicks, "spawnTicks", index);
  const scheduledTick = nonnegativeSafeInteger(command.scheduledTick, "scheduledTick", index);
  const expectedEnergyCost = body.reduce((total, part) => total + BODY_PART_ENERGY_COSTS[part], 0);
  if (energyCost !== expectedEnergyCost) {
    throw new RangeError(
      `spawn command energyCost at index ${String(index)} must equal body energy cost ${String(expectedEnergyCost)}`,
    );
  }
  const expectedSpawnTicks = body.length * CREEP_SPAWN_TICKS_PER_PART;
  if (spawnTicks !== expectedSpawnTicks) {
    throw new RangeError(
      `spawn command spawnTicks at index ${String(index)} must equal body spawn duration ${String(expectedSpawnTicks)}`,
    );
  }

  return deepFreeze({
    intentId,
    demandId,
    colonyId,
    issuer,
    revision,
    reservationId,
    spawnId,
    spawnName,
    roomName,
    body,
    name,
    energyCost,
    spawnTicks,
    scheduledTick,
  });
}

function boundedText(
  value: unknown,
  field: string,
  index: number,
  maximumLength = MAX_SPAWN_COMMAND_TEXT_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength
  ) {
    throw new RangeError(
      `spawn command ${field} at index ${String(index)} must contain 1-${String(maximumLength)} characters`,
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string, index: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `spawn command ${field} at index ${String(index)} must be a positive safe integer`,
    );
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown, field: string, index: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `spawn command ${field} at index ${String(index)} must be a non-negative safe integer`,
    );
  }
  return value;
}

function isSpawnBodyPart(value: unknown): value is SpawnBodyPart {
  return (
    value === "tough" ||
    value === "work" ||
    value === "carry" ||
    value === "attack" ||
    value === "ranged_attack" ||
    value === "heal" ||
    value === "claim" ||
    value === "move"
  );
}

function readCpu(cpu: SpawnCpuMeter | undefined): number | null {
  if (cpu === undefined) {
    return null;
  }
  try {
    const value = cpu.getUsed();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function cpuDelta(startedAt: number | null, endedAt: number | null): number {
  if (startedAt === null || endedAt === null) {
    return 0;
  }
  const delta = endedAt - startedAt;
  return Number.isFinite(delta) ? Math.max(0, delta) : 0;
}

function compactError(error: unknown): string {
  return redactUntrusted("spawn-error", error);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
