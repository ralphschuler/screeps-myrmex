import {
  SEGMENT_MANAGER_LIMITS,
  SEGMENT_OWNER_SCHEMA_VERSION,
  SEGMENT_PRIORITIES,
  type SegmentGenerationRef,
  type SegmentManifestEntry,
  type SegmentOwnerStateV1,
  type SegmentPendingGeneration,
  type SegmentPriority,
  type SegmentQuarantineEntry,
  type SegmentQuarantineReason,
} from "./contracts";

export type SegmentOwnerOpenResult =
  | {
      readonly owner: SegmentOwnerStateV1;
      readonly status: "ready" | "initialized" | "recovered";
    }
  | { readonly foundSchemaVersion: number; readonly status: "unsupported" };

export function emptySegmentOwner(recoveryCount = 0): SegmentOwnerStateV1 {
  return freezeOwner({
    schemaVersion: SEGMENT_OWNER_SCHEMA_VERSION,
    revision: 0,
    recoveryCount,
    entries: [],
    quarantine: [],
  });
}

export function openSegmentOwner(value: unknown, tick: number): SegmentOwnerOpenResult {
  validateTick(tick);
  if (isExactEmptyRecord(value)) {
    return { owner: emptySegmentOwner(), status: "initialized" };
  }
  if (
    record(value) &&
    Number.isSafeInteger(value.schemaVersion) &&
    typeof value.schemaVersion === "number" &&
    value.schemaVersion > SEGMENT_OWNER_SCHEMA_VERSION
  ) {
    return { foundSchemaVersion: value.schemaVersion, status: "unsupported" };
  }
  const parsed = parseSegmentOwner(value, tick);
  if (parsed !== null) return { owner: parsed, status: "ready" };
  return {
    owner: emptySegmentOwner(recoveryCountFromMalformed(value)),
    status: "recovered",
  };
}

export function parseSegmentOwner(value: unknown, tick: number): SegmentOwnerStateV1 | null {
  validateTick(tick);
  if (
    !record(value) ||
    !exactKeys(value, ["entries", "quarantine", "recoveryCount", "revision", "schemaVersion"]) ||
    value.schemaVersion !== SEGMENT_OWNER_SCHEMA_VERSION ||
    !nonNegativeSafeInteger(value.revision) ||
    !nonNegativeSafeInteger(value.recoveryCount) ||
    !Array.isArray(value.entries) ||
    value.entries.length > SEGMENT_MANAGER_LIMITS.maximumEntries ||
    !Array.isArray(value.quarantine) ||
    value.quarantine.length > SEGMENT_MANAGER_LIMITS.maximumQuarantineEntries
  ) {
    return null;
  }

  const entries: SegmentManifestEntry[] = [];
  for (const candidate of value.entries) {
    const entry = parseEntry(candidate, tick);
    if (entry === null) return null;
    entries.push(entry);
  }
  entries.sort(compareEntries);
  if (hasDuplicate(entries, (entry) => logicalIdentity(entry.storeId, entry.key))) return null;

  const quarantine: SegmentQuarantineEntry[] = [];
  for (const candidate of value.quarantine) {
    const item = parseQuarantine(candidate, tick);
    if (item === null) return null;
    quarantine.push(item);
  }
  quarantine.sort(compareQuarantine);
  if (hasDuplicate(quarantine, (item) => String(item.segmentId))) return null;

  const physicalIds = new Set<number>();
  for (const entry of entries) {
    for (const reference of [entry.current, entry.previous, entry.pending]) {
      if (reference === null) continue;
      if (physicalIds.has(reference.segmentId)) return null;
      physicalIds.add(reference.segmentId);
    }
  }
  for (const item of quarantine) {
    if (physicalIds.has(item.segmentId)) return null;
    physicalIds.add(item.segmentId);
  }

  const owner = freezeOwner({
    schemaVersion: SEGMENT_OWNER_SCHEMA_VERSION,
    revision: value.revision,
    recoveryCount: value.recoveryCount,
    entries,
    quarantine,
  });
  return JSON.stringify(owner).length <= SEGMENT_MANAGER_LIMITS.maximumManifestCodeUnits
    ? owner
    : null;
}

export function freezeOwner(owner: SegmentOwnerStateV1): SegmentOwnerStateV1 {
  return Object.freeze({
    schemaVersion: SEGMENT_OWNER_SCHEMA_VERSION,
    revision: owner.revision,
    recoveryCount: owner.recoveryCount,
    entries: Object.freeze(
      [...owner.entries].sort(compareEntries).map((entry) =>
        Object.freeze({
          storeId: entry.storeId,
          key: entry.key,
          priority: entry.priority,
          lastAccessTick: entry.lastAccessTick,
          current: freezeReference(entry.current),
          previous: freezeReference(entry.previous),
          pending: freezePending(entry.pending),
        }),
      ),
    ),
    quarantine: Object.freeze(
      [...owner.quarantine].sort(compareQuarantine).map((item) => Object.freeze({ ...item })),
    ),
  });
}

function parseEntry(value: unknown, tick: number): SegmentManifestEntry | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "current",
      "key",
      "lastAccessTick",
      "pending",
      "previous",
      "priority",
      "storeId",
    ]) ||
    !boundedString(value.storeId, SEGMENT_MANAGER_LIMITS.maximumStoreIdCodeUnits) ||
    !boundedString(value.key, SEGMENT_MANAGER_LIMITS.maximumKeyCodeUnits, true) ||
    !priority(value.priority) ||
    !nonNegativeSafeInteger(value.lastAccessTick) ||
    value.lastAccessTick > tick
  ) {
    return null;
  }
  const current = value.current === null ? null : parseReference(value.current, tick);
  const previous = value.previous === null ? null : parseReference(value.previous, tick);
  const pending = value.pending === null ? null : parsePending(value.pending, tick);
  if (
    (value.current !== null && current === null) ||
    (value.previous !== null && previous === null) ||
    (value.pending !== null && pending === null)
  ) {
    return null;
  }
  if (current !== null && previous !== null && previous.generation >= current.generation)
    return null;
  if (pending !== null && current !== null && pending.generation <= current.generation) return null;
  if (pending !== null && previous !== null && pending.generation <= previous.generation)
    return null;
  return Object.freeze({
    storeId: value.storeId,
    key: value.key,
    priority: value.priority,
    lastAccessTick: value.lastAccessTick,
    current,
    previous,
    pending,
  });
}

function parseReference(value: unknown, tick: number): SegmentGenerationRef | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "checksum",
      "generation",
      "schemaVersion",
      "segmentId",
      "size",
      "writtenAtTick",
    ]) ||
    !segmentId(value.segmentId) ||
    !positiveSafeInteger(value.schemaVersion) ||
    !positiveSafeInteger(value.generation) ||
    !checksum(value.checksum) ||
    !positiveSafeInteger(value.size) ||
    value.size > SEGMENT_MANAGER_LIMITS.maximumSegmentCodeUnits ||
    !nonNegativeSafeInteger(value.writtenAtTick) ||
    value.writtenAtTick > tick
  ) {
    return null;
  }
  return Object.freeze({
    segmentId: value.segmentId,
    schemaVersion: value.schemaVersion,
    generation: value.generation,
    checksum: value.checksum,
    size: value.size,
    writtenAtTick: value.writtenAtTick,
  });
}

function parsePending(value: unknown, tick: number): SegmentPendingGeneration | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "checksum",
      "createdAtTick",
      "generation",
      "schemaVersion",
      "segmentId",
      "size",
      "state",
      "writtenAtTick",
    ]) ||
    (value.state !== "allocated" && value.state !== "written") ||
    !nonNegativeSafeInteger(value.createdAtTick) ||
    value.createdAtTick > tick
  ) {
    return null;
  }
  const reference = parseReference(
    {
      segmentId: value.segmentId,
      schemaVersion: value.schemaVersion,
      generation: value.generation,
      checksum: value.checksum,
      size: value.size,
      writtenAtTick: value.writtenAtTick,
    },
    tick,
  );
  if (reference === null || value.createdAtTick > reference.writtenAtTick) return null;
  return Object.freeze({ ...reference, state: value.state, createdAtTick: value.createdAtTick });
}

function parseQuarantine(value: unknown, tick: number): SegmentQuarantineEntry | null {
  if (
    !record(value) ||
    !exactKeys(value, ["quarantinedAtTick", "reason", "retryAtTick", "segmentId"]) ||
    !segmentId(value.segmentId) ||
    !nonNegativeSafeInteger(value.quarantinedAtTick) ||
    value.quarantinedAtTick > tick ||
    !nonNegativeSafeInteger(value.retryAtTick) ||
    value.retryAtTick !== value.quarantinedAtTick + SEGMENT_MANAGER_LIMITS.quarantineTicks ||
    !quarantineReason(value.reason)
  ) {
    return null;
  }
  return Object.freeze({
    segmentId: value.segmentId,
    quarantinedAtTick: value.quarantinedAtTick,
    retryAtTick: value.retryAtTick,
    reason: value.reason,
  });
}

function freezeReference(value: SegmentGenerationRef | null): SegmentGenerationRef | null {
  return value === null ? null : Object.freeze({ ...value });
}

function freezePending(value: SegmentPendingGeneration | null): SegmentPendingGeneration | null {
  return value === null ? null : Object.freeze({ ...value });
}

function recoveryCountFromMalformed(value: unknown): number {
  if (!record(value) || !nonNegativeSafeInteger(value.recoveryCount)) return 1;
  return value.recoveryCount < Number.MAX_SAFE_INTEGER
    ? value.recoveryCount + 1
    : value.recoveryCount;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareStrings);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactEmptyRecord(value: unknown): boolean {
  return record(value) && Object.keys(value).length === 0;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    value === value.trim()
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function segmentId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= 99;
}

function checksum(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}$/u.test(value);
}

function priority(value: unknown): value is SegmentPriority {
  return SEGMENT_PRIORITIES.includes(value as SegmentPriority);
}

function quarantineReason(value: unknown): value is SegmentQuarantineReason {
  return ["checksum", "envelope", "pending-timeout", "schema"].includes(String(value));
}

function hasDuplicate<Value>(values: readonly Value[], keyOf: (value: Value) => string): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function logicalIdentity(storeId: string, key: string): string {
  return `${String(storeId.length)}:${storeId}${key}`;
}

function compareEntries(left: SegmentManifestEntry, right: SegmentManifestEntry): number {
  return compareStrings(left.storeId, right.storeId) || compareStrings(left.key, right.key);
}

function compareQuarantine(left: SegmentQuarantineEntry, right: SegmentQuarantineEntry): number {
  return (
    left.retryAtTick - right.retryAtTick ||
    left.segmentId - right.segmentId ||
    compareStrings(left.reason, right.reason)
  );
}

function validateTick(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Segment owner tick must be a non-negative safe integer");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
