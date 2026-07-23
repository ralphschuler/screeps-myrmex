import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseLayoutsOwner,
  reconcileStaleLayoutRemovalReceipt,
  reconcileStaleLayoutSiteReceipt,
  type LayoutsOwnerV25,
} from "../src/layout";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";
import { PLAIN_ROOM_TERRAIN } from "./support/room-terrain-fixture";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const ROOM_NAME = "W1N1";

interface StaleSiteEvidence {
  readonly ownership: "foreign" | "owned";
  readonly structureType: string;
  readonly x: number;
  readonly y: number;
}

interface GameOptions {
  readonly blockedTerrain?: boolean;
  readonly controllerLevel?: number;
  readonly controllerRisk?: boolean;
  readonly reverse?: boolean;
  readonly staleRemovalTarget?: boolean;
  readonly staleRemovalTargetType?: "extension" | "link" | "spawn" | "tower";
  readonly staleSiteEvidence?: StaleSiteEvidence;
  readonly threat?: boolean;
  readonly visible?: boolean;
}

interface Commands {
  readonly createConstructionSite: ReturnType<typeof vi.fn<() => number>>;
  readonly destroyStructure: ReturnType<typeof vi.fn<() => number>>;
}

type StaleActiveEvidence =
  | "completed-extension-evacuation"
  | "completed-extension-evacuation-with-site"
  | "completed-link-evacuation"
  | "completed-link-evacuation-with-site"
  | "completed-spawn-evacuation"
  | "completed-spawn-evacuation-with-site"
  | "completed-tower-evacuation"
  | "completed-tower-evacuation-with-site"
  | "container-migration"
  | "evacuation"
  | "site-receipt"
  | "source-handoff"
  | null;

describe("stale layout revision runtime handoff (#385/#387/#389/#391/#393/#395/#397)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("persists one command-free handoff, then resumes ordinary convergence", () => {
    const forward = runHandoffVariant(false, false);
    const reset = runHandoffVariant(false, true);
    const reordered = runHandoffVariant(true, false);

    expect(forward.handoffCalls).toBe(0);
    expect(forward.followingCalls).toBe(1);
    expect(forward.followingAccepted).toBe(1);
    expect(forward.followingPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "complete" }),
    ]);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.owner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      schemaVersion: 25,
      staleRecords: [],
    });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("suppresses every room's layout commands while admitting only one stale handoff", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(300, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(301, firstCommands, secondCommands), memory });
    seedStaleOwner(memory, null, "W1N1");
    firstCommands.createConstructionSite.mockClear();
    secondCommands.createConstructionSite.mockClear();

    const handoff = runTick({ game: twoRoomGame(302, firstCommands, secondCommands), memory });

    expect(handoff.layout.planning).toEqual([
      expect.objectContaining({ roomName: "W1N1", status: "handoff" }),
    ]);
    expect(handoff.layout.arbitration?.accepted).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();

    runTick({ game: twoRoomGame(303, firstCommands, secondCommands), memory });
    expect(
      firstCommands.createConstructionSite.mock.calls.length +
        secondCommands.createConstructionSite.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("suppresses every room's site/removal output while settling one stale receipt", () => {
    const firstCommands = commandSpies();
    const secondCommands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: twoRoomGame(300, firstCommands, secondCommands), memory });
    runTick({ game: twoRoomGame(301, firstCommands, secondCommands), memory });
    const target = seedStaleSiteReceipt(memory, {});
    firstCommands.createConstructionSite.mockClear();
    secondCommands.createConstructionSite.mockClear();

    const settlement = runTick({
      game: twoRoomGame(302, firstCommands, secondCommands, {
        staleSiteEvidence: {
          ownership: "owned",
          structureType: target.structureType,
          x: target.x,
          y: target.y,
        },
      }),
      memory,
    });

    expect(settlement.layout.planning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(settlement.layout.arbitration?.intents).toEqual([]);
    expect(settlement.layout.execution).toEqual([]);
    expect(settlement.layout.migration.proposals).toEqual([]);
    expect(settlement.layout.migration.arbitration?.intents ?? []).toEqual([]);
    expect(settlement.layout.migration.execution).toEqual([]);
    expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
    expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
    expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
  });

  it.each(["extension", "link", "spawn", "tower"] as const)(
    "suppresses every room's layout commands while settling one stale %s pair",
    (kind) => {
      const firstCommands = commandSpies();
      const secondCommands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: twoRoomGame(100, firstCommands, secondCommands), memory });
      runTick({ game: twoRoomGame(101, firstCommands, secondCommands), memory });
      seedStaleRemovalReceipt(memory, {}, `completed-${kind}-evacuation`);
      runTick({
        game: twoRoomGame(102, firstCommands, secondCommands, {
          staleRemovalTarget: true,
          staleRemovalTargetType: kind,
        }),
        memory,
      });
      const priorOwner = layoutsOwner(memory);
      const priorOtherRoom = priorOwner.records.find(({ roomName }) => roomName === "W2N2");
      if (priorOtherRoom === undefined) throw new Error("expected unaffected second-room record");
      firstCommands.createConstructionSite.mockClear();
      firstCommands.destroyStructure.mockClear();
      secondCommands.createConstructionSite.mockClear();
      secondCommands.destroyStructure.mockClear();

      const settlement = runTick({ game: twoRoomGame(103, firstCommands, secondCommands), memory });

      const settledOwner = layoutsOwner(memory);
      const settledRecord = settledOwner.staleRecords[0];
      expect(settledOwner.revision).toBe(priorOwner.revision + 1);
      expect(staleEvacuation(settledRecord, kind)).toBeUndefined();
      expect(settledRecord?.removalReceipt).toBeUndefined();
      expect(settledOwner.records.find(({ roomName }) => roomName === "W2N2")).toEqual(
        priorOtherRoom,
      );
      expect(settlement.layout.planning).toEqual([
        expect.objectContaining({
          blocker: "revision-handoff-active",
          roomName: ROOM_NAME,
          status: "degraded",
        }),
      ]);
      expect(settlement.layout.arbitration?.accepted ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.deferred ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.intents ?? []).toEqual([]);
      expect(settlement.layout.arbitration?.rejected ?? []).toEqual([]);
      expect(settlement.layout.execution).toEqual([]);
      expect(settlement.layout.migration.proposals).toEqual([]);
      expect(settlement.layout.migration.arbitration?.intents ?? []).toEqual([]);
      expect(settlement.layout.migration.execution).toEqual([]);
      expect(firstCommands.createConstructionSite).not.toHaveBeenCalled();
      expect(firstCommands.destroyStructure).not.toHaveBeenCalled();
      expect(secondCommands.createConstructionSite).not.toHaveBeenCalled();
      expect(secondCommands.destroyStructure).not.toHaveBeenCalled();
    },
  );

  it("settles an exact owned construction-site observation without changing another receipt", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    const target = seedStaleSiteReceipt(memory, {});
    const owner = layoutsOwner(memory);
    const staleRecord = owner.staleRecords[0];
    const successfulReceipt = staleRecord?.siteReceipts?.[0];
    if (staleRecord === undefined || successfulReceipt === undefined)
      throw new Error("expected one stale successful site receipt");
    const ownerWithPending = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...staleRecord,
          siteReceipts: [
            successfulReceipt,
            { ...successfulReceipt, code: "ERR_FULL" },
            successfulReceipt,
          ],
        },
      ],
    });
    if (ownerWithPending === null) throw new Error("expected valid stale receipt owner");
    const serializedOwner: unknown = JSON.parse(JSON.stringify(ownerWithPending));
    const resetOwner = parseLayoutsOwner(serializedOwner);
    if (resetOwner === null) throw new Error("expected reset stale receipt owner");
    const constructionSites = [
      {
        id: "observed-site",
        ownerUsername: "Myrmex",
        ownership: "owned" as const,
        pos: { roomName: ROOM_NAME, x: target.x, y: target.y },
        progress: 0,
        progressTotal: 5_000,
        structureType: target.structureType,
      },
    ];
    const reconcile = (candidate: LayoutsOwnerV25) =>
      reconcileStaleLayoutSiteReceipt({
        constructionSites,
        observedAt: 102,
        owner: candidate,
        roomName: ROOM_NAME,
        structures: [],
      });

    const result = reconcile(ownerWithPending);
    const resetResult = reconcile(resetOwner);

    expect(result.settled).toMatchObject({ code: "OK" });
    expect(result.owner.staleRecords).toHaveLength(1);
    expect(result.owner.staleRecords[0]?.siteReceipts?.map(({ code }) => code)).toEqual([
      "ERR_FULL",
      "OK",
    ]);
    expect(resetResult).toEqual(result);
    const observedSite = constructionSites[0];
    if (observedSite === undefined) throw new Error("expected observed site fixture");

    const crossRoom = reconcileStaleLayoutSiteReceipt({
      constructionSites: [
        {
          ...observedSite,
          pos: { roomName: "W2N2", x: target.x, y: target.y },
        },
      ],
      observedAt: 102,
      owner: ownerWithPending,
      roomName: ROOM_NAME,
      structures: [],
    });
    expect(crossRoom.settled).toBeNull();
    expect(crossRoom.owner).toBe(ownerWithPending);
  });

  it("settles one freshly observed stale site before a later command-free handoff", () => {
    const forward = runStaleSiteSettlementVariant(false, false);
    const reset = runStaleSiteSettlementVariant(false, true);
    const reordered = runStaleSiteSettlementVariant(true, false);

    expect(forward.settlementCalls).toBe(0);
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.settledOwner.records).toEqual([]);
    expect(forward.settledOwner.staleRecords).toHaveLength(1);
    expect(forward.settledOwner.staleRecords[0]?.siteReceipts).toBeUndefined();
    expect(forward.handoffCalls).toBe(0);
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffOwner).toMatchObject({
      records: [
        expect.objectContaining({ algorithmRevision: "owned-room-layout-v2-source-services" }),
      ],
      staleRecords: [],
    });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it("settles one successful stale removal from newer complete target absence", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, {});
    const owner = layoutsOwner(memory);
    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: null,
      observedAt: 102,
      owner,
      roomName: ROOM_NAME,
      structures: [],
    });

    expect(result.settled).toMatchObject({ code: "OK", targetId: "extension-obsolete" });
    expect(result.owner.staleRecords).toHaveLength(1);
    expect(result.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");
    const priorRecord = owner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected stale removal record");
    const { removalReceipt: _removalReceipt, ...retained } = priorRecord;
    void _removalReceipt;
    expect(result.owner.staleRecords[0]).toEqual(retained);

    const targetAbsentOwner = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...priorRecord,
          removalReceipt: { ...priorRecord.removalReceipt, code: "TARGET_ABSENT" },
        },
      ],
    });
    if (targetAbsentOwner === null) throw new Error("expected target-absent stale receipt owner");
    expect(
      reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: targetAbsentOwner,
        roomName: ROOM_NAME,
        structures: [],
      }).settled,
    ).toMatchObject({ code: "TARGET_ABSENT" });
  });

  it.each(["extension", "link", "spawn", "tower"] as const)(
    "atomically settles one completed stale %s evacuation pair",
    (kind) => {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(memory, {}, `completed-${kind}-evacuation`);
      const owner = layoutsOwner(memory);
      const priorRecord = owner.staleRecords[0];
      const evacuation = staleEvacuation(priorRecord, kind);
      if (
        priorRecord === undefined ||
        evacuation === undefined ||
        priorRecord.removalReceipt === undefined
      )
        throw new Error(`expected completed stale ${kind} evacuation`);

      const result = reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner,
        roomName: ROOM_NAME,
        structures: [],
      });
      const evacuationKey = `${kind}Evacuation`;

      expect(result.settled).toMatchObject({
        code: "OK",
        replacementId: evacuation.replacementId,
        targetId: evacuation.sourceId,
        targetStructureType: kind,
      });
      expect(result.owner.revision).toBe(owner.revision + 1);
      expect(result.owner.staleRecords).toHaveLength(1);
      expect(result.owner.staleRecords[0]).not.toHaveProperty(evacuationKey);
      expect(result.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");
      expect(result.owner.staleRecords[0]).toEqual(withoutCompletedEvacuation(priorRecord, kind));

      const targetAbsentOwner = parseLayoutsOwner({
        ...owner,
        staleRecords: [
          {
            ...priorRecord,
            removalReceipt: { ...priorRecord.removalReceipt, code: "TARGET_ABSENT" },
          },
        ],
      });
      if (targetAbsentOwner === null) throw new Error("expected paired target-absent owner");
      const targetAbsentResult = reconcileStaleLayoutRemovalReceipt({
        blocker: null,
        observedAt: 102,
        owner: targetAbsentOwner,
        roomName: ROOM_NAME,
        structures: [],
      });
      expect(targetAbsentResult.settled).toMatchObject({ code: "TARGET_ABSENT" });
      expect(targetAbsentResult.owner.staleRecords[0]).not.toHaveProperty(evacuationKey);
      expect(targetAbsentResult.owner.staleRecords[0]).not.toHaveProperty("removalReceipt");

      const lowerBoundOwner = parseLayoutsOwner({
        ...owner,
        staleRecords: [
          {
            ...priorRecord,
            removalReceipt: {
              ...priorRecord.removalReceipt,
              observedAt: evacuation.startedAt,
            },
          },
        ],
      });
      if (lowerBoundOwner === null) throw new Error("expected lower-bound completed owner");
      expect(
        reconcileStaleLayoutRemovalReceipt({
          blocker: null,
          observedAt: evacuation.startedAt + 1,
          owner: lowerBoundOwner,
          roomName: ROOM_NAME,
          structures: [],
        }).settled,
      ).toMatchObject({ observedAt: evacuation.startedAt });
    },
  );

  it("preserves a completed stale spawn pair when another evacuation remains active", () => {
    const commands = commandSpies();
    const memory = {} as Memory;
    runTick({ game: game(100, commands), memory });
    runTick({ game: game(101, commands), memory });
    seedStaleRemovalReceipt(memory, {}, "completed-spawn-evacuation");
    const owner = layoutsOwner(memory);
    const priorRecord = owner.staleRecords[0];
    if (priorRecord === undefined) throw new Error("expected completed stale spawn record");
    const mixedOwner = parseLayoutsOwner({
      ...owner,
      staleRecords: [
        {
          ...priorRecord,
          towerEvacuation: {
            amount: 500,
            expiresAt: 250,
            replacementId: "tower-replacement",
            replacementInitialEnergy: 10,
            sourceId: "tower-obsolete",
            startedAt: 100,
          },
        },
      ],
    });
    if (mixedOwner === null) throw new Error("expected mixed stale evacuation owner");

    const result = reconcileStaleLayoutRemovalReceipt({
      blocker: null,
      observedAt: 102,
      owner: mixedOwner,
      roomName: ROOM_NAME,
      structures: [],
    });

    expect(result.settled).toBeNull();
    expect(result.owner).toBe(mixedOwner);
  });

  it("settles stale removal command-free before a later revision handoff", async () => {
    const forward = await runStaleRemovalSettlementVariant(false, false);
    const reset = await runStaleRemovalSettlementVariant(false, true);
    const reordered = await runStaleRemovalSettlementVariant(true, false);

    expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({ code: "OK" });
    expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
    expect(forward.settlementOwner.records).toEqual([]);
    expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.settlementPlanning).toEqual([
      expect.objectContaining({
        blocker: "revision-handoff-active",
        roomName: ROOM_NAME,
        status: "degraded",
      }),
    ]);
    expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
    expect(forward.handoffPlanning).toEqual([
      expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
    ]);
    expect(forward.handoffOwner).toMatchObject({ records: [expect.anything()], staleRecords: [] });
    expect(reset).toEqual(forward);
    expect(reordered).toEqual(forward);
  });

  it.each(["link", "spawn"] as const)(
    "settles target-absent %s evidence across runtime variants",
    async (kind) => {
      const forward = await runStaleRemovalSettlementVariant(false, false, kind, "TARGET_ABSENT");
      const reset = await runStaleRemovalSettlementVariant(false, true, kind, "TARGET_ABSENT");
      const reordered = await runStaleRemovalSettlementVariant(true, false, kind, "TARGET_ABSENT");

      expect(forward.pendingOwner.staleRecords[0]?.removalReceipt).toMatchObject({
        code: "TARGET_ABSENT",
      });
      expect(staleEvacuation(forward.settlementOwner.staleRecords[0], kind)).toBeUndefined();
      expect(forward.settlementOwner.staleRecords[0]?.removalReceipt).toBeUndefined();
      expect(reset).toEqual(forward);
      expect(reordered).toEqual(forward);
    },
  );

  it.each(["extension", "link", "spawn", "tower"] as const)(
    "settles a completed stale %s evacuation before a later revision handoff",
    async (kind) => {
      const forward = await runStaleRemovalSettlementVariant(false, false, kind);
      const reset = await runStaleRemovalSettlementVariant(false, true, kind);
      const reordered = await runStaleRemovalSettlementVariant(true, false, kind);
      const pendingRecord = forward.pendingOwner.staleRecords[0];
      const settlementRecord = forward.settlementOwner.staleRecords[0];

      expect(staleEvacuation(pendingRecord, kind)).toBeDefined();
      expect(pendingRecord?.removalReceipt).toMatchObject({ code: "OK" });
      expect(staleEvacuation(settlementRecord, kind)).toBeUndefined();
      expect(settlementRecord?.removalReceipt).toBeUndefined();
      expect(forward.settlementOwner.records).toEqual([]);
      expect(forward.settlementCommands).toEqual({ create: 0, destroy: 0 });
      expect(forward.settlementPlanning).toEqual([
        expect.objectContaining({
          blocker: "revision-handoff-active",
          roomName: ROOM_NAME,
          status: "degraded",
        }),
      ]);
      expect(forward.handoffCommands).toEqual({ create: 0, destroy: 0 });
      expect(forward.handoffPlanning).toEqual([
        expect.objectContaining({ blocker: null, roomName: ROOM_NAME, status: "handoff" }),
      ]);
      expect(forward.handoffOwner).toMatchObject({
        records: [expect.anything()],
        staleRecords: [],
      });
      expect(reset).toEqual(forward);
      expect(reordered).toEqual(forward);
    },
  );

  it("preserves stale removal receipts without exact terminal-success absence evidence", () => {
    for (const testCase of [
      { name: "target present", observedAt: 102, receipt: {}, structures: ["extension-obsolete"] },
      { name: "same tick", observedAt: 101, receipt: {}, structures: [] },
      {
        name: "storage",
        observedAt: 102,
        receipt: { targetStructureType: "storage" },
        structures: [],
      },
      { name: "failed", observedAt: 102, receipt: { code: "ERR_BUSY" }, structures: [] },
      {
        name: "incomplete structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
      },
      {
        name: "active evacuation",
        blocker: "revision-handoff-active",
        observedAt: 102,
        receipt: {},
        structures: [],
        withEvacuation: true,
      },
      {
        name: "wrong paired target",
        observedAt: 102,
        receipt: { targetId: "different-extension" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "wrong paired replacement",
        observedAt: 102,
        receipt: { replacementId: "different-extension" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "wrong paired type",
        observedAt: 102,
        receipt: { targetStructureType: "container" },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "extension",
      },
      {
        name: "spawn target present",
        observedAt: 102,
        receipt: {},
        structures: ["spawn-obsolete"],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "incomplete spawn structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "spawn",
      },
      {
        name: "unsafe spawn policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn target",
        observedAt: 102,
        receipt: { targetId: "different-spawn" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn replacement",
        observedAt: 102,
        receipt: { replacementId: "different-spawn" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "wrong spawn type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "spawn receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "spawn",
      },
      {
        name: "link target present",
        observedAt: 102,
        receipt: {},
        structures: ["link-obsolete"],
        completedEvacuation: "link",
      },
      {
        name: "link same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "incomplete link structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "link",
      },
      {
        name: "unsafe link policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link target",
        observedAt: 102,
        receipt: { targetId: "different-link" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link replacement",
        observedAt: 102,
        receipt: { replacementId: "different-link" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "wrong link type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "link receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "link",
      },
      {
        name: "tower target present",
        observedAt: 102,
        receipt: {},
        structures: ["tower-obsolete"],
        completedEvacuation: "tower",
      },
      {
        name: "tower same tick",
        observedAt: 101,
        receipt: {},
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower failed",
        observedAt: 102,
        receipt: { code: "ERR_BUSY" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "incomplete tower structure projection",
        observedAt: 102,
        receipt: {},
        structures: undefined,
        completedEvacuation: "tower",
      },
      {
        name: "unsafe tower policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower target",
        observedAt: 102,
        receipt: { targetId: "different-tower" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower replacement",
        observedAt: 102,
        receipt: { replacementId: "different-tower" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "wrong tower type",
        observedAt: 102,
        receipt: { targetStructureType: "extension" },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower receipt predates evacuation",
        observedAt: 102,
        receipt: { observedAt: 99 },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "tower receipt at evacuation expiry",
        observedAt: 251,
        receipt: { observedAt: 250 },
        structures: [],
        completedEvacuation: "tower",
      },
      {
        name: "unsafe policy",
        blocker: "policy-unavailable",
        observedAt: 102,
        receipt: {},
        structures: [],
      },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      const completedEvacuation =
        "completedEvacuation" in testCase ? testCase.completedEvacuation : null;
      seedStaleRemovalReceipt(
        memory,
        testCase.receipt,
        completedEvacuation === null
          ? testCase.withEvacuation === true
            ? "evacuation"
            : null
          : `completed-${completedEvacuation}-evacuation`,
      );
      const owner = layoutsOwner(memory);
      const result = reconcileStaleLayoutRemovalReceipt({
        blocker: testCase.blocker ?? null,
        observedAt: testCase.observedAt,
        owner,
        roomName: ROOM_NAME,
        structures: testCase.structures?.map((id) => ({ id })),
      });

      expect(result.settled, testCase.name).toBeNull();
      expect(result.owner, testCase.name).toBe(owner);
    }
  });

  it("keeps stale removal receipts blocked by active or unsafe runtime evidence", () => {
    for (const testCase of [
      { active: "evacuation", name: "active evacuation", options: {} },
      {
        active: "completed-extension-evacuation-with-site",
        name: "completed extension evacuation with another active term",
        options: {},
      },
      {
        active: "completed-link-evacuation-with-site",
        name: "completed link evacuation with another active term",
        options: {},
      },
      {
        active: "completed-spawn-evacuation-with-site",
        name: "completed spawn evacuation with another active term",
        options: {},
      },
      {
        active: "completed-tower-evacuation-with-site",
        name: "completed tower evacuation with another active term",
        options: {},
      },
      { active: "container-migration", name: "active migration", options: {} },
      { active: "site-receipt", name: "active site receipt", options: {} },
      { active: "source-handoff", name: "active source handoff", options: {} },
      { active: null, name: "unsafe threat", options: { threat: true } },
      { active: null, name: "unknown vision", options: { visible: false } },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(100, commands), memory });
      runTick({ game: game(101, commands), memory });
      seedStaleRemovalReceipt(memory, {}, testCase.active);
      commands.createConstructionSite.mockClear();
      commands.destroyStructure.mockClear();

      const outcome = runTick({ game: game(102, commands, testCase.options), memory });
      const owner = layoutsOwner(memory);

      expect(owner.staleRecords[0]?.removalReceipt, testCase.name).toMatchObject({ code: "OK" });
      expect(owner.records, testCase.name).toEqual([]);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(commands.destroyStructure, testCase.name).not.toHaveBeenCalled();
      if (testCase.options.visible === false) expect(outcome.layout.planning).toEqual([]);
      else
        expect(outcome.layout.planning[0], testCase.name).toMatchObject({
          blocker: "revision-handoff-active",
          status: "degraded",
        });
    }
  });

  it("preserves stale site receipts without fresh exact successful owned evidence", () => {
    for (const testCase of [
      { name: "absent", evidence: null, receipt: {} },
      { name: "foreign structure", evidence: { ownership: "foreign" }, receipt: {} },
      {
        name: "wrong position",
        evidence: { ownership: "owned", xOffset: 1 },
        receipt: {},
      },
      {
        name: "wrong structure type",
        evidence: { ownership: "owned", structureType: "road" },
        receipt: {},
      },
      {
        name: "malformed proposal identity",
        evidence: { ownership: "owned" },
        receipt: { proposalId: "not-a-layout-site" },
      },
      {
        name: "noncanonical identity prefix",
        evidence: { ownership: "owned" },
        receipt: { proposalId: "noncanonical-prefix" },
      },
      {
        name: "different layout fingerprint",
        evidence: { ownership: "owned" },
        receipt: { layoutFingerprint: "layout-v2:different" },
      },
      {
        name: "non-success result",
        evidence: { ownership: "owned" },
        receipt: { code: "ERR_FULL" },
      },
      {
        name: "same-tick result",
        evidence: { ownership: "owned" },
        receipt: { observedAt: 202 },
      },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(200, commands), memory });
      runTick({ game: game(201, commands), memory });
      const target = seedStaleSiteReceipt(memory, testCase.receipt);
      commands.createConstructionSite.mockClear();
      const evidence =
        testCase.evidence === null
          ? undefined
          : {
              ownership: testCase.evidence.ownership,
              structureType: testCase.evidence.structureType ?? target.structureType,
              x: target.x + (testCase.evidence.xOffset ?? 0),
              y: target.y,
            };

      const outcome = runTick({
        game: game(202, commands, evidence === undefined ? {} : { staleSiteEvidence: evidence }),
        memory,
      });
      const owner = layoutsOwner(memory);

      expect(outcome.kernel.faults, testCase.name).toEqual([]);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(owner.records, testCase.name).toEqual([]);
      expect(owner.staleRecords[0]?.siteReceipts, testCase.name).toHaveLength(1);
      expect(outcome.layout.planning[0], testCase.name).toMatchObject({
        blocker: "revision-handoff-active",
        status: "degraded",
      });
    }
  });

  it("preserves active or unsafe stale evidence and authorizes no command", () => {
    for (const testCase of [
      { name: "active evacuation", active: "evacuation", options: {} },
      { name: "active source handoff", active: "source-handoff", options: {} },
      { name: "threat", active: null, options: { threat: true } },
      { name: "controller risk", active: null, options: { controllerRisk: true } },
      { name: "RCL outside policy", active: null, options: { controllerLevel: 1 } },
      { name: "blocked source access", active: null, options: { blockedTerrain: true } },
      { name: "unknown vision", active: null, options: { visible: false } },
    ] as const) {
      const commands = commandSpies();
      const memory = {} as Memory;
      runTick({ game: game(200, commands), memory });
      runTick({ game: game(201, commands), memory });
      seedStaleOwner(memory, testCase.active);
      commands.createConstructionSite.mockClear();

      const outcome = runTick({ game: game(202, commands, testCase.options), memory });
      const owner = parseLayoutsOwner(memory.myrmex?.layouts);
      if (owner === null) throw new Error("expected parsed layouts owner");

      expect(outcome.kernel.faults, testCase.name).toEqual([]);
      expect(outcome.stateCommit?.committed, testCase.name).toBe(true);
      expect(
        (memory.myrmex?.layouts as { readonly schemaVersion?: unknown } | undefined)?.schemaVersion,
        testCase.name,
      ).toBe(25);
      expect(commands.createConstructionSite, testCase.name).not.toHaveBeenCalled();
      expect(owner.records, testCase.name).toEqual([]);
      expect(owner.staleRecords, testCase.name).toHaveLength(1);
      if (testCase.options.visible === false) expect(outcome.layout.planning).toEqual([]);
      else expect(outcome.layout.planning[0], testCase.name).toMatchObject({ status: "degraded" });
      if (testCase.active !== null)
        expect(outcome.layout.planning[0]).toMatchObject({ blocker: "revision-handoff-active" });
    }
  });
});

function runStaleSiteSettlementVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  runTick({ game: game(100, commands, { reverse }), memory });
  runTick({ game: game(101, commands, { reverse }), memory });
  const target = seedStaleSiteReceipt(memory, {});
  if (reset) memory = JSON.parse(JSON.stringify(memory)) as Memory;
  commands.createConstructionSite.mockClear();
  const staleSiteEvidence: StaleSiteEvidence = {
    ownership: "owned",
    structureType: target.structureType,
    x: target.x,
    y: target.y,
  };

  const settlement = runTick({
    game: game(102, commands, { reverse, staleSiteEvidence }),
    memory,
  });
  const settledOwner = layoutsOwner(memory);
  const settlementCalls = commands.createConstructionSite.mock.calls.length;
  commands.createConstructionSite.mockClear();
  const handoff = runTick({
    game: game(103, commands, { reverse, staleSiteEvidence }),
    memory,
  });

  return {
    handoffCalls: commands.createConstructionSite.mock.calls.length,
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    settledOwner,
    settlementCalls,
    settlementPlanning: settlement.layout.planning,
  };
}

async function runStaleRemovalSettlementVariant(
  reverse: boolean,
  reset: boolean,
  completedEvacuation: "extension" | "link" | "spawn" | "tower" | null = null,
  receiptCode: "OK" | "TARGET_ABSENT" = "OK",
) {
  const commands = commandSpies();
  let memory = {} as Memory;
  let executeTick = runTick;
  executeTick({ game: game(100, commands, { reverse }), memory });
  executeTick({ game: game(101, commands, { reverse }), memory });
  seedStaleRemovalReceipt(
    memory,
    { code: receiptCode },
    completedEvacuation === null ? null : `completed-${completedEvacuation}-evacuation`,
  );
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();

  executeTick({
    game: game(102, commands, {
      reverse,
      staleRemovalTarget: true,
      ...(completedEvacuation === null ? {} : { staleRemovalTargetType: completedEvacuation }),
    }),
    memory,
  });
  const pendingOwner = layoutsOwner(memory);
  if (reset) {
    memory = JSON.parse(JSON.stringify(memory)) as Memory;
    vi.resetModules();
    executeTick = (await import("../src/runtime/tick")).runTick;
  }
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();
  const settlement = executeTick({ game: game(103, commands, { reverse }), memory });
  const settlementOwner = layoutsOwner(memory);
  const settlementCommands = {
    create: commands.createConstructionSite.mock.calls.length,
    destroy: commands.destroyStructure.mock.calls.length,
  };
  commands.createConstructionSite.mockClear();
  commands.destroyStructure.mockClear();
  const handoff = executeTick({ game: game(104, commands, { reverse }), memory });

  return {
    handoffCommands: {
      create: commands.createConstructionSite.mock.calls.length,
      destroy: commands.destroyStructure.mock.calls.length,
    },
    handoffOwner: layoutsOwner(memory),
    handoffPlanning: handoff.layout.planning,
    pendingOwner,
    settlementCommands,
    settlementOwner,
    settlementPlanning: settlement.layout.planning,
  };
}

function runHandoffVariant(reverse: boolean, reset: boolean) {
  const commands = commandSpies();
  let memory = {} as Memory;
  runTick({ game: game(100, commands, { reverse }), memory });
  runTick({ game: game(101, commands, { reverse }), memory });
  seedStaleOwner(memory, null);
  if (reset) memory = JSON.parse(JSON.stringify(memory)) as Memory;
  commands.createConstructionSite.mockClear();

  const handoff = runTick({ game: game(102, commands, { reverse }), memory });
  const owner = JSON.parse(JSON.stringify(layoutsOwner(memory))) as unknown;
  const handoffCalls = commands.createConstructionSite.mock.calls.length;
  commands.createConstructionSite.mockClear();
  const following = runTick({ game: game(103, commands, { reverse }), memory });

  return {
    followingAccepted: following.layout.arbitration?.accepted.length ?? 0,
    followingCalls: commands.createConstructionSite.mock.calls.length,
    followingPlanning: following.layout.planning,
    handoffCalls,
    handoffPlanning: handoff.layout.planning,
    owner,
  };
}

function seedStaleRemovalReceipt(
  memory: Memory,
  overrides: Partial<NonNullable<LayoutsOwnerV25["records"][number]["removalReceipt"]>>,
  active: StaleActiveEvidence = null,
): void {
  seedStaleOwner(memory, active);
  const owner = layoutsOwner(memory);
  const staleRecord = owner.staleRecords.find((record) => record.roomName === ROOM_NAME);
  if (staleRecord === undefined) throw new Error("expected stale layout record");
  const structureType = active?.startsWith("completed-link-evacuation")
    ? ("link" as const)
    : active?.startsWith("completed-spawn-evacuation")
      ? ("spawn" as const)
      : active?.startsWith("completed-tower-evacuation")
        ? ("tower" as const)
        : ("extension" as const);
  const removalReceipt = {
    attempt: 1,
    code: "OK" as const,
    nextEligibleTick: Number.MAX_SAFE_INTEGER,
    observedAt: 101,
    replacementId: `${structureType}-replacement`,
    targetId: `${structureType}-obsolete`,
    targetStructureType: structureType,
    ...overrides,
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      ...owner,
      staleRecords: [
        {
          ...staleRecord,
          removalReceipt,
        },
      ],
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
}

function seedStaleSiteReceipt(
  memory: Memory,
  overrides: Partial<NonNullable<LayoutsOwnerV25["records"][number]["siteReceipts"]>[number]>,
): { readonly structureType: string; readonly x: number; readonly y: number } {
  const owner = layoutsOwner(memory);
  const current = owner.records.find((record) => record.roomName === ROOM_NAME);
  const receipt = current?.siteReceipts?.find(({ code }) => code === "OK");
  if (current === undefined || receipt === undefined)
    throw new Error("expected initialized layout site receipt");
  const proposalId = `site-v1:colony:${ROOM_NAME}:${current.fingerprint}:0:extension:40:40`;
  const normalizedOverrides =
    overrides.proposalId === "noncanonical-prefix"
      ? {
          ...overrides,
          proposalId: `site-v1:extra:${proposalId.slice("site-v1:".length)}`,
        }
      : overrides;
  const canonicalReceipt = { ...receipt, proposalId, ...normalizedOverrides };
  const identity = parseSiteIdentity(proposalId);
  const staleRecord = {
    ...current,
    algorithmRevision: "owned-room-layout-v1",
    siteReceipts: [canonicalReceipt],
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      records: owner.records.map((record) =>
        record.roomName === ROOM_NAME ? staleRecord : record,
      ),
      revision: owner.revision,
      schemaVersion: 24,
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
  return identity;
}

function parseSiteIdentity(proposalId: string): {
  readonly structureType: string;
  readonly x: number;
  readonly y: number;
} {
  const fields = proposalId.split(":");
  const x = Number(fields[fields.length - 1]);
  const y = Number(fields[fields.length - 2]);
  const structureType = fields[fields.length - 3];
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || structureType === undefined)
    throw new Error("expected canonical layout site identity");
  return { structureType, x, y };
}

function seedStaleOwner(memory: Memory, active: StaleActiveEvidence, roomName = ROOM_NAME): void {
  const owner = layoutsOwner(memory);
  const current = owner.records.find((record) => record.roomName === roomName);
  if (current === undefined) throw new Error("expected initialized layout record");
  const {
    containerMigration: _containerMigration,
    extensionEvacuation: _extensionEvacuation,
    labEvacuation: _labEvacuation,
    linkEvacuation: _linkEvacuation,
    removalReceipt: _removalReceipt,
    siteReceipts: _siteReceipts,
    spawnEvacuation: _spawnEvacuation,
    storageEvacuation: _storageEvacuation,
    terminalEvacuation: _terminalEvacuation,
    towerEvacuation: _towerEvacuation,
    ...stable
  } = current;
  void [
    _containerMigration,
    _extensionEvacuation,
    _labEvacuation,
    _linkEvacuation,
    _removalReceipt,
    _siteReceipts,
    _spawnEvacuation,
    _storageEvacuation,
    _terminalEvacuation,
    _towerEvacuation,
  ];
  const completedExtensionEvacuation =
    active !== null && active.startsWith("completed-extension-evacuation");
  const completedLinkEvacuation = active !== null && active.startsWith("completed-link-evacuation");
  const completedSpawnEvacuation =
    active !== null && active.startsWith("completed-spawn-evacuation");
  const completedTowerEvacuation =
    active !== null && active.startsWith("completed-tower-evacuation");
  const staleRecord = {
    ...stable,
    algorithmRevision: "owned-room-layout-v1",
    ...(active === "container-migration"
      ? {
          containerMigration: {
            expiresAt: 350,
            replacementId: "container-replacement",
            startedAt: 200,
            targetId: "container-obsolete",
          },
        }
      : {}),
    ...(active === "evacuation" || completedExtensionEvacuation
      ? {
          extensionEvacuation: {
            amount: 50,
            expiresAt: completedExtensionEvacuation ? 250 : 350,
            replacementId: "extension-replacement",
            replacementInitialEnergy: 0,
            sourceId: "extension-obsolete",
            startedAt: completedExtensionEvacuation ? 100 : 200,
          },
        }
      : {}),
    ...(completedLinkEvacuation
      ? {
          linkEvacuation: {
            amount: 800,
            expiresAt: 250,
            replacementId: "link-replacement",
            replacementInitialEnergy: 0,
            sourceId: "link-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(completedSpawnEvacuation
      ? {
          spawnEvacuation: {
            amount: 300,
            expiresAt: 250,
            replacementId: "spawn-replacement",
            replacementInitialEnergy: 0,
            sourceId: "spawn-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...(completedTowerEvacuation
      ? {
          towerEvacuation: {
            amount: 500,
            expiresAt: 250,
            replacementId: "tower-replacement",
            replacementInitialEnergy: 10,
            sourceId: "tower-obsolete",
            startedAt: 100,
          },
        }
      : {}),
    ...((active === "site-receipt" ||
      active === "completed-extension-evacuation-with-site" ||
      active === "completed-link-evacuation-with-site" ||
      active === "completed-spawn-evacuation-with-site" ||
      active === "completed-tower-evacuation-with-site") &&
    _siteReceipts?.[0] !== undefined
      ? { siteReceipts: [_siteReceipts[0]] }
      : {}),
    ...(active === "source-handoff" && stable.sourceServices !== undefined
      ? {
          sourceServices: stable.sourceServices.map((placement) => ({
            ...placement,
            ...(placement.service === undefined
              ? {}
              : { service: { ...placement.service, issuerSequence: 2 } }),
          })),
        }
      : {}),
  };
  memory.myrmex = {
    ...memory.myrmex,
    layouts: {
      records: owner.records.map((record) => (record.roomName === roomName ? staleRecord : record)),
      revision: owner.revision,
      schemaVersion: 24,
    },
  } as unknown as NonNullable<Memory["myrmex"]>;
}

function staleEvacuation(
  record: LayoutsOwnerV25["staleRecords"][number] | undefined,
  kind: "extension" | "link" | "spawn" | "tower",
) {
  return kind === "extension"
    ? record?.extensionEvacuation
    : kind === "link"
      ? record?.linkEvacuation
      : kind === "spawn"
        ? record?.spawnEvacuation
        : record?.towerEvacuation;
}

function withoutCompletedEvacuation(
  record: LayoutsOwnerV25["staleRecords"][number],
  kind: "extension" | "link" | "spawn" | "tower",
): LayoutsOwnerV25["staleRecords"][number] {
  const { removalReceipt: _removalReceipt, ...withoutReceipt } = record;
  void _removalReceipt;
  if (kind === "extension") {
    const { extensionEvacuation: _extensionEvacuation, ...retained } = withoutReceipt;
    void _extensionEvacuation;
    return retained;
  }
  if (kind === "link") {
    const { linkEvacuation: _linkEvacuation, ...retained } = withoutReceipt;
    void _linkEvacuation;
    return retained;
  }
  if (kind === "spawn") {
    const { spawnEvacuation: _spawnEvacuation, ...retained } = withoutReceipt;
    void _spawnEvacuation;
    return retained;
  }
  const { towerEvacuation: _towerEvacuation, ...retained } = withoutReceipt;
  void _towerEvacuation;
  return retained;
}

function layoutsOwner(memory: Memory): LayoutsOwnerV25 {
  const owner = parseLayoutsOwner(memory.myrmex?.layouts);
  if (owner === null) throw new Error("expected layouts owner");
  return owner;
}

function commandSpies(): Commands {
  return {
    createConstructionSite: vi.fn(() => 0),
    destroyStructure: vi.fn(() => 0),
  };
}

function twoRoomGame(
  time: number,
  firstCommands: Commands,
  secondCommands: Commands,
  firstOptions: GameOptions = {},
): RuntimeGame {
  const first = game(time, firstCommands, firstOptions, "W1N1");
  const second = game(time, secondCommands, {}, "W2N2");
  return {
    ...first,
    creeps: { ...first.creeps, ...second.creeps },
    getObjectById: (id) => first.getObjectById?.(id) ?? second.getObjectById?.(id) ?? null,
    rooms: { ...first.rooms, ...second.rooms },
  };
}

function game(
  time: number,
  commands: Commands,
  options: GameOptions = {},
  roomName = ROOM_NAME,
): RuntimeGame {
  if (options.visible === false)
    return {
      cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: {},
      rooms: {},
      shard: { name: "shard3" },
      time,
    };
  const pos = (x: number, y: number) => ({ roomName, x, y });
  const source = {
    energy: 3_000,
    energyCapacity: 3_000,
    id: `source-${roomName}`,
    pos: pos(10, 10),
    ticksToRegeneration: 300,
  } as unknown as Source;
  const worker = {
    body: ["work", "carry", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: `worker-${roomName}`,
    my: true,
    name: `worker-${roomName}`,
    owner: { username: "Myrmex" },
    pos: pos(25, 25),
    room: { name: roomName },
    spawning: false,
    store: { getCapacity: () => 50, getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: `spawn-${roomName}`,
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24, 25),
    room: { name: roomName },
    spawnCreep: () => 0,
    spawning: null,
    store: { getCapacity: () => 300, getFreeCapacity: () => 0, getUsedCapacity: () => 300 },
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const hostile = {
    body: [{ hits: 100, type: "attack" }],
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: `hostile-${roomName}`,
    my: false,
    name: `hostile-${roomName}`,
    owner: { username: "Enemy" },
    pos: pos(20, 20),
    spawning: false,
    store: { getCapacity: () => 0, getFreeCapacity: () => 0, getUsedCapacity: () => 0 },
    ticksToLive: 1_000,
  } as unknown as Creep;
  const controller = {
    id: `controller-${roomName}`,
    level: options.controllerLevel ?? 3,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(25, 20),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: options.controllerRisk ? 100 : 10_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const completedStructure =
    options.staleSiteEvidence === undefined
      ? null
      : ({
          destroy: commands.destroyStructure,
          hits: 1_000,
          hitsMax: 1_000,
          id: `completed-${roomName}`,
          isActive: () => true,
          my: options.staleSiteEvidence.ownership === "owned",
          owner: {
            username: options.staleSiteEvidence.ownership === "owned" ? "Myrmex" : "OtherPlayer",
          },
          pos: pos(options.staleSiteEvidence.x, options.staleSiteEvidence.y),
          room: { name: roomName },
          store: {
            getCapacity: () => 50,
            getFreeCapacity: () => 50,
            getUsedCapacity: () => 0,
          },
          structureType: options.staleSiteEvidence.structureType,
        } as unknown as AnyStructure);
  const staleRemovalTargetType = options.staleRemovalTargetType ?? "extension";
  const staleRemovalHits =
    staleRemovalTargetType === "spawn" ? 5_000 : staleRemovalTargetType === "tower" ? 3_000 : 1_000;
  const staleRemovalCapacity =
    staleRemovalTargetType === "spawn"
      ? 300
      : staleRemovalTargetType === "tower"
        ? 1_000
        : staleRemovalTargetType === "link"
          ? 800
          : 50;
  const staleRemovalTarget = options.staleRemovalTarget
    ? ({
        destroy: commands.destroyStructure,
        hits: staleRemovalHits,
        hitsMax: staleRemovalHits,
        id: `${staleRemovalTargetType}-obsolete`,
        isActive: () => true,
        my: true,
        ...(staleRemovalTargetType === "spawn"
          ? { name: "ObsoleteSpawn", spawnCreep: () => 0, spawning: null }
          : staleRemovalTargetType === "link"
            ? { cooldown: 0, transferEnergy: () => 0 }
            : {}),
        owner: { username: "Myrmex" },
        pos: pos(40, 40),
        room: { name: roomName },
        store: {
          getCapacity: () => staleRemovalCapacity,
          getFreeCapacity: () => staleRemovalCapacity,
          getUsedCapacity: () => 0,
        },
        structureType: staleRemovalTargetType,
      } as unknown as AnyStructure)
    : null;
  const structures = options.reverse
    ? [
        spawn,
        ...(completedStructure === null ? [] : [completedStructure]),
        ...(staleRemovalTarget === null ? [] : [staleRemovalTarget]),
      ].reverse()
    : [
        spawn,
        ...(completedStructure === null ? [] : [completedStructure]),
        ...(staleRemovalTarget === null ? [] : [staleRemovalTarget]),
      ];
  const creeps = options.threat ? [worker, hostile] : [worker];
  const room = {
    controller,
    createConstructionSite: commands.createConstructionSite,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    find: (kind: number): unknown[] =>
      kind === FIND_CREEPS_VALUE
        ? options.reverse
          ? [...creeps].reverse()
          : creeps
        : kind === FIND_STRUCTURES_VALUE
          ? structures
          : kind === FIND_SOURCES_VALUE
            ? [source]
            : kind === FIND_CONSTRUCTION_SITES_VALUE
              ? []
              : [],
    getTerrain: () => (options.blockedTerrain ? { get: () => 1 } : PLAIN_ROOM_TERRAIN),
    name: roomName,
  } as unknown as Room;
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: { [worker.name]: worker },
    getObjectById: (id) =>
      id === worker.id ? worker : id === spawn.id ? spawn : id === source.id ? source : null,
    rooms: { [roomName]: room },
    shard: { name: "shard3" },
    time,
  };
}
