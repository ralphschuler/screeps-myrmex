import { describe, expect, it } from "vitest";
import type { ContractExecutionView, LeasedWorkExecution } from "../../bot/src/contracts";
import { planLeaseAgents } from "../../bot/src/agents/lease-agent";
import { MovementRuntime } from "../../bot/src/movement/runtime";
import type {
  LocalPathPlanningService,
  LocalPathPlanResult,
} from "../../bot/src/movement/path-cache";
import type { WorldSnapshot } from "../../bot/src/world/snapshot";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

const FIRST_TICK = 30_000;
const CPU_BUDGET = 3;

type PathMode = "blocked" | "no-path" | "ready";

interface RecoveryInput {
  readonly path: PathMode;
  readonly targetPresent: boolean;
  readonly reverseLeases: boolean;
}

interface RecoveryWorld {
  readonly phase: number;
}

interface RecoveryOutcome {
  readonly dispositions: readonly { readonly contractId: string; readonly reason: string }[];
  readonly movement: readonly {
    readonly actorId: string;
    readonly reason: string;
    readonly status: string;
  }[];
  readonly commands: readonly string[];
  readonly replans: number;
}

type RecoveryHeap = object;

describe("Phase 1 path and target recovery replay (#30)", () => {
  it("replays blocked/no-path and stale-target outcomes into one valid command", () => {
    const { warm, reset, reordered } = collectPathTargetEvidence();

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reordered.outcomes).toEqual(reset.outcomes);
    expect(reordered.finalWorld).toEqual(reset.finalWorld);
    expect(reordered.outcomeHash).toBe(reset.outcomeHash);

    expect(reset.outcomes[0]).toEqual({
      dispositions: [
        { contractId: "contract-stale", reason: "target-missing" },
        { contractId: "contract-worker", reason: "path-unavailable" },
      ],
      movement: [],
      commands: [],
      replans: 1,
    });
    expect(reset.outcomes[1]).toEqual({
      dispositions: [{ contractId: "contract-worker", reason: "path-unavailable" }],
      movement: [],
      commands: [],
      replans: 1,
    });
    expect(reset.outcomes[2]).toEqual({
      dispositions: [],
      movement: [{ actorId: "creep-worker", reason: "accepted", status: "executed" }],
      commands: ["creep-worker:3"],
      replans: 0,
    });
    expect(reset.outcomes.flatMap(({ commands }) => commands)).toEqual(["creep-worker:3"]);
  });
});

export function collectPathTargetEvidence() {
  return Object.freeze({
    warm: runScenario(recoveryScenario(false)),
    reset: runScenario(recoveryScenario(true)),
    reordered: runScenario(recoveryScenario(true, true)),
  });
}

function recoveryScenario(
  resetHeap: boolean,
  reverseLeases = false,
): ReplayScenario<RecoveryWorld, RecoveryInput, RecoveryOutcome, RecoveryHeap> {
  const input = (path: PathMode, targetPresent: boolean): RecoveryInput => ({
    path,
    targetPresent,
    reverseLeases,
  });
  return defineReplayScenario({
    id: "phase1/path-target-recovery",
    seed: "phase1-path-target-recovery",
    initialWorld: { phase: 0 },
    ticks: [
      { gameTime: FIRST_TICK, input: input("blocked", false), cpuBudget: CPU_BUDGET },
      {
        gameTime: FIRST_TICK + 1,
        input: input("no-path", true),
        cpuBudget: CPU_BUDGET,
        resetHeap: resetHeap,
      },
      {
        gameTime: FIRST_TICK + 2,
        input: input("ready", true),
        cpuBudget: CPU_BUDGET,
        resetHeap: resetHeap,
      },
    ],
    createHeap: () => ({}),
    resetHeap: () => ({}),
    assertCpu: ({ budget, used }) => {
      expect(budget).toBe(CPU_BUDGET);
      expect(used).toBe(2);
      expect(used).toBeLessThanOrEqual(budget);
    },
    step: ({ gameTime, input }) => {
      const runtime = new MovementRuntime();
      const snapshot = recoverySnapshot(gameTime);
      const plan = planLeaseAgents({
        availablePathCpu: 0.5,
        execution: execution(input.reverseLeases, input.targetPresent),
        paths: pathService(input.path),
        snapshot,
        tick: gameTime,
      });
      for (const intent of plan.movement) runtime.movementProducer.submit(intent);

      const commands: string[] = [];
      const result = runtime.execute(snapshot, gameTime, {
        resolveActor: (actorId) =>
          actorId === "creep-worker"
            ? {
                move: (direction: DirectionConstant) => (
                  commands.push(`creep-worker:${String(direction)}`),
                  0
                ),
              }
            : { move: () => 0 },
        resolveTarget: () => null,
      });
      return {
        nextWorld: { phase: gameTime - FIRST_TICK + 1 },
        outcome: {
          dispositions: plan.dispositions.map(({ contractId, reason }) => ({ contractId, reason })),
          movement: result.movementExecution.map(({ intent, reason, status }) => ({
            actorId: intent.actorId,
            reason,
            status,
          })),
          commands,
          replans: plan.dispositions.filter(({ reason }) => reason === "path-unavailable").length,
        },
        cpuUsed: 2,
      };
    },
  });
}

function pathService(mode: PathMode): LocalPathPlanningService {
  return {
    plan: (): LocalPathPlanResult =>
      mode === "ready"
        ? { cost: 2, directions: [3, 3], source: "search", status: "ready" }
        : { reason: mode === "no-path" ? "incomplete" : "unavailable", status: "no-path" },
  };
}

function execution(reverse: boolean, targetPresent: boolean): ContractExecutionView {
  const leases = [lease("creep-worker", "source-a")];
  if (!targetPresent) leases.push(lease("creep-stale", "missing-source"));
  return { leases: reverse ? leases.reverse() : leases, status: "ready" };
}

function lease(actorId: string, targetId: string): LeasedWorkExecution {
  return {
    actorId,
    actorName: actorId,
    contractId: actorId === "creep-worker" ? "contract-worker" : "contract-stale",
    deadline: FIRST_TICK + 10,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: FIRST_TICK + 20,
    leaseExpiresAt: FIRST_TICK + 20,
    priority: { class: "survival", value: 10 },
    quantity: 1,
    range: 1,
    revision: 1,
    state: "assigned",
    target: { roomName: "W1N1", x: 13, y: 10 },
    targetId,
  };
}

function recoverySnapshot(tick: number): WorldSnapshot {
  const worker = creep("creep-worker", 10);
  const stale = creep("creep-stale", 20);
  const blocker = creep("creep-blocker", 10);
  return {
    observation: { age: 0, shard: "sim", status: "observed", tick },
    observedAt: tick,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: null,
        energyAvailable: 0,
        energyCapacityAvailable: 0,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: tick,
        ownedCreeps: [worker, stale, blocker],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: [],
        sources: [source()],
        storedStructures: [],
        traversal: { revision: "terrain:1", walkability: ".".repeat(2_500) },
      },
    ],
    schemaVersion: 1,
    stats: { entities: {} as never, estimatedPayloadBytes: 0 },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function creep(id: string, x: number): never {
  return {
    body: {
      activeParts: 2,
      attack: part(),
      carry: part(1),
      claim: part(),
      heal: part(),
      move: part(1),
      rangedAttack: part(),
      size: 2,
      tough: part(),
      work: part(1),
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id,
    name: id,
    ownerUsername: "TedRoastBeef",
    pos: { roomName: "W1N1", x, y: 10 },
    spawning: false,
    store: store(),
    ticksToLive: 1_000,
  } as never;
}

function source(): never {
  return {
    energy: 3_000,
    energyCapacity: 3_000,
    id: "source-a",
    pos: { roomName: "W1N1", x: 13, y: 10 },
    ticksToRegeneration: null,
  } as never;
}

function part(active = 0): { active: number; boosted: number; total: number } {
  return { active, boosted: 0, total: active };
}
function store(): never {
  return { capacity: 50, freeCapacity: 50, resources: [], usedCapacity: 0 } as never;
}
