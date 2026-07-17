import { buildRuntimeConfig } from "../../../bot/src/config/runtime-config";
import { BudgetLedger, type BudgetCategory, type BudgetRequest } from "../../../bot/src/colony";
import {
  executeDefenseIntents,
  planDefense,
  planRoutineTowerMaintenance,
  type DefenseIntent,
} from "../../../bot/src/defense";
import type { ArbitrationBatch, CommandExecutionResult } from "../../../bot/src/execution";
import type { LayoutPlacement } from "../../../bot/src/layout";
import {
  assignMaintenanceExecution,
  authorizeMaintenanceWork,
  ConstructionPlanner,
  DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY,
  maintenanceWorkOutcomes,
  measureMaintenanceTraffic,
  projectMaintenanceBudgets,
  projectMaintenanceTelemetry,
} from "../../../bot/src/maintenance";
import type { ContractPlanningRecord } from "../../../bot/src/contracts";
import type { WorldSnapshot } from "../../../bot/src/world/snapshot";
import { canonicalHash, canonicalSerialize } from "../../src";

const ROOM = "W1N1";
const FIRST_TICK = 1_000;
const TICKS = 12;
const ROAD_FLOOR = 2_000;
const CONTAINER_FLOOR = 125_000;
const TOWER_RESERVE = 400;

export function collectPhase2MaintenanceEvidence() {
  const warm = runVariant(false, false);
  const reset = runVariant(true, false);
  const reordered = runVariant(true, true);
  const semanticBytes = [warm, reset, reordered].map(({ semantic }) =>
    canonicalSerialize(semantic),
  );
  const hashes = [warm.hash, reset.hash, reordered.hash];

  return Object.freeze({
    schemaVersion: 1,
    issue: 243,
    status: "complete",
    sustainedDecay: reset.semantic.sustainedDecay,
    protectedPriorities: reset.semantic.protectedPriorities,
    fortificationBands: reset.semantic.fortificationBands,
    towerArbitration: reset.semantic.towerArbitration,
    reconciliation: reset.semantic.reconciliation,
    telemetry: reset.semantic.telemetry,
    equivalence: {
      contractsIdentical: equalField(warm, reset, reordered, "contracts"),
      retirementsIdentical: equalField(warm, reset, reordered, "retirements"),
      commandsIdentical: equalField(warm, reset, reordered, "commands"),
      telemetryIdentical: equalField(warm, reset, reordered, "telemetryRows"),
      semanticBytesIdentical: new Set(semanticBytes).size === 1,
      evidenceHashesIdentical: new Set(hashes).size === 1,
      hashes: { warm: hashes[0], heapReset: hashes[1], reordered: hashes[2] },
    },
    bounds: {
      ticks: TICKS,
      maximumCpuPerTick: 1,
      maximumMaintenanceRequestsPerTick: 2,
      maximumPlannerEnergyPerTick: DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY.maximumEnergyPerRoom,
      maximumTowerCommandsPerTick: 1,
    },
  });
}

function runVariant(heapReset: boolean, reorder: boolean) {
  const config = buildRuntimeConfig();
  let world = { roadHits: 2_300, containerHits: 130_000, towerEnergy: 900 };
  const contracts = new Set<string>();
  const commands: Array<{
    tick: number;
    kind: string;
    target: string;
    status: string;
    reason: string;
  }> = [];
  const telemetryRows: ReturnType<typeof projectMaintenanceTelemetry>[] = [];
  let minimumRoadHits = Number.MAX_SAFE_INTEGER;
  let minimumContainerHits = Number.MAX_SAFE_INTEGER;
  let maximumCpu = 0;
  let maximumRequests = 0;
  let maximumRequestedEnergy = 0;
  let maximumFundedEnergy = 0;
  let duplicateTargetsSuppressed = 0;
  let commandFailureCount = 0;
  let healCommands = 0;
  let attackCommands = 0;
  let repairCommands = 0;

  for (let offset = 0; offset < TICKS; offset += 1) {
    const tick = FIRST_TICK + offset;
    world.roadHits = Math.max(0, world.roadHits - 75);
    world.containerHits = Math.max(0, world.containerHits - 600);
    const injured = offset === 3;
    const hostile = offset === 5;
    const reserve = offset < 2 ? "protected" : "surplus";
    const snapshot = maintenanceWorld(tick, world, { hostile, injured, reorder, rcl: 6 });
    const planning = plan(snapshot, reserve);
    const budgets = projectMaintenanceBudgets({ existing: [], planning, tick, ttl: 20 });
    const ledger = allocate([...survivalRequests(tick), ...budgets.budgets], tick, reorder);
    const authorized = authorizeMaintenanceWork({
      budgets: budgets.budgets,
      planning,
      reservations: ledger.entries,
      contracts: { status: "ready", contracts: [] },
      tick,
    });
    for (const request of authorized.creepRequests) contracts.add(request.issuer);

    const defense = planDefense(snapshot, config);
    const routine = planRoutineTowerMaintenance(snapshot, config, authorized.towerCandidates);
    const selected = defense.length > 0 ? defense : routine;
    let cpu = 0;
    const results = executeDefenseIntents(
      batch(selected, tick),
      tick,
      liveObjectResolver(world, tick, () => {
        cpu += 0.125;
      }),
      { getUsed: () => cpu },
    );
    for (const result of results) {
      commands.push({
        tick,
        kind: result.command.kind,
        target: result.command.target,
        status: result.status,
        reason: result.reason,
      });
      if (result.command.kind === "tower.heal") healCommands += 1;
      if (result.command.kind === "tower.attack") attackCommands += 1;
      if (result.command.kind === "tower.repair") repairCommands += 1;
      if (result.status === "failed") commandFailureCount += 1;
      if (result.status === "executed") world.towerEnergy -= 10;
    }

    const assigned = assignMaintenanceExecution(authorized, routine);
    duplicateTargetsSuppressed += assigned.duplicateTargetsSuppressed;
    let creepEnergy = maintenanceGrant(ledger.entries);
    for (const request of assigned.creepRequests) {
      const target = request.targetId;
      const completion =
        request.execution?.version === 1 ? request.execution.completionHits : undefined;
      if (target === null || typeof completion !== "number" || creepEnergy <= 0) continue;
      const current = target === "road-critical" ? world.roadHits : world.containerHits;
      const required = Math.max(0, Math.ceil((completion - current) / 100));
      const spent = Math.min(creepEnergy, request.quantity, required);
      if (target === "road-critical") world.roadHits += spent * 100;
      if (target === "container-source") world.containerHits += spent * 100;
      creepEnergy -= spent;
    }

    if (planning.proposals.some(({ targetId }) => targetId === "road-critical"))
      minimumRoadHits = Math.min(minimumRoadHits, world.roadHits);
    if (planning.proposals.some(({ targetId }) => targetId === "container-source"))
      minimumContainerHits = Math.min(minimumContainerHits, world.containerHits);

    const requestedEnergy = budgets.budgets[0]?.energy?.desired ?? 0;
    const fundedEnergy = maintenanceGrant(ledger.entries);
    maximumRequestedEnergy = Math.max(maximumRequestedEnergy, requestedEnergy);
    maximumFundedEnergy = Math.max(maximumFundedEnergy, fundedEnergy);
    maximumRequests = Math.max(maximumRequests, authorized.creepRequests.length);
    maximumCpu = Math.max(
      maximumCpu,
      results.reduce((sum, row) => sum + row.cpuUsed, 0),
    );
    telemetryRows.push(
      projectMaintenanceTelemetry({
        planning,
        requestedEnergyCaps: [requestedEnergy],
        fundedEnergyCaps: [fundedEnergy],
        towerCommands: results,
        towerRejections:
          defense.length > 0 && routine.length === 0
            ? [{ targetId: "road-critical", reason: "safety-preempted" }]
            : [],
        emergencyReservePreserved: world.towerEnergy >= TOWER_RESERVE,
        duplicateTargetsSuppressed: assigned.duplicateTargetsSuppressed,
        workOutcomes: [],
      }),
    );
    if (heapReset && offset === 6) world = roundTrip(world);
  }

  const protectedPriorities = priorityEvidence(reorder);
  const fortificationBands = fortificationEvidence(reorder);
  const towerArbitration = arbitrationEvidence(reorder);
  const reconciliation = reconciliationEvidence(reorder);
  const telemetry = projectMaintenanceTelemetry({
    planning: reconciliation.planning,
    requestedEnergyCaps: [maximumRequestedEnergy],
    fundedEnergyCaps: [maximumFundedEnergy],
    towerCommands: commandsForTelemetry(commands),
    towerRejections: [{ targetId: "road-critical", reason: "safety-preempted" }],
    emergencyReservePreserved: world.towerEnergy >= TOWER_RESERVE,
    duplicateTargetsSuppressed,
    workOutcomes: reconciliation.workOutcomes,
  });
  const retirements = reconciliation.retirements;
  const semantic = {
    sustainedDecay: {
      ticks: TICKS,
      road: { floor: ROAD_FLOOR, minimumObservedHits: minimumRoadHits, finalHits: world.roadHits },
      container: {
        floor: CONTAINER_FLOOR,
        minimumObservedHits: minimumContainerHits,
        finalHits: world.containerHits,
      },
      maximumCpuPerTick: maximumCpu,
      maximumRequestsPerTick: maximumRequests,
      maximumRequestedEnergyPerTick: maximumRequestedEnergy,
      maximumFundedEnergyPerTick: maximumFundedEnergy,
      commandFailureCount,
    },
    protectedPriorities,
    fortificationBands,
    towerArbitration: {
      ...towerArbitration,
      sustained: { healCommands, attackCommands, repairCommands, duplicateTargetsSuppressed },
    },
    reconciliation: stripPlanning(reconciliation),
    telemetry,
    contracts: [...contracts].sort(),
    retirements,
    commands,
    telemetryRows,
  };
  return { semantic, hash: canonicalHash(semantic) };
}

function priorityEvidence(reorder: boolean) {
  const tick = FIRST_TICK;
  const snapshot = maintenanceWorld(
    tick,
    { roadHits: 2_300, containerHits: 130_000, towerEnergy: 900 },
    { hostile: false, injured: false, reorder, rcl: 6 },
  );
  const planning = plan(snapshot, "surplus");
  const budgets = projectMaintenanceBudgets({ existing: [], planning, tick, ttl: 20 });
  const result = allocate([...survivalRequests(tick), ...budgets.budgets], tick, reorder);
  return {
    grants: result.decisions.map(({ category, grant, issuer, reasonCode, status }) => ({
      category,
      energy: grant?.energy ?? 0,
      issuer,
      reasonCode,
      status,
    })),
    maintenanceEnergy: maintenanceGrant(result.entries),
    protectedEnergy: 550,
    cpuCap: 1,
    requestCount: result.decisions.length,
  };
}

function fortificationEvidence(reorder: boolean) {
  const matrix = [
    { name: "rcl3-protected", rcl: 3, reserve: "protected" as const, hostile: false },
    { name: "rcl3-surplus", rcl: 3, reserve: "surplus" as const, hostile: false },
    { name: "rcl3-threat", rcl: 3, reserve: "surplus" as const, hostile: true },
    { name: "rcl6-surplus", rcl: 6, reserve: "surplus" as const, hostile: false },
  ];
  return matrix.map((row) => {
    const planning = new ConstructionPlanner().plan({
      layouts: new Map(),
      reserves: [{ roomName: ROOM, state: row.reserve }],
      snapshot: fortificationWorld(row.rcl, row.hostile, reorder),
      traffic: [],
    });
    return {
      name: row.name,
      targets: planning.proposals.map(({ structureClass, targetHits }) => ({
        structureClass,
        targetHits,
      })),
      deferredProtected: planning.deferred.filter(({ reason }) => reason === "protected-reserve")
        .length,
      targetsHitsMax: planning.proposals.some(({ targetHits }) => targetHits >= 300_000_000),
      towerEligible: planning.proposals.some(({ towerEligible }) => towerEligible),
    };
  });
}

function arbitrationEvidence(reorder: boolean) {
  const config = buildRuntimeConfig();
  const base = { roadHits: 2_300, containerHits: 130_000, towerEnergy: 900 };
  const clear = maintenanceWorld(FIRST_TICK, base, {
    hostile: false,
    injured: false,
    reorder,
    rcl: 6,
  });
  const planning = plan(clear, "surplus");
  const budgets = projectMaintenanceBudgets({ existing: [], planning, tick: FIRST_TICK, ttl: 20 });
  const ledger = allocate(
    [...survivalRequests(FIRST_TICK), ...budgets.budgets],
    FIRST_TICK,
    reorder,
  );
  const authorized = authorizeMaintenanceWork({
    budgets: budgets.budgets,
    planning,
    reservations: ledger.entries,
    contracts: { status: "ready", contracts: [] },
    tick: FIRST_TICK,
  });
  const routine = planRoutineTowerMaintenance(clear, config, authorized.towerCandidates);
  const assigned = assignMaintenanceExecution(authorized, routine);
  const healWorld = maintenanceWorld(FIRST_TICK + 1, base, {
    hostile: false,
    injured: true,
    reorder,
    rcl: 6,
  });
  const attackWorld = maintenanceWorld(FIRST_TICK + 2, base, {
    hostile: true,
    injured: false,
    reorder,
    rcl: 6,
  });
  const lowEnergy = maintenanceWorld(
    FIRST_TICK + 3,
    { ...base, towerEnergy: 790 },
    { hostile: false, injured: false, reorder, rcl: 6 },
  );
  return {
    clear: routine.map(({ kind, target }) => ({ kind, target })),
    heal: planDefense(healWorld, config).map(({ kind, target }) => ({ kind, target })),
    attack: planDefense(attackWorld, config).map(({ kind, target }) => ({ kind, target })),
    routineDuringHeal: planRoutineTowerMaintenance(healWorld, config, authorized.towerCandidates)
      .length,
    routineDuringAttack: planRoutineTowerMaintenance(
      attackWorld,
      config,
      authorized.towerCandidates,
    ).length,
    lowEnergyRoutine: planRoutineTowerMaintenance(lowEnergy, config, authorized.towerCandidates)
      .length,
    duplicateTargetsSuppressed: assigned.duplicateTargetsSuppressed,
    creepTargets: assigned.creepRequests.map(({ targetId }) => targetId),
  };
}

function reconciliationEvidence(reorder: boolean) {
  const tick = FIRST_TICK + TICKS;
  const snapshot = lifecycleWorld(tick, reorder);
  const planning = new ConstructionPlanner().plan({
    layouts: new Map(),
    reserves: [{ roomName: ROOM, state: "surplus" }],
    snapshot,
    traffic: [],
  });
  const budgets = projectMaintenanceBudgets({ existing: [], planning, tick, ttl: 20 });
  const ledger = allocate(budgets.budgets, tick, reorder);
  const contracts = lifecycleContracts(reorder);
  const first = authorizeMaintenanceWork({
    budgets: budgets.budgets,
    planning,
    reservations: ledger.entries,
    contracts: { status: "ready", contracts },
    tick,
  });
  const workOutcomes = maintenanceWorkOutcomes(
    { status: "ready", contracts },
    snapshot,
    first.retirements,
  );
  const retired = new Set(first.retirements.map(({ contractId }) => contractId));
  const second = authorizeMaintenanceWork({
    budgets: budgets.budgets,
    planning,
    reservations: ledger.entries,
    contracts: {
      status: "ready",
      contracts: contracts.filter(({ contractId }) => !retired.has(contractId)),
    },
    tick: tick + 1,
  });
  return {
    planning,
    retirements: first.retirements,
    repeatedRetirements: second.retirements.filter(({ to }) => to === "cancelled").length,
    retirementCounts: first.retirements.map(({ contractId }) => ({ contractId, count: 1 })),
    workOutcomes,
    changedBandTarget: planning.proposals.find(({ targetId }) => targetId === "wall-band")
      ?.targetHits,
  };
}

function plan(snapshot: WorldSnapshot, reserve: "protected" | "surplus") {
  return new ConstructionPlanner().plan({
    layouts: layouts(),
    reserves: [{ roomName: ROOM, state: reserve }],
    snapshot,
    traffic: measureMaintenanceTraffic(snapshot),
  });
}

function allocate(requests: readonly BudgetRequest[], tick: number, reorder: boolean) {
  return new BudgetLedger().reconcile({
    tick,
    capacity: {
      energy: [{ colonyId: ROOM, available: 1_000, protected: 550 }],
      cpu: 1,
      spawns: [],
    },
    requests: reorder ? [...requests].reverse() : requests,
  });
}

function survivalRequests(tick: number): readonly BudgetRequest[] {
  return [
    budget("emergency-spawn", "survival/spawn", 300, tick),
    budget("defense", "survival/defense", 100, tick),
    budget("replacement", "survival/replacement", 150, tick),
    budget("harvesting-filling", "survival/harvest", 50, tick),
    budget("controller-risk", "survival/controller", 50, tick),
  ];
}

function budget(
  category: BudgetCategory,
  issuer: string,
  energy: number,
  tick: number,
): BudgetRequest {
  return {
    category,
    colonyId: ROOM,
    issuer,
    revision: 1,
    expiresAt: tick + 20,
    energy: { minimum: energy, desired: energy },
    cpu: null,
    spawn: null,
  };
}

function maintenanceWorld(
  tick: number,
  state: {
    readonly roadHits: number;
    readonly containerHits: number;
    readonly towerEnergy: number;
  },
  options: {
    readonly hostile: boolean;
    readonly injured: boolean;
    readonly reorder: boolean;
    readonly rcl: number;
  },
): WorldSnapshot {
  const structures = [
    structure("spawn-main", "spawn", 5_000, 5_000, 10, 10, "owned"),
    structure("extension-ordinary", "extension", 1_000, 1_000, 13, 10, "owned"),
    structure("wall-main", "constructedWall", 50_000, 300_000_000, 20, 20, "unowned"),
    structure("rampart-main", "rampart", 50_000, 300_000_000, 21, 20, "owned"),
  ];
  const roads = [
    {
      ...structure("road-critical", "road", state.roadHits, 5_000, 11, 10, "unowned"),
      ticksToDecay: 900,
    },
  ];
  const stored = [
    {
      ...structure("container-source", "container", state.containerHits, 250_000, 12, 10, "owned"),
      ticksToDecay: 900,
      store: store(0, 2_000),
    },
  ];
  const worker = creep("worker", "Myrmex", {
    hits: options.injured ? 10 : 100,
    work: 1,
    carry: 1,
    move: 1,
    x: 11,
    y: 10,
  });
  const hostile = creep("hostile", "Enemy", {
    hits: 100,
    attack: 2,
    move: 2,
    x: 15,
    y: 15,
  });
  const room = {
    name: ROOM,
    observedAt: tick,
    energyAvailable: 1_000,
    energyCapacityAvailable: 1_000,
    controller: controller(options.rcl),
    hostileCreeps: options.hostile ? [hostile] : [],
    ownedCreeps: [worker],
    ownedExtensions: [],
    ownedSpawns: [
      {
        active: true,
        hits: 5_000,
        hitsMax: 5_000,
        id: "spawn-main",
        name: "Spawn1",
        pos: pos(10, 10),
        spawning: null,
        store: store(300, 300),
      },
    ],
    ownedTowers: [
      {
        hits: 3_000,
        hitsMax: 3_000,
        id: "tower-main",
        pos: pos(14, 10),
        store: store(state.towerEnergy, 1_000),
      },
    ],
    roads: options.reorder ? roads.slice().reverse() : roads,
    storedStructures: options.reorder ? stored.slice().reverse() : stored,
    structures: options.reorder ? structures.slice().reverse() : structures,
    constructionSites: [],
    droppedResources: [],
    ruins: [],
    sources: [],
    tombstones: [],
  };
  return snapshot(tick, room);
}

function fortificationWorld(rcl: number, hostile: boolean, reorder: boolean): WorldSnapshot {
  const structures = [
    structure("wall-band", "constructedWall", 100, 300_000_000, 20, 20, "unowned"),
    structure("rampart-band", "rampart", 100, 300_000_000, 21, 20, "owned"),
  ];
  const room = {
    ...emptyRoom(rcl),
    hostileCreeps: hostile ? [creep("hostile", "Enemy", { hits: 100, attack: 1 })] : [],
    structures: reorder ? structures.slice().reverse() : structures,
  };
  return snapshot(FIRST_TICK, room);
}

function lifecycleWorld(tick: number, reorder: boolean): WorldSnapshot {
  const structures = [
    structure("exact", "extension", 9_500, 10_000, 10, 10, "owned"),
    structure("over", "extension", 9_600, 10_000, 11, 10, "owned"),
    structure("wall-band", "constructedWall", 100, 300_000_000, 20, 20, "unowned"),
  ];
  return snapshot(tick, {
    ...emptyRoom(6),
    structures: reorder ? structures.slice().reverse() : structures,
  });
}

function lifecycleContracts(reorder: boolean): readonly ContractPlanningRecord[] {
  const values = [
    contract("changed-band", "wall-band", 20_000),
    contract("lost-target", "gone", 9_500),
    contract("overshoot", "over", 9_500),
    contract("satisfied", "exact", 9_500),
  ];
  return reorder ? values.slice().reverse() : values;
}

function contract(
  contractId: string,
  targetId: string,
  completionHits: number,
): ContractPlanningRecord {
  return {
    budgetBinding: { category: "maintenance", issuer: `maintenance-v2/${ROOM}` },
    contractId,
    execution: {
      action: "repair",
      completion: "work-complete",
      completionHits,
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    issuer: `maintenance-v2/${ROOM}/${targetId}/${String(completionHits)}`,
    owner: { id: ROOM, kind: "colony" },
    state: "active",
    targetId,
  };
}

function liveObjectResolver(
  state: { roadHits: number; containerHits: number },
  tick: number,
  meter: () => void,
) {
  const tower = {
    attack: () => {
      meter();
      return 0;
    },
    heal: () => {
      meter();
      return 0;
    },
    repair: (target: unknown) => {
      meter();
      if (tick === FIRST_TICK + 4) throw new Error("modeled command fault");
      const id = (target as { id?: string }).id;
      if (id === "road-critical") state.roadHits += 800;
      if (id === "container-source") state.containerHits += 800;
      return 0;
    },
  };
  return (id: string): unknown => {
    if (id === "tower-main") return tower;
    return { id };
  };
}

function batch(accepted: readonly DefenseIntent[], tick: number): ArbitrationBatch {
  return {
    tick,
    submitted: accepted.length,
    acceptedBudget: accepted.reduce((sum, intent) => sum + intent.budget.cost, 0),
    accepted,
    decisions: [],
  };
}

function commandsForTelemetry(
  rows: readonly { tick: number; kind: string; target: string; status: string; reason: string }[],
): readonly CommandExecutionResult<DefenseIntent>[] {
  return rows
    .filter(({ kind }) => kind === "tower.repair")
    .map((row) => ({
      command: {
        id: `evidence/${String(row.tick)}/${row.target}`,
        kind: "tower.repair",
        issuer: `maintenance/${ROOM}`,
        tick: row.tick,
        target: row.target,
        snapshotRevision: `evidence:${String(row.tick)}`,
        exclusiveResourceKey: "tower/tower-main",
        priority: { class: "maintenance", value: 1 },
        deadline: row.tick,
        budget: { id: `maintenance-v2/${ROOM}`, cost: 10 },
        preconditions: [],
        payload: { towerId: "tower-main" },
      },
      intentId: `evidence/${String(row.tick)}/${row.target}`,
      tick: row.tick,
      returnCode: row.status === "executed" ? 0 : row.status === "failed" ? null : -1,
      status: row.status as "executed" | "failed" | "rejected",
      reason: row.reason as CommandExecutionResult<DefenseIntent>["reason"],
      cpuUsed: 0.125,
      outcome:
        row.status === "executed"
          ? { state: "scheduled" as const, code: 0 as const, name: "OK" as const }
          : row.status === "failed"
            ? {
                state: "adapter-fault" as const,
                code: null,
                name: null,
                error: "modeled-command-fault",
              }
            : {
                state: "game-rejected" as const,
                code: -1 as const,
                name: "ERR_NOT_OWNER" as const,
              },
    }));
}

function maintenanceGrant(entries: readonly { category: string; grant: { energy: number } }[]) {
  return entries.find(({ category }) => category === "maintenance")?.grant.energy ?? 0;
}

function layouts(): ReadonlyMap<string, readonly LayoutPlacement[]> {
  return new Map([
    [
      ROOM,
      [
        placement("spawn", 10, 10),
        placement("road", 11, 10),
        placement("container", 12, 10),
        placement("extension", 13, 10),
      ],
    ],
  ]);
}

function placement(structureType: string, x: number, y: number): LayoutPlacement {
  return {
    adoption: "planned",
    layer: structureType === "road" ? "road" : "primary",
    minimumRcl: 1,
    pos: pos(x, y),
    structureType,
  };
}

function snapshot(tick: number, room: unknown): WorldSnapshot {
  return {
    schemaVersion: 1,
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    rooms: [room],
    ownedRooms: [room],
    visibility: { absentRoomSemantics: "unknown", scope: "current-tick", rooms: [] },
    stats: { estimatedPayloadBytes: 1, entities: {} },
  } as unknown as WorldSnapshot;
}

function emptyRoom(rcl: number) {
  return {
    name: ROOM,
    observedAt: FIRST_TICK,
    energyAvailable: 1_000,
    energyCapacityAvailable: 1_000,
    controller: controller(rcl),
    hostileCreeps: [],
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    roads: [],
    storedStructures: [],
    structures: [],
    constructionSites: [],
    droppedResources: [],
    ruins: [],
    sources: [],
    tombstones: [],
  };
}

function controller(level: number) {
  return {
    id: "controller",
    level,
    ownerUsername: "Myrmex",
    ownership: "owned" as const,
    pos: pos(25, 25),
    progress: 0,
    progressTotal: 1,
    reservationTicksToEnd: null,
    reservationUsername: null,
    safeMode: null,
    safeModeAvailable: 1,
    safeModeCooldown: null,
    ticksToDowngrade: 10_000,
    upgradeBlocked: null,
  };
}

function structure(
  id: string,
  structureType: string,
  hits: number,
  hitsMax: number,
  x: number,
  y: number,
  ownership: "owned" | "unowned",
) {
  return {
    hits,
    hitsMax,
    id,
    isPublic: structureType === "rampart" ? false : null,
    ownerUsername: ownership === "owned" ? "Myrmex" : null,
    ownership,
    pos: pos(x, y),
    structureType,
    ticksToDecay: null,
  };
}

function creep(
  id: string,
  ownerUsername: string,
  options: {
    readonly hits: number;
    readonly attack?: number;
    readonly carry?: number;
    readonly heal?: number;
    readonly move?: number;
    readonly work?: number;
    readonly x?: number;
    readonly y?: number;
  },
) {
  const part = (active = 0) => ({ active, boosted: 0, total: active });
  const activeParts =
    (options.attack ?? 0) +
    (options.carry ?? 0) +
    (options.heal ?? 0) +
    (options.move ?? 0) +
    (options.work ?? 0);
  return {
    id,
    name: id,
    ownerUsername,
    pos: pos(options.x ?? 15, options.y ?? 15),
    body: {
      activeParts,
      size: activeParts,
      attack: part(options.attack),
      carry: part(options.carry),
      claim: part(),
      heal: part(options.heal),
      move: part(options.move),
      rangedAttack: part(),
      tough: part(),
      work: part(options.work),
    },
    fatigue: 0,
    hits: options.hits,
    hitsMax: 100,
    spawning: false,
    store: store(0, 50),
    ticksToLive: 1_000,
  };
}

function store(energy: number, capacity: number) {
  return {
    capacity,
    freeCapacity: capacity - energy,
    resources: energy === 0 ? [] : [{ resourceType: "energy", amount: energy }],
    usedCapacity: energy,
  };
}

function pos(x: number, y: number) {
  return { roomName: ROOM, x, y };
}

function stripPlanning(value: ReturnType<typeof reconciliationEvidence>) {
  const { planning: _planning, ...rest } = value;
  void _planning;
  return rest;
}

function equalField(
  warm: ReturnType<typeof runVariant>,
  reset: ReturnType<typeof runVariant>,
  reordered: ReturnType<typeof runVariant>,
  field: "contracts" | "retirements" | "commands" | "telemetryRows",
) {
  const first = canonicalSerialize(warm.semantic[field]);
  return (
    first === canonicalSerialize(reset.semantic[field]) &&
    first === canonicalSerialize(reordered.semantic[field])
  );
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
