import { isLabPolicyCommitment, type LabPolicyCommitment } from "./lab-policy";
import { isPendingLabAttempt, type PendingLabAttempt } from "./lab-runtime";
import { isPendingMatureAttempt, type PendingMatureAttempt } from "./mature-attempt";
import { isMaturePolicyCommitment, type MaturePolicyCommitment } from "./mature-policy";
import { isPendingObserverAttempt, type PendingObserverAttempt } from "../observer/authority";
import type { IndustryCommandState } from "./telemetry";

export const INDUSTRY_OWNER_SCHEMA_VERSION = 5 as const;
export const MAX_INDUSTRY_COMMAND_STATES = 128 as const;
export const MAX_INDUSTRY_LAB_COMMITMENTS = 64 as const;
export const MAX_INDUSTRY_LAB_ATTEMPTS = 64 as const;
export const MAX_INDUSTRY_MATURE_ATTEMPTS = 64 as const;
export const MAX_INDUSTRY_MATURE_COMMITMENTS = 64 as const;
export const MAX_INDUSTRY_OBSERVER_ATTEMPTS = 64 as const;

export interface IndustryOwnerV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly policySourceVersion: string;
  readonly commands: readonly IndustryCommandState[];
}
export interface IndustryOwnerV2 extends Omit<IndustryOwnerV1, "schemaVersion"> {
  readonly schemaVersion: 2;
  readonly labCommitments: readonly LabPolicyCommitment[];
}
export interface IndustryOwnerV3 extends Omit<IndustryOwnerV2, "schemaVersion"> {
  readonly schemaVersion: 3;
  readonly labAttempts: readonly PendingLabAttempt[];
}
export interface IndustryOwnerV4 extends Omit<IndustryOwnerV3, "schemaVersion"> {
  readonly schemaVersion: 4;
  readonly matureAttempts: readonly PendingMatureAttempt[];
}
export interface IndustryOwnerV5 extends Omit<IndustryOwnerV4, "schemaVersion"> {
  readonly schemaVersion: typeof INDUSTRY_OWNER_SCHEMA_VERSION;
  readonly matureCommitments: readonly MaturePolicyCommitment[];
  readonly observerAttempts: readonly PendingObserverAttempt[];
}

export function emptyIndustryOwner(): IndustryOwnerV5 {
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: 0,
    policySourceVersion: "",
    commands: [],
    labCommitments: [],
    labAttempts: [],
    matureAttempts: [],
    matureCommitments: [],
    observerAttempts: [],
  });
}

export function parseIndustryOwner(value: unknown): IndustryOwnerV5 | null {
  if (
    !record(value) ||
    value.schemaVersion !== INDUSTRY_OWNER_SCHEMA_VERSION ||
    !ownerBaseValid(value) ||
    !validCommitments(value.labCommitments) ||
    !validLabAttempts(value.labAttempts) ||
    !validMatureAttempts(value.matureAttempts) ||
    !validMatureCommitments(value.matureCommitments) ||
    !validObserverAttempts(value.observerAttempts)
  )
    return null;
  const commands = canonicalCommands(value.commands);
  const labCommitments = canonicalCommitments(value.labCommitments);
  const labAttempts = canonicalAttempts(value.labAttempts);
  const matureAttempts = canonicalMatureAttempts(value.matureAttempts);
  const matureCommitments = canonicalMatureCommitments(value.matureCommitments);
  const observerAttempts = canonicalObserverAttempts(value.observerAttempts);
  if (
    duplicateCommands(commands) ||
    duplicateCommitments(labCommitments) ||
    duplicateAttempts(labAttempts) ||
    duplicateMatureAttempts(matureAttempts) ||
    duplicateMatureCommitments(matureCommitments) ||
    duplicateObserverAttempts(observerAttempts)
  )
    return null;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
    labCommitments,
    labAttempts,
    matureAttempts,
    matureCommitments,
    observerAttempts,
  });
}

/** Owner-local opaque migration. Root Memory schema and envelope remain unchanged. */
export function migrateIndustryOwner(value: unknown): IndustryOwnerV5 | null {
  const current = parseIndustryOwner(value);
  if (current !== null) return current;
  const v4 = parseIndustryOwnerV4(value);
  if (v4 !== null)
    return freeze({
      ...v4,
      schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
      revision: v4.revision + 1,
      matureCommitments: [],
      observerAttempts: [],
    });
  const v3 = parseIndustryOwnerV3(value);
  if (v3 !== null)
    return freeze({
      ...v3,
      schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
      revision: v3.revision + 1,
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
  const v2 = parseIndustryOwnerV2(value);
  if (v2 !== null)
    return freeze({
      ...v2,
      schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
      revision: v2.revision + 1,
      labAttempts: [],
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
  const v1 = parseIndustryOwnerV1(value);
  if (v1 === null) return null;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: v1.revision + 1,
    policySourceVersion: "industry-policy-v2",
    commands: v1.commands,
    labCommitments: [],
    labAttempts: [],
    matureAttempts: [],
    matureCommitments: [],
    observerAttempts: [],
  });
}

export function persistIndustryOwner(
  owner: IndustryOwnerV5,
  policySourceVersion: string,
  commands: readonly IndustryCommandState[],
  labCommitments: readonly LabPolicyCommitment[],
  labAttempts: readonly PendingLabAttempt[] = owner.labAttempts,
  matureAttempts: readonly PendingMatureAttempt[] = owner.matureAttempts,
  matureCommitments: readonly MaturePolicyCommitment[] = owner.matureCommitments,
  observerAttempts: readonly PendingObserverAttempt[] = owner.observerAttempts,
): IndustryOwnerV5 {
  if (!boundedString(policySourceVersion, 64, false))
    throw new Error("industry policy source version must be a bounded non-empty string");
  if (!commands.every(validCommand)) throw new Error("invalid industry command state");
  if (!labCommitments.every(isLabPolicyCommitment))
    throw new Error("invalid industry lab commitment");
  if (!labAttempts.every(isPendingLabAttempt)) throw new Error("invalid industry lab attempt");
  if (!matureAttempts.every(isPendingMatureAttempt))
    throw new Error("invalid industry mature attempt");
  if (!matureCommitments.every(isMaturePolicyCommitment))
    throw new Error("invalid industry mature commitment");
  if (!observerAttempts.every(isPendingObserverAttempt))
    throw new Error("invalid industry observer attempt");
  const commandsValue = canonicalCommands(commands).slice(0, MAX_INDUSTRY_COMMAND_STATES);
  const commitmentsValue = canonicalCommitments(labCommitments).slice(
    0,
    MAX_INDUSTRY_LAB_COMMITMENTS,
  );
  const attemptsValue = canonicalAttempts(labAttempts).slice(0, MAX_INDUSTRY_LAB_ATTEMPTS);
  const matureAttemptsValue = canonicalMatureAttempts(matureAttempts).slice(
    0,
    MAX_INDUSTRY_MATURE_ATTEMPTS,
  );
  const matureCommitmentsValue = canonicalMatureCommitments(matureCommitments).slice(
    0,
    MAX_INDUSTRY_MATURE_COMMITMENTS,
  );
  const observerAttemptsValue = canonicalObserverAttempts(observerAttempts).slice(
    0,
    MAX_INDUSTRY_OBSERVER_ATTEMPTS,
  );
  if (duplicateCommands(commandsValue)) throw new Error("duplicate industry command identity");
  if (duplicateCommitments(commitmentsValue))
    throw new Error("duplicate industry lab commitment identity");
  if (duplicateAttempts(attemptsValue)) throw new Error("duplicate industry lab attempt identity");
  if (duplicateMatureAttempts(matureAttemptsValue))
    throw new Error("duplicate industry mature attempt identity");
  if (duplicateMatureCommitments(matureCommitmentsValue))
    throw new Error("duplicate industry mature commitment identity");
  if (duplicateObserverAttempts(observerAttemptsValue))
    throw new Error("duplicate industry observer attempt identity");
  const compatible =
    owner.policySourceVersion === "" || owner.policySourceVersion === policySourceVersion;
  const nextCommands = compatible ? commandsValue : [];
  const nextCommitments = compatible ? commitmentsValue : [];
  const nextAttempts = compatible ? attemptsValue : [];
  const nextMatureAttempts = compatible ? matureAttemptsValue : [];
  const nextMatureCommitments = compatible ? matureCommitmentsValue : [];
  const nextObserverAttempts = compatible ? observerAttemptsValue : [];
  if (
    owner.policySourceVersion === policySourceVersion &&
    same(owner.commands, nextCommands) &&
    same(owner.labCommitments, nextCommitments) &&
    same(owner.labAttempts, nextAttempts) &&
    same(owner.matureAttempts, nextMatureAttempts) &&
    same(owner.matureCommitments, nextMatureCommitments) &&
    same(owner.observerAttempts, nextObserverAttempts)
  )
    return owner;
  return freeze({
    schemaVersion: INDUSTRY_OWNER_SCHEMA_VERSION,
    revision: owner.revision + 1,
    policySourceVersion,
    commands: nextCommands,
    labCommitments: nextCommitments,
    labAttempts: nextAttempts,
    matureAttempts: nextMatureAttempts,
    matureCommitments: nextMatureCommitments,
    observerAttempts: nextObserverAttempts,
  });
}

export function persistIndustryCommands(
  owner: IndustryOwnerV5,
  policySourceVersion: string,
  commands: readonly IndustryCommandState[],
): IndustryOwnerV5 {
  return persistIndustryOwner(
    owner,
    policySourceVersion,
    commands,
    owner.labCommitments,
    owner.labAttempts,
    owner.matureAttempts,
    owner.matureCommitments,
    owner.observerAttempts,
  );
}

function parseIndustryOwnerV4(value: unknown): IndustryOwnerV4 | null {
  if (
    !record(value) ||
    value.schemaVersion !== 4 ||
    !ownerBaseValid(value) ||
    !validCommitments(value.labCommitments) ||
    !validLabAttempts(value.labAttempts) ||
    !validMatureAttempts(value.matureAttempts)
  )
    return null;
  const commands = canonicalCommands(value.commands);
  const labCommitments = canonicalCommitments(value.labCommitments);
  const labAttempts = canonicalAttempts(value.labAttempts);
  const matureAttempts = canonicalMatureAttempts(value.matureAttempts);
  if (
    duplicateCommands(commands) ||
    duplicateCommitments(labCommitments) ||
    duplicateAttempts(labAttempts) ||
    duplicateMatureAttempts(matureAttempts)
  )
    return null;
  return freeze({
    schemaVersion: 4,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
    labCommitments,
    labAttempts,
    matureAttempts,
  });
}

function parseIndustryOwnerV3(value: unknown): IndustryOwnerV3 | null {
  if (
    !record(value) ||
    value.schemaVersion !== 3 ||
    !ownerBaseValid(value) ||
    !validCommitments(value.labCommitments) ||
    !validLabAttempts(value.labAttempts)
  )
    return null;
  const commands = canonicalCommands(value.commands);
  const labCommitments = canonicalCommitments(value.labCommitments);
  const labAttempts = canonicalAttempts(value.labAttempts);
  if (
    duplicateCommands(commands) ||
    duplicateCommitments(labCommitments) ||
    duplicateAttempts(labAttempts)
  )
    return null;
  return freeze({
    schemaVersion: 3,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
    labCommitments,
    labAttempts,
  });
}

function parseIndustryOwnerV2(value: unknown): IndustryOwnerV2 | null {
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    !ownerBaseValid(value) ||
    !validCommitments(value.labCommitments)
  )
    return null;
  const commands = canonicalCommands(value.commands);
  const labCommitments = canonicalCommitments(value.labCommitments);
  if (duplicateCommands(commands) || duplicateCommitments(labCommitments)) return null;
  return freeze({
    schemaVersion: 2,
    revision: value.revision,
    policySourceVersion: value.policySourceVersion,
    commands,
    labCommitments,
  });
}
function parseIndustryOwnerV1(value: unknown): IndustryOwnerV1 | null {
  if (!record(value) || value.schemaVersion !== 1 || !ownerBaseValid(value)) return null;
  const commands = canonicalCommands(value.commands);
  if (duplicateCommands(commands)) return null;
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
function validCommitments(value: unknown): value is readonly LabPolicyCommitment[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDUSTRY_LAB_COMMITMENTS &&
    value.every(isLabPolicyCommitment)
  );
}
function validLabAttempts(value: unknown): value is readonly PendingLabAttempt[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDUSTRY_LAB_ATTEMPTS &&
    value.every(isPendingLabAttempt)
  );
}
function validMatureAttempts(value: unknown): value is readonly PendingMatureAttempt[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDUSTRY_MATURE_ATTEMPTS &&
    value.every(isPendingMatureAttempt)
  );
}
function validMatureCommitments(value: unknown): value is readonly MaturePolicyCommitment[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDUSTRY_MATURE_COMMITMENTS &&
    value.every(isMaturePolicyCommitment)
  );
}
function validObserverAttempts(value: unknown): value is readonly PendingObserverAttempt[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDUSTRY_OBSERVER_ATTEMPTS &&
    value.every(isPendingObserverAttempt)
  );
}
function canonicalCommands(values: readonly IndustryCommandState[]): IndustryCommandState[] {
  return [...values]
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((value) => freeze({ ...value }));
}
function canonicalCommitments(values: readonly LabPolicyCommitment[]): LabPolicyCommitment[] {
  return [...values]
    .sort(
      (a, b) =>
        a.colonyId.localeCompare(b.colonyId) ||
        a.objectiveId.localeCompare(b.objectiveId) ||
        a.objectiveRevision - b.objectiveRevision,
    )
    .map((value) =>
      value.kind === "reaction"
        ? freeze({ ...value, reagents: freeze([...value.reagents] as [string, string]) })
        : freeze({ ...value }),
    );
}
function canonicalAttempts(values: readonly PendingLabAttempt[]): PendingLabAttempt[] {
  return [...values]
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
    .map((value) =>
      value.kind === "reaction"
        ? freeze({
            ...value,
            reagentLabIds: freeze([...value.reagentLabIds] as [string, string]),
            reagentMineralsBefore: freeze([...value.reagentMineralsBefore] as [number, number]),
            reagents: freeze([...value.reagents] as [string, string]),
          })
        : freeze({ ...value }),
    );
}
function canonicalMatureAttempts(values: readonly PendingMatureAttempt[]): PendingMatureAttempt[] {
  return [...values]
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
    .map((value) =>
      value.kind === "factory"
        ? freeze({
            ...value,
            components: freeze(value.components.map((component) => freeze({ ...component }))),
            resourcesBefore: freeze(
              value.resourcesBefore.map((resource) => freeze({ ...resource })),
            ),
          })
        : freeze({ ...value }),
    );
}
function canonicalMatureCommitments(
  values: readonly MaturePolicyCommitment[],
): MaturePolicyCommitment[] {
  return [...values]
    .sort(
      (a, b) =>
        a.objective.id.localeCompare(b.objective.id) || a.objective.revision - b.objective.revision,
    )
    .map((value) => freeze({ ...value, objective: freeze({ ...value.objective }) }));
}
function canonicalObserverAttempts(
  values: readonly PendingObserverAttempt[],
): PendingObserverAttempt[] {
  return [...values]
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
    .map((value) => freeze({ ...value }));
}
function duplicateCommands(values: readonly IndustryCommandState[]): boolean {
  return new Set(values.map(({ identity }) => identity)).size !== values.length;
}
function duplicateCommitments(values: readonly LabPolicyCommitment[]): boolean {
  return (
    new Set(
      values.map(
        ({ colonyId, objectiveId, objectiveRevision }) =>
          `${colonyId}\u0000${objectiveId}\u0000${String(objectiveRevision)}`,
      ),
    ).size !== values.length
  );
}
function duplicateAttempts(values: readonly PendingLabAttempt[]): boolean {
  return new Set(values.map(({ attemptId }) => attemptId)).size !== values.length;
}
function duplicateMatureAttempts(values: readonly PendingMatureAttempt[]): boolean {
  return new Set(values.map(({ attemptId }) => attemptId)).size !== values.length;
}
function duplicateMatureCommitments(values: readonly MaturePolicyCommitment[]): boolean {
  return (
    new Set(values.map(({ objective }) => `${objective.id}\u0000${String(objective.revision)}`))
      .size !== values.length
  );
}
function duplicateObserverAttempts(values: readonly PendingObserverAttempt[]): boolean {
  return (
    new Set(values.map(({ attemptId }) => attemptId)).size !== values.length ||
    new Set(
      values.map(
        ({ requestId, requestRevision }) => `${requestId}\u0000${String(requestRevision)}`,
      ),
    ).size !== values.length
  );
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
