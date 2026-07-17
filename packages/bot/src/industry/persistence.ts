import { isLabPolicyCommitment, type LabPolicyCommitment } from "./lab-policy";
import type { IndustryCommandState } from "./telemetry";

export const INDUSTRY_OWNER_SCHEMA_VERSION = 2 as const;
export const MAX_INDUSTRY_COMMAND_STATES = 128 as const;
export const MAX_INDUSTRY_LAB_COMMITMENTS = 64 as const;

export interface IndustryOwnerV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly policySourceVersion: string;
  readonly commands: readonly IndustryCommandState[];
}

export interface IndustryOwnerV2 {
  readonly schemaVersion: typeof INDUSTRY_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly policySourceVersion: string;
  readonly commands: readonly IndustryCommandState[];
  readonly labCommitments: readonly LabPolicyCommitment[];
}

export function emptyIndustryOwner(): IndustryOwnerV2 {
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: 0,
    policySourceVersion: "",
    commands: [],
    labCommitments: [],
  });
}

export function parseIndustryOwner(value: unknown): IndustryOwnerV2 | null {
  if (
    !record(value) ||
    value.schemaVersion !== INDUSTRY_OWNER_SCHEMA_VERSION ||
    !ownerBaseValid(value) ||
    !Array.isArray(value.labCommitments) ||
    value.labCommitments.length > MAX_INDUSTRY_LAB_COMMITMENTS ||
    !value.labCommitments.every(isLabPolicyCommitment)
  )
    return null;
  const commands = canonicalCommands(value.commands);
  const labCommitments = canonicalCommitments(value.labCommitments);
  if (
    new Set(commands.map(({ identity }) => identity)).size !== commands.length ||
    duplicateCommitmentIdentity(labCommitments)
  )
    return null;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
    labCommitments,
  });
}

/** Owner-local opaque migration. Root Memory schema and envelope remain unchanged. */
export function migrateIndustryOwner(value: unknown): IndustryOwnerV2 | null {
  const current = parseIndustryOwner(value);
  if (current !== null) return current;
  const previous = parseIndustryOwnerV1(value);
  if (previous === null) return null;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: previous.revision + 1,
    policySourceVersion: "industry-policy-v2",
    commands: previous.commands,
    labCommitments: [],
  });
}

export function persistIndustryOwner(
  owner: IndustryOwnerV2,
  policySourceVersion: string,
  commands: readonly IndustryCommandState[],
  labCommitments: readonly LabPolicyCommitment[],
): IndustryOwnerV2 {
  if (!boundedString(policySourceVersion, 64, false))
    throw new Error("industry policy source version must be a bounded non-empty string");
  if (!commands.every(validCommand)) throw new Error("invalid industry command state");
  if (!labCommitments.every(isLabPolicyCommitment))
    throw new Error("invalid industry lab commitment");
  const canonicalCommandsValue = canonicalCommands(commands).slice(0, MAX_INDUSTRY_COMMAND_STATES);
  const canonicalCommitmentsValue = canonicalCommitments(labCommitments).slice(
    0,
    MAX_INDUSTRY_LAB_COMMITMENTS,
  );
  if (
    new Set(canonicalCommandsValue.map(({ identity }) => identity)).size !==
    canonicalCommandsValue.length
  )
    throw new Error("duplicate industry command identity");
  if (duplicateCommitmentIdentity(canonicalCommitmentsValue))
    throw new Error("duplicate industry lab commitment identity");
  const compatible =
    owner.policySourceVersion === "" || owner.policySourceVersion === policySourceVersion;
  const nextCommands = compatible ? canonicalCommandsValue : [];
  const nextCommitments = compatible ? canonicalCommitmentsValue : [];
  if (
    owner.policySourceVersion === policySourceVersion &&
    sameCommands(owner.commands, nextCommands) &&
    sameCommitments(owner.labCommitments, nextCommitments)
  )
    return owner;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: owner.revision + 1,
    policySourceVersion,
    commands: nextCommands,
    labCommitments: nextCommitments,
  });
}

export function persistIndustryCommands(
  owner: IndustryOwnerV2,
  policySourceVersion: string,
  commands: readonly IndustryCommandState[],
): IndustryOwnerV2 {
  return persistIndustryOwner(owner, policySourceVersion, commands, owner.labCommitments);
}

function parseIndustryOwnerV1(value: unknown): IndustryOwnerV1 | null {
  if (!record(value) || value.schemaVersion !== 1 || !ownerBaseValid(value)) return null;
  const commands = canonicalCommands(value.commands);
  if (new Set(commands.map(({ identity }) => identity)).size !== commands.length) return null;
  return freeze({
    schemaVersion: 1,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
  });
}

function ownerBaseValid(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly revision: number;
  readonly policySourceVersion: string;
  readonly commands: readonly IndustryCommandState[];
} {
  return (
    nonNegativeInteger(value.revision) &&
    boundedString(value.policySourceVersion, 64, true) &&
    Array.isArray(value.commands) &&
    value.commands.length <= MAX_INDUSTRY_COMMAND_STATES &&
    value.commands.every(validCommand)
  );
}

function sameCommands(
  left: readonly IndustryCommandState[],
  right: readonly IndustryCommandState[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCommitments(
  left: readonly LabPolicyCommitment[],
  right: readonly LabPolicyCommitment[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalCommands(commands: readonly IndustryCommandState[]): IndustryCommandState[] {
  return [...commands]
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((command) => freeze({ ...command }));
}

function canonicalCommitments(commitments: readonly LabPolicyCommitment[]): LabPolicyCommitment[] {
  return [...commitments]
    .sort(
      (left, right) =>
        left.colonyId.localeCompare(right.colonyId) ||
        left.objectiveId.localeCompare(right.objectiveId) ||
        left.objectiveRevision - right.objectiveRevision,
    )
    .map((commitment) =>
      commitment.kind === "reaction"
        ? freeze({ ...commitment, reagents: freeze([...commitment.reagents] as [string, string]) })
        : freeze({ ...commitment }),
    );
}

function duplicateCommitmentIdentity(commitments: readonly LabPolicyCommitment[]): boolean {
  const identities = commitments.map(
    ({ colonyId, objectiveId, objectiveRevision }) =>
      `${colonyId}\u0000${objectiveId}\u0000${String(objectiveRevision)}`,
  );
  return new Set(identities).size !== identities.length;
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
