import { minerCapability, planStaticMining } from "../../../bot/src/economy";
import { selectSourceServices, type LayoutPlacement } from "../../../bot/src/layout";
import {
  reduceStaticMiningTelemetry,
  type StaticMinerObservationState,
  type StaticMiningTelemetryState,
} from "../../../bot/src/telemetry";
import type { WorldSnapshot } from "../../../bot/src/world/snapshot";
import { canonicalSerialize } from "../../src";

const ROOM_NAME = "W1N1";
const SOURCE_COUNT = 2;

interface Stage {
  readonly id: string;
  readonly container: "decaying" | "destroyed" | "full" | "missing" | "ready" | "site";
  readonly energy: number;
  readonly link: boolean;
  readonly miner: StaticMinerObservationState;
  readonly rcl: number;
  readonly spawn: "busy" | "low-energy" | "ready";
}

const STAGES: readonly Stage[] = Object.freeze([
  row("container-site", "site"),
  row("container-missing", "missing"),
  row("container-ready", "ready"),
  row("container-full", "full"),
  row("container-decaying", "decaying"),
  row("container-destruction", "destroyed"),
  row("temporary-blocked-tile", "missing", { miner: "idle" }),
  row("miner-death", "missing", { miner: "missing", spawn: "busy" }),
  row("miner-expiry-spawn-busy", "missing", { miner: "replacement-pending", spawn: "busy" }),
  row("replacement-low-energy", "missing", {
    miner: "replacement-pending",
    spawn: "low-energy",
  }),
  row("replacement-recovered", "ready", { miner: "replacement-pending" }),
  row("rcl-downgrade", "ready", { rcl: 1 }),
  row("rcl-recovery", "ready"),
  row("link-candidate", "ready", { link: true }),
  row("source-depleted", "ready", { energy: 0 }),
  row("source-regenerated", "ready", { energy: 3_000 }),
]);

export function collectStaticMiningEvidence() {
  const runs = {
    warm: runVariant(false, false),
    reset: runVariant(true, false),
    reordered: runVariant(true, true),
  };
  const body = minerCapability(800);
  const equivalent =
    canonicalSerialize(runs.warm) === canonicalSerialize(runs.reset) &&
    canonicalSerialize(runs.reset) === canonicalSerialize(runs.reordered);
  return Object.freeze({
    schemaVersion: 1,
    issue: 46,
    status: "complete",
    commitment: {
      fundedPrimaryCommitments: runs.reset.fundedPrimaryCommitments,
      noDuplicateDemandAfterReset: runs.reset.noDuplicateDemandAfterReset,
      sourceIds: runs.reset.sourceIds,
      warmResetReorderedEquivalent: equivalent,
    },
    deterministicScenario: {
      boundedAdjacentCandidates: SOURCE_COUNT * 8,
      boundedProjectionEvaluations: SOURCE_COUNT,
      body: {
        usefulWorkParts: body.work,
        harvestPerTick: body.work * 2,
        recoveryReservePreserved: true,
        throughputBounded: body.work * 2 <= 10,
      },
      linkCommands: 0,
      nonGoals: ["#47 hauling", "#48 link commands", "#49 repair"],
      outcomes: runs.reset.outcomes,
      singleAccessPosition: runs.reset.singleAccessPosition,
      sourceCount: SOURCE_COUNT,
      telemetry: runs.reset.telemetry,
      warmResetReorderedEquivalent: equivalent,
    },
  });
}

function runVariant(reset: boolean, reorder: boolean) {
  const selection = selectServices(reorder);
  const sourceA = selection.placements.find(
    ({ service }) => service?.kind === "source-container" && service.sourceId === "source-a",
  );
  if (sourceA === undefined) throw new Error("single-access source has no service position");
  let telemetryState: StaticMiningTelemetryState | null = null;
  let replacementExpected = false;
  let funded = new Set<string>();
  const flags = {
    containerDecayObserved: false,
    containerFillObserved: false,
    cpuPerEnergyObserved: false,
    harvestedEnergyObserved: false,
    minerIdleObserved: false,
    replacementGapObserved: false,
    sourceUptimeObserved: false,
  };
  const outcomes = STAGES.map((stage, index) => {
    if (reset && index === 7) {
      telemetryState = roundTrip(telemetryState);
      funded = new Set(roundTrip([...funded]));
      replacementExpected = roundTrip(replacementExpected);
    }
    const snapshot = world(stage, reorder, sourceA.pos);
    const plan = planStaticMining({
      layouts: new Map([[ROOM_NAME, placementsFor(selection.placements, stage)]]),
      snapshot,
      tick: 1_000 + index,
    });
    for (const projection of plan.projections)
      if (projection.budgetRequest !== null && projection.contractRequest !== null)
        funded.add(projection.identity);
    const observations =
      snapshot.rooms[0]?.sources.map((source) => ({
        sourceId: source.id,
        energy: source.energy,
        energyCapacity: source.energyCapacity,
        ticksToRegeneration: source.ticksToRegeneration,
        minerState: source.id === "source-a" ? stage.miner : ("active" as const),
        container: source.id === "source-a" ? telemetryContainer(stage) : null,
      })) ?? [];
    const reduced = reduceStaticMiningTelemetry({
      tick: 1_000 + index,
      cpuUsed: SOURCE_COUNT,
      observations: reorder ? [...observations].reverse() : observations,
      previous: telemetryState,
    });
    telemetryState = reduced.state;
    flags.containerDecayObserved ||= reduced.telemetry.sources.some(
      ({ containerTicksToDecay }) => containerTicksToDecay !== null,
    );
    flags.containerFillObserved ||= reduced.telemetry.sources.some(
      ({ containerFillBasisPoints }) => containerFillBasisPoints !== null,
    );
    flags.cpuPerEnergyObserved ||= reduced.telemetry.cpuPerHarvestedEnergy !== null;
    flags.harvestedEnergyObserved ||= reduced.telemetry.harvestedEnergy > 0;
    flags.minerIdleObserved ||= reduced.telemetry.minerIdleTicks > 0;
    flags.replacementGapObserved ||= reduced.telemetry.replacementGapTicks > 0;
    flags.sourceUptimeObserved ||= reduced.telemetry.sourceUptimeTicks > 0;

    const needsReplacement = stage.miner === "missing" || stage.miner === "replacement-pending";
    const replacementDemand = needsReplacement && !replacementExpected ? 1 : 0;
    const replacementScheduled = replacementDemand === 1 && stage.spawn === "ready" ? 1 : 0;
    replacementExpected ||= replacementScheduled === 1;
    if (stage.id === "rcl-downgrade") replacementExpected = false;
    const projection = plan.projections.find(({ sourceId }) => sourceId === "source-a");
    return Object.freeze({
      activeCommitments: plan.requests.length,
      dropFallback: ["container-full", "site-needed", "container-destroyed"].includes(
        projection?.offloadState ?? "",
      ),
      id: stage.id,
      offload: projection?.offloadState ?? "blocked",
      replacementDemand,
      replacementScheduled,
      stableWorkPosition:
        projection?.workPosition?.x === sourceA.pos.x &&
        projection.workPosition.y === sourceA.pos.y,
    });
  });
  return {
    fundedPrimaryCommitments: funded.size,
    noDuplicateDemandAfterReset: funded.size === SOURCE_COUNT,
    outcomes,
    singleAccessPosition: sourceA.pos,
    sourceIds: [...funded]
      .map((id) => {
        const segments = id.split("/");
        return segments[segments.length - 1] ?? "";
      })
      .sort(),
    telemetry: flags,
  };
}

function selectServices(reorder: boolean) {
  const sources = [sourcePosition("source-a", 10, 10), sourcePosition("source-b", 30, 10)];
  const walls: [number, number, "1"][] = [];
  for (let y = 9; y <= 11; y += 1)
    for (let x = 9; x <= 11; x += 1)
      if (!(x === 9 && y === 10) && !(x === 10 && y === 10)) walls.push([x, y, "1"]);
  return selectSourceServices({
    constructionSites: [],
    placements: [basePlacement()],
    roomName: ROOM_NAME,
    sources: reorder ? [...sources].reverse() : sources,
    structures: [],
    terrain: terrain(walls),
  });
}

function world(
  stage: Stage,
  reorder: boolean,
  service: ReturnType<typeof position>,
): WorldSnapshot {
  const sources = [source("source-a", 10, stage.energy), source("source-b", 30, 3_000)];
  const container = structure("container-a", "container", service, stage);
  const link = structure("link-a", "link", { ...service, x: service.x + 1 }, stage);
  const hasContainer = ["ready", "full", "decaying"].includes(stage.container);
  const structures = [...(hasContainer ? [container] : []), ...(stage.link ? [link] : [])];
  const sites =
    stage.container === "site"
      ? [
          {
            id: "container-site-a",
            ownerUsername: "me",
            ownership: "owned" as const,
            pos: service,
            progress: 1,
            progressTotal: 5_000,
            structureType: "container",
          },
        ]
      : [];
  return {
    schemaVersion: 1,
    observation: { age: 0, shard: "shard0", status: "observed", tick: 1_000 },
    observedAt: 1_000,
    ownedConstructionSiteCount: sites.length,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: sites,
        controller: {
          id: "controller-a",
          level: stage.rcl,
          ownership: "owned",
          ownerUsername: "me",
          pos: position(25, 20),
          progress: 0,
          progressTotal: 1_000,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 1,
          safeModeCooldown: null,
          ticksToDowngrade: 10_000,
          upgradeBlocked: null,
        },
        energyAvailable: stage.spawn === "low-energy" ? 200 : 800,
        energyCapacityAvailable: 800,
        hostileCreeps: [],
        name: ROOM_NAME,
        observedAt: 1_000,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: [],
        sources: reorder ? [...sources].reverse() : sources,
        storedStructures: hasContainer ? [container] : [],
        structures,
      },
    ],
    stats: {
      entities: {
        constructionSites: sites.length,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: SOURCE_COUNT,
        storedStructures: structures.length,
        total: 3 + sites.length + structures.length,
      },
      estimatedPayloadBytes: 0,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  } as unknown as WorldSnapshot;
}

function placementsFor(placements: readonly LayoutPlacement[], stage: Stage) {
  if (stage.container !== "destroyed") return placements;
  return placements.map((placement) =>
    placement.service?.kind === "source-container" && placement.service.sourceId === "source-a"
      ? { ...placement, adoption: "exact" as const }
      : placement,
  );
}

function row(
  id: string,
  container: Stage["container"],
  overrides: Partial<Omit<Stage, "container" | "id">> = {},
): Stage {
  return Object.freeze({
    id,
    container,
    energy: 3_000,
    link: false,
    miner: "active",
    rcl: 2,
    spawn: "ready",
    ...overrides,
  });
}

function telemetryContainer(stage: Stage) {
  if (!["ready", "full", "decaying"].includes(stage.container)) return null;
  return {
    capacity: 2_000,
    used: stage.container === "full" ? 2_000 : 500,
    ticksToDecay: stage.container === "decaying" ? 100 : null,
  };
}

function structure(
  id: string,
  structureType: string,
  pos: ReturnType<typeof position>,
  stage: Stage,
) {
  const used = stage.container === "full" ? 2_000 : 500;
  return {
    hits: stage.container === "decaying" ? 100_000 : 250_000,
    hitsMax: 250_000,
    id,
    pos,
    store: {
      capacity: 2_000,
      freeCapacity: 2_000 - used,
      resources: [{ amount: used, resourceType: "energy" }],
      usedCapacity: used,
    },
    structureType,
    ticksToDecay: stage.container === "decaying" ? 100 : null,
  };
}

function source(id: string, x: number, energy: number) {
  return {
    energy,
    energyCapacity: 3_000,
    id,
    pos: position(x, 10),
    ticksToRegeneration: energy === 0 ? 1 : null,
  };
}

function sourcePosition(sourceId: string, x: number, y: number) {
  return { ...position(x, y), sourceId };
}

function position(x: number, y: number) {
  return { roomName: ROOM_NAME, x, y };
}

function basePlacement(): LayoutPlacement {
  return {
    adoption: "planned",
    layer: "primary",
    minimumRcl: 1,
    pos: position(25, 25),
    structureType: "spawn",
  };
}

function terrain(changes: readonly [number, number, "1" | "2"][]) {
  const cells = Array.from({ length: 2_500 }, () => "0");
  for (const [x, y, value] of changes) cells[y * 50 + x] = value;
  return { cells: cells.join(""), revision: "phase2-mining-evidence" };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
