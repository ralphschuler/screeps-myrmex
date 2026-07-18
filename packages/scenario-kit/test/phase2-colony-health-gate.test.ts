import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-colony-health-results.json";
import {
  COLONY_DOMAIN_HEALTH_DOMAINS,
  ColonyDirector,
  type BudgetRequest,
  type ColonyDomainHealthStatus,
  type ColoniesOwnerV1,
} from "../../bot/src/colony";
import { buildRuntimeConfig } from "../../bot/src/config/runtime-config";
import { selectLayoutPlanningWindow } from "../../bot/src/layout";
import { deriveRuntimeColonyDomainHealth } from "../../bot/src/runtime/colony-domain-health";
import { colonyDomainHealthFixture } from "../../bot/test/support/colony-domain-health-fixture";
import { freezeWorldSnapshot, type WorldSnapshot } from "../../bot/src/world/snapshot";
import { canonicalHash } from "../src";

const CPU_BUDGET = Object.freeze({
  available: 5,
  hardCeiling: 10,
  estimate: 1.5,
  reservedForTail: 2,
});

describe("Phase 2 colony domain-health deterministic evidence (#225)", () => {
  it("matches checked recovery, maturity, reset, and reorder evidence", () => {
    expect(collectColonyHealthEvidence()).toEqual(checked);
  });
});

export function collectColonyHealthEvidence() {
  const director = new ColonyDirector();
  const nominal = director.plan(input(100, {}, healthyStatuses(100)));
  const owner = required(nominal.replacementOwner);
  const resetOwner = JSON.parse(JSON.stringify(owner)) as ColoniesOwnerV1;
  const reordered = director.plan(
    input(101, resetOwner, [...healthyStatuses(101)].reverse(), { reverseWorld: true }),
  );
  const failures = Object.fromEntries(
    COLONY_DOMAIN_HEALTH_DOMAINS.map((domain) => {
      const result = director.plan(input(101, resetOwner, directStatuses(101, domain)));
      return [
        domain,
        {
          blocker: result.colonies[0]?.domainHealth.blocker ?? null,
          objectiveCount: result.objectives.length,
          state: result.colonies[0]?.state ?? null,
        },
      ];
    }),
  );
  const stale = director.plan(input(101, resetOwner, directStatuses(101, "stale-logistics")));
  const workforceLoss = director.plan(
    input(101, resetOwner, healthyStatuses(101), { legalWorker: false }),
  );
  const reserveLoss = director.plan(input(101, resetOwner, healthyStatuses(101), { energy: 299 }));
  const jointLoss = director.plan(input(101, resetOwner, directStatuses(101, "all")));
  const jointOwner = required(jointLoss.replacementOwner);
  const repairRequest = growthRequest("build", "site-a");
  const repair = director.plan({
    ...input(102, jointOwner, directStatuses(102, "layout"), { energy: 400 }),
    requests: [repairRequest, growthRequest("upgrade-controller", "controller")],
  });
  const restored = director.plan(input(102, jointOwner, healthyStatuses(102)));
  const layoutCoverage = new Set(
    [100, 101].flatMap((tick) =>
      selectLayoutPlanningWindow(
        ["W3N3", "W1N1", "W2N2"].map((roomName) => ({ roomName })),
        tick,
      ).map(({ roomName }) => roomName),
    ),
  );

  return {
    schemaVersion: 1,
    nominal: {
      lifecycle: nominal.colonies[0]?.state ?? null,
      policy: nominal.colonies[0]?.rclPolicy.progression ?? null,
      domainStatus: nominal.colonies[0]?.domainHealth.status ?? null,
      persistedDomainHealth: "domainHealth" in (owner.colonies[0] ?? {}),
    },
    deterministic: {
      resetAndReorderEquivalent:
        canonicalHash(nominal.colonies[0]) === canonicalHash(reordered.colonies[0]),
      canonicalDomainOrder: reordered.colonies[0]?.domainHealth.domains.map(({ domain }) => domain),
    },
    failures: {
      domains: failures,
      jointBlocker: jointLoss.colonies[0]?.domainHealth.blocker ?? null,
      reserve: {
        reason: reserveLoss.colonies[0]?.reasonCode ?? null,
        state: reserveLoss.colonies[0]?.state ?? null,
      },
      stale: stale.colonies[0]?.domainHealth.blocker ?? null,
      workforce: {
        objectiveCount: workforceLoss.objectives.length,
        state: workforceLoss.colonies[0]?.state ?? null,
      },
    },
    recovery: {
      exitState: restored.colonies[0]?.state ?? null,
      objectiveCount: restored.objectives.length,
      ownerRevision: restored.replacementOwner?.revision ?? jointOwner.revision,
      repairBuildStatus:
        repair.decisions.find(({ issuer }) => issuer === repairRequest.issuer)?.status ?? null,
      repairUpgradeReason:
        repair.decisions.find(({ issuer }) => issuer.includes("upgrade-controller"))?.reasonCode ??
        null,
      reservationCount: restored.reservations.length,
    },
    bounds: {
      domainCount: COLONY_DOMAIN_HEALTH_DOMAINS.length,
      layoutWindowCoverage: [...layoutCoverage].sort(),
      persistentBytesAdded: 0,
      telemetryDecisionInputs: 0,
    },
  };
}

function growthRequest(action: "build" | "upgrade-controller", targetId: string): BudgetRequest {
  return {
    colonyId: "W1N1",
    category: "optional-growth",
    issuer: `growth/W1N1/${action}/${targetId}`,
    revision: 1,
    expiresAt: 120,
    energy: { minimum: 1, desired: 1 },
    cpu: { minimum: 1, desired: 1 },
    spawn: null,
  };
}

function input(
  tick: number,
  owner: unknown,
  domainHealth: readonly ColonyDomainHealthStatus[],
  options: {
    readonly energy?: number;
    readonly legalWorker?: boolean;
    readonly reverseWorld?: boolean;
  } = {},
) {
  return {
    tick,
    snapshot: snapshot(tick, options),
    config: buildRuntimeConfig(),
    owner,
    cpuMode: "normal" as const,
    cpuBudget: CPU_BUDGET,
    domainHealth,
  };
}

function healthyStatuses(tick: number): readonly ColonyDomainHealthStatus[] {
  return directStatuses(tick, null);
}

function directStatuses(
  tick: number,
  failure: (typeof COLONY_DOMAIN_HEALTH_DOMAINS)[number] | "all" | "stale-logistics" | null,
): readonly ColonyDomainHealthStatus[] {
  const base = colonyDomainHealthFixture(tick);
  const room = base.rooms[0];
  if (room === undefined) throw new Error("domain-health fixture room missing");
  const fails = (domain: (typeof COLONY_DOMAIN_HEALTH_DOMAINS)[number]) =>
    failure === domain || failure === "all";
  return deriveRuntimeColonyDomainHealth({
    ...base,
    rooms: [
      {
        ...room,
        ownedSpawns: fails("layout") ? room.ownedSpawns.slice(0, 2) : room.ownedSpawns,
      },
    ],
    activeHarvestTargetIds: fails("mining") ? new Set(["source-a"]) : base.activeHarvestTargetIds,
    logisticsHealth:
      fails("logistics") || failure === "stale-logistics"
        ? [
            {
              colonyId: "W1N1",
              observedAt: failure === "stale-logistics" ? tick - 1 : tick,
              status: fails("logistics") ? ("failed" as const) : ("healthy" as const),
            },
          ]
        : base.logisticsHealth,
    linkHealth: fails("links")
      ? [{ colonyId: "W1N1", observedAt: tick, status: "failed" as const }]
      : base.linkHealth,
    maintenanceHealth: fails("maintenance")
      ? [{ colonyId: "W1N1", observedAt: tick, status: "failed" as const }]
      : base.maintenanceHealth,
    resources: base.resources.map((resource) => ({
      ...resource,
      hasTerminal: fails("resources") ? false : resource.hasTerminal,
    })),
    labAssignments: fails("labs") ? [] : base.labAssignments,
    mature: {
      ...base.mature,
      capabilities: fails("industry") ? [] : base.mature.capabilities,
    },
  });
}

function snapshot(
  tick: number,
  options: {
    readonly energy?: number;
    readonly legalWorker?: boolean;
    readonly reverseWorld?: boolean;
  },
): WorldSnapshot {
  const roomName = "W1N1";
  const worker = {
    id: "worker",
    name: "worker",
    ownerUsername: "Myrmex",
    pos: { roomName, x: 20, y: 20 },
    body: {
      activeParts: 3,
      size: 3,
      attack: capability(),
      carry: capability(1),
      claim: capability(),
      heal: capability(),
      move: capability(1),
      rangedAttack: capability(),
      tough: capability(),
      work: capability(1),
    },
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    spawning: false,
    store: { capacity: 50, freeCapacity: 50, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
  const ownedCreeps = options.legalWorker === false ? [] : [worker];
  const spawns = ["spawn-a", "spawn-b", "spawn-c"].map((id, index) => ({
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id,
    name: id,
    pos: { roomName, x: 23 + index, y: 25 },
    spawning: null,
    store: {
      capacity: 300,
      freeCapacity: 0,
      resources: [{ resourceType: "energy", amount: 300 }],
      usedCapacity: 300,
    },
  }));
  const room = {
    name: roomName,
    observedAt: tick,
    energyAvailable: options.energy ?? 300,
    energyCapacityAvailable: 12_900,
    controller: {
      id: "controller",
      level: 8,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: { roomName, x: 25, y: 25 },
      progress: 0,
      progressTotal: 0,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 1,
      safeModeCooldown: null,
      ticksToDowngrade: 100_000,
      upgradeBlocked: null,
    },
    sources: (options.reverseWorld ? ["source-b", "source-a"] : ["source-a", "source-b"]).map(
      (id, index) => ({
        energy: 3_000,
        energyCapacity: 3_000,
        id,
        pos: { roomName, x: 10 + index * 20, y: 10 },
        ticksToRegeneration: 100,
      }),
    ),
    ownedSpawns: options.reverseWorld ? [...spawns].reverse() : spawns,
    ownedExtensions: [],
    ownedTowers: [],
    ownedCreeps,
    hostileCreeps: [],
    constructionSites: [],
    droppedResources: [],
    storedStructures: [],
    ruins: [],
    tombstones: [],
  };
  return freezeWorldSnapshot({
    schemaVersion: 1,
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
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
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: ownedCreeps.length,
        ownedExtensions: 0,
        ownedSpawns: spawns.length,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 2,
        storedStructures: 0,
        tombstones: 0,
        total: 6 + ownedCreeps.length,
      },
      estimatedPayloadBytes: 0,
    },
  });
}

function capability(active = 0) {
  return { active, boosted: 0, total: active };
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("expected persisted colony owner");
  return value;
}
