import {
  LAYOUT_ALGORITHM_REVISION,
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_OWNER_SCHEMA_VERSION,
  MAX_LAYOUT_BLOCKERS,
  MAX_LAYOUT_EXTENSION_ENERGY,
  MAX_LAYOUT_RECORDS,
  type ConstructionSiteAttemptReceipt,
  type LayoutCommitment,
  type LayoutExtensionEvacuation,
  type LayoutRecord,
  type LayoutPlacement,
  type LayoutsOwnerV1,
} from "./contracts";
import { normalizeConstructionSiteReceipts } from "./construction-site-arbiter";

export function emptyLayoutsOwner(): LayoutsOwnerV1 {
  return freeze({ schemaVersion: LAYOUT_OWNER_SCHEMA_VERSION, revision: 0, records: [] });
}
export function parseLayoutsOwner(value: unknown): LayoutsOwnerV1 | null {
  if (
    !record(value) ||
    value.schemaVersion !== LAYOUT_OWNER_SCHEMA_VERSION ||
    !integer(value.revision) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_LAYOUT_RECORDS
  )
    return null;
  const records: LayoutRecord[] = [];
  let staleRecords = 0;
  for (const item of value.records) {
    if (staleRecord(item)) {
      staleRecords += 1;
      continue;
    }
    if (!validRecord(item)) return null;
    records.push(item);
  }
  records.sort((a, b) => compare(a.roomName, b.roomName));
  if (new Set(records.map((r) => r.roomName)).size !== records.length) return null;
  return freeze({
    schemaVersion: LAYOUT_OWNER_SCHEMA_VERSION,
    revision: value.revision + (staleRecords > 0 ? 1 : 0),
    records,
  });
}
export function persistLayoutCommitment(
  owner: LayoutsOwnerV1,
  roomName: string,
  commitment: LayoutCommitment,
  placements: readonly LayoutPlacement[] = [],
): LayoutsOwnerV1 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  const records = owner.records.filter((r) => r.roomName !== roomName);
  const sourceServices = placements.filter(
    (placement) => placement.service?.kind === "source-container",
  );
  const sameCommitment = prior?.fingerprint === commitment.fingerprint;
  records.push({
    roomName,
    ...commitment,
    ...(sameCommitment && prior.extensionEvacuation !== undefined
      ? { extensionEvacuation: prior.extensionEvacuation }
      : {}),
    ...(sourceServices.length === 0
      ? sameCommitment && prior.sourceServices !== undefined
        ? { sourceServices: prior.sourceServices }
        : {}
      : { sourceServices }),
    ...(sameCommitment && prior.siteReceipts !== undefined
      ? { siteReceipts: prior.siteReceipts }
      : {}),
  });
  records.sort((a, b) => compare(a.roomName, b.roomName));
  return freeze({
    schemaVersion: LAYOUT_OWNER_SCHEMA_VERSION,
    revision: owner.revision + 1,
    records: records.slice(0, MAX_LAYOUT_RECORDS),
  });
}
export function persistLayoutExtensionEvacuation(
  owner: LayoutsOwnerV1,
  roomName: string,
  evacuation: LayoutExtensionEvacuation | null,
): LayoutsOwnerV1 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  if (prior === undefined) return owner;
  if (
    (evacuation === null && prior.extensionEvacuation === undefined) ||
    (evacuation !== null &&
      JSON.stringify(evacuation) === JSON.stringify(prior.extensionEvacuation))
  )
    return owner;
  const records = owner.records.map((record) => {
    if (record.roomName !== roomName) return record;
    if (evacuation === null) {
      const { extensionEvacuation, ...retained } = record;
      return extensionEvacuation === undefined ? record : retained;
    }
    return { ...record, extensionEvacuation: evacuation };
  });
  return freeze({ ...owner, records, revision: owner.revision + 1 });
}

export function freshSourceServicePlacements(
  owner: LayoutsOwnerV1,
  roomName: string,
): readonly LayoutPlacement[] {
  const record = owner.records.find((item) => item.roomName === roomName);
  if (record?.algorithmRevision !== LAYOUT_ALGORITHM_REVISION) return Object.freeze([]);
  return Object.freeze(
    [...(record.sourceServices ?? [])]
      .filter((placement) => placement.service?.kind === "source-container")
      .sort(
        (a, b) =>
          (a.service?.sourceId ?? "").localeCompare(b.service?.sourceId ?? "") ||
          a.pos.y - b.pos.y ||
          a.pos.x - b.pos.x,
      ),
  );
}
export function reconcileOwnedLayouts(
  owner: LayoutsOwnerV1,
  ownedRoomNames: readonly string[],
): LayoutsOwnerV1 {
  const owned = new Set(ownedRoomNames);
  const records = owner.records.filter((r) => owned.has(r.roomName));
  return records.length === owner.records.length
    ? owner
    : freeze({ ...owner, revision: owner.revision + 1, records });
}
export function persistConstructionSiteReceipt(
  owner: LayoutsOwnerV1,
  roomName: string,
  receipt: ConstructionSiteAttemptReceipt,
): LayoutsOwnerV1 {
  const records = owner.records.map((item) =>
    item.roomName === roomName
      ? {
          ...item,
          siteReceipts: normalizeConstructionSiteReceipts([...(item.siteReceipts ?? []), receipt]),
        }
      : item,
  );
  return records.some((item, index) => item !== owner.records[index])
    ? freeze({ ...owner, revision: owner.revision + 1, records })
    : owner;
}
function validRecord(v: unknown): v is LayoutRecord {
  return (
    record(v) &&
    v.algorithmRevision === LAYOUT_ALGORITHM_REVISION &&
    typeof v.roomName === "string" &&
    v.roomName.length > 0 &&
    v.roomName.length <= 16 &&
    record(v.anchor) &&
    v.anchor.roomName === v.roomName &&
    coordinate(v.anchor.x) &&
    coordinate(v.anchor.y) &&
    integer(v.committedAt) &&
    typeof v.fingerprint === "string" &&
    v.fingerprint.length <= 128 &&
    integer(v.transform) &&
    v.transform <= 7 &&
    Array.isArray(v.blockers) &&
    v.blockers.length <= MAX_LAYOUT_BLOCKERS &&
    v.blockers.every((b) => typeof b === "string" && b.length <= 32) &&
    (v.extensionEvacuation === undefined || validExtensionEvacuation(v.extensionEvacuation)) &&
    (v.serviceBlockers === undefined || validServiceBlockers(v.serviceBlockers, v.roomName)) &&
    (v.sourceServices === undefined || validSourceServices(v.sourceServices, v.roomName)) &&
    (v.siteReceipts === undefined || validReceipts(v.siteReceipts, v.roomName))
  );
}
function validExtensionEvacuation(value: unknown): value is LayoutExtensionEvacuation {
  return (
    record(value) &&
    positiveInteger(value.amount) &&
    value.amount <= MAX_LAYOUT_EXTENSION_ENERGY &&
    integer(value.startedAt) &&
    integer(value.expiresAt) &&
    value.expiresAt - value.startedAt === LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS &&
    integer(value.replacementInitialEnergy) &&
    value.replacementInitialEnergy + value.amount <= MAX_LAYOUT_EXTENSION_ENERGY &&
    identity(value.sourceId, 128) &&
    identity(value.replacementId, 128) &&
    value.sourceId !== value.replacementId
  );
}
function validSourceServices(value: unknown, roomName: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (item) =>
        record(item) &&
        item.structureType === "container" &&
        item.layer === "primary" &&
        ["planned", "exact", "matching-site", "compatible-external"].includes(
          String(item.adoption),
        ) &&
        integer(item.minimumRcl) &&
        record(item.pos) &&
        item.pos.roomName === roomName &&
        coordinate(item.pos.x) &&
        coordinate(item.pos.y) &&
        record(item.service) &&
        item.service.kind === "source-container" &&
        typeof item.service.sourceId === "string" &&
        item.service.sourceId.length > 0 &&
        item.service.sourceId.length <= 128,
    )
  );
}
function staleRecord(v: unknown): boolean {
  return (
    record(v) &&
    typeof v.algorithmRevision === "string" &&
    v.algorithmRevision !== LAYOUT_ALGORITHM_REVISION &&
    v.algorithmRevision.length <= 128 &&
    typeof v.roomName === "string" &&
    record(v.anchor) &&
    v.anchor.roomName === v.roomName &&
    coordinate(v.anchor.x) &&
    coordinate(v.anchor.y) &&
    integer(v.committedAt) &&
    typeof v.fingerprint === "string" &&
    integer(v.transform) &&
    v.transform <= 7 &&
    Array.isArray(v.blockers)
  );
}
function validServiceBlockers(value: unknown, roomName: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAYOUT_BLOCKERS &&
    value.every(
      (item) =>
        record(item) &&
        item.kind === "source-container" &&
        typeof item.sourceId === "string" &&
        item.sourceId.length > 0 &&
        item.sourceId.length <= 128 &&
        ["missing-source-id", "no-legal-position"].includes(String(item.reason)) &&
        record(item.pos) &&
        item.pos.roomName === roomName &&
        coordinate(item.pos.x) &&
        coordinate(item.pos.y),
    )
  );
}
function validReceipts(
  value: unknown,
  roomName: unknown,
): value is readonly ConstructionSiteAttemptReceipt[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every(
    (item) =>
      record(item) &&
      item.roomName === roomName &&
      typeof item.proposalId === "string" &&
      item.proposalId.length <= 256 &&
      [
        "OK",
        "ERR_FULL",
        "ERR_RCL_NOT_ENOUGH",
        "ERR_INVALID_TARGET",
        "ERR_INVALID_ARGS",
        "ERR_NOT_OWNER",
        "UNEXPECTED",
      ].includes(String(item.code)) &&
      integer(item.attempt) &&
      item.attempt <= 16 &&
      integer(item.nextEligibleTick) &&
      integer(item.observedAt) &&
      typeof item.layoutFingerprint === "string" &&
      item.layoutFingerprint.length <= 128 &&
      typeof item.observationFingerprint === "string" &&
      item.observationFingerprint.length <= 128 &&
      typeof item.policyFingerprint === "string" &&
      item.policyFingerprint.length <= 128,
  );
}
function record(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function positiveInteger(v: unknown): v is number {
  return integer(v) && v > 0;
}
function identity(v: unknown, maximumLength: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maximumLength;
}
function coordinate(v: unknown): v is number {
  return integer(v) && v < 50;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v)) freeze(child);
    Object.freeze(v);
  }
  return v;
}
