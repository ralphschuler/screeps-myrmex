import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { arbitrateStructureRemovals, STRUCTURE_REMOVAL_LIMITS } from "../src/layout";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";
import {
  MAX_PHASE2_CONTROLLER_TRACKERS,
  PHASE2_AUTHORITY_IDS,
  PHASE2_COOLDOWN_IDS,
  PHASE2_COOLDOWN_LIMITS,
  PHASE2_RCL_DESTINATIONS,
  observePhase2Telemetry,
  reducePhase2Telemetry,
  type Phase2TelemetryObservation,
  type Phase2TelemetryState,
} from "../src/telemetry/phase2";

describe("Phase 2 telemetry reducer", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("publishes fixed authority outcomes and reconciled flow identities", () => {
    const result = reducePhase2Telemetry({
      observation: observation(100),
      previous: null,
      maximumSamples: 4,
    });

    expect(result.telemetry.authorities).toHaveLength(PHASE2_AUTHORITY_IDS.length);
    expect(result.telemetry.authorities[0]).toEqual([1, 1, 1, 400, 0, 100, 9]);
    expect(result.telemetry.flows).toMatchObject({
      harvestedEnergy: 20,
      logistics: { requested: 80, scheduled: 60, shortfall: 20, delivered: 50, loss: 3 },
      links: { sent: 40, delivered: 38, lost: 2 },
      maintenanceEnergy: 15,
      terminalTransactionEnergyPlanned: 4,
    });
    expect(result.telemetry.identities).toEqual([
      [true, 0],
      [true, 0],
      [true, 5],
    ]);
    expect(result.telemetry.window).toEqual([1, 100, 100, 20, 50, 38, 190, 113, 18, 10, 1, 250, 0]);
    expect(result.telemetry.attrition).toBeUndefined();
    expect(Object.isFrozen(result.telemetry.authorities)).toBe(true);
  });

  it("reports fixed current and rolling cooldown utilization without hiding tick gaps", () => {
    const first = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        cooldownSlots: [
          [2, 1],
          [3, 2],
          [0, 0],
          [4, 1],
          [1, 0],
        ],
        droppedCooldownInputs: 0,
      },
      previous: null,
    });
    const second = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        cooldownSlots: [
          [2, 0],
          [3, 1],
          [1, 1],
          [4, 2],
          [1, 1],
        ],
        droppedCooldownInputs: 0,
      },
      previous: JSON.parse(JSON.stringify(first.state)) as Phase2TelemetryState,
    });

    expect(PHASE2_COOLDOWN_IDS).toEqual(["extractor", "link", "terminal", "lab", "factory"]);
    expect(second.telemetry.cooldowns).toEqual({
      continuous: true,
      current: [
        [2, 0, 0],
        [3, 1, 3_333],
        [1, 1, 10_000],
        [4, 2, 5_000],
        [1, 1, 10_000],
      ],
      window: [
        [4, 1, 2_500],
        [6, 3, 5_000],
        [1, 1, 10_000],
        [8, 3, 3_750],
        [2, 1, 5_000],
      ],
    });

    const gap = reducePhase2Telemetry({
      observation: {
        ...observation(103),
        cooldownSlots: [
          [2, 0],
          [3, 0],
          [1, 0],
          [4, 0],
          [1, 0],
        ],
        droppedCooldownInputs: 0,
      },
      previous: second.state,
    });
    expect(gap.telemetry.cooldowns?.continuous).toBe(false);
  });

  it("composes reset-safe road/container attrition into the Phase 2 owner", () => {
    const baseline = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        attrition: {
          colonies: ["colony:00000001"],
          assets: [
            ["road:00000001", "colony:00000001", 4_000, 5_000],
            ["container:00000001", "colony:00000001", 200_000, 250_000],
          ],
          droppedObservations: 0,
        },
      },
      previous: null,
    });
    const changed = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        attrition: {
          colonies: ["colony:00000001"],
          assets: [
            ["road:00000001", "colony:00000001", 3_900, 5_000],
            ["container:00000001", "colony:00000001", 205_000, 250_000],
          ],
          droppedObservations: 0,
        },
      },
      previous: JSON.parse(JSON.stringify(baseline.state)) as Phase2TelemetryState,
    });

    expect(changed.state.schemaVersion).toBe(5);
    expect(changed.telemetry.attrition?.rows).toEqual([
      [1, 5_000, 100, 0, 0, 0],
      [1, 250_000, 0, 5_000, 0, 0],
    ]);
  });

  it("drops legacy samples without fabricating missing recipe inputs", () => {
    const previous = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
        attrition: {
          colonies: ["colony:00000001"],
          assets: [["road:00000001", "colony:00000001", 4_000, 5_000]],
          droppedObservations: 0,
        },
      },
      previous: null,
    }).state;
    const legacy = {
      ...previous,
      schemaVersion: 3,
      samples: previous.samples.map((sample) => {
        const legacy = { ...sample } as Record<string, unknown>;
        delete legacy.industryEnergyInput;
        delete legacy.industryResourceInput;
        return legacy;
      }),
    } as unknown as Phase2TelemetryState;

    const result = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
      },
      previous: JSON.parse(JSON.stringify(legacy)) as Phase2TelemetryState,
    });

    expect(result.state.schemaVersion).toBe(5);
    expect(result.state.samples.map(({ tick }) => tick)).toEqual([101]);
    expect(result.state.droppedSamples).toBe(1);
    expect(result.state.rclTracks).toEqual([["colony:00000001", 2, 100, 101]]);
    expect(result.state.attrition.tracks).toHaveLength(0);
    expect(result.state.attrition.interruptedAssets).toBe(1);
  });

  it("drops V4 samples with unknowable cooldowns while preserving timing and attrition", () => {
    const baseline = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
        attrition: {
          colonies: ["colony:00000001"],
          assets: [["road:00000001", "colony:00000001", 4_000, 5_000]],
          droppedObservations: 0,
        },
      },
      previous: null,
    });
    const legacy = {
      ...baseline.state,
      schemaVersion: 4,
      samples: baseline.state.samples.map((sample) => {
        const row = { ...sample } as Record<string, unknown>;
        delete row.cooldownSlots;
        return row;
      }),
    } as unknown as Phase2TelemetryState;
    const migrated = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
      },
      previous: JSON.parse(JSON.stringify(legacy)) as Phase2TelemetryState,
    });

    expect(migrated.state.schemaVersion).toBe(5);
    expect(migrated.state.samples.map(({ tick }) => tick)).toEqual([101]);
    expect(migrated.state.droppedSamples).toBe(1);
    expect(migrated.state.rclTracks).toEqual([["colony:00000001", 2, 100, 101]]);
    expect(migrated.state.attrition.interruptedAssets).toBe(1);
  });

  it("keeps a deterministic bounded rolling window across JSON reset", () => {
    const first = reducePhase2Telemetry({
      observation: observation(100),
      previous: null,
      maximumSamples: 2,
    });
    const reset = JSON.parse(JSON.stringify(first.state)) as Phase2TelemetryState;
    const second = reducePhase2Telemetry({
      observation: { ...observation(101), harvestedEnergy: 30 },
      previous: reset,
      maximumSamples: 2,
    });
    const third = reducePhase2Telemetry({
      observation: { ...observation(102), harvestedEnergy: 40 },
      previous: second.state,
      maximumSamples: 2,
    });

    expect(third.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(third.telemetry.window).toEqual([2, 101, 102, 70, 100, 76, 380, 226, 36, 20, 2, 500, 1]);
    const replay = reducePhase2Telemetry({
      observation: { ...observation(102), harvestedEnergy: 40 },
      previous: second.state,
      maximumSamples: 2,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(third));
  });

  it("composes byte-equivalent gate inputs from reordered runtime observations", () => {
    const memory = {} as Memory;
    const forward = runTick({
      game: establishedRcl2World().game(100),
      memory,
    });
    const reversed = runTick({
      game: establishedRcl2World({ reverseCollections: true }).game(100),
      memory: {} as Memory,
    });

    expect(forward.telemetry?.phase2).toEqual(reversed.telemetry?.phase2);
    const persistedPhase2 = JSON.stringify(memory.myrmex?.telemetry?.phase2);
    expect(persistedPhase2).not.toContain("W1N1");
    expect(persistedPhase2).toMatch(/colony:[0-9a-f]{8}/u);
    expect(forward.telemetry?.phase2).toMatchObject({
      progression: {
        controllers: 1,
        rcl8Controllers: 0,
        controllerProgress: 0,
        controllerProgressTotal: 1_000,
        minimumDowngradeTicks: 20_000,
      },
      reserves: { energyAvailable: 300, energyCapacity: 400 },
      spawn: { active: 1 },
      construction: { backlog: 1, progressRemaining: 95 },
    });
  });

  it("wires exact settled industry inputs and outputs into fixed Phase 2 units", () => {
    const outcome = runTick({
      game: establishedRcl2World().game(100),
      memory: {} as Memory,
    });
    const telemetry = outcome.telemetry;
    if (telemetry === null || telemetry.logistics === undefined)
      throw new Error("expected complete runtime telemetry fixture");
    const current = observePhase2Telemetry({
      tick: 101,
      snapshot: outcome.snapshot,
      colony: outcome.colony,
      spawn: outcome.spawn,
      staticMining: telemetry.staticMining,
      logistics: telemetry.logistics,
      maintenance: telemetry.maintenanceV2,
      industry: {
        ...telemetry.industry,
        labs: {
          accounting: [20, 45, 15],
          cancelled: 0,
          commands: { executed: 3, failed: 0, rejected: 0 },
          commitments: 3,
          intents: 3,
          readinessBlockers: 0,
          resourceDemands: 0,
          retries: 0,
          settledAmount: 7,
        },
        mature: {
          accounting: {
            factory: [40, 100, 20],
            powerProcessing: [150, 3, 3],
          },
          commands: { executed: 2, failed: 0, rejected: 0 },
          intents: { factory: 1, powerProcessing: 1, total: 2 },
          settlements: { cancelled: 0, pending: 0, retries: 0 },
          truncated: false,
        },
      },
    });

    expect(current).toMatchObject({
      industryEnergyInput: 210,
      industryResourceInput: 148,
      labOutput: 15,
      factoryOutput: 20,
      powerOutput: 3,
    });
  });

  it("counts temporary-road arbitration and exact destroy results in the fixed layout row", () => {
    const outcome = runTick({
      game: establishedRcl2World().game(100),
      memory: {} as Memory,
    });
    const telemetry = outcome.telemetry;
    if (telemetry === null || telemetry.logistics === undefined)
      throw new Error("expected complete runtime telemetry fixture");
    const logistics = telemetry.logistics;
    const proposal = {
      colonyId: "W1N1",
      layoutFingerprint: "layout-a",
      observationFingerprint: "observation-a",
      policyFingerprint: "policy-a",
      pos: { roomName: "W1N1", x: 10, y: 11 },
      replacementStructureType: "tower" as const,
      stableId: "remove-road/road-a",
      targetId: "road-a",
      targetStructureType: "road" as const,
    };
    const arbitration = arbitrateStructureRemovals({
      authorizations: [
        {
          colonyId: proposal.colonyId,
          layoutFingerprint: proposal.layoutFingerprint,
          observationFingerprint: proposal.observationFingerprint,
          policyFingerprint: proposal.policyFingerprint,
          roomName: proposal.pos.roomName,
        },
      ],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: [proposal],
    });
    const intent = arbitration.intents[0];
    if (intent === undefined) throw new Error("expected accepted removal intent");
    const observe = (layout: typeof outcome.layout) =>
      observePhase2Telemetry({
        tick: 101,
        snapshot: outcome.snapshot,
        colony: outcome.colony,
        spawn: outcome.spawn,
        layout,
        staticMining: telemetry.staticMining,
        logistics,
        maintenance: telemetry.maintenanceV2,
        industry: telemetry.industry,
      });
    const baseline = observe(outcome.layout);
    const migrated = observe({
      ...outcome.layout,
      migration: {
        arbitration,
        blockers: [],
        execution: [
          {
            called: true,
            code: "OK",
            fault: null,
            intent,
          },
        ],
        proposals: [proposal],
        scannedCandidates: 1,
        truncatedCandidates: 0,
      },
    });

    expect(migrated.layoutAccepted).toBe(baseline.layoutAccepted + 1);
    expect(migrated.layoutExecuted).toBe(baseline.layoutExecuted + 1);
  });

  it("observes bounded active cooldown slots and rejects over-cap assets before traversal", () => {
    const outcome = runTick({
      game: establishedRcl2World().game(100),
      memory: {} as Memory,
    });
    const telemetry = outcome.telemetry;
    const room = outcome.snapshot.ownedRooms[0];
    if (telemetry === null || telemetry.logistics === undefined || room === undefined)
      throw new Error("expected complete runtime telemetry fixture");
    const withCooldowns = {
      ...room,
      ownedExtractors: [
        { active: true, cooldown: 4 },
        { active: false, cooldown: 4 },
      ],
      ownedLinks: [
        { active: true, cooldown: 0 },
        { active: true, cooldown: 2 },
      ],
      ownedTerminals: [{ active: true, cooldown: 0, store: { resources: [] } }],
      ownedLabs: [
        { active: true, cooldown: 5 },
        { active: true, cooldown: 0 },
      ],
      ownedFactories: [{ active: true, cooldown: 7 }],
    } as unknown as typeof room;
    const observed = observePhase2Telemetry({
      tick: 101,
      snapshot: { ...outcome.snapshot, ownedRooms: [withCooldowns], rooms: [withCooldowns] },
      colony: outcome.colony,
      spawn: outcome.spawn,
      staticMining: telemetry.staticMining,
      logistics: telemetry.logistics,
      maintenance: telemetry.maintenanceV2,
      industry: telemetry.industry,
    });
    expect(observed.cooldownSlots).toEqual([
      [1, 1],
      [2, 1],
      [1, 0],
      [2, 1],
      [1, 1],
    ]);

    const oversizedLabs = new Array(PHASE2_COOLDOWN_LIMITS[3] + 1) as unknown[];
    Object.defineProperty(oversizedLabs, 0, {
      get: () => {
        throw new Error("over-cap cooldown assets must not be traversed");
      },
    });
    const overCapRoom = { ...room, ownedLabs: oversizedLabs } as unknown as typeof room;
    const overCap = observePhase2Telemetry({
      tick: 101,
      snapshot: { ...outcome.snapshot, ownedRooms: [overCapRoom], rooms: [overCapRoom] },
      colony: outcome.colony,
      spawn: outcome.spawn,
      staticMining: telemetry.staticMining,
      logistics: telemetry.logistics,
      maintenance: telemetry.maintenanceV2,
      industry: telemetry.industry,
    });
    expect(overCap.cooldownSlots).toEqual(PHASE2_COOLDOWN_IDS.map(() => [0, 0]));
    expect(overCap.droppedCooldownInputs).toBeGreaterThan(PHASE2_COOLDOWN_LIMITS[3]);

    const malformedRoom = {
      ...room,
      ownedLinks: [{ active: true, cooldown: -1 }],
    } as unknown as typeof room;
    const malformed = observePhase2Telemetry({
      tick: 101,
      snapshot: { ...outcome.snapshot, ownedRooms: [malformedRoom], rooms: [malformedRoom] },
      colony: outcome.colony,
      spawn: outcome.spawn,
      staticMining: telemetry.staticMining,
      logistics: telemetry.logistics,
      maintenance: telemetry.maintenanceV2,
      industry: telemetry.industry,
    });
    expect(malformed.cooldownSlots).toEqual(PHASE2_COOLDOWN_IDS.map(() => [0, 0]));
    expect(malformed.droppedCooldownInputs).toBeGreaterThan(0);
  });

  it("fails the whole RCL timing batch closed when runtime observation exceeds 64 rooms", () => {
    const outcome = runTick({
      game: establishedRcl2World().game(100),
      memory: {} as Memory,
    });
    const telemetry = outcome.telemetry;
    const room = outcome.snapshot.ownedRooms[0];
    if (telemetry === null || telemetry.logistics === undefined || room === undefined)
      throw new Error("expected complete runtime telemetry fixture");
    const overflowRooms = Array.from(
      { length: MAX_PHASE2_CONTROLLER_TRACKERS + 1 },
      (_, index) => ({
        ...room,
        name: `W${String(index)}N1`,
        controller: { ...room.controller, level: 3 },
      }),
    );
    const current = observePhase2Telemetry({
      tick: 101,
      snapshot: {
        ...outcome.snapshot,
        ownedRooms: overflowRooms,
        rooms: overflowRooms,
      },
      colony: outcome.colony,
      spawn: outcome.spawn,
      staticMining: telemetry.staticMining,
      logistics: telemetry.logistics,
      maintenance: telemetry.maintenanceV2,
      industry: telemetry.industry,
    });
    const tracked = current.controllerLevels[0];
    if (tracked === undefined) throw new Error("expected one retained normalized controller");
    const baseline = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        controllers: 1,
        controllerLevels: [{ ...tracked, level: 2 }],
      },
      previous: null,
    });
    const result = reducePhase2Telemetry({ observation: current, previous: baseline.state });

    expect(current.controllerLevels).toHaveLength(MAX_PHASE2_CONTROLLER_TRACKERS);
    expect(current.droppedControllerLevels).toBe(MAX_PHASE2_CONTROLLER_TRACKERS + 1);
    expect(result.state.rclTransitionDurations.every(([samples]) => samples === 0)).toBe(true);
    expect(result.state.rclTracks).toEqual([]);
    expect(result.state.interruptedRclTracks).toBe(1);
    expect(result.state.droppedRclObservations).toBe(MAX_PHASE2_CONTROLLER_TRACKERS + 1);
    const replay = reducePhase2Telemetry({ observation: current, previous: result.state });
    expect(replay.state).toEqual(result.state);
  });

  it("persists and restores the bounded window through the runtime telemetry owner", () => {
    const memory = {} as Memory;
    const first = runTick({ game: game(100), memory });
    const second = runTick({ game: game(101), memory });
    if (first.telemetry === null || second.telemetry === null)
      throw new Error("expected telemetry");

    expect(first.telemetry.phase2.window.slice(0, 3)).toEqual([1, 100, 100]);
    expect(first.telemetry.phase2.cooldowns).toBeUndefined();
    expect(second.telemetry.phase2.window.slice(0, 3)).toEqual([2, 100, 101]);
    expect(memory.myrmex?.telemetry).toMatchObject({
      schemaVersion: 5,
      phase2: {
        schemaVersion: 5,
        samples: [
          [100, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          [101, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ],
      },
    });

    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const reset = runTick({ game: game(102), memory: resetMemory });
    expect(reset.telemetry?.phase2.window.slice(0, 3)).toEqual([3, 100, 102]);
  });

  it("rejects oversized durable samples before traversal and counts the dropped window", () => {
    const oversized = new Array(65) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("oversized sample must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: observation(200),
      previous: {
        schemaVersion: 1,
        droppedSamples: Number.MAX_SAFE_INTEGER,
        samples: oversized,
      } as unknown as Phase2TelemetryState,
      maximumSamples: 64,
    });

    expect(result.telemetry.window.slice(0, 3)).toEqual([1, 200, 200]);
    expect(result.telemetry.window[12]).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("tracks one adjacent RCL duration across JSON reset without duplicate replay", () => {
    const colonyA = { colonyRef: "colony:0000000a", level: 2 } as const;
    const colonyB = { colonyRef: "colony:0000000b", level: 4 } as const;
    const baseline = reducePhase2Telemetry({
      observation: { ...observation(100), controllerLevels: [colonyB, colonyA] },
      previous: null,
    });
    const continued = reducePhase2Telemetry({
      observation: { ...observation(101), controllerLevels: [colonyA, colonyB] },
      previous: JSON.parse(JSON.stringify(baseline.state)) as Phase2TelemetryState,
    });
    const reset = reducePhase2Telemetry({
      observation: { ...observation(102), controllerLevels: [colonyB, colonyA] },
      previous: JSON.parse(JSON.stringify(continued.state)) as Phase2TelemetryState,
    });
    const completed = reducePhase2Telemetry({
      observation: {
        ...observation(103),
        controllerLevels: [{ ...colonyA, level: 3 }, colonyB],
      },
      previous: JSON.parse(JSON.stringify(reset.state)) as Phase2TelemetryState,
    });

    expect(PHASE2_RCL_DESTINATIONS).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(completed.state.rclTransitionDurations[1]).toEqual([1, 3, 3, 3, 3, 103]);
    expect(completed.state.rclTracks).toHaveLength(2);
    expect(completed.state.interruptedRclTracks).toBe(0);
    expect(completed.telemetry.progression.rcl).toEqual([3, 1, 3, 3, 3, 3, 103, 0, 0, 0]);

    const replay = reducePhase2Telemetry({
      observation: {
        ...observation(103),
        controllerLevels: [colonyB, { ...colonyA, level: 3 }],
      },
      previous: JSON.parse(JSON.stringify(completed.state)) as Phase2TelemetryState,
    });
    expect(replay.state).toEqual(completed.state);
    expect(replay.telemetry.progression.rcl).toEqual(completed.telemetry.progression.rcl);
  });

  it("breaks RCL timing continuity instead of fabricating transitions", () => {
    const colonyRef = "colony:0000000a";
    const state = reducePhase2Telemetry({
      observation: { ...observation(100), controllerLevels: [{ colonyRef, level: 2 }] },
      previous: null,
    }).state;

    const skipped = reducePhase2Telemetry({
      observation: { ...observation(102), controllerLevels: [{ colonyRef, level: 3 }] },
      previous: state,
    });
    expect(skipped.state.rclTransitionDurations[1]?.[0]).toBe(0);

    const downgraded = reducePhase2Telemetry({
      observation: { ...observation(103), controllerLevels: [{ colonyRef, level: 2 }] },
      previous: skipped.state,
    });
    const jumped = reducePhase2Telemetry({
      observation: { ...observation(104), controllerLevels: [{ colonyRef, level: 4 }] },
      previous: downgraded.state,
    });
    const missing = reducePhase2Telemetry({
      observation: { ...observation(105), controllerLevels: [] },
      previous: jumped.state,
    });
    const returned = reducePhase2Telemetry({
      observation: { ...observation(106), controllerLevels: [{ colonyRef, level: 5 }] },
      previous: missing.state,
    });

    expect(returned.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);
    expect(returned.state.interruptedRclTracks).toBe(4);
    expect(returned.telemetry.progression.rcl).toEqual([
      null,
      0,
      0,
      null,
      null,
      null,
      null,
      4,
      0,
      0,
    ]);
  });

  it("upgrades V1 state and rejects over-cap controller input before traversal", () => {
    const oversized = new Array(MAX_PHASE2_CONTROLLER_TRACKERS + 1) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("over-cap controller input must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        controllerLevels: oversized,
      } as unknown as Phase2TelemetryObservation,
      previous: {
        schemaVersion: 1,
        droppedSamples: 0,
        samples: [sample(100)],
      },
    });

    expect(result.state.schemaVersion).toBe(5);
    expect(result.state.samples.map(({ tick }) => tick)).toEqual([101]);
    expect(result.state.droppedSamples).toBe(1);
    expect(result.state.rclTracks).toHaveLength(0);
    expect(result.state.droppedRclObservations).toBe(MAX_PHASE2_CONTROLLER_TRACKERS + 1);
  });

  it("drops legacy samples and malformed transition state independently", () => {
    const malformedTracks = new Array(MAX_PHASE2_CONTROLLER_TRACKERS + 1) as unknown[];
    Object.defineProperty(malformedTracks, 0, {
      get: () => {
        throw new Error("over-cap persisted tracks must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: observation(101),
      previous: {
        schemaVersion: 2,
        droppedSamples: 0,
        samples: [sample(100)],
        rclTimingSchemaVersion: 1,
        interruptedRclTracks: 0,
        droppedRclObservations: 0,
        droppedRclTransitions: 0,
        rclTracks: malformedTracks,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map(() => [0, 0, null, null, null, null]),
      } as unknown as Phase2TelemetryState,
    });

    expect(result.state.samples.map(({ tick }) => tick)).toEqual([101]);
    expect(result.state.rclTracks).toEqual([]);
    expect(result.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);

    const impossibleAggregate = reducePhase2Telemetry({
      observation: observation(102),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0 ? [2, 2, 1, 2, 1, 100] : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(impossibleAggregate.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(impossibleAggregate.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(
      true,
    );

    const impossibleLatestAggregate = reducePhase2Telemetry({
      observation: observation(102),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0 ? [2, 4, 1, 3, 2, 100] : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(
      impossibleLatestAggregate.state.rclTransitionDurations.every(([count]) => count === 0),
    ).toBe(true);

    const impossibleCompletionTick = reducePhase2Telemetry({
      observation: observation(102),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0 ? [1, 100, 100, 100, 100, 50] : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(
      impossibleCompletionTick.state.rclTransitionDurations.every(([count]) => count === 0),
    ).toBe(true);

    const impossibleSaturatedAggregate = reducePhase2Telemetry({
      observation: observation(Number.MAX_SAFE_INTEGER),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0
            ? [2, Number.MAX_SAFE_INTEGER, 1, 1, 1, Number.MAX_SAFE_INTEGER]
            : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(
      impossibleSaturatedAggregate.state.rclTransitionDurations.every(([count]) => count === 0),
    ).toBe(true);

    const impossibleSaturatedLatest = reducePhase2Telemetry({
      observation: observation(Number.MAX_SAFE_INTEGER),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0
            ? [2, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 2, Number.MAX_SAFE_INTEGER]
            : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(
      impossibleSaturatedLatest.state.rclTransitionDurations.every(([count]) => count === 0),
    ).toBe(true);

    const saturatedAggregate = reducePhase2Telemetry({
      observation: observation(Number.MAX_SAFE_INTEGER),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0
            ? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 2, 2, 2, Number.MAX_SAFE_INTEGER]
            : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(saturatedAggregate.state.rclTransitionDurations[0]).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      2,
      2,
      2,
      Number.MAX_SAFE_INTEGER,
    ]);

    const futureDatedTrack = reducePhase2Telemetry({
      observation: {
        ...observation(102),
        controllerLevels: [{ colonyRef: "colony:0000000a", level: 2 }],
      },
      previous: {
        ...result.state,
        rclTracks: [["colony:0000000a", 2, 100, 200]],
      },
    });
    expect(futureDatedTrack.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(futureDatedTrack.state.rclTracks).toEqual([["colony:0000000a", 2, 102, 102]]);

    const futureDatedAggregate = reducePhase2Telemetry({
      observation: observation(102),
      previous: {
        ...result.state,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map((_, index) =>
          index === 0 ? [1, 2, 2, 2, 2, 200] : [0, 0, null, null, null, null],
        ),
      },
    });
    expect(futureDatedAggregate.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(futureDatedAggregate.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(
      true,
    );

    const futureTiming = reducePhase2Telemetry({
      observation: {
        ...observation(102),
        controllerLevels: [{ colonyRef: "colony:0000000a", level: 2 }],
      },
      previous: {
        ...result.state,
        rclTimingSchemaVersion: 2,
        rclTracks: [["colony:0000000a", 1, 100, 101]],
      } as unknown as Phase2TelemetryState,
    });
    expect(futureTiming.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(futureTiming.state.rclTracks).toEqual([["colony:0000000a", 2, 102, 102]]);
    expect(futureTiming.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);
  });

  it("drops malformed attrition state without losing samples or RCL timing", () => {
    const baseline = reducePhase2Telemetry({
      observation: {
        ...observation(100),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
        attrition: {
          colonies: ["colony:00000001"],
          assets: [["road:00000001", "colony:00000001", 4_000, 5_000]],
          droppedObservations: 0,
        },
      },
      previous: null,
    });
    const oversized = new Array(129) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("over-cap persisted attrition must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        controllerLevels: [{ colonyRef: "colony:00000001", level: 2 }],
      },
      previous: {
        ...baseline.state,
        attrition: { ...baseline.state.attrition, tracks: oversized },
      } as unknown as Phase2TelemetryState,
    });

    expect(result.state.samples.map(({ tick }) => tick)).toEqual([100, 101]);
    expect(result.state.rclTracks).toEqual([["colony:00000001", 2, 100, 101]]);
    expect(result.state.attrition.tracks).toEqual([]);
    expect(result.state.attrition.rows).toEqual([
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ]);
    expect(result.telemetry.attrition).toBeUndefined();
  });

  it("fails closed on malformed values instead of publishing misleading gate inputs", () => {
    expect(() =>
      reducePhase2Telemetry({
        observation: { ...observation(100), linkSent: -1 },
        previous: null,
      }),
    ).toThrow(/nonnegative safe integer/u);
    expect(() =>
      reducePhase2Telemetry({
        observation: {
          ...observation(100),
          cooldownSlots: [
            [1, 2],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        },
        previous: null,
      }),
    ).toThrow(/exceeds active slots/u);
    const current = reducePhase2Telemetry({ observation: observation(100), previous: null }).state;
    expect(() =>
      reducePhase2Telemetry({
        observation: observation(99),
        previous: current,
      }),
    ).toThrow(/tick order/u);
  });
});

function observation(tick: number): Phase2TelemetryObservation {
  return {
    tick,
    attrition: { colonies: [], assets: [], droppedObservations: 0 },
    controllerLevels: [],
    droppedControllerLevels: 0,
    cooldownSlots: [
      [2, 1],
      [3, 2],
      [1, 0],
      [4, 1],
      [1, 0],
    ],
    droppedCooldownInputs: 0,
    controllers: 2,
    rcl8Controllers: 1,
    sustainingColonies: 1,
    controllerProgress: 100,
    controllerProgressTotal: 1_000,
    minimumDowngradeTicks: 50_000,
    energyAvailable: 500,
    energyCapacity: 800,
    storedEnergy: 10_000,
    terminalEnergy: 2_000,
    reserveViolations: 1,
    colonyEnergyReserved: 400,
    colonyCpuReserved: 100,
    colonySpawnTicksReserved: 9,
    activeSpawns: 2,
    busySpawns: 1,
    scheduledSpawns: 1,
    deferredSpawns: 1,
    failedSpawns: 1,
    scheduledSpawnEnergy: 200,
    scheduledSpawnTicks: 9,
    constructionBacklog: 3,
    constructionProgressRemaining: 900,
    layoutComplete: 1,
    layoutDegraded: 1,
    layoutAccepted: 1,
    layoutDeferred: 2,
    layoutRejected: 1,
    layoutExecuted: 1,
    layoutFailed: 1,
    harvestedEnergy: 20,
    wastedEnergy: 2,
    sourceUptimeTicks: 1,
    sourceDowntimeTicks: 1,
    logisticsActiveFlows: 2,
    logisticsDeferredFlows: 1,
    logisticsRequested: 80,
    logisticsScheduled: 60,
    logisticsDelivered: 50,
    logisticsShortfall: 20,
    logisticsLoss: 3,
    linkAccepted: 1,
    linkDeferred: 2,
    linkFailed: 1,
    linkSent: 40,
    linkDelivered: 38,
    linkLost: 2,
    maintenanceAdmitted: 2,
    maintenanceDeferred: 1,
    maintenanceFailed: 1,
    maintenanceRequestedEnergy: 20,
    maintenanceFundedEnergy: 15,
    maintenanceEnergy: 15,
    industryAdmitted: 2,
    industryDeferred: 1,
    industryFailed: 1,
    industryReserved: 30,
    terminalTransactionEnergyPlanned: 4,
    industryEnergyInput: 190,
    industryResourceInput: 113,
    labAdmitted: 1,
    labDeferred: 1,
    labFailed: 1,
    labOutput: 5,
    matureAdmitted: 1,
    matureDeferred: 1,
    matureFailed: 1,
    factoryOutput: 6,
    powerOutput: 7,
    observerAdmitted: 1,
    observerDeferred: 1,
    observerFailed: 1,
    measuredCpuMilli: 250,
    droppedInputs: 0,
  };
}

function game(time: number) {
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}

function sample(tick: number) {
  return {
    tick,
    harvestedEnergy: 0,
    logisticsDelivered: 0,
    linkDelivered: 0,
    industryEnergyInput: 0,
    industryResourceInput: 0,
    industryOutput: 0,
    authorityFailures: 0,
    reserveViolations: 0,
    measuredCpuMilli: 0,
    cooldownSlots: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  };
}
