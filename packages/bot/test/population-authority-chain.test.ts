import { describe, expect, it } from "vitest";
import {
  BudgetLedger,
  ColonyDirectorSession,
  ColonyPopulationPolicy,
  canonicalColoniesOwner,
  type ColonyDirectorResult,
} from "../src/colony";
import {
  ContractLedger,
  contractIdFor,
  inRangeOrUnknownTravel,
  type CapabilityVector,
  type ContractFundingView,
  type NormalizedPopulationLoad,
  type WorkforceActor,
  type WorkContractRequest,
} from "../src/contracts";
import { SpawnBroker, type SpawnDemand } from "../src/spawn";
import type { WorldSnapshot } from "../src/world/snapshot";

const CAPABILITY: CapabilityVector = {
  attack: 0,
  carry: 1,
  claim: 0,
  heal: 0,
  move: 1,
  rangedAttack: 0,
  tough: 0,
  work: 1,
};
const ACTOR: WorkforceActor = {
  capability: CAPABILITY,
  id: "actor-1",
  name: "worker",
  pos: { roomName: "W1N1", x: 10, y: 10 },
  spawning: false,
  ticksToLive: 100,
};

describe("population authority chain", () => {
  it("ContractLedger exposes only sanitized funded active normalized load", () => {
    const ledger = readyLedger();
    const active = ledger.view().active[0];
    if (active === undefined) throw new Error("expected active funded contract");
    const expected = populationLoad({
      contractId: active.id,
      reservationId: active.id,
      revision: active.revision,
    });
    const accepted = ledger.populationView();
    expect(accepted).toEqual({ status: "ready", loads: [expected] });
    expect(Object.isFrozen(accepted.loads)).toBe(true);
  });

  it("SpawnBroker uses priorityValue for safety ordering inside funded-workforce", () => {
    const broker = new SpawnBroker().arbitrate({
      tick: 10,
      snapshot: spawnSnapshot(300),
      expectations: [],
      policy: {
        maximumBodyParts: 50,
        maximumBodyEnergy: 3_000,
        maximumNonMovePartsPerMovePart: 2,
        nameCollisionRetryLimit: 3,
        retryDelayTicks: 2,
      },
      demands: [spawnDemand("optional", 100), spawnDemand("defense", 900)],
    });
    expect(broker.selections).toHaveLength(1);
    expect(broker.selections[0]?.demandId).toBe("defense");
    expect(broker.decisions.find(({ demandId }) => demandId === "optional")?.reason).toBe(
      "no-idle-spawn",
    );
  });

  it("settles the selected funded population claim exactly and suppresses its duplicate", () => {
    const tick = 10;
    const policy = new ColonyPopulationPolicy();
    const projection = policy.project(policyInput());
    const demand = projection.demands[0];
    if (demand === undefined) throw new Error("expected population demand");
    const broker = new SpawnBroker().arbitrate({
      tick,
      snapshot: spawnSnapshot(300),
      expectations: [],
      policy: {
        maximumBodyParts: 50,
        maximumBodyEnergy: 3_000,
        maximumNonMovePartsPerMovePart: 2,
        nameCollisionRetryLimit: 3,
        retryDelayTicks: 2,
      },
      demands: [spawnDemand(demand.id, 900, demand.reservationId)],
    });
    const selection = broker.selections[0];
    if (selection === undefined) throw new Error("expected broker selection");
    const budget = new BudgetLedger([]).reconcile({
      tick,
      capacity: {
        energy: [{ colonyId: "W1N1", available: 300, protected: 300 }],
        cpu: 10,
        spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
      },
      requests: [
        {
          colonyId: "W1N1",
          category: "replacement",
          issuer: "population-objective",
          revision: 1,
          expiresAt: 20,
          energy: { minimum: 200, desired: 200 },
          cpu: null,
          spawn: selection.spawnClaim,
        },
      ],
    });
    const granted = budget.entries[0];
    if (granted === undefined) throw new Error("expected exact grant");
    const record = {
      roomName: "W1N1",
      state: "developing" as const,
      stateSince: 1,
      revision: 1,
      policyRevision: "policy",
      reasonCode: "survival-capability-restored" as const,
    };
    const owner = canonicalColoniesOwner(0, [record], budget.entries);
    const result = {
      status: "planned",
      reasonCode: "planned",
      ownerRevision: 0,
      colonies: [],
      objectives: [],
      decisions: budget.decisions,
      reservations: budget.entries,
      transitions: budget.transitions,
      totals: budget.totals,
      replacementOwner: owner,
    } as unknown as ColonyDirectorResult;
    const session = new ColonyDirectorSession(
      result,
      owner,
      owner,
      false,
      [
        {
          reservationId: granted.reservationId,
          energyCost: selection.energyCost,
          spawn: selection.spawnClaim,
        },
      ],
      tick,
    );
    const settled = session.settle(tick, [
      {
        reservationId: granted.reservationId,
        status: "scheduled",
        energyCost: selection.energyCost,
      },
    ]);
    expect(settled.replacementOwner?.ledger[0]).toMatchObject({
      status: "consumed",
      consumed: { energy: 200, spawn: true },
    });
    expect(
      policy.project(policyInput({ committedDemandIds: projection.demands.map(({ id }) => id) }))
        .demands,
    ).toEqual([]);
  });
});

function readyLedger(): ContractLedger {
  const opened = ContractLedger.open({});
  if (opened.status !== "ready") throw new Error("expected ledger");
  const request = contractRequest();
  const funding: ContractFundingView = {
    status: "ready",
    owners: [{ id: "W1N1", visibility: "visible" }],
    authorizations: [
      {
        category: "replacement",
        colonyId: "W1N1",
        expiresAt: 100,
        issuer: "population-objective",
        reservationId: "reservation-1",
        revision: 1,
        status: "active",
      },
    ],
  };
  opened.ledger.reconcile({
    actors: [ACTOR],
    funding,
    requests: [request],
    tick: 1,
    transitions: [],
    travel: inRangeOrUnknownTravel,
  });
  opened.ledger.reconcile({
    actors: [ACTOR],
    funding,
    requests: [],
    tick: 1,
    transitions: [
      {
        contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
        reason: "test-funded",
        tick: 1,
        to: "funded",
      },
    ],
    travel: inRangeOrUnknownTravel,
  });
  return opened.ledger;
}
function contractRequest(): WorkContractRequest {
  return {
    budgetBinding: { category: "replacement", issuer: "population-objective" },
    conditions: { cancellation: null, failure: "failed", success: "complete" },
    deadline: 90,
    earliestStart: 1,
    estimatedWorkTicks: 40,
    expiresAt: 100,
    issuer: "population-test",
    issuerKey: "worker",
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 10,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: [],
    priority: { class: "survival", value: 100 },
    quantity: 20,
    range: 1,
    requiredCapability: CAPABILITY,
    target: { roomName: "W1N1", x: 10, y: 10 },
    targetId: "source-1",
    execution: {
      action: "harvest",
      completion: "target-depleted",
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
  };
}
function populationLoad(change: Partial<NormalizedPopulationLoad> = {}): NormalizedPopulationLoad {
  const request = contractRequest();
  return {
    backlogWorkTicks: 20,
    category: "replacement",
    colonyId: "W1N1",
    contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
    measuredWorkTicks: 40,
    minimumCapability: CAPABILITY,
    objectiveId: "population-objective",
    reservationId: "reservation-1",
    revision: 1,
    sourceCapacityWorkTicks: 60,
    travelTicks: 10,
    ...change,
  };
}
function policyInput(
  change: Record<string, unknown> = {},
): Parameters<ColonyPopulationPolicy["project"]>[0] {
  return {
    activeThreat: false,
    actors: [],
    availableEnergy: 300,
    colonyId: "W1N1",
    committedDemandIds: [],
    controllerRisk: false,
    cpuMode: "normal",
    funded: { status: "ready", loads: [populationLoad()] },
    maximumBodyEnergy: 3_000,
    protectedSpawnEnergy: 300,
    replacementLeadTicks: 59,
    spawnUtilizationBasisPoints: 0,
    state: "developing",
    visibility: "visible",
    ...change,
  };
}
function spawnDemand(id: string, priorityValue: number, budgetId = "reservation-1"): SpawnDemand {
  return {
    id,
    issuer: "population-objective",
    colonyId: "W1N1",
    revision: 1,
    category: "funded-workforce",
    priorityValue,
    deadline: 20,
    earliestTick: 10,
    destinationRoomName: "W1N1",
    replacementCreepName: null,
    budgetId,
    requiredPartCounts: {
      tough: 0,
      work: 1,
      carry: 1,
      attack: 0,
      ranged_attack: 0,
      heal: 0,
      claim: 0,
      move: 1,
    },
    energyCap: 300,
    nameBasis: null,
  };
}
function spawnSnapshot(energy: number): WorldSnapshot {
  const pos = { roomName: "W1N1", x: 10, y: 10 };
  const store = {
    capacity: 300,
    freeCapacity: 300 - energy,
    resources: [{ resourceType: "energy", amount: energy }],
    usedCapacity: energy,
  };
  const spawn = {
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-1",
    name: "Spawn1",
    pos,
    spawning: null,
    store,
  };
  const controller = {
    id: "controller-1",
    level: 2,
    ownerUsername: "Myrmex",
    ownership: "owned" as const,
    pos,
    progress: 0,
    progressTotal: 45_000,
    reservationTicksToEnd: null,
    reservationUsername: null,
    safeMode: null,
    safeModeAvailable: 1,
    safeModeCooldown: null,
    ticksToDowngrade: 10_000,
    upgradeBlocked: null,
  };
  const room = {
    name: "W1N1",
    controller,
    energyAvailable: energy,
    energyCapacityAvailable: 300,
    constructionSites: [],
    hostileCreeps: [],
    observedAt: 10,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [spawn],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
  };
  return {
    observation: { age: 0, shard: "shard3", status: "current", tick: 10 },
    observedAt: 10,
    rooms: [room],
    ownedRooms: [room],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: 2,
      },
      estimatedPayloadBytes: 0,
    },
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: [{ age: 0, observedAt: 10, roomName: "W1N1", status: "visible" }],
      scope: "current-tick",
    },
  } as unknown as WorldSnapshot;
}
