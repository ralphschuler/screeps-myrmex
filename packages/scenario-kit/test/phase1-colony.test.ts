import { describe, expect, it } from "vitest";
import { RuntimeConfigAuthority } from "../../bot/src/config/authority";
import type { RuntimeConfig } from "../../bot/src/config";
import {
  ColonyDirector,
  type BudgetRequest,
  type ColonyDirectorResult,
} from "../../bot/src/colony";
import type { CpuBudget } from "../../bot/src/runtime/kernel";
import {
  freezeWorldSnapshot,
  type BodyCapabilitiesSnapshot,
  type CreepSnapshot,
  type OwnedRoomSnapshot,
  type OwnedSpawnSnapshot,
  type RoomSnapshot,
  type SnapshotEntityCounts,
  type SourceSnapshot,
  type StoreSnapshot,
  type WorldSnapshot,
} from "../../bot/src/world/snapshot";
import { canonicalSerialize, defineReplayScenario, runScenario, type ReplayScenario } from "../src";

const ROOM_NAME = "W1N1";
const SPAWN_ID = "spawn-W1N1-primary";
const FIRST_TICK = 20_000;

type ColonyStage =
  | "discovery"
  | "bootstrap"
  | "developing"
  | "growth-floor"
  | "replacement-competition"
  | "threatened"
  | "brownout"
  | "replenished"
  | "restored"
  | "unknown"
  | "lost";

interface ColonyWorld {
  readonly owner: Readonly<Record<string, unknown>>;
}

interface ColonyInput {
  readonly reverse: boolean;
  readonly roundTripOwner: boolean;
  readonly stage: ColonyStage;
}

interface ColonyHeap {
  readonly config: RuntimeConfig;
  readonly director: ColonyDirector;
}

const CPU_BUDGET: CpuBudget = Object.freeze({
  available: 2,
  hardCeiling: 2,
  estimate: 1,
  reservedForTail: 0,
});

const STAGES: readonly ColonyStage[] = [
  "discovery",
  "bootstrap",
  "bootstrap",
  "developing",
  "growth-floor",
  "replacement-competition",
  "threatened",
  "brownout",
  "replenished",
  "restored",
  "unknown",
  "lost",
];

describe("Phase 1 colony lifecycle and budget replay", () => {
  it("survives bootstrap, deterministic preemption, threat recovery, reset, and room loss", () => {
    const ordered = runScenario(colonyScenario(false));
    const resetAndReordered = runScenario(colonyScenario(true));

    expect(canonicalSerialize(resetAndReordered.outcomes)).toBe(
      canonicalSerialize(ordered.outcomes),
    );
    expect(resetAndReordered.outcomes).toEqual(ordered.outcomes);
    expect(resetAndReordered.finalWorld).toEqual(ordered.finalWorld);
    expect(resetAndReordered.outcomeHash).toBe(ordered.outcomeHash);
    expect(resetAndReordered.transcriptHash).not.toBe(ordered.transcriptHash);
    expect(resetAndReordered.transcript.ticks.map((tick) => tick.heapReset)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    assertAccounting(ordered.outcomes);

    expect(ordered.outcomes.map((outcome) => outcome.colonies[0]?.state)).toEqual([
      "discovering",
      "bootstrapping",
      "bootstrapping",
      "developing",
      "developing",
      "developing",
      "threatened",
      "recovering",
      "recovering",
      "developing",
      "developing",
      "lost",
    ]);

    const firstBootstrap = requiredOutcome(ordered.outcomes, 1);
    const resetBootstrap = requiredOutcome(ordered.outcomes, 2);
    for (const outcome of [firstBootstrap, resetBootstrap]) {
      expect(outcome.objectives).toHaveLength(1);
      expect(outcome.objectives[0]).toMatchObject({
        colonyId: ROOM_NAME,
        kind: "restore-workforce",
        status: "funded",
        demand: { kind: "recovery-worker", work: 1, carry: 1, move: 1 },
      });
      expect(["granted", "already-granted"]).toContain(outcome.objectives[0]?.budgetReasonCode);
      expect(
        outcome.reservations.filter(
          (entry) => entry.issuer === `colony/${ROOM_NAME}/restore-workforce`,
        ),
      ).toHaveLength(1);
      expect(outcome.totals).toMatchObject({
        active: 1,
        energyReserved: 300,
        cpuReserved: 100,
      });
    }
    expect(resetBootstrap.objectives[0]?.reservationId).toBe(
      firstBootstrap.objectives[0]?.reservationId,
    );

    const stableDevelopment = requiredOutcome(ordered.outcomes, 3);
    const protectedGrowth = requiredOutcome(ordered.outcomes, 4);
    expect(protectedGrowth.colonies[0]).toMatchObject({
      state: "developing",
      revision: stableDevelopment.colonies[0]?.revision,
    });
    expect(decisionFor(protectedGrowth, "economy/protected-growth", 1)).toMatchObject({
      status: "denied",
      reasonCode: "protected-energy-floor",
      grant: null,
    });
    expect(protectedGrowth.totals.energyReserved).toBe(0);

    const competition = requiredOutcome(ordered.outcomes, 5);
    expect(decisionFor(competition, "agents/worker-due-replacement", 1)).toMatchObject({
      category: "replacement",
      status: "granted",
      grant: {
        energy: 300,
        cpu: 100,
        spawn: { spawnId: SPAWN_ID, startTick: FIRST_TICK + 5, endTick: FIRST_TICK + 14 },
      },
    });
    expect(decisionFor(competition, "economy/competing-growth", 1)).toMatchObject({
      category: "optional-growth",
      status: "denied",
      reasonCode: "spawn-interval-overlap",
      grant: null,
    });
    expect(competition.totals).toMatchObject({
      active: 1,
      energyReserved: 300,
      cpuReserved: 100,
      spawnTicksReserved: 9,
    });
    expect(competition.totals.energyReserved).toBeLessThanOrEqual(550);
    expect(
      competition.reservations.filter(
        (entry) => entry.status === "active" && entry.grant.spawn !== null,
      ),
    ).toHaveLength(1);

    const threatened = requiredOutcome(ordered.outcomes, 6);
    expect(threatened.colonies[0]).toMatchObject({
      state: "threatened",
      activeThreat: true,
      reasonCode: "local-threat-observed",
    });
    expect(decisionFor(threatened, "economy/competing-growth", 2)).toMatchObject({
      status: "denied",
      reasonCode: "posture-preempted",
    });
    expect(threatened.totals.active).toBe(0);

    const brownout = requiredOutcome(ordered.outcomes, 7);
    expect(brownout.colonies[0]).toMatchObject({
      state: "recovering",
      activeThreat: false,
      reasonCode: "local-threat-cleared",
    });
    expect(brownout.objectives).toHaveLength(1);
    expect(brownout.objectives[0]).toMatchObject({
      status: "blocked",
      budgetReasonCode: "insufficient-energy",
    });
    expect(decisionFor(brownout, "economy/competing-growth", 3)).toMatchObject({
      status: "denied",
      reasonCode: "posture-preempted",
    });
    expect(brownout.totals).toMatchObject({ active: 0, energyReserved: 0 });

    const replenished = requiredOutcome(ordered.outcomes, 8);
    expect(replenished.colonies[0]?.state).toBe("recovering");
    expect(replenished.objectives).toHaveLength(1);
    expect(replenished.objectives[0]).toMatchObject({
      status: "funded",
      budgetReasonCode: "granted",
    });
    expect(replenished.totals).toMatchObject({
      active: 1,
      energyReserved: 300,
      cpuReserved: 100,
    });

    const restored = requiredOutcome(ordered.outcomes, 9);
    expect(restored.colonies[0]).toMatchObject({
      state: "developing",
      legalWorkforce: true,
      reasonCode: "survival-capability-restored",
    });
    expect(restored.objectives).toEqual([]);
    expect(restored.totals.active).toBe(0);

    const unknown = requiredOutcome(ordered.outcomes, 10);
    expect(unknown.colonies[0]).toMatchObject({
      state: "developing",
      visibility: "unknown",
      legalWorkforce: null,
      activeThreat: null,
    });
    expect(unknown.replacementOwner).toBeNull();

    const lost = requiredOutcome(ordered.outcomes, 11);
    expect(lost.colonies[0]).toMatchObject({
      state: "lost",
      visibility: "visible",
      reasonCode: "visible-ownership-lost",
    });
    expect(lost.objectives).toEqual([]);
    expect(lost.totals.active).toBe(0);
  });
});

function colonyScenario(
  resetAndReverse: boolean,
): ReplayScenario<ColonyWorld, ColonyInput, ColonyDirectorResult, ColonyHeap> {
  return defineReplayScenario<ColonyWorld, ColonyInput, ColonyDirectorResult, ColonyHeap>({
    id: "phase1/colony/survival-ledger-reset-equivalence",
    seed: "phase1-colony-ledger",
    initialWorld: { owner: {} },
    ticks: STAGES.map((stage, index) => ({
      gameTime: FIRST_TICK + index,
      input: {
        stage,
        reverse: resetAndReverse,
        roundTripOwner: resetAndReverse && (index === 2 || index === 10),
      },
      cpuBudget: 2,
      resetHeap: resetAndReverse && (index === 2 || index === 10),
    })),
    createHeap: createHeap,
    resetHeap: createHeap,
    step: ({ gameTime, heap, input, world }) => {
      const owner = input.roundTripOwner ? cloneOwner(world.owner) : world.owner;
      const result = heap.director.plan({
        tick: gameTime,
        snapshot: snapshotFor(gameTime, input.stage, input.reverse),
        config: heap.config,
        owner,
        cpuMode: "normal",
        cpuBudget: CPU_BUDGET,
        requests: requestsFor(gameTime, input.stage, input.reverse),
      });
      if (result.status !== "planned") {
        throw new Error(`colony scenario was not planned: ${result.reasonCode}`);
      }
      const nextOwner = cloneOwner(result.replacementOwner ?? owner);
      return {
        nextWorld: { owner: nextOwner },
        outcome: result,
        cpuUsed: 1,
      };
    },
  });
}

function createHeap(): ColonyHeap {
  const config = new RuntimeConfigAuthority().resolve({}, FIRST_TICK).config;
  if (!config.features.gates["phase1.colony"].enabled) {
    throw new Error("phase1.colony must be source-available for its acceptance scenario");
  }
  return { config, director: new ColonyDirector() };
}

function requestsFor(tick: number, stage: ColonyStage, reverse: boolean): readonly BudgetRequest[] {
  let requests: readonly BudgetRequest[];
  switch (stage) {
    case "growth-floor":
      requests = [
        budgetRequest({
          tick,
          category: "optional-growth",
          issuer: "economy/protected-growth",
          revision: 1,
          energy: 300,
          spawn: null,
        }),
      ];
      break;
    case "replacement-competition": {
      const interval = { spawnId: SPAWN_ID, startTick: tick, endTick: tick + 9 };
      requests = [
        budgetRequest({
          tick,
          category: "replacement",
          issuer: "agents/worker-due-replacement",
          revision: 1,
          energy: 300,
          spawn: interval,
        }),
        budgetRequest({
          tick,
          category: "optional-growth",
          issuer: "economy/competing-growth",
          revision: 1,
          energy: 250,
          spawn: interval,
        }),
      ];
      break;
    }
    case "threatened":
    case "brownout":
      requests = [
        budgetRequest({
          tick,
          category: "optional-growth",
          issuer: "economy/competing-growth",
          revision: stage === "threatened" ? 2 : 3,
          energy: 50,
          spawn: null,
        }),
      ];
      break;
    default:
      requests = [];
      break;
  }
  return reverse ? [...requests].reverse() : requests;
}

function budgetRequest(input: {
  readonly tick: number;
  readonly category: BudgetRequest["category"];
  readonly issuer: string;
  readonly revision: number;
  readonly energy: number;
  readonly spawn: BudgetRequest["spawn"];
}): BudgetRequest {
  return Object.freeze({
    colonyId: ROOM_NAME,
    category: input.category,
    issuer: input.issuer,
    revision: input.revision,
    expiresAt: input.tick + 20,
    energy: { minimum: input.energy, desired: input.energy },
    cpu: { minimum: 100, desired: 100 },
    spawn: input.spawn,
  });
}

function snapshotFor(tick: number, stage: ColonyStage, reverse: boolean): WorldSnapshot {
  if (stage === "unknown") {
    return freezeWorldSnapshot({
      schemaVersion: 1,
      observation: { age: 0, shard: "shard0", status: "observed", tick },
      observedAt: tick,
      ownedConstructionSiteCount: 0,
      rooms: [],
      ownedRooms: [],
      visibility: {
        absentRoomSemantics: "unknown",
        scope: "current-tick",
        rooms: [{ roomName: ROOM_NAME, status: "unknown", observedAt: null, age: null }],
      },
      stats: { entities: emptyCounts(), estimatedPayloadBytes: 0 },
    });
  }

  const owned = stage !== "lost";
  const hasSpawn = stage !== "discovery" && owned;
  const hasWorker = [
    "developing",
    "growth-floor",
    "replacement-competition",
    "threatened",
    "restored",
  ].includes(stage);
  const energy =
    stage === "brownout"
      ? 150
      : stage === "developing" ||
          stage === "growth-floor" ||
          stage === "replacement-competition" ||
          stage === "threatened"
        ? 550
        : owned
          ? 300
          : 0;
  // This stage tests a competing replacement claim while the incumbent is still viable. The
  // director's own handoff trigger is 9 spawn ticks plus the default 50-tick margin.
  const workerTtl = stage === "replacement-competition" ? 60 : 1_200;
  const ownedCreeps = hasWorker
    ? order(
        [
          creep("worker-primary", "Myrmex", body({ work: 1, carry: 1, move: 1 }), workerTtl),
          creep("scout-secondary", "Myrmex", body({ move: 1 }), 900),
        ],
        reverse,
      )
    : [];
  const hostileCreeps =
    stage === "threatened"
      ? order(
          [
            creep("raider", "Invader", body({ attack: 1, move: 1 }), 200),
            creep("harmless-observer", "Unknown", body({ move: 1 }), 200),
          ],
          reverse,
        )
      : [];
  const ownedSpawns = hasSpawn ? [spawn(energy)] : [];
  const room: RoomSnapshot = {
    name: ROOM_NAME,
    observedAt: tick,
    energyAvailable: energy,
    energyCapacityAvailable: owned ? 550 : 0,
    controller: {
      id: "controller-W1N1",
      level: owned ? 3 : 4,
      ownerUsername: owned ? "Myrmex" : "Opponent",
      ownership: owned ? "owned" : "foreign",
      pos: position(25, 25),
      progress: owned ? 12_000 : null,
      progressTotal: owned ? 45_000 : null,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 1,
      safeModeCooldown: null,
      ticksToDowngrade: 10_000,
      upgradeBlocked: null,
    },
    sources: order([source("source-a", 10, 10), source("source-b", 40, 40)], reverse),
    ownedSpawns,
    ownedExtensions: [],
    ownedTowers: [],
    ownedCreeps,
    hostileCreeps,
    constructionSites: [],
    storedStructures: [],
  };
  const entities = countsFor(room);
  return freezeWorldSnapshot({
    schemaVersion: 1,
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    rooms: [room],
    ownedRooms: owned ? [room as OwnedRoomSnapshot] : [],
    visibility: {
      absentRoomSemantics: "unknown",
      scope: "current-tick",
      rooms: [{ roomName: ROOM_NAME, status: "visible", observedAt: tick, age: 0 }],
    },
    stats: { entities, estimatedPayloadBytes: 0 },
  });
}

function spawn(energy: number): OwnedSpawnSnapshot {
  const stored = Math.min(300, energy);
  return {
    active: true,
    id: SPAWN_ID,
    name: "Spawn1",
    pos: position(24, 25),
    hits: 5_000,
    hitsMax: 5_000,
    spawning: null,
    store: store(300, stored),
  };
}

function source(id: string, x: number, y: number): SourceSnapshot {
  return {
    id,
    pos: position(x, y),
    energy: 3_000,
    energyCapacity: 3_000,
    ticksToRegeneration: null,
  };
}

function creep(
  name: string,
  ownerUsername: string,
  capabilities: BodyCapabilitiesSnapshot,
  ticksToLive: number,
): CreepSnapshot {
  return {
    id: `creep-${name}`,
    name,
    ownerUsername,
    pos: position(20, 20),
    body: capabilities,
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    spawning: false,
    store: store(50, 0),
    ticksToLive,
  };
}

function body(parts: {
  readonly attack?: number;
  readonly carry?: number;
  readonly claim?: number;
  readonly heal?: number;
  readonly move?: number;
  readonly rangedAttack?: number;
  readonly tough?: number;
  readonly work?: number;
}): BodyCapabilitiesSnapshot {
  const capability = (active = 0) => ({ active, boosted: 0, total: active });
  const values = {
    attack: parts.attack ?? 0,
    carry: parts.carry ?? 0,
    claim: parts.claim ?? 0,
    heal: parts.heal ?? 0,
    move: parts.move ?? 0,
    rangedAttack: parts.rangedAttack ?? 0,
    tough: parts.tough ?? 0,
    work: parts.work ?? 0,
  };
  const size = Object.values(values).reduce((total, value) => total + value, 0);
  return {
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
  };
}

function position(
  x: number,
  y: number,
): { readonly roomName: string; readonly x: number; readonly y: number } {
  return { roomName: ROOM_NAME, x, y };
}

function store(capacity: number, usedCapacity: number): StoreSnapshot {
  return {
    capacity,
    usedCapacity,
    freeCapacity: capacity - usedCapacity,
    resources: usedCapacity === 0 ? [] : [{ resourceType: "energy", amount: usedCapacity }],
  };
}

function countsFor(room: RoomSnapshot): SnapshotEntityCounts {
  const counts = {
    constructionSites: room.constructionSites.length,
    controllers: room.controller === null ? 0 : 1,
    hostileCreeps: room.hostileCreeps.length,
    ownedCreeps: room.ownedCreeps.length,
    ownedExtensions: room.ownedExtensions.length,
    ownedSpawns: room.ownedSpawns.length,
    ownedTowers: room.ownedTowers.length,
    rooms: 1,
    sources: room.sources.length,
    storedStructures: room.storedStructures.length,
  };
  return {
    ...counts,
    total: Object.values(counts).reduce((total, value) => total + value, 0),
  };
}

function emptyCounts(): SnapshotEntityCounts {
  return {
    constructionSites: 0,
    controllers: 0,
    hostileCreeps: 0,
    ownedCreeps: 0,
    ownedExtensions: 0,
    ownedSpawns: 0,
    ownedTowers: 0,
    rooms: 0,
    sources: 0,
    storedStructures: 0,
    total: 0,
  };
}

function order<Value>(values: readonly Value[], reverse: boolean): readonly Value[] {
  return reverse ? [...values].reverse() : values;
}

function decisionFor(outcome: ColonyDirectorResult, issuer: string, revision: number) {
  const decision = outcome.decisions.find(
    (candidate) => candidate.issuer === issuer && candidate.revision === revision,
  );
  if (decision === undefined) {
    throw new Error(`missing budget decision for ${issuer} revision ${String(revision)}`);
  }
  return decision;
}

function requiredOutcome(
  outcomes: readonly ColonyDirectorResult[],
  index: number,
): ColonyDirectorResult {
  const outcome = outcomes[index];
  if (outcome === undefined) {
    throw new Error(`missing colony outcome ${String(index)}`);
  }
  return outcome;
}

function cloneOwner(value: unknown): Readonly<Record<string, unknown>> {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof clone !== "object" || clone === null || Array.isArray(clone)) {
    throw new TypeError("colony owner must round-trip as a data object");
  }
  return clone as Readonly<Record<string, unknown>>;
}

function assertAccounting(outcomes: readonly ColonyDirectorResult[]): void {
  for (const [index, outcome] of outcomes.entries()) {
    const active = outcome.reservations.filter((entry) => entry.status === "active");
    const energyReserved = active.reduce(
      (total, entry) => total + entry.grant.energy - entry.consumed.energy,
      0,
    );
    const cpuReserved = active.reduce(
      (total, entry) => total + entry.grant.cpu - entry.consumed.cpu,
      0,
    );
    const spawnTicksReserved = active.reduce(
      (total, entry) =>
        total +
        (entry.grant.spawn === null || entry.consumed.spawn
          ? 0
          : entry.grant.spawn.endTick - entry.grant.spawn.startTick),
      0,
    );
    expect(outcome.totals).toMatchObject({
      active: active.length,
      energyReserved,
      cpuReserved,
      spawnTicksReserved,
    });

    const stage = STAGES[index];
    if (stage === undefined) {
      throw new Error(`missing accounting stage ${String(index)}`);
    }
    const capacity = stageEnergy(stage);
    const protectedGranted = active
      .filter((entry) => ["emergency-spawn", "defense", "replacement"].includes(entry.category))
      .reduce((total, entry) => total + entry.grant.energy - entry.consumed.energy, 0);
    const protectedRemaining = Math.max(0, Math.min(300, capacity) - protectedGranted);
    const free = capacity - energyReserved - protectedRemaining;
    expect(free).toBeGreaterThanOrEqual(0);
    expect(energyReserved + protectedRemaining + free).toBe(capacity);
    expect(cpuReserved).toBeLessThanOrEqual(CPU_BUDGET.available * 1_000);

    const intervals = active.flatMap((entry) =>
      entry.grant.spawn === null || entry.consumed.spawn ? [] : [entry.grant.spawn],
    );
    for (const [intervalIndex, interval] of intervals.entries()) {
      for (const other of intervals.slice(intervalIndex + 1)) {
        if (interval.spawnId === other.spawnId) {
          expect(interval.startTick < other.endTick && other.startTick < interval.endTick).toBe(
            false,
          );
        }
      }
    }

    const tick = FIRST_TICK + index;
    for (const request of requestsFor(tick, stage, false)) {
      expect(
        outcome.decisions.filter(
          (decision) =>
            decision.colonyId === request.colonyId &&
            decision.category === request.category &&
            decision.issuer === request.issuer &&
            decision.revision === request.revision,
        ),
      ).toHaveLength(1);
    }
    for (const objective of outcome.objectives) {
      expect(
        outcome.decisions.filter(
          (decision) =>
            decision.issuer === objective.id && decision.revision === objective.revision,
        ),
      ).toHaveLength(1);
    }
  }
}

function stageEnergy(stage: ColonyStage): number {
  if (stage === "unknown" || stage === "lost") {
    return 0;
  }
  if (stage === "brownout") {
    return 150;
  }
  if (
    stage === "developing" ||
    stage === "growth-floor" ||
    stage === "replacement-competition" ||
    stage === "threatened"
  ) {
    return 550;
  }
  return 300;
}
