import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import {
  PRODUCTION_REMOTE_ACCOUNTING_POLICY_V1,
  projectRemoteAccountingObservations,
  reduceRemoteAccounting,
  type RemoteAccountingRecordV1,
  type RemoteCandidateEvidence,
} from "../src/remotes";
import { selectRemoteCandidatePairs } from "../src/remotes/runtime";
import type { ContractExecutionView, ContractPlanningView } from "../src/contracts";
import type { WorldSnapshot } from "../src/world/snapshot";
import { RoutePlanner } from "../src/world/routes";
import { installMatureRuntimeGlobals, matureRuntimeWorld } from "./support/mature-runtime-fixture";
import { remoteRuntimeGame } from "./support/remote-runtime-fixture";

describe("remote portfolio production composition", () => {
  beforeAll(() => {
    installMatureRuntimeGlobals();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("source-enables the portfolio gate but waits for map evidence before owner initialization", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    const outcome = runTick({ game: world.game(100), memory });
    const remotes = (outcome as unknown as { readonly remotes?: { readonly status: string } })
      .remotes;

    expect(outcome.config.features.gates["phase3.portfolio" as never]).toMatchObject({
      enabled: true,
    });
    expect(remotes).toMatchObject({ status: "owner-malformed" });
    expect(memory.myrmex?.remotes).toEqual({});
  });

  it("discovers a visible adjacent neutral remote and activates it after bounded probing", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;

    const first = runTick({ game: remoteRuntimeGame(world, 200), memory });
    const second = runTick({ game: remoteRuntimeGame(world, 201), memory });
    const third = runTick({ game: remoteRuntimeGame(world, 202), memory });
    const fourth = runTick({ game: remoteRuntimeGame(world, 203), memory });

    expect(first.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "probing", reason: "positive-probe" }),
    ]);
    expect(second.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "active", reason: "positive-active" }),
    ]);
    expect(second.remotes.objectives).toEqual([
      expect.objectContaining({ roomName: "W1N2", donorColonyId: "W1N1", state: "active" }),
    ]);
    expect(second.remotes.metrics).toMatchObject({ active: 1, reservedEnergy: 6_800 });
    const remoteIssuers = second.colony.reservations
      .filter(({ issuer }) => issuer.startsWith("remote-"))
      .map(({ issuer }) => issuer)
      .sort();
    expect(remoteIssuers.filter((issuer) => issuer.startsWith("remote-hauling/"))).toHaveLength(0);
    expect(remoteIssuers).toEqual([
      "remote-mining/W1N1/W1N2/remote-source-a",
      "remote-mining/W1N1/W1N2/remote-source-b",
      "remote-reservation/W1N1/W1N2",
    ]);
    expect(second.colony.reservations.every(({ grant }) => grant.energy >= 0)).toBe(true);
    expect(third.remoteOperations?.hauling.dispositions.map(({ reason }) => reason)).toEqual([
      "budget-unavailable",
      "budget-unavailable",
    ]);
    expect(
      third.colony.reservations.filter(({ issuer }) => issuer.startsWith("remote-hauling/")),
    ).toHaveLength(2);
    expect(fourth.remoteOperations?.hauling.dispositions.map(({ reason }) => reason)).toEqual([
      "contract-ready",
      "contract-ready",
    ]);
    expect(
      (
        memory.myrmex?.contracts as
          { readonly active?: readonly { readonly issuer: string }[] } | undefined
      )?.active?.filter(
        ({ issuer }) =>
          issuer.startsWith("remote-mining/") || issuer.startsWith("remote-reservation/"),
      ),
    ).toHaveLength(3);
    expect(
      (
        memory.myrmex?.contracts as
          | {
              readonly active?: readonly {
                readonly execution: { readonly version: number };
              }[];
            }
          | undefined
      )?.active?.filter(({ execution }) => execution.version === 6),
    ).toHaveLength(2);
  });

  it("renews a continuously qualified objective before its terminal timeout", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    runTick({ game: remoteRuntimeGame(world, 410), memory });
    runTick({ game: remoteRuntimeGame(world, 411), memory });
    const initial = remoteRecord(memory, "W1N2");
    const renewalTick = initial.expiresAt - 250;

    const renewed = runTick({ game: remoteRuntimeGame(world, renewalTick), memory });
    const current = remoteRecord(memory, "W1N2");

    expect(renewed.remotes.dispositions).toContainEqual(
      expect.objectContaining({ roomName: "W1N2", state: "active" }),
    );
    expect(current.expiresAt).toBe(renewalTick + 1_500);
  });

  it("does not renew a threat-blocked objective", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    runTick({ game: remoteRuntimeGame(world, 415), memory });
    runTick({ game: remoteRuntimeGame(world, 416), memory });
    const initial = remoteRecord(memory, "W1N2");
    const renewalTick = initial.expiresAt - 250;

    const blocked = runTick({
      game: remoteRuntimeGame(world, renewalTick, { threat: true }),
      memory,
    });

    expect(blocked.remotes.dispositions).toContainEqual(
      expect.objectContaining({ roomName: "W1N2", state: "threatened" }),
    );
    expect(remoteRecord(memory, "W1N2").expiresAt).toBe(initial.expiresAt);
  });

  it("prioritizes an active retained remote and its exact donor at the candidate cap", () => {
    const prior = (activeRemoteOwner() as { readonly records: readonly Record<string, unknown>[] })
      .records[0];
    if (prior === undefined) throw new Error("missing retained remote fixture");
    const owner = {
      ...(activeRemoteOwner() as Record<string, unknown>),
      records: [{ ...prior, roomName: "W9N9", donorColonyId: "W2N1" }],
    };
    const snapshot = {
      ownedRooms: [{ name: "W1N1" }, { name: "W2N1" }],
      rooms: [],
    } as unknown as WorldSnapshot;
    const map = {
      describeExits: (roomName: string) =>
        roomName === "W1N1"
          ? { 1: "W1N2", 3: "W1N3", 5: "W1N4", 7: "W9N9" }
          : roomName === "W2N1"
            ? { 1: "W1N5", 3: "W9N9" }
            : {},
      getRoomStatus: () => ({ status: "normal" as const, timestamp: null }),
    };

    const selected = selectRemoteCandidatePairs(snapshot, map, owner);

    expect(selected).toHaveLength(4);
    expect(selected.find(({ remote }) => remote === "W9N9")?.donor.name).toBe("W2N1");
  });

  it("keeps planning after bounded expected remote spawn command errors", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    const outcomes = Array.from({ length: 8 }, (_, index) =>
      runTick({
        game: remoteRuntimeGame(world, 430 + index, {
          secondRemote: true,
          ...(index >= 4 && index <= 6 ? { spawnReturnCode: -6 } : {}),
          threat: index === 7,
        }),
        memory,
      }),
    );

    expect(
      outcomes
        .flatMap((outcome) => outcome.spawn.execution)
        .filter(({ returnCode }) => returnCode === -6),
    ).toHaveLength(3);
    expect(outcomes[6]?.kernel.faults).toEqual([]);
    expect(outcomes[6]?.colony.status).toBe("planned");
    expect(outcomes[6]?.remotes.dispositions).toContainEqual(
      expect.objectContaining({ roomName: "W1N2", state: "active" }),
    );
    expect(outcomes[7]?.kernel.faults).toEqual([]);
    expect(outcomes[7]?.remotes.dispositions).toContainEqual(
      expect.objectContaining({ roomName: "W1N2", state: "threatened" }),
    );
    expect(outcomes[7]?.spawn.execution).toEqual([]);
  });

  it("keeps only the profitable competing remote after a forecast reversal", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;

    runTick({ game: remoteRuntimeGame(world, 450, { secondRemote: true }), memory });
    const selected = runTick({
      game: remoteRuntimeGame(world, 451, { secondRemote: true }),
      memory,
    });
    const reversed = runTick({
      game: remoteRuntimeGame(world, 452, {
        reducedPrimarySourceCapacity: true,
        secondRemote: true,
      }),
      memory,
    });
    const replacement = runTick({
      game: remoteRuntimeGame(world, 453, {
        reducedPrimarySourceCapacity: true,
        secondRemote: true,
      }),
      memory,
    });

    expect(selected.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "active" }),
      expect.objectContaining({ roomName: "W1N3", state: "candidate" }),
    ]);
    expect(reversed.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "suspended", reason: "negative-value" }),
      expect.objectContaining({ roomName: "W1N3", state: "probing", reason: "positive-probe" }),
    ]);
    expect(replacement.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "suspended", reason: "negative-value" }),
      expect.objectContaining({ roomName: "W1N3", state: "active", reason: "positive-active" }),
    ]);
    expect(replacement.remotes.objectives.map(({ roomName }) => roomName)).toEqual(["W1N3"]);
  });

  it("releases remote capacity when total donor workforce loss starts survival recovery", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    runTick({ game: remoteRuntimeGame(world, 470), memory });
    runTick({ game: remoteRuntimeGame(world, 471), memory });

    const lost = runTick({
      game: remoteRuntimeGame(world, 472, { totalWorkerLoss: true }),
      memory,
    });

    expect(lost.colony.colonies).toEqual([
      expect.objectContaining({ id: "W1N1", state: "recovering" }),
    ]);
    expect(lost.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "suspended", reason: "donor-pressure" }),
    ]);
    expect(lost.remotes.metrics).toMatchObject({
      released: 1,
      reservedEnergy: 0,
      reservedSpawnTicks: 0,
      reservedCpuMilli: 0,
      reservedMemoryCodeUnits: 0,
    });
    expect(lost.remoteOperations?.budgetRequests).toEqual([]);
  });

  it("waits for a settled delivery or actor loss before opening realized accounting", () => {
    const observations = projectRemoteAccountingObservations({
      candidates: [accountingCandidate()],
      contracts: accountingContracts(),
      execution: remoteExecution(),
      owner: activeRemoteOwner(),
      snapshot: remoteAccountingSnapshot(true, 100, 50),
      tick: 499,
    });

    expect(observations).toEqual([]);
  });

  it("keeps full-cost settled cycles warming through the payback window", () => {
    let previous: readonly RemoteAccountingRecordV1[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const tick = 500 + cycle * 100;
      const result = reduceRemoteAccounting({
        observations: [
          {
            constructionEnergy: 0,
            cpuMilli: 20_000,
            creepLossEnergy: 0,
            deliveredEnergy: 1_000,
            donorColonyId: "W1N1",
            downtimeTicks: 0,
            forecastProfitMilliPerTick: 5_000,
            forecastRevenueMilliPerTick: 10_000,
            harvestedEnergy: 1_000,
            observedAt: tick,
            quality: "complete",
            repairEnergy: 0,
            reservationEnergy: 0,
            roomName: "W1N2",
            spawnEnergy: 401,
            spawnTicks: 12,
            travelTicks: 113,
          },
        ],
        policy: PRODUCTION_REMOTE_ACCOUNTING_POLICY_V1,
        previous,
        tick,
      });
      expect(result.status).toBe("ready");
      expect(result.summaries[0]?.reason).toBe(cycle < 4 ? "warming-up" : "profitable");
      previous = result.records;
      if (cycle === 0) {
        const inFlight = reduceRemoteAccounting({
          observations: [],
          policy: PRODUCTION_REMOTE_ACCOUNTING_POLICY_V1,
          previous,
          tick: tick + 10,
        });
        expect(inFlight.summaries[0]?.reason).toBe("warming-up");
        previous = inFlight.records;
      }
    }
  });

  it("attributes exact owned-sink delivery and actor loss without cross-room ghost revenue", () => {
    const candidate = accountingCandidate();
    const [mining, hauling] = accountingContracts().contracts;
    if (mining === undefined || hauling === undefined)
      throw new Error("missing accounting fixture");
    const decoyReservation = {
      ...mining,
      contractId: "decoy-reservation",
      execution: {
        action: "reserve-controller",
        completion: "controller-reserved",
        counterpartId: null,
        originRoomName: "W1N1",
        resourceType: null,
        routeRoomNames: ["W1N20"],
        routeTravelTicks: 50,
        version: 4,
      },
      issuer: "remote-reservation/W1N1/W1N20",
      targetId: "decoy-controller",
    };
    const wrongDonorHauling = {
      ...hauling,
      contractId: "wrong-donor-hauling",
      issuer: "logistics/wrong-donor",
      owner: { id: "W9N9", kind: "colony" },
    };
    const contracts = {
      contracts: [mining, hauling, decoyReservation, wrongDonorHauling],
      status: "ready",
    } as unknown as ContractPlanningView;
    const extraLeases = [
      { actorId: "missing-decoy", contractId: "decoy-reservation" },
      { actorId: "missing-wrong-donor", contractId: "wrong-donor-hauling" },
    ];
    const owner = activeRemoteOwner();
    const complete = projectRemoteAccountingObservations({
      candidates: [candidate],
      contracts,
      execution: remoteExecution(extraLeases),
      owner,
      snapshot: remoteAccountingSnapshot(true),
      tick: 500,
    });
    const continued = projectRemoteAccountingObservations({
      candidates: [candidate],
      contracts,
      execution: remoteExecution(extraLeases),
      owner: trackedRemoteOwner(),
      snapshot: remoteAccountingSnapshot(true),
      tick: 500,
    });
    const lost = projectRemoteAccountingObservations({
      candidates: [candidate],
      contracts,
      execution: remoteExecution(extraLeases),
      owner,
      snapshot: remoteAccountingSnapshot(false),
      tick: 501,
    });

    expect(complete).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        quality: "complete",
        deliveredEnergy: 50,
        creepLossEnergy: 0,
        spawnEnergy: 37,
        spawnTicks: 3,
        travelTicks: 104,
        cpuMilli: 10_000,
      }),
    ]);
    expect(continued).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        deliveredEnergy: 50,
        spawnEnergy: 37,
        spawnTicks: 3,
        travelTicks: 104,
        cpuMilli: 10_000,
      }),
    ]);
    expect(lost).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        quality: "complete",
        deliveredEnergy: 0,
        creepLossEnergy: 100,
      }),
    ]);
  });

  it("authorizes no cold route-search CPU on a constrained boot", () => {
    const routePlan = vi.spyOn(RoutePlanner.prototype, "plan");
    const world = matureRuntimeWorld();

    runTick({ game: remoteRuntimeGame(world, 290, { bucket: 4_000 }), memory: {} as Memory });

    const remoteCalls = routePlan.mock.calls
      .map(([request]) => request)
      .filter(({ id }) => id.startsWith("remote-runtime/"));
    expect(remoteCalls.length).toBeGreaterThan(0);
    expect(remoteCalls.every(({ availableCpuMilli }) => availableCpuMilli === 0)).toBe(true);
    routePlan.mockRestore();
  });

  it("releases remote capacity before new work under credible threat and CPU pressure", () => {
    const world = matureRuntimeWorld();
    const memory = {} as Memory;
    for (let tick = 300; tick <= 301; tick += 1) {
      runTick({ game: remoteRuntimeGame(world, tick), memory });
    }

    const threatened = runTick({
      game: remoteRuntimeGame(world, 302, { threat: true }),
      memory,
    });
    const constrained = runTick({
      game: remoteRuntimeGame(world, 303, { bucket: 4_000 }),
      memory,
    });

    expect(threatened.kernel.faults).toEqual([]);
    expect(threatened.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "threatened", reason: "threat-risk" }),
    ]);
    expect(threatened.remotes.metrics).toMatchObject({ released: 1, reservedEnergy: 0 });
    expect(threatened.remoteOperations?.budgetRequests).toEqual([]);
    expect(constrained.remotes.dispositions).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        state: "suspended",
        reason: "route-unavailable",
      }),
    ]);
    expect(constrained.remoteOperations?.budgetRequests).toEqual([]);

    const cpuMemory = {} as Memory;
    runTick({ game: remoteRuntimeGame(world, 400), memory: cpuMemory });
    runTick({ game: remoteRuntimeGame(world, 401), memory: cpuMemory });
    const cpuPressure = runTick({
      game: remoteRuntimeGame(world, 402, { bucket: 4_000 }),
      memory: cpuMemory,
    });
    expect(cpuPressure.remotes.dispositions).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "suspended", reason: "capacity-cpu" }),
    ]);
    expect(cpuPressure.remotes.metrics).toMatchObject({ released: 1, reservedCpuMilli: 0 });
  });
});

function remoteRecord(
  memory: Memory,
  roomName: string,
): { readonly expiresAt: number; readonly roomName: string } {
  const owner = memory.myrmex?.remotes as
    | { readonly records?: readonly { readonly expiresAt: number; readonly roomName: string }[] }
    | undefined;
  const record = owner?.records?.find((candidate) => candidate.roomName === roomName);
  if (record === undefined) throw new Error(`missing remote fixture record ${roomName}`);
  return record;
}

function activeRemoteOwner(): unknown {
  return {
    schemaVersion: 2,
    revision: 1,
    records: [
      {
        roomName: "W1N2",
        donorColonyId: "W1N1",
        state: "active",
        stateSince: 490,
        lastEvaluatedTick: 499,
        revision: 2,
        reasonCode: "positive-active",
        evidenceRevision: "remote-runtime/test",
        expiresAt: 1_000,
        positiveTicks: 2,
        resumeAt: 0,
        forecast: { revenue: 5_000, cost: 1_000, profit: 4_000 },
        commitment: { energy: 2_000, spawnTicks: 100, cpuMilli: 100, memoryCodeUnits: 512 },
      },
    ],
    accounting: [],
  };
}

function accountingCandidate(): RemoteCandidateEvidence {
  return {
    roomName: "W1N2",
    donorColonyId: "W1N1",
    commitment: { cpuMilli: 100 },
    intel: {
      record: {
        sources: [{ id: "remote-source", energyCapacity: 1_500 }],
      },
    },
    route: { plan: { estimate: { roundTripTicks: 100 } } },
  } as unknown as RemoteCandidateEvidence;
}

function accountingContracts(): ContractPlanningView {
  return {
    contracts: [
      {
        budgetBinding: { category: "harvesting-filling", issuer: "remote-mining/test" },
        contractId: "mining-contract",
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: null,
          offload: "container-or-drop",
          originRoomName: "W1N1",
          resourceType: null,
          routeRoomNames: ["W1N2"],
          routeTravelTicks: 50,
          version: 5,
          workPosition: { roomName: "W1N2", x: 9, y: 9 },
        },
        issuer: "remote-mining/W1N1/W1N2/remote-source",
        owner: { id: "W1N1", kind: "colony" },
        state: "active",
        targetId: "remote-source",
      },
      {
        budgetBinding: { category: "harvesting-filling", issuer: "remote-hauling/test" },
        contractId: "hauling-contract",
        execution: {
          acquireOriginRoomName: "W1N1",
          acquireRouteRoomNames: ["W1N2"],
          acquireRouteTravelTicks: 50,
          action: "transfer",
          completion: "flow-complete",
          counterpartId: "remote-container",
          deliverOriginRoomName: "W1N2",
          deliverRouteRoomNames: ["W1N1"],
          deliverRouteTravelTicks: 50,
          flowId: "remote-haul/test",
          recommendedCarry: 1,
          recommendedMove: 1,
          reservedAmount: 50,
          resourceType: "energy",
          sinkBaselineAmount: 100,
          sinkNodeId: "remote-haul-sink/test",
          sinkPosition: { roomName: "W1N1", x: 20, y: 20 },
          sinkTargetId: "storage",
          sourceNodeId: "remote-haul-source/test",
          sourcePosition: { roomName: "W1N2", x: 9, y: 9 },
          sourceTargetId: "remote-container",
          stage: "deliver",
          version: 6,
        },
        issuer: "logistics/test",
        owner: { id: "W1N1", kind: "colony" },
        state: "active",
        targetId: "storage",
      },
    ],
    status: "ready",
  } as unknown as ContractPlanningView;
}

function trackedRemoteOwner(): unknown {
  return {
    ...(activeRemoteOwner() as Record<string, unknown>),
    accounting: [
      {
        roomName: "W1N2",
        donorColonyId: "W1N1",
        samples: [[400, 1, 0, 50, 37, 3, 100, 0, 0, 0, 10_000, 0, 0, 5_000, 4_000]],
      },
    ],
  };
}

function remoteExecution(
  extra: readonly { readonly actorId: string; readonly contractId: string }[] = [],
): ContractExecutionView {
  return {
    status: "ready",
    leases: [
      { actorId: "miner", contractId: "mining-contract" },
      { actorId: "hauler", contractId: "hauling-contract" },
      ...extra,
    ],
  } as unknown as ContractExecutionView;
}

function remoteAccountingSnapshot(
  haulerPresent: boolean,
  sinkEnergy = 150,
  haulerEnergy = 0,
): WorldSnapshot {
  const actor = (id: string, roomName: string, energy: number) => ({
    id,
    pos: { roomName, x: 20, y: 20 },
    store: {
      resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
    },
  });
  return {
    rooms: [
      {
        name: "W1N1",
        ownedCreeps: haulerPresent ? [actor("hauler", "W1N1", haulerEnergy)] : [],
        storedStructures: [
          {
            id: "storage",
            store: { resources: [{ amount: sinkEnergy, resourceType: "energy" }] },
          },
        ],
      },
      {
        name: "W1N2",
        ownedCreeps: [actor("miner", "W1N2", 0)],
        storedStructures: [],
      },
    ],
  } as unknown as WorldSnapshot;
}
