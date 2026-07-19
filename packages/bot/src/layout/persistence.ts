import {
  LAYOUT_ALGORITHM_REVISION,
  LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_LINK_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_OWNER_SCHEMA_VERSION,
  LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_BLOCKERS,
  MAX_LAYOUT_CONTAINER_ENERGY,
  MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES,
  MAX_LAYOUT_EXTENSION_ENERGY,
  MAX_LAYOUT_LINK_ENERGY,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_TOWER_ENERGY,
  MINIMUM_OPERATIONAL_TOWER_ENERGY,
  type ConstructionSiteAttemptReceipt,
  type LayoutCommitment,
  type LayoutContainerMigration,
  type LayoutExtensionEvacuation,
  type LayoutLinkEvacuation,
  type LayoutRecord,
  type LayoutPlacement,
  type LayoutStructureRemovalReceipt,
  type LayoutTowerEvacuation,
  type LayoutsOwnerV9,
} from "./contracts";
import { normalizeConstructionSiteReceipts } from "./construction-site-arbiter";

export function emptyLayoutsOwner(): LayoutsOwnerV9 {
  return freeze({ schemaVersion: LAYOUT_OWNER_SCHEMA_VERSION, revision: 0, records: [] });
}
export function parseLayoutsOwner(value: unknown): LayoutsOwnerV9 | null {
  if (
    !record(value) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4 &&
      value.schemaVersion !== 5 &&
      value.schemaVersion !== 6 &&
      value.schemaVersion !== 7 &&
      value.schemaVersion !== 8 &&
      value.schemaVersion !== LAYOUT_OWNER_SCHEMA_VERSION) ||
    !integer(value.revision) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_LAYOUT_RECORDS
  )
    return null;
  const records: LayoutRecord[] = [];
  let staleRecords = 0;
  const migratingV1 = value.schemaVersion === 1;
  const migratingBeforeV3 = value.schemaVersion === 1 || value.schemaVersion === 2;
  const migratingBeforeV4 = value.schemaVersion < 4;
  const migratingBeforeV5 = value.schemaVersion < 5;
  const migratingBeforeV6 = value.schemaVersion < 6;
  const migratingBeforeV7 = value.schemaVersion < 7;
  const migratingBeforeV8 = value.schemaVersion < 8;
  const migratingBeforeV9 = value.schemaVersion < LAYOUT_OWNER_SCHEMA_VERSION;
  for (const rawItem of value.records) {
    if (record(rawItem) && record(rawItem.containerMigration)) {
      if (migratingV1 && rawItem.containerMigration.resourceManifest !== undefined) return null;
      if (
        migratingBeforeV3 &&
        (rawItem.containerMigration.sourceId !== undefined ||
          rawItem.containerMigration.removalReceipt !== undefined)
      )
        return null;
      if (!migratingBeforeV5 && rawItem.containerMigration.removalReceipt !== undefined)
        return null;
    }
    if (migratingBeforeV5 && record(rawItem) && rawItem.removalReceipt !== undefined) return null;
    if (migratingBeforeV7 && record(rawItem) && rawItem.towerEvacuation !== undefined) return null;
    if (migratingBeforeV9 && record(rawItem) && rawItem.linkEvacuation !== undefined) return null;
    if (
      migratingBeforeV8 &&
      record(rawItem) &&
      record(rawItem.removalReceipt) &&
      rawItem.removalReceipt.targetStructureType === "link"
    )
      return null;
    if (
      migratingBeforeV6 &&
      record(rawItem) &&
      record(rawItem.removalReceipt) &&
      rawItem.removalReceipt.targetStructureType === "tower"
    )
      return null;
    if (
      migratingBeforeV4 &&
      record(rawItem) &&
      Array.isArray(rawItem.sourceServices) &&
      rawItem.sourceServices.some(
        (placement) =>
          record(placement) &&
          record(placement.service) &&
          placement.service.issuerSequence !== undefined,
      )
    )
      return null;
    const item = migrateRemovalReceipt(rawItem, migratingBeforeV5);
    if (item === null) return null;
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
    revision: value.revision + (staleRecords > 0 ? 1 : 0) + (migratingBeforeV9 ? 1 : 0),
    records,
  });
}

function migrateRemovalReceipt(value: unknown, migrating: boolean): unknown {
  if (!migrating || !record(value) || !record(value.containerMigration)) return value;
  const nested = value.containerMigration.removalReceipt;
  if (nested === undefined) return value;
  if (!identity(value.containerMigration.sourceId, 128) || !validLegacyRemovalReceipt(nested))
    return null;
  const { removalReceipt: _receipt, ...containerMigration } = value.containerMigration;
  void _receipt;
  return {
    ...value,
    containerMigration,
    removalReceipt: {
      ...nested,
      replacementId: containerMigration.replacementId,
      targetId: containerMigration.targetId,
      targetStructureType: "container",
    },
  };
}
export function persistLayoutCommitment(
  owner: LayoutsOwnerV9,
  roomName: string,
  commitment: LayoutCommitment,
  placements: readonly LayoutPlacement[] = [],
): LayoutsOwnerV9 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  const records = owner.records.filter((r) => r.roomName !== roomName);
  const sourceServices = placements.filter(
    (placement) => placement.service?.kind === "source-container",
  );
  const sameCommitment = prior?.fingerprint === commitment.fingerprint;
  records.push({
    roomName,
    ...commitment,
    ...(sameCommitment && prior.containerMigration !== undefined
      ? { containerMigration: prior.containerMigration }
      : {}),
    ...(sameCommitment && prior.extensionEvacuation !== undefined
      ? { extensionEvacuation: prior.extensionEvacuation }
      : {}),
    ...(sameCommitment && prior.linkEvacuation !== undefined
      ? { linkEvacuation: prior.linkEvacuation }
      : {}),
    ...(sameCommitment && prior.towerEvacuation !== undefined
      ? { towerEvacuation: prior.towerEvacuation }
      : {}),
    ...(sameCommitment && prior.removalReceipt !== undefined
      ? { removalReceipt: prior.removalReceipt }
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
export function persistLayoutContainerMigration(
  owner: LayoutsOwnerV9,
  roomName: string,
  migration: LayoutContainerMigration | null,
): LayoutsOwnerV9 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  if (prior === undefined) return owner;
  if (
    (migration === null && prior.containerMigration === undefined) ||
    (migration !== null && JSON.stringify(migration) === JSON.stringify(prior.containerMigration))
  )
    return owner;
  const records = owner.records.map((record) => {
    if (record.roomName !== roomName) return record;
    if (migration === null) {
      const { containerMigration, ...retained } = record;
      return containerMigration === undefined ? record : retained;
    }
    return { ...record, containerMigration: migration };
  });
  return freeze({ ...owner, records, revision: owner.revision + 1 });
}

export function persistLayoutExtensionEvacuation(
  owner: LayoutsOwnerV9,
  roomName: string,
  evacuation: LayoutExtensionEvacuation | null,
): LayoutsOwnerV9 {
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

export function persistLayoutLinkEvacuation(
  owner: LayoutsOwnerV9,
  roomName: string,
  evacuation: LayoutLinkEvacuation | null,
): LayoutsOwnerV9 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  if (prior === undefined) return owner;
  if (
    (evacuation === null && prior.linkEvacuation === undefined) ||
    (evacuation !== null && JSON.stringify(evacuation) === JSON.stringify(prior.linkEvacuation))
  )
    return owner;
  const records = owner.records.map((record) => {
    if (record.roomName !== roomName) return record;
    if (evacuation === null) {
      const { linkEvacuation, ...retained } = record;
      return linkEvacuation === undefined ? record : retained;
    }
    return { ...record, linkEvacuation: evacuation };
  });
  return freeze({ ...owner, records, revision: owner.revision + 1 });
}

export function persistLayoutTowerEvacuation(
  owner: LayoutsOwnerV9,
  roomName: string,
  evacuation: LayoutTowerEvacuation | null,
): LayoutsOwnerV9 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  if (prior === undefined) return owner;
  if (
    (evacuation === null && prior.towerEvacuation === undefined) ||
    (evacuation !== null && JSON.stringify(evacuation) === JSON.stringify(prior.towerEvacuation))
  )
    return owner;
  const records = owner.records.map((record) => {
    if (record.roomName !== roomName) return record;
    if (evacuation === null) {
      const { towerEvacuation, ...retained } = record;
      return towerEvacuation === undefined ? record : retained;
    }
    return { ...record, towerEvacuation: evacuation };
  });
  return freeze({ ...owner, records, revision: owner.revision + 1 });
}

export function persistLayoutRemovalReceipt(
  owner: LayoutsOwnerV9,
  roomName: string,
  receipt: LayoutStructureRemovalReceipt | null,
): LayoutsOwnerV9 {
  const prior = owner.records.find((record) => record.roomName === roomName);
  if (prior === undefined) return owner;
  if (
    (receipt === null && prior.removalReceipt === undefined) ||
    (receipt !== null && JSON.stringify(receipt) === JSON.stringify(prior.removalReceipt))
  )
    return owner;
  const records = owner.records.map((record) => {
    if (record.roomName !== roomName) return record;
    if (receipt === null) {
      const { removalReceipt, ...retained } = record;
      return removalReceipt === undefined ? record : retained;
    }
    return { ...record, removalReceipt: receipt };
  });
  return freeze({ ...owner, records, revision: owner.revision + 1 });
}

export function freshSourceServicePlacements(
  owner: LayoutsOwnerV9,
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
  owner: LayoutsOwnerV9,
  ownedRoomNames: readonly string[],
): LayoutsOwnerV9 {
  const owned = new Set(ownedRoomNames);
  const records = owner.records.filter((r) => owned.has(r.roomName));
  return records.length === owner.records.length
    ? owner
    : freeze({ ...owner, revision: owner.revision + 1, records });
}
export function persistConstructionSiteReceipt(
  owner: LayoutsOwnerV9,
  roomName: string,
  receipt: ConstructionSiteAttemptReceipt,
): LayoutsOwnerV9 {
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
    (v.containerMigration === undefined || validContainerMigration(v.containerMigration)) &&
    (v.extensionEvacuation === undefined || validExtensionEvacuation(v.extensionEvacuation)) &&
    (v.linkEvacuation === undefined || validLinkEvacuation(v.linkEvacuation)) &&
    (v.towerEvacuation === undefined || validTowerEvacuation(v.towerEvacuation)) &&
    (v.removalReceipt === undefined || validRemovalReceipt(v.removalReceipt)) &&
    (v.serviceBlockers === undefined || validServiceBlockers(v.serviceBlockers, v.roomName)) &&
    (v.sourceServices === undefined || validSourceServices(v.sourceServices, v.roomName)) &&
    (v.siteReceipts === undefined || validReceipts(v.siteReceipts, v.roomName))
  );
}
function validContainerMigration(value: unknown): value is LayoutContainerMigration {
  if (
    !record(value) ||
    !integer(value.startedAt) ||
    !integer(value.expiresAt) ||
    value.expiresAt - value.startedAt !== LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS ||
    !identity(value.targetId, 128) ||
    !identity(value.replacementId, 128) ||
    value.targetId === value.replacementId ||
    value.removalReceipt !== undefined ||
    (value.sourceId !== undefined && !identity(value.sourceId, 128))
  )
    return false;
  const hasEnergyAmount = value.energyAmount !== undefined;
  const hasReplacementBaseline = value.replacementInitialEnergy !== undefined;
  const hasResourceManifest = value.resourceManifest !== undefined;
  if (hasEnergyAmount !== hasReplacementBaseline || (hasEnergyAmount && hasResourceManifest))
    return false;
  const validTerms = hasResourceManifest
    ? validContainerResourceManifest(value.resourceManifest)
    : !hasEnergyAmount ||
      (positiveInteger(value.energyAmount) &&
        value.energyAmount <= MAX_LAYOUT_CONTAINER_ENERGY &&
        integer(value.replacementInitialEnergy) &&
        value.replacementInitialEnergy + value.energyAmount <= MAX_LAYOUT_CONTAINER_ENERGY);
  return validTerms;
}
function validLegacyRemovalReceipt(value: unknown): boolean {
  return (
    record(value) &&
    positiveInteger(value.attempt) &&
    value.attempt <= 3 &&
    [
      "OK",
      "ERR_NOT_OWNER",
      "ERR_BUSY",
      "TARGET_ABSENT",
      "ERR_INVALID_TARGET",
      "UNEXPECTED",
    ].includes(String(value.code)) &&
    integer(value.observedAt) &&
    integer(value.nextEligibleTick) &&
    value.nextEligibleTick > value.observedAt
  );
}
function validRemovalReceipt(value: unknown): value is LayoutStructureRemovalReceipt {
  return (
    validLegacyRemovalReceipt(value) &&
    record(value) &&
    identity(value.targetId, 128) &&
    identity(value.replacementId, 128) &&
    value.targetId !== value.replacementId &&
    ["container", "extension", "link", "tower"].includes(String(value.targetStructureType))
  );
}
function validContainerResourceManifest(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES
  )
    return false;
  let prior = "";
  let amountTotal = 0;
  let replacementTotal = 0;
  for (const row of value) {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      !identity(row[0], 64) ||
      row[0] !== row[0].trim() ||
      (prior !== "" && compare(prior, row[0]) >= 0) ||
      !positiveInteger(row[1]) ||
      !integer(row[2])
    )
      return false;
    prior = row[0];
    amountTotal += row[1];
    replacementTotal += row[2];
  }
  return (
    !(value.length === 1 && prior === "energy") &&
    amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY &&
    replacementTotal + amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY
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
function validLinkEvacuation(value: unknown): value is LayoutLinkEvacuation {
  return (
    record(value) &&
    positiveInteger(value.amount) &&
    value.amount <= MAX_LAYOUT_LINK_ENERGY &&
    integer(value.startedAt) &&
    integer(value.expiresAt) &&
    value.expiresAt - value.startedAt === LAYOUT_LINK_EVACUATION_TIMEOUT_TICKS &&
    integer(value.replacementInitialEnergy) &&
    value.replacementInitialEnergy + value.amount <= MAX_LAYOUT_LINK_ENERGY &&
    identity(value.sourceId, 128) &&
    identity(value.replacementId, 128) &&
    value.sourceId !== value.replacementId
  );
}
function validTowerEvacuation(value: unknown): value is LayoutTowerEvacuation {
  return (
    record(value) &&
    positiveInteger(value.amount) &&
    value.amount <= MAX_LAYOUT_TOWER_ENERGY &&
    integer(value.startedAt) &&
    integer(value.expiresAt) &&
    value.expiresAt - value.startedAt === LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS &&
    integer(value.replacementInitialEnergy) &&
    value.replacementInitialEnergy >= MINIMUM_OPERATIONAL_TOWER_ENERGY &&
    value.replacementInitialEnergy + value.amount <= MAX_LAYOUT_TOWER_ENERGY &&
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
        (item.service.issuerSequence === undefined ||
          (positiveInteger(item.service.issuerSequence) && item.service.issuerSequence >= 2)) &&
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
