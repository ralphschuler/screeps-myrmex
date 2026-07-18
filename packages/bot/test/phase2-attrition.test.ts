import { describe, expect, it } from "vitest";
import {
  MAX_PHASE2_ATTRITION_ASSETS,
  MAX_PHASE2_ATTRITION_COLONIES,
  PHASE2_ATTRITION_ASSET_TYPES,
  observePhase2Attrition,
  reducePhase2Attrition,
  type Phase2AttritionObservation,
  type Phase2AttritionState,
} from "../src/telemetry/phase2-attrition";

describe("Phase 2 road/container attrition", () => {
  it("records only net outcomes across consecutive complete owned-room observations", () => {
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([
        ["road:00000001", "colony:00000001", 4_000, 5_000],
        ["road:00000002", "colony:00000001", 3_000, 5_000],
        ["container:00000001", "colony:00000001", 200_000, 250_000],
      ]),
      previous: null,
    });
    const changed = reducePhase2Attrition({
      tick: 101,
      observation: observation([
        ["road:00000001", "colony:00000001", 3_900, 5_000],
        ["road:00000003", "colony:00000001", 5_000, 5_000],
        ["container:00000001", "colony:00000001", 205_000, 250_000],
      ]),
      previous: baseline.state,
    });

    expect(PHASE2_ATTRITION_ASSET_TYPES).toEqual(["road", "container"]);
    expect(changed.telemetry.rows).toEqual([
      [1, 5_000, 3_100, 0, 1, 1],
      [1, 250_000, 0, 5_000, 0, 0],
    ]);
    expect(changed.telemetry).toMatchObject({
      interruptedAssets: 0,
      droppedObservations: 0,
      droppedRows: 0,
    });
    expect(JSON.stringify(changed.state)).not.toContain("W1N1");
    expect(Object.isFrozen(changed.telemetry.rows)).toBe(true);
  });

  it("interrupts gaps and ownership loss without fabricating attrition", () => {
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([["road:00000001", "colony:00000001", 4_000, 5_000]]),
      previous: null,
    });
    const skipped = reducePhase2Attrition({
      tick: 102,
      observation: observation([]),
      previous: baseline.state,
    });
    const absentRoom = reducePhase2Attrition({
      tick: 103,
      observation: { colonies: [], assets: [], droppedObservations: 0 },
      previous: skipped.state,
    });
    const returned = reducePhase2Attrition({
      tick: 104,
      observation: observation([["road:00000002", "colony:00000001", 5_000, 5_000]]),
      previous: absentRoom.state,
    });

    expect(skipped.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(skipped.telemetry.interruptedAssets).toBe(1);
    expect(absentRoom.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(returned.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("is reset/reorder equivalent and same-tick replay idempotent", () => {
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([
        ["road:00000002", "colony:00000001", 4_000, 5_000],
        ["container:00000001", "colony:00000001", 200_000, 250_000],
      ]),
      previous: null,
    });
    const reset = JSON.parse(JSON.stringify(baseline.state)) as Phase2AttritionState;
    const forward = reducePhase2Attrition({
      tick: 101,
      observation: observation([
        ["road:00000002", "colony:00000001", 3_900, 5_000],
        ["container:00000001", "colony:00000001", 199_000, 250_000],
      ]),
      previous: reset,
    });
    const reordered = reducePhase2Attrition({
      tick: 101,
      observation: observation([
        ["container:00000001", "colony:00000001", 199_000, 250_000],
        ["road:00000002", "colony:00000001", 3_900, 5_000],
      ]),
      previous: reset,
    });
    const replay = reducePhase2Attrition({
      tick: 101,
      observation: reordered.state.tracks.length === 0 ? observation([]) : reorderedObservation(),
      previous: JSON.parse(JSON.stringify(reordered.state)) as Phase2AttritionState,
      sameTickReplay: true,
    });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reordered));
    expect(replay.state).toEqual(reordered.state);
  });

  it("interrupts missing legacy road facts instead of reporting disappearance", () => {
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([["road:00000001", "colony:00000001", 4_000, 5_000]]),
      previous: null,
    });
    const incomplete = observePhase2Attrition({
      ownedRooms: [{ name: "W1N1", storedStructures: [] }],
    } as never);
    const result = reducePhase2Attrition({
      tick: 101,
      observation: incomplete,
      previous: baseline.state,
    });

    expect(incomplete.droppedObservations).toBe(1);
    expect(result.telemetry.interruptedAssets).toBe(1);
    expect(result.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects future state before applying same-tick replay", () => {
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([["road:00000001", "colony:00000001", 4_000, 5_000]]),
      previous: null,
    });
    const future = {
      ...baseline.state,
      lastTick: 999,
      rows: [
        [1, 5_000, 100, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
    } as Phase2AttritionState;
    const result = reducePhase2Attrition({
      tick: 100,
      observation: observation([["road:00000001", "colony:00000001", 4_000, 5_000]]),
      previous: future,
      sameTickReplay: true,
    });

    expect(result.state.lastTick).toBe(100);
    expect(result.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);

    const invalid = reducePhase2Attrition({
      tick: 100,
      observation: { colonies: [], assets: [], droppedObservations: 1 },
      previous: future,
      sameTickReplay: true,
    });
    expect(invalid.state.lastTick).toBeNull();
    expect(invalid.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(invalid.telemetry.droppedObservations).toBe(1);
  });

  it("rejects over-cap owned rooms before room traversal", () => {
    const rooms = new Array(MAX_PHASE2_ATTRITION_COLONIES + 1) as unknown[];
    Object.defineProperty(rooms, 0, {
      get: () => {
        throw new Error("over-cap owned rooms must not be read");
      },
    });
    const result = observePhase2Attrition({ ownedRooms: rooms } as never);

    expect(result.assets).toEqual([]);
    expect(result.colonies).toEqual([]);
    expect(result.droppedObservations).toBe(MAX_PHASE2_ATTRITION_COLONIES + 1);
  });

  it("rejects an over-cap world snapshot before road traversal", () => {
    const roads = new Array(MAX_PHASE2_ATTRITION_ASSETS + 1) as unknown[];
    Object.defineProperty(roads, 0, {
      get: () => {
        throw new Error("over-cap road facts must not be read");
      },
    });
    const result = observePhase2Attrition({
      ownedRooms: [
        {
          name: "W1N1",
          roads,
          storedStructures: [],
        },
      ],
    } as never);

    expect(result.assets).toEqual([]);
    expect(result.colonies).toEqual([]);
    expect(result.droppedObservations).toBe(MAX_PHASE2_ATTRITION_ASSETS + 2);
  });

  it("rejects over-cap batches before asset traversal", () => {
    const assets = new Array(MAX_PHASE2_ATTRITION_ASSETS + 1) as unknown[];
    Object.defineProperty(assets, 0, {
      get: () => {
        throw new Error("over-cap attrition input must not be read");
      },
    });
    const baseline = reducePhase2Attrition({
      tick: 100,
      observation: observation([["road:00000001", "colony:00000001", 4_000, 5_000]]),
      previous: null,
    });
    const result = reducePhase2Attrition({
      tick: 101,
      observation: {
        colonies: ["colony:00000001"],
        assets: assets as Phase2AttritionObservation["assets"],
        droppedObservations: 0,
      },
      previous: baseline.state,
    });

    expect(result.state.tracks).toEqual([]);
    expect(result.telemetry.interruptedAssets).toBe(1);
    expect(result.telemetry.droppedObservations).toBe(MAX_PHASE2_ATTRITION_ASSETS + 2);
    expect(result.telemetry.rows[0]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

function observation(assets: Phase2AttritionObservation["assets"]): Phase2AttritionObservation {
  return {
    colonies: ["colony:00000001"],
    assets,
    droppedObservations: 0,
  };
}

function reorderedObservation(): Phase2AttritionObservation {
  return observation([
    ["container:00000001", "colony:00000001", 199_000, 250_000],
    ["road:00000002", "colony:00000001", 3_900, 5_000],
  ]);
}
