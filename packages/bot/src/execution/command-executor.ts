import { redactUntrusted } from "../security";

export const SCREEPS_RETURN_CODES = {
  0: "OK",
  [-1]: "ERR_NOT_OWNER",
  [-2]: "ERR_NO_PATH",
  [-3]: "ERR_NAME_EXISTS",
  [-4]: "ERR_BUSY",
  [-5]: "ERR_NOT_FOUND",
  // Screeps aliases energy, resources, and extensions to the same numeric code.
  [-6]: "ERR_NOT_ENOUGH_RESOURCES",
  [-7]: "ERR_INVALID_TARGET",
  [-8]: "ERR_FULL",
  [-9]: "ERR_NOT_IN_RANGE",
  [-10]: "ERR_INVALID_ARGS",
  [-11]: "ERR_TIRED",
  [-12]: "ERR_NO_BODYPART",
  [-14]: "ERR_RCL_NOT_ENOUGH",
  [-15]: "ERR_GCL_NOT_ENOUGH",
  [-16]: "ERR_ACCESS_DENIED",
} as const;

export type KnownScreepsReturnCode = keyof typeof SCREEPS_RETURN_CODES;
export type ScreepsReturnCodeName = (typeof SCREEPS_RETURN_CODES)[KnownScreepsReturnCode];

export type NormalizedCommandOutcome =
  | {
      readonly state: "scheduled";
      readonly code: 0;
      readonly name: "OK";
    }
  | {
      readonly state: "game-rejected";
      readonly code: Exclude<KnownScreepsReturnCode, 0>;
      readonly name: Exclude<ScreepsReturnCodeName, "OK">;
    }
  | {
      readonly state: "invalid-return-code";
      readonly code: number | null;
      readonly name: null;
    }
  | {
      readonly state: "adapter-fault";
      readonly code: null;
      readonly name: null;
      readonly error: string;
    };

export interface CommandRequest<Command> {
  readonly intentId: string;
  readonly command: Command;
}

/** The only boundary permitted to translate a command into one API interaction. */
export interface CommandAdapter<Command> {
  issue(command: Command): number;
}

export interface CommandCpuMeter {
  getUsed(): number;
}

export interface CommandExecutionResult<Command> {
  readonly intentId: string;
  readonly tick: number;
  readonly command: Command;
  readonly status: "executed" | "rejected" | "failed";
  readonly reason: ScreepsReturnCodeName | "invalid-return-code" | "adapter-fault";
  readonly returnCode: number | null;
  readonly cpuUsed: number;
  readonly outcome: NormalizedCommandOutcome;
}

export interface CommandBatchRequest<Command> {
  readonly tick: number;
  readonly commands: readonly CommandRequest<Command>[];
  readonly adapter: CommandAdapter<Command>;
  readonly cpu?: CommandCpuMeter;
}

export interface AcceptedIntentBatchRequest<
  Command,
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly tick: number;
  readonly arbitration: ArbitrationBatch<Kind, Payload>;
  /** Pure translation from an already accepted data envelope into one bounded command. */
  readonly commandFor: (intent: IntentEnvelope<Kind, Payload>) => Command;
  readonly adapter: CommandAdapter<Command>;
  readonly cpu?: CommandCpuMeter;
}

/**
 * Public execution entry point. Commands can only be derived from the accepted side of a sealed
 * arbitration batch; rejected and deferred intents cannot reach a game adapter.
 */
export function executeAcceptedIntentBatch<
  Command,
  Kind extends string = string,
  Payload extends IntentData = IntentData,
>(
  request: AcceptedIntentBatchRequest<Command, Kind, Payload>,
): readonly CommandExecutionResult<Command>[] {
  if (request.arbitration.tick !== request.tick) {
    throw new Error("command execution tick must match the arbitration batch tick");
  }
  const commands = request.arbitration.accepted.map((intent) => ({
    intentId: intent.id,
    command: request.commandFor(intent),
  }));
  return executeCommandBatch({
    tick: request.tick,
    commands,
    adapter: request.adapter,
    ...(request.cpu === undefined ? {} : { cpu: request.cpu }),
  });
}

/**
 * Issues each accepted command once and turns both legal game failures and
 * unexpected adapter failures into data for reconciliation.
 */
function executeCommandBatch<Command>(
  request: CommandBatchRequest<Command>,
): readonly CommandExecutionResult<Command>[] {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    throw new Error("command batch tick must be a non-negative safe integer");
  }
  const intentIds = new Set<string>();
  for (const command of request.commands) {
    if (command.intentId.trim().length === 0 || command.intentId !== command.intentId.trim()) {
      throw new Error("command intent ids must be non-empty and trimmed");
    }
    if (intentIds.has(command.intentId)) {
      throw new Error(`duplicate command intent id: ${command.intentId}`);
    }
    intentIds.add(command.intentId);
  }
  return Object.freeze(request.commands.map((command) => executeCommand(request, command)));
}

export function normalizeScreepsReturnCode(code: number): NormalizedCommandOutcome {
  if (!Number.isFinite(code)) {
    return Object.freeze({ state: "invalid-return-code", code: null, name: null });
  }
  if (code === 0) {
    return Object.freeze({ state: "scheduled", code: 0, name: "OK" });
  }
  if (isKnownScreepsReturnCode(code)) {
    const name = SCREEPS_RETURN_CODES[code];
    return Object.freeze({
      state: "game-rejected",
      code: code as Exclude<KnownScreepsReturnCode, 0>,
      name: name as Exclude<ScreepsReturnCodeName, "OK">,
    });
  }
  return Object.freeze({ state: "invalid-return-code", code, name: null });
}

function isKnownScreepsReturnCode(code: number): code is KnownScreepsReturnCode {
  return Object.prototype.hasOwnProperty.call(SCREEPS_RETURN_CODES, code);
}

function executeCommand<Command>(
  batch: CommandBatchRequest<Command>,
  request: CommandRequest<Command>,
): CommandExecutionResult<Command> {
  const startedAt = readCpu(batch.cpu);
  let outcome: NormalizedCommandOutcome;
  try {
    outcome = normalizeScreepsReturnCode(batch.adapter.issue(request.command));
  } catch (error: unknown) {
    outcome = Object.freeze({
      state: "adapter-fault",
      code: null,
      name: null,
      error: compactError(error),
    });
  }
  const cpuUsed = Math.max(0, readCpu(batch.cpu) - startedAt);

  if (outcome.state === "scheduled") {
    return Object.freeze({
      intentId: request.intentId,
      tick: batch.tick,
      command: request.command,
      status: "executed",
      reason: outcome.name,
      returnCode: outcome.code,
      cpuUsed,
      outcome,
    });
  }
  if (outcome.state === "game-rejected") {
    return Object.freeze({
      intentId: request.intentId,
      tick: batch.tick,
      command: request.command,
      status: "rejected",
      reason: outcome.name,
      returnCode: outcome.code,
      cpuUsed,
      outcome,
    });
  }
  return Object.freeze({
    intentId: request.intentId,
    tick: batch.tick,
    command: request.command,
    status: "failed",
    reason: outcome.state,
    returnCode: outcome.code,
    cpuUsed,
    outcome,
  });
}

function readCpu(cpu: CommandCpuMeter | undefined): number {
  if (cpu === undefined) {
    return 0;
  }
  const value = cpu.getUsed();
  return Number.isFinite(value) ? value : 0;
}

function compactError(error: unknown): string {
  return redactUntrusted("command-error", error);
}
import type { ArbitrationBatch, IntentData, IntentEnvelope } from "./contracts";
