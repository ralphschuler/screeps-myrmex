import { opaqueId } from "../security";
import type { WorldSnapshot } from "../world/snapshot";

export const PHASE2_ATTRITION_SCHEMA_VERSION = 1 as const;
export const MAX_PHASE2_ATTRITION_ASSETS = 128 as const;
export const MAX_PHASE2_ATTRITION_COLONIES = 64 as const;
export const PHASE2_ATTRITION_ASSET_TYPES = Object.freeze(["road", "container"] as const);

export type Phase2AttritionAssetType = (typeof PHASE2_ATTRITION_ASSET_TYPES)[number];

/** Opaque asset ref, opaque owned-colony ref, current hits, and maximum hits. */
export type Phase2AttritionAssetObservation = readonly [
  assetRef: string,
  colonyRef: string,
  hits: number,
  hitsMax: number,
];

export interface Phase2AttritionObservation {
  readonly colonies: readonly string[];
  readonly assets: readonly Phase2AttritionAssetObservation[];
  /** Positive means the whole current batch is unusable and no asset entry may be trusted. */
  readonly droppedObservations: number;
}

/** Compact reset-safe baseline with the same fields as the normalized asset observation. */
export type Phase2AttritionTrack = Phase2AttritionAssetObservation;

/** Fixed row: compared asset ticks, capacity-hit ticks, lost/restored hits, disappearances/additions. */
export type Phase2AttritionRow = readonly [
  assetTicks: number,
  capacityHitTicks: number,
  hitsLost: number,
  hitsRestored: number,
  structuresLost: number,
  structuresAdded: number,
];

export interface Phase2AttritionState {
  readonly schemaVersion: typeof PHASE2_ATTRITION_SCHEMA_VERSION;
  readonly lastTick: number | null;
  readonly interruptedAssets: number;
  readonly droppedObservations: number;
  readonly droppedRows: number;
  readonly colonies: readonly string[];
  readonly tracks: readonly Phase2AttritionTrack[];
  readonly rows: readonly [Phase2AttritionRow, Phase2AttritionRow];
}

export interface Phase2AttritionTelemetry {
  readonly rows: readonly [Phase2AttritionRow, Phase2AttritionRow];
  readonly interruptedAssets: number;
  readonly droppedObservations: number;
  readonly droppedRows: number;
}

export interface Phase2AttritionReduction {
  readonly state: Phase2AttritionState;
  readonly telemetry: Phase2AttritionTelemetry;
}

/** Projects only complete, currently visible owned-room roads and containers. */
export function observePhase2Attrition(snapshot: WorldSnapshot): Phase2AttritionObservation {
  const rooms = snapshot.ownedRooms;
  if (rooms.length > MAX_PHASE2_ATTRITION_COLONIES) {
    return deepFreeze({
      colonies: [],
      assets: [],
      droppedObservations: rooms.length,
    });
  }
  const missingRoadCollections = rooms.filter(({ roads }) => roads === undefined).length;
  if (missingRoadCollections > 0) {
    return deepFreeze({
      colonies: [],
      assets: [],
      droppedObservations: missingRoadCollections,
    });
  }
  let assetUpperBound = 0;
  for (const room of rooms) {
    assetUpperBound = saturatingAdd(assetUpperBound, room.roads?.length ?? 0);
    assetUpperBound = saturatingAdd(assetUpperBound, room.storedStructures.length);
  }
  if (assetUpperBound > MAX_PHASE2_ATTRITION_ASSETS) {
    return deepFreeze({
      colonies: [],
      assets: [],
      droppedObservations: saturatingAdd(assetUpperBound, rooms.length),
    });
  }

  const colonies: string[] = [];
  const assets: Phase2AttritionAssetObservation[] = [];
  for (const room of rooms) {
    const colonyRef = opaqueId("colony", room.name);
    colonies.push(colonyRef);
    for (const road of room.roads ?? [])
      assets.push([opaqueId("road", road.id), colonyRef, road.hits, road.hitsMax]);
    for (const container of room.storedStructures)
      if (container.structureType === "container")
        assets.push([
          opaqueId("container", container.id),
          colonyRef,
          container.hits,
          container.hitsMax,
        ]);
  }
  return normalizeObservation({ colonies, assets, droppedObservations: 0 }).observation;
}

/** Reduces adjacent complete observations into cumulative, explicitly non-causal net outcomes. */
export function reducePhase2Attrition(input: {
  readonly tick: number;
  readonly observation: Phase2AttritionObservation;
  readonly previous?: Phase2AttritionState | null;
  readonly sameTickReplay?: boolean;
}): Phase2AttritionReduction {
  const tick = nonnegativeSafeInteger(input.tick);
  const persisted = normalizeState(input.previous);
  const futureState = persisted.lastTick !== null && persisted.lastTick > tick;
  if (
    !futureState &&
    (persisted.lastTick === tick ||
      (input.sameTickReplay === true &&
        (persisted.lastTick === null || persisted.lastTick <= tick)))
  )
    return result(persisted);
  const previous = futureState ? emptyPhase2AttritionState() : persisted;
  const normalized = normalizeObservation(input.observation);
  if (!normalized.valid) {
    return result({
      ...previous,
      lastTick: null,
      interruptedAssets: saturatingAdd(previous.interruptedAssets, previous.tracks.length),
      droppedObservations: saturatingAdd(
        previous.droppedObservations,
        normalized.droppedObservations,
      ),
      colonies: [],
      tracks: [],
    });
  }

  const current = normalized.observation;
  if (previous.tracks.length === 0 && current.assets.length === 0) {
    return result({
      ...previous,
      lastTick: null,
      colonies: [],
      tracks: [],
    });
  }
  if (previous.lastTick === null || previous.lastTick > tick || previous.lastTick !== tick - 1) {
    const keepAggregates = previous.lastTick === null || previous.lastTick < tick;
    const baseline = keepAggregates ? previous : emptyPhase2AttritionState();
    return result({
      ...baseline,
      lastTick: tick,
      interruptedAssets:
        previous.lastTick === null
          ? baseline.interruptedAssets
          : saturatingAdd(baseline.interruptedAssets, previous.tracks.length),
      colonies: current.colonies,
      tracks: current.assets,
    });
  }

  const rows = previous.rows.map((row) => [...row]) as [number[], number[]];
  const priorColonies = new Set(previous.colonies);
  const currentColonies = new Set(current.colonies);
  const prior = new Map(previous.tracks.map((track) => [track[0], track] as const));
  const seen = new Set<string>();
  let interruptedAssets = previous.interruptedAssets;

  for (const asset of current.assets) {
    const [assetRef, colonyRef, hits, hitsMax] = asset;
    seen.add(assetRef);
    if (!priorColonies.has(colonyRef)) continue;
    const track = prior.get(assetRef);
    const row = rows[assetTypeIndex(assetRef)];
    if (row === undefined) continue;
    if (track === undefined) {
      row[5] = saturatingAdd(row[5] ?? 0, 1);
      continue;
    }
    if (track[1] !== colonyRef || track[3] !== hitsMax) {
      interruptedAssets = saturatingAdd(interruptedAssets, 1);
      continue;
    }
    row[0] = saturatingAdd(row[0] ?? 0, 1);
    row[1] = saturatingAdd(row[1] ?? 0, hitsMax);
    if (hits < track[2]) row[2] = saturatingAdd(row[2] ?? 0, track[2] - hits);
    else if (hits > track[2]) row[3] = saturatingAdd(row[3] ?? 0, hits - track[2]);
  }

  for (const track of previous.tracks) {
    if (seen.has(track[0])) continue;
    if (!currentColonies.has(track[1])) {
      interruptedAssets = saturatingAdd(interruptedAssets, 1);
      continue;
    }
    const row = rows[assetTypeIndex(track[0])];
    if (row === undefined) continue;
    row[2] = saturatingAdd(row[2] ?? 0, track[2]);
    row[4] = saturatingAdd(row[4] ?? 0, 1);
  }

  return result({
    schemaVersion: PHASE2_ATTRITION_SCHEMA_VERSION,
    lastTick: tick,
    interruptedAssets,
    droppedObservations: previous.droppedObservations,
    droppedRows: previous.droppedRows,
    colonies: current.colonies,
    tracks: current.assets,
    rows: rows as unknown as [Phase2AttritionRow, Phase2AttritionRow],
  });
}

export function emptyPhase2AttritionState(): Phase2AttritionState {
  return {
    schemaVersion: PHASE2_ATTRITION_SCHEMA_VERSION,
    lastTick: null,
    interruptedAssets: 0,
    droppedObservations: 0,
    droppedRows: 0,
    colonies: [],
    tracks: [],
    rows: emptyRows(),
  };
}

export function hasPhase2AttritionEvidence(value: Phase2AttritionTelemetry): boolean {
  return (
    value.interruptedAssets > 0 ||
    value.droppedObservations > 0 ||
    value.droppedRows > 0 ||
    value.rows.some((row) => row.some((field) => field > 0))
  );
}

export function projectPhase2AttritionTelemetry(
  state: Phase2AttritionState,
): Phase2AttritionTelemetry {
  return deepFreeze({
    rows: state.rows.map((row) => [...row]) as unknown as [Phase2AttritionRow, Phase2AttritionRow],
    interruptedAssets: state.interruptedAssets,
    droppedObservations: state.droppedObservations,
    droppedRows: state.droppedRows,
  });
}

function result(state: Phase2AttritionState): Phase2AttritionReduction {
  const frozen = deepFreeze({
    ...state,
    colonies: [...state.colonies],
    tracks: state.tracks.map((track) => [...track] as Phase2AttritionTrack),
    rows: state.rows.map((row) => [...row]) as unknown as [Phase2AttritionRow, Phase2AttritionRow],
  });
  return deepFreeze({ state: frozen, telemetry: projectPhase2AttritionTelemetry(frozen) });
}

function normalizeState(value: unknown): Phase2AttritionState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return emptyPhase2AttritionState();
  try {
    const state = value as Record<string, unknown>;
    if (state.schemaVersion !== PHASE2_ATTRITION_SCHEMA_VERSION) return emptyPhase2AttritionState();
    const lastTick = nullableNonnegativeSafeInteger(state.lastTick);
    const interruptedAssets = nonnegativeSafeInteger(state.interruptedAssets);
    const droppedObservations = nonnegativeSafeInteger(state.droppedObservations);
    const droppedRows = nonnegativeSafeInteger(state.droppedRows);
    if (
      !Array.isArray(state.colonies) ||
      !Array.isArray(state.tracks) ||
      !Array.isArray(state.rows)
    )
      return emptyPhase2AttritionState();
    if (
      state.colonies.length > MAX_PHASE2_ATTRITION_COLONIES ||
      state.tracks.length > MAX_PHASE2_ATTRITION_ASSETS ||
      state.rows.length !== PHASE2_ATTRITION_ASSET_TYPES.length
    )
      return emptyPhase2AttritionState();
    const normalized = normalizeObservation({
      colonies: state.colonies,
      assets: state.tracks,
      droppedObservations: 0,
    });
    if (!normalized.valid) return emptyPhase2AttritionState();
    if (
      lastTick === null &&
      (normalized.observation.colonies.length > 0 || normalized.observation.assets.length > 0)
    )
      return emptyPhase2AttritionState();
    const colonies = new Set(normalized.observation.colonies);
    if (normalized.observation.assets.some((track) => !colonies.has(track[1])))
      return emptyPhase2AttritionState();
    const rows = state.rows.map((row: unknown) => normalizeRow(row)) as [
      Phase2AttritionRow,
      Phase2AttritionRow,
    ];
    return {
      schemaVersion: PHASE2_ATTRITION_SCHEMA_VERSION,
      lastTick,
      interruptedAssets,
      droppedObservations,
      droppedRows,
      colonies: normalized.observation.colonies,
      tracks: normalized.observation.assets,
      rows,
    };
  } catch {
    return emptyPhase2AttritionState();
  }
}

function normalizeObservation(value: Phase2AttritionObservation): {
  readonly valid: boolean;
  readonly droppedObservations: number;
  readonly observation: Phase2AttritionObservation;
} {
  try {
    if (!Array.isArray(value.colonies) || !Array.isArray(value.assets))
      throw new TypeError("phase 2 attrition observation is invalid");
    const declaredDropped = nonnegativeSafeInteger(value.droppedObservations);
    if (
      declaredDropped > 0 ||
      value.colonies.length > MAX_PHASE2_ATTRITION_COLONIES ||
      value.assets.length > MAX_PHASE2_ATTRITION_ASSETS
    ) {
      const dropped = Math.max(declaredDropped, value.colonies.length + value.assets.length, 1);
      return {
        valid: false,
        droppedObservations: dropped,
        observation: { colonies: [], assets: [], droppedObservations: dropped },
      };
    }
    const colonies = value.colonies.map((colonyRef) => {
      if (!isOpaqueRef(colonyRef, "colony"))
        throw new TypeError("phase 2 attrition colony identity is invalid");
      return colonyRef;
    });
    colonies.sort((left, right) => left.localeCompare(right));
    if (hasDuplicate(colonies)) throw new TypeError("phase 2 attrition colonies collide");
    const assets = (value.assets as readonly unknown[]).map(
      (asset: unknown): Phase2AttritionAssetObservation => {
        if (!Array.isArray(asset) || asset.length !== 4)
          throw new TypeError("phase 2 attrition asset is invalid");
        const [assetRef, colonyRef, rawHits, rawHitsMax] = asset as unknown[];
        if (
          (!isOpaqueRef(assetRef, "road") && !isOpaqueRef(assetRef, "container")) ||
          !isOpaqueRef(colonyRef, "colony")
        )
          throw new TypeError("phase 2 attrition asset identity is invalid");
        const hits = nonnegativeSafeInteger(rawHits);
        const hitsMax = positiveSafeInteger(rawHitsMax);
        if (hits > hitsMax) throw new RangeError("phase 2 attrition hits exceed capacity");
        return [assetRef, colonyRef, hits, hitsMax];
      },
    );
    assets.sort((left, right) => left[0].localeCompare(right[0]));
    if (hasDuplicate(assets.map(([assetRef]) => assetRef)))
      throw new TypeError("phase 2 attrition assets collide");
    return {
      valid: true,
      droppedObservations: 0,
      observation: deepFreeze({ colonies, assets, droppedObservations: 0 }),
    };
  } catch {
    return {
      valid: false,
      droppedObservations: 1,
      observation: { colonies: [], assets: [], droppedObservations: 1 },
    };
  }
}

function normalizeRow(value: unknown): Phase2AttritionRow {
  if (!Array.isArray(value) || value.length !== 6)
    throw new TypeError("phase 2 attrition row is invalid");
  const row = value.map(nonnegativeSafeInteger) as unknown as Phase2AttritionRow;
  if (row[0] > 0 && row[1] < row[0]) throw new TypeError("phase 2 attrition row is inconsistent");
  return row;
}

function emptyRows(): [Phase2AttritionRow, Phase2AttritionRow] {
  return [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ];
}

function assetTypeIndex(assetRef: string): number {
  return assetRef.startsWith("road:") ? 0 : 1;
}

function isOpaqueRef(value: unknown, kind: Phase2AttritionAssetType | "colony"): value is string {
  return typeof value === "string" && new RegExp(`^${kind}:[0-9a-f]{8}$`, "u").test(value);
}

function hasDuplicate(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1)
    if (values[index - 1] === values[index]) return true;
  return false;
}

function nullableNonnegativeSafeInteger(value: unknown): number | null {
  return value === null ? null : nonnegativeSafeInteger(value);
}

function positiveSafeInteger(value: unknown): number {
  const result = nonnegativeSafeInteger(value);
  if (result === 0) throw new RangeError("phase 2 attrition requires a positive safe integer");
  return result;
}

function nonnegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError("phase 2 attrition requires a nonnegative safe integer");
  return value;
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
