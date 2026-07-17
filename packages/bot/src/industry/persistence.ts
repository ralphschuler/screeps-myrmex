import type { IndustryCommandState } from "./telemetry";

export const INDUSTRY_OWNER_SCHEMA_VERSION = 1 as const;
export const MAX_INDUSTRY_COMMAND_STATES = 128 as const;

export interface IndustryOwnerV1 {
  readonly schemaVersion: typeof INDUSTRY_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly policySourceVersion: string;
  readonly commands: readonly IndustryCommandState[];
}

export function emptyIndustryOwner(): IndustryOwnerV1 {
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: 0,
    policySourceVersion: "",
    commands: [],
  });
}

export function parseIndustryOwner(value: unknown): IndustryOwnerV1 | null {
  if (
    !record(value) ||
    value.schemaVersion !== INDUSTRY_OWNER_SCHEMA_VERSION ||
    !nonNegativeInteger(value.revision) ||
    !boundedString(value.policySourceVersion, 64, true) ||
    !Array.isArray(value.commands) ||
    value.commands.length > MAX_INDUSTRY_COMMAND_STATES
  )
    return null;
  if (!value.commands.every(validCommand)) return null;
  const commands = canonicalCommands(value.commands);
  if (new Set(commands.map(({ identity }) => identity)).size !== commands.length) return null;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
  });
}

export function persistIndustryCommands(
  owner: IndustryOwnerV1,
  policySourceVersion: string,
  commands: readonly IndustryCommandState[],
): IndustryOwnerV1 {
  if (!boundedString(policySourceVersion, 64, false)) {
    throw new Error("industry policy source version must be a bounded non-empty string");
  }
  if (!commands.every(validCommand)) throw new Error("invalid industry command state");
  const canonical = canonicalCommands(commands).slice(0, MAX_INDUSTRY_COMMAND_STATES);
  if (new Set(canonical.map(({ identity }) => identity)).size !== canonical.length)
    throw new Error("duplicate industry command identity");
  const nextCommands =
    owner.policySourceVersion === "" || owner.policySourceVersion === policySourceVersion
      ? canonical
      : [];
  if (
    owner.policySourceVersion === policySourceVersion &&
    sameCommands(owner.commands, nextCommands)
  )
    return owner;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: owner.revision + 1,
    policySourceVersion,
    commands: nextCommands,
  });
}

function sameCommands(
  left: readonly IndustryCommandState[],
  right: readonly IndustryCommandState[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.attempt === other.attempt &&
        item.identity === other.identity &&
        item.lastCode === other.lastCode &&
        item.nextEligibleTick === other.nextEligibleTick &&
        item.status === other.status
      );
    })
  );
}

function canonicalCommands(commands: readonly IndustryCommandState[]): IndustryCommandState[] {
  return [...commands]
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((command) => freeze({ ...command }));
}

function validCommand(value: unknown): value is IndustryCommandState {
  return (
    record(value) &&
    nonNegativeInteger(value.attempt) &&
    value.attempt <= 8 &&
    boundedString(value.identity, 160, false) &&
    boundedString(value.lastCode, 64, false) &&
    nonNegativeInteger(value.nextEligibleTick) &&
    (value.status === "active" ||
      value.status === "backoff" ||
      value.status === "completed" ||
      value.status === "retired")
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedString(value: unknown, maximum: number, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    value === value.trim()
  );
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
