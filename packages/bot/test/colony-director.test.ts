import { describe, expect, it } from "vitest";
import { ColonyDirector } from "../src/colony";
import {
  MAX_COLONIES,
  MAX_BUDGET_REQUESTS_PER_TICK,
  type BudgetRequest,
} from "../src/colony/contracts";
import { canonicalColoniesOwner } from "../src/colony/persistence";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { emptyWorldSnapshot, freezeWorldSnapshot, type WorldSnapshot } from "../src/world/snapshot";

const CPU_BUDGET = Object.freeze({
  available: 5,
  hardCeiling: 10,
  estimate: 1.5,
  reservedForTail: 2,
});

describe("ColonyDirector owner boundary", () => {
  it("distinguishes unavailable, malformed, future, and exact initializer owners", () => {
    const director = new ColonyDirector();
    const base = {
      tick: 10,
      snapshot: emptyWorldSnapshot(10, "shard3"),
      config: buildRuntimeConfig(),
      cpuMode: "normal" as const,
      cpuBudget: CPU_BUDGET,
    };

    expect(director.plan({ ...base, owner: null })).toMatchObject({
      status: "owner-unavailable",
      replacementOwner: null,
    });
    expect(director.plan({ ...base, owner: { schemaVersion: 1 } })).toMatchObject({
      status: "owner-malformed",
      replacementOwner: null,
    });
    expect(director.plan({ ...base, owner: { schemaVersion: 2 } })).toMatchObject({
      status: "owner-future-schema",
      replacementOwner: null,
    });

    const initialized = director.plan({ ...base, owner: {} });
    expect(initialized).toMatchObject({
      status: "planned",
      ownerRevision: 0,
      colonies: [],
      objectives: [],
      replacementOwner: {
        schemaVersion: 1,
        revision: 0,
        colonies: [],
        ledger: [],
      },
    });
    expect(Object.isFrozen(initialized)).toBe(true);
    expect(Object.isFrozen(initialized.replacementOwner)).toBe(true);
  });

  it("does not parse or replace the owner while the source gate is operator-disabled", () => {
    const result = new ColonyDirector().plan({
      tick: 10,
      snapshot: emptyWorldSnapshot(10, "shard3"),
      config: buildRuntimeConfig({ features: { disabled: ["phase1.colony"] } }),
      owner: { schemaVersion: 999 },
      cpuMode: "normal",
      cpuBudget: CPU_BUDGET,
      requests: Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK * 2 + 1 }, (_, index) =>
        request(index),
      ),
    });

    expect(result).toMatchObject({
      status: "disabled",
      reasonCode: "feature-disabled",
      replacementOwner: null,
    });
  });

  it("bounds unknown external demand before posture decisions", () => {
    const director = new ColonyDirector();
    const base = {
      tick: 10,
      snapshot: emptyWorldSnapshot(10, "shard3"),
      config: buildRuntimeConfig(),
      owner: {},
      cpuMode: "normal" as const,
      cpuBudget: CPU_BUDGET,
    };
    const requests = Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK + 2 }, (_, index) =>
      request(index),
    ).reverse();

    const result = director.plan({ ...base, requests });

    expect(result.decisions).toHaveLength(MAX_BUDGET_REQUESTS_PER_TICK + 2);
    expect(
      result.decisions.filter(({ reasonCode }) => reasonCode === "observation-unknown"),
    ).toHaveLength(MAX_BUDGET_REQUESTS_PER_TICK);
    expect(
      result.decisions.filter(({ reasonCode }) => reasonCode === "request-cap-exceeded"),
    ).toHaveLength(2);
    expect(() =>
      director.plan({
        ...base,
        requests: Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK * 2 + 1 }, (_, index) =>
          request(index),
        ),
      }),
    ).toThrow(/bounded input cap/u);
  });

  it("revises a live recovery request when accepted policy changes its claim", () => {
    const director = new ColonyDirector();
    const first = director.plan({
      tick: 10,
      snapshot: bootstrapSnapshot(10, 400),
      config: buildRuntimeConfig(),
      owner: {},
      cpuMode: "normal",
      cpuBudget: CPU_BUDGET,
    });
    if (first.replacementOwner === null) {
      throw new Error("bootstrap fixture did not produce a colonies owner");
    }

    const changed = director.plan({
      tick: 11,
      snapshot: bootstrapSnapshot(11, 400),
      config: buildRuntimeConfig({
        policy: { recovery: { emergencyWorkerEnergyBudget: 400 } },
      }),
      owner: first.replacementOwner,
      cpuMode: "normal",
      cpuBudget: CPU_BUDGET,
    });

    expect(first.objectives[0]).toMatchObject({
      revision: 1,
      status: "funded",
      budgetReasonCode: "granted",
    });
    expect(changed.objectives[0]).toMatchObject({
      revision: 2,
      status: "funded",
      budgetReasonCode: "granted",
    });
    expect(changed.decisions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ reasonCode: "revision-reused" })]),
    );
    expect(changed.reservations.find(({ revision }) => revision === 2)).toMatchObject({
      revision: 2,
      grant: { energy: 400 },
    });
  });

  it("preserves every persisted colony before admitting a newly observed room at the cap", () => {
    const config = buildRuntimeConfig();
    const colonies = Array.from({ length: MAX_COLONIES }, (_, index) => ({
      roomName: `W${String(index + 10)}N1`,
      state: "developing" as const,
      stateSince: 1,
      revision: 1,
      policyRevision: config.policyRevision,
      reasonCode: "survival-capability-restored" as const,
    }));
    const owner = canonicalColoniesOwner(1, colonies, []);

    const result = new ColonyDirector().plan({
      tick: 10,
      snapshot: bootstrapSnapshot(10, 300, "A0N0"),
      config,
      owner,
      cpuMode: "normal",
      cpuBudget: CPU_BUDGET,
    });

    expect(result.colonies).toHaveLength(MAX_COLONIES);
    expect(result.colonies.some(({ roomName }) => roomName === "A0N0")).toBe(false);
    expect(result.replacementOwner).toBeNull();
  });

  it("derives maturity, controller risk, and diplomacy-filtered threat from active evidence", () => {
    const director = new ColonyDirector();
    const relations = buildRuntimeConfig({
      relations: { self: ["Myrmex"], allies: ["Friend"], naps: ["Neighbor"] },
    });
    const plan = (tick: number, snapshot: WorldSnapshot, config = relations) =>
      director.plan({
        tick,
        snapshot,
        config,
        owner: {},
        cpuMode: "normal",
        cpuBudget: CPU_BUDGET,
      });

    expect(
      plan(
        20,
        bootstrapSnapshot(20, 300, "W1N1", {
          legalWorker: true,
          controllerLevel: 8,
        }),
      ).colonies[0],
    ).toMatchObject({ state: "mature", reasonCode: "maturity-evidence-met" });
    expect(
      plan(
        21,
        bootstrapSnapshot(21, 300, "W1N1", {
          legalWorker: true,
          ticksToDowngrade: 100,
        }),
      ).colonies[0],
    ).toMatchObject({ state: "recovering", reasonCode: "controller-downgrade-risk" });

    const excluded = plan(
      22,
      bootstrapSnapshot(22, 300, "W1N1", {
        legalWorker: true,
        hostiles: [
          { username: "Friend", attack: 1 },
          { username: "Neighbor", rangedAttack: 1 },
          { username: "Myrmex", work: 1 },
          { username: "Unknown", heal: 1 },
        ],
      }),
    );
    expect(excluded.colonies[0]).toMatchObject({ state: "developing", activeThreat: false });

    const threatened = plan(
      23,
      bootstrapSnapshot(23, 300, "W1N1", {
        legalWorker: true,
        hostiles: [{ username: "Unknown", attack: 1 }],
      }),
    );
    expect(threatened.colonies[0]).toMatchObject({
      state: "threatened",
      activeThreat: true,
      reasonCode: "local-threat-observed",
    });
  });

  it("fails closed before overflowing accepted persistent revisions", () => {
    const config = buildRuntimeConfig();
    const colony = {
      roomName: "W1N1",
      state: "developing" as const,
      stateSince: 1,
      revision: 1,
      policyRevision: config.policyRevision,
      reasonCode: "survival-capability-restored" as const,
    };
    const rootExhausted = canonicalColoniesOwner(Number.MAX_SAFE_INTEGER, [colony], []);
    expect(() =>
      new ColonyDirector().plan({
        tick: 10,
        snapshot: bootstrapSnapshot(10, 300),
        config,
        owner: rootExhausted,
        cpuMode: "normal",
        cpuBudget: CPU_BUDGET,
      }),
    ).toThrow(/safe integer range/u);

    const recordExhausted = canonicalColoniesOwner(
      1,
      [{ ...colony, revision: Number.MAX_SAFE_INTEGER }],
      [],
    );
    expect(() =>
      new ColonyDirector().plan({
        tick: 10,
        snapshot: bootstrapSnapshot(10, 300),
        config,
        owner: recordExhausted,
        cpuMode: "normal",
        cpuBudget: CPU_BUDGET,
      }),
    ).toThrow(/safe integer range/u);
  });
});

function request(index: number): BudgetRequest {
  return {
    colonyId: "W1N1",
    category: "optional-growth",
    issuer: `economy/growth-${String(index).padStart(3, "0")}`,
    revision: 1,
    expiresAt: 100,
    energy: { minimum: 1, desired: 1 },
    cpu: null,
    spawn: null,
  };
}

interface SnapshotOptions {
  readonly legalWorker?: boolean;
  readonly controllerLevel?: number;
  readonly ticksToDowngrade?: number;
  readonly hostiles?: readonly {
    readonly username: string;
    readonly attack?: number;
    readonly rangedAttack?: number;
    readonly work?: number;
    readonly heal?: number;
  }[];
}

function bootstrapSnapshot(
  tick: number,
  energy: number,
  roomName = "W1N1",
  options: SnapshotOptions = {},
): WorldSnapshot {
  const ownedCreeps = options.legalWorker
    ? [testCreep("worker", "Myrmex", { work: 1, carry: 1, move: 1 }, roomName)]
    : [];
  const hostileCreeps = (options.hostiles ?? []).map((hostile, index) =>
    testCreep(`foreign-${String(index)}`, hostile.username, hostile, roomName),
  );
  const room = {
    name: roomName,
    observedAt: tick,
    energyAvailable: energy,
    energyCapacityAvailable: 550,
    controller: {
      id: "controller-1",
      level: options.controllerLevel ?? 3,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: { roomName, x: 25, y: 25 },
      progress: 1,
      progressTotal: 2,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 1,
      safeModeCooldown: null,
      ticksToDowngrade: options.ticksToDowngrade ?? 10_000,
      upgradeBlocked: null,
    },
    sources: [],
    ownedSpawns: [
      {
        id: "spawn-1",
        name: "Spawn1",
        pos: { roomName, x: 24, y: 25 },
        hits: 5_000,
        hitsMax: 5_000,
        spawning: null,
        store: {
          capacity: 300,
          freeCapacity: Math.max(0, 300 - energy),
          resources: [{ resourceType: "energy", amount: Math.min(300, energy) }],
          usedCapacity: Math.min(300, energy),
        },
      },
    ],
    ownedExtensions: [],
    ownedTowers: [],
    ownedCreeps,
    hostileCreeps,
    constructionSites: [],
    storedStructures: [],
  };
  return freezeWorldSnapshot({
    schemaVersion: 1,
    observation: { age: 0, shard: "shard3", status: "observed", tick },
    observedAt: tick,
    rooms: [room],
    ownedRooms: [room],
    visibility: {
      absentRoomSemantics: "unknown",
      scope: "current-tick",
      rooms: [{ roomName, status: "visible", observedAt: tick, age: 0 }],
    },
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: hostileCreeps.length,
        ownedCreeps: ownedCreeps.length,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        sources: 0,
        storedStructures: 0,
        total: 3 + hostileCreeps.length + ownedCreeps.length,
      },
      estimatedPayloadBytes: 0,
    },
  });
}

function testCreep(
  name: string,
  ownerUsername: string,
  parts: {
    readonly attack?: number;
    readonly carry?: number;
    readonly heal?: number;
    readonly move?: number;
    readonly rangedAttack?: number;
    readonly work?: number;
  },
  roomName: string,
) {
  const capability = (active = 0) => ({ active, boosted: 0, total: active });
  const values = {
    attack: parts.attack ?? 0,
    carry: parts.carry ?? 0,
    claim: 0,
    heal: parts.heal ?? 0,
    move: parts.move ?? 0,
    rangedAttack: parts.rangedAttack ?? 0,
    tough: 0,
    work: parts.work ?? 0,
  };
  const size = Object.values(values).reduce((total, value) => total + value, 0);
  return {
    id: `creep-${name}`,
    name,
    ownerUsername,
    pos: { roomName, x: 20, y: 20 },
    body: {
      activeParts: size,
      size,
      attack: capability(values.attack),
      carry: capability(values.carry),
      claim: capability(values.claim),
      heal: capability(values.heal),
      move: capability(values.move),
      rangedAttack: capability(values.rangedAttack),
      tough: capability(values.tough),
      work: capability(values.work),
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    spawning: false,
    store: { capacity: 50, freeCapacity: 50, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}
