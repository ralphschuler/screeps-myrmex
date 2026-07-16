import { describe, expect, it } from "vitest";
import {
  dispositionTransitions,
  planLeaseAgents,
  reconcileLeaseAgentActions,
  repairRetryTransitions,
} from "../src/agents";
import type { ContractPlanningView, LeasedWorkExecution } from "../src/contracts";
import type { LocalPathPlanningService, MovementRuntimeResult } from "../src/movement";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

const paths: LocalPathPlanningService = {
  plan: () => ({ cost: 2, directions: [3], source: "search", status: "ready" }),
};

describe("lease agents", () => {
  it("deterministically turns one leased out-of-range harvest into one correlated movement intent", () => {
    const lease = harvestLease();
    const first = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [lease], status: "ready" },
      paths,
      snapshot: snapshot({ actor: position(10, 10), source: position(12, 10) }),
      tick: 10,
    });
    const reordered = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [harvestLease({ contractId: "z" }), lease], status: "ready" },
      paths,
      snapshot: snapshot({ actor: position(10, 10), source: position(12, 10) }),
      tick: 10,
    });

    expect(first.actions).toEqual([]);
    expect(first.movement).toEqual([
      expect.objectContaining({
        actorId: "creep-a",
        contractId: "contract-a",
        contractRevision: 2,
        destination: position(11, 10),
      }),
    ]);
    expect(reordered.movement.filter(({ contractId }) => contractId === "contract-a")).toEqual(
      first.movement,
    );
  });

  it("emits one in-range primary action and fails closed for full carry, stale target, and missing capability", () => {
    const inRange = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [harvestLease()], status: "ready" },
      paths,
      snapshot: snapshot({ actor: position(11, 10), source: position(12, 10) }),
      tick: 10,
    });
    expect(inRange.actions).toEqual([
      expect.objectContaining({ kind: "harvest", contractId: "contract-a", targetId: "source-a" }),
    ]);

    const fill = planLeaseAgents({
      availablePathCpu: 1,
      execution: {
        leases: [
          harvestLease({
            execution: {
              action: "transfer",
              completion: "continuous",
              counterpartId: null,
              resourceType: "energy",
              version: 1,
            },
            targetId: "spawn-a",
          }),
        ],
        status: "ready",
      },
      paths,
      snapshot: snapshot({
        actor: position(11, 10),
        energy: 50,
        source: position(12, 10),
        structure: { hits: 5_000, hitsMax: 5_000, pos: position(12, 10) },
      }),
      tick: 10,
    });
    expect(fill.actions).toEqual([
      expect.objectContaining({ amount: null, kind: "transfer", targetId: "spawn-a" }),
    ]);

    const stale = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [harvestLease({ targetId: "missing" })], status: "ready" },
      paths,
      snapshot: snapshot({ actor: position(11, 10), source: position(12, 10) }),
      tick: 10,
    });
    expect(stale.dispositions).toEqual([
      expect.objectContaining({ reason: "target-missing", to: "suspended" }),
    ]);
    expect(dispositionTransitions(stale.dispositions, 10)).toEqual([
      expect.objectContaining({ reason: "agent-target-missing", to: "suspended" }),
    ]);
  });

  it("reconciles only a matching scheduled action into assigned-to-active progress", () => {
    const lease = harvestLease();
    const result: MovementRuntimeResult = {
      actionDecisions: [],
      actionExecution: [
        {
          intent: {
            actorId: "creep-a",
            amount: 1,
            contractId: "contract-a",
            contractRevision: 2,
            deadline: 20,
            id: "action",
            kind: "harvest",
            priority: 10,
            resourceType: null,
            targetId: "source-a",
          },
          outcome: { code: 0, name: "OK", state: "scheduled" },
          reason: "executed",
          status: "executed",
        },
      ],
      actionSubmitted: 1,
      movementDecisions: [],
      movementExecution: [],
      movementSubmitted: 0,
      status: "executed",
    };
    expect(reconcileLeaseAgentActions([lease], result, 10)).toEqual([
      { contractId: "contract-a", reason: "agent-action-scheduled", tick: 10, to: "active" },
    ]);
  });

  it("completes repair at its explicit threshold and bounds command-failure retries", () => {
    const lease = repairLease();
    const atThreshold = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [lease], status: "ready" },
      paths,
      snapshot: snapshot({
        actor: position(11, 10),
        source: position(12, 10),
        structure: { hits: 800, hitsMax: 1_000, pos: position(12, 10) },
        energy: 1,
      }),
      tick: 10,
    });
    expect(atThreshold.actions).toEqual([]);
    expect(atThreshold.dispositions).toEqual([
      expect.objectContaining({ reason: "work-complete", to: "suspended" }),
    ]);

    const repairPlanningRecord = {
      budgetBinding: { category: "critical-maintenance", issuer: "maintenance/W1N1/spawn" },
      contractId: "contract-repair",
      execution: lease.execution,
      issuer: "maintenance/W1N1/spawn",
      owner: { id: "W1N1", kind: "colony" } as const,
      repairRetry: { attempts: 2, eligibleAt: 10 },
      state: "suspended" as const,
      targetId: "spawn-a",
    };
    const planning: ContractPlanningView = {
      status: "ready",
      contracts: [repairPlanningRecord],
    };
    expect(
      repairRetryTransitions(
        planning,
        { initialDelayTicks: 2, maximumAttempts: 3, maximumDelayTicks: 16 },
        13,
      ),
    ).toEqual([]);
    expect(
      repairRetryTransitions(
        planning,
        { initialDelayTicks: 2, maximumAttempts: 3, maximumDelayTicks: 16 },
        14,
      ),
    ).toEqual([
      { contractId: "contract-repair", reason: "repair-retry-due", tick: 14, to: "funded" },
    ]);
    expect(
      repairRetryTransitions(
        {
          ...planning,
          contracts: [{ ...repairPlanningRecord, repairRetry: { attempts: 3, eligibleAt: 10 } }],
        },
        { initialDelayTicks: 2, maximumAttempts: 3, maximumDelayTicks: 16 },
        11,
      ),
    ).toEqual([
      { contractId: "contract-repair", reason: "repair-retry-exhausted", tick: 11, to: "failed" },
    ]);
  });
});

function harvestLease(overrides: Partial<LeasedWorkExecution> = {}): LeasedWorkExecution {
  return {
    actorId: "creep-a",
    actorName: "worker",
    contractId: "contract-a",
    deadline: 20,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: 21,
    leaseExpiresAt: 21,
    priority: { class: "survival", value: 10 },
    quantity: 1,
    range: 1,
    revision: 2,
    state: "assigned",
    target: position(12, 10),
    targetId: "source-a",
    ...overrides,
  };
}

function repairLease(): LeasedWorkExecution {
  return {
    ...harvestLease({
      contractId: "contract-repair",
      target: position(12, 10),
      targetId: "spawn-a",
    }),
    execution: {
      action: "repair",
      completion: "work-complete",
      completionHits: 800,
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
  };
}

function snapshot(input: {
  actor: ReturnType<typeof position>;
  source: ReturnType<typeof position>;
  structure?: {
    readonly hits: number;
    readonly hitsMax: number;
    readonly pos: ReturnType<typeof position>;
  };
  energy?: number;
}): WorldSnapshot {
  const store = {
    capacity: 50,
    freeCapacity: 50,
    resources: input.energy === undefined ? [] : [{ amount: input.energy, resourceType: "energy" }],
    usedCapacity: input.energy ?? 0,
  };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: null,
        droppedResources: [],
        energyAvailable: 0,
        energyCapacityAvailable: 0,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 10,
        ownedCreeps: [
          {
            body: body(),
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            id: "creep-a",
            name: "worker",
            ownerUsername: "me",
            pos: input.actor,
            spawning: false,
            store,
            ticksToLive: 100,
          },
        ],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: [],
        ruins: [],
        sources: [
          {
            energy: 3000,
            energyCapacity: 3000,
            id: "source-a",
            pos: input.source,
            ticksToRegeneration: null,
          },
        ],
        storedStructures:
          input.structure === undefined
            ? []
            : [
                {
                  hits: input.structure.hits,
                  hitsMax: input.structure.hitsMax,
                  id: "spawn-a",
                  ownerUsername: "me",
                  ownership: "owned",
                  pos: input.structure.pos,
                  store,
                  structureType: "spawn",
                },
              ],
        tombstones: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 0,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 1,
        storedStructures: 0,
        tombstones: 0,
        total: 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function body() {
  const part = { active: 0, boosted: 0, total: 0 };
  return {
    activeParts: 2,
    attack: part,
    carry: { ...part, active: 1, total: 1 },
    claim: part,
    heal: part,
    move: part,
    rangedAttack: part,
    size: 2,
    tough: part,
    work: { ...part, active: 1, total: 1 },
  };
}
