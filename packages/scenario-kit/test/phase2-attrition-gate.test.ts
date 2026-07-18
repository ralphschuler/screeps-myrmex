import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import checked from "../../../docs/phase2-attrition-results.json";
import { utf8ByteLength } from "../../bot/src/config/canonical";
import { runTick } from "../../bot/src/runtime/tick";
import { establishedRcl2World } from "../../bot/test/support/established-rcl2-fixture";
import {
  MAX_PHASE2_ATTRITION_ASSETS,
  MAX_PHASE2_ATTRITION_COLONIES,
  PHASE2_ATTRITION_ASSET_TYPES,
  reducePhase2Attrition,
  type Phase2AttritionObservation,
  type Phase2AttritionState,
} from "../../bot/src/telemetry/phase2-attrition";
import { canonicalHash, canonicalSerialize } from "../src";

describe("Phase 2 bounded road/container attrition evidence (#279)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("matches checked reset, reorder, gap, replay, persistence, migration, and cap outcomes", () => {
    expect(collectPhase2AttritionEvidence()).toEqual(checked);
  });
});

export function collectPhase2AttritionEvidence() {
  const persistence = collectPersistenceEvidence();
  const migration = collectMigrationEvidence();
  const forward = runSequence(false);
  const reversed = runSequence(true);
  const beforeGapRows = forward.changed.telemetry.rows;
  const replay = reducePhase2Attrition({
    tick: 102,
    observation: { colonies: [], assets: [], droppedObservations: 0 },
    previous: JSON.parse(JSON.stringify(forward.gap.state)) as Phase2AttritionState,
    sameTickReplay: true,
  });
  const oversized = new Array(MAX_PHASE2_ATTRITION_ASSETS + 1) as unknown[];
  Object.defineProperty(oversized, 0, {
    get: () => {
      throw new Error("over-cap evidence must not be traversed");
    },
  });
  const overCap = reducePhase2Attrition({
    tick: 101,
    observation: {
      colonies: ["colony:00000001"],
      assets: oversized as Phase2AttritionObservation["assets"],
      droppedObservations: 0,
    },
    previous: forward.baseline.state,
  });

  return {
    schemaVersion: 1,
    deterministic: {
      resetAndReorderEquivalent: canonicalHash(forward.gap) === canonicalHash(reversed.gap),
      sameTickReplayEquivalent: canonicalHash(replay) === canonicalHash(forward.gap),
    },
    outcomes: PHASE2_ATTRITION_ASSET_TYPES.map((assetType, index) => ({
      assetType,
      assetTicks: forward.gap.telemetry.rows[index]?.[0] ?? 0,
      capacityHitTicks: forward.gap.telemetry.rows[index]?.[1] ?? 0,
      hitsLost: forward.gap.telemetry.rows[index]?.[2] ?? 0,
      hitsRestored: forward.gap.telemetry.rows[index]?.[3] ?? 0,
      structuresLost: forward.gap.telemetry.rows[index]?.[4] ?? 0,
      structuresAdded: forward.gap.telemetry.rows[index]?.[5] ?? 0,
    })),
    safety: {
      gapPreservedRows: canonicalHash(beforeGapRows) === canonicalHash(forward.gap.telemetry.rows),
      interruptedAssets: forward.gap.telemetry.interruptedAssets,
      droppedObservations: forward.gap.telemetry.droppedObservations,
      overCapDroppedObservations: overCap.telemetry.droppedObservations,
      overCapReportedLoss: overCap.telemetry.rows.some((row) => row[2] > 0 || row[4] > 0),
      persistedRoomNames: persistence.persistedRoomNames,
      causalLabels: persistence.causalLabels,
    },
    migration,
    persistence,
    bounds: {
      assetTypes: PHASE2_ATTRITION_ASSET_TYPES.length,
      maximumAssets: MAX_PHASE2_ATTRITION_ASSETS,
      maximumColonies: MAX_PHASE2_ATTRITION_COLONIES,
      telemetryOwnerBytes: 8_192,
    },
  };
}

function collectPersistenceEvidence() {
  const world = establishedRcl2World();
  let memory = {} as Memory;
  runTickWithAssets(world, 100, memory, 4_000, 200_000);
  memory = JSON.parse(JSON.stringify(memory)) as Memory;
  const changed = runTickWithAssets(world, 101, memory, 3_900, 205_000);
  if (changed.telemetry === null) throw new Error("expected attrition telemetry");
  const owner = telemetryOwner(memory);
  const phase2 = phase2Owner(owner);
  const attrition = phase2.attrition;
  if (attrition === undefined) throw new Error("expected persisted attrition evidence");
  const encodedOwner = canonicalSerialize(owner);
  const encodedAttrition = canonicalSerialize(attrition);
  const forbiddenCausalLabels = ["decay", "damage", "repair", "dismantle", "replacement"];
  return {
    ownerSchemaVersion: phase2.schemaVersion,
    attritionSchemaVersion: attrition[0],
    resetRoadRow: attrition[7][0],
    resetContainerRow: attrition[7][1],
    statusHashMatches:
      (owner.last as { readonly hash?: unknown } | undefined)?.hash ===
      changed.telemetry.status.hash,
    persistedRoomNames: encodedOwner.includes("W1N1") ? 1 : 0,
    causalLabels: forbiddenCausalLabels.filter((label) => encodedAttrition.includes(label)).length,
    ownerBytes: utf8ByteLength(encodedOwner),
  };
}

function collectMigrationEvidence() {
  const world = establishedRcl2World();
  const memory = {} as Memory;
  runTick({ game: world.game(100), memory });
  const owner = phase2Owner(telemetryOwner(memory)) as unknown as Record<string, unknown>;
  owner.schemaVersion = 2;
  delete owner.attrition;
  const reconstructed = JSON.parse(JSON.stringify(memory)) as Memory;
  runTick({ game: world.game(101), memory: reconstructed });
  const migrated = phase2Owner(telemetryOwner(reconstructed));
  return {
    fromSchemaVersion: 2,
    toSchemaVersion: migrated.schemaVersion,
    samplesPreserved: migrated.samples.length === 2,
    attritionOmittedWhileEmpty: migrated.attrition === undefined,
  };
}

function runTickWithAssets(
  world: ReturnType<typeof establishedRcl2World>,
  tick: number,
  memory: Memory,
  roadHits: number,
  containerHits: number,
) {
  const game = world.game(tick);
  const room = game.rooms.W1N1;
  if (room === undefined) throw new Error("expected owned room fixture");
  const mutableRoom = room as unknown as {
    find: (findType: number) => unknown[];
  };
  const originalFind = mutableRoom.find.bind(room);
  const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });
  const road = {
    hits: roadHits,
    hitsMax: 5_000,
    id: "attrition-road",
    pos: position(20, 20),
    structureType: "road",
    ticksToDecay: 500,
  };
  const container = {
    hits: containerHits,
    hitsMax: 250_000,
    id: "attrition-container",
    pos: position(21, 20),
    store: emptyStore(2_000),
    structureType: "container",
    ticksToDecay: 250,
  };
  mutableRoom.find = (findType) => {
    const found = originalFind(findType);
    return findType === 107 ? [...found, road, container] : found;
  };
  try {
    return runTick({ game, memory });
  } finally {
    mutableRoom.find = originalFind;
  }
}

function emptyStore(capacity: number) {
  return {
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity,
    getUsedCapacity: () => 0,
  };
}

type PersistedPhase2Owner = {
  readonly schemaVersion: number;
  readonly samples: readonly unknown[];
  readonly attrition?: readonly [
    schemaVersion: number,
    lastTick: number | null,
    interruptedAssets: number,
    droppedObservations: number,
    droppedRows: number,
    colonies: readonly string[],
    tracks: readonly unknown[],
    rows: readonly (readonly number[])[],
  ];
};

function telemetryOwner(memory: Memory): Record<string, unknown> {
  const owner = memory.myrmex?.telemetry;
  if (owner === undefined) throw new Error("expected telemetry owner");
  return owner;
}

function phase2Owner(owner: Record<string, unknown>): PersistedPhase2Owner {
  const phase2 = owner.phase2;
  if (typeof phase2 !== "object" || phase2 === null || Array.isArray(phase2))
    throw new Error("expected Phase 2 telemetry owner");
  return phase2 as unknown as PersistedPhase2Owner;
}

function runSequence(reverse: boolean) {
  const ordered = <T>(values: readonly T[]): readonly T[] =>
    reverse ? [...values].reverse() : values;
  const baselineObservation = observation(
    ordered([
      ["road:00000001", "colony:00000001", 4_000, 5_000],
      ["road:00000002", "colony:00000001", 3_000, 5_000],
      ["container:00000001", "colony:00000001", 200_000, 250_000],
    ]),
  );
  const baseline = reducePhase2Attrition({
    tick: 100,
    observation: baselineObservation,
    previous: null,
  });
  const changed = reducePhase2Attrition({
    tick: 101,
    observation: observation(
      ordered([
        ["road:00000001", "colony:00000001", 3_900, 5_000],
        ["road:00000003", "colony:00000001", 5_000, 5_000],
        ["container:00000001", "colony:00000001", 205_000, 250_000],
      ]),
    ),
    previous: JSON.parse(JSON.stringify(baseline.state)) as Phase2AttritionState,
  });
  const gap = reducePhase2Attrition({
    tick: 102,
    observation: { colonies: [], assets: [], droppedObservations: 0 },
    previous: JSON.parse(JSON.stringify(changed.state)) as Phase2AttritionState,
  });
  return { baseline, changed, gap };
}

function observation(assets: Phase2AttritionObservation["assets"]): Phase2AttritionObservation {
  return { colonies: ["colony:00000001"], assets, droppedObservations: 0 };
}
