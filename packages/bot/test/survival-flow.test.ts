import { describe, expect, it } from "vitest";
import {
  authorizedSurvivalFlow,
  planSurvivalFlow,
  renewSurvivalFlowBudgets,
  withoutSupersededSurvivalHarvestLeases,
} from "../src/economy";
import {
  contractIdFor,
  ContractLedger,
  normalizeContractRequest,
  requestSignature,
  WorkforceAllocator,
  workforceActorFromCreep,
  type ContractExecutionView,
  type ContractPlanningView,
  type WorkContractRecord,
} from "../src/contracts";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("survival flow", () => {
  it("batches partial cargo at a deterministic source before selecting a sink", () => {
    const plan = planSurvivalFlow(snapshot());
    expect(plan.map(({ budgetRequest }) => budgetRequest.issuer)).toEqual([
      "economy/W1N1/harvest/source-near",
    ]);
    expect(
      plan.every(
        ({ budgetRequest }) => budgetRequest.energy === null && budgetRequest.cpu?.minimum === 1,
      ),
    ).toBe(true);
    expect(planSurvivalFlow(snapshot(25)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/harvest/source-near"],
    );
    expect(planSurvivalFlow(snapshot(50)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/transfer/spawn-near"],
    );
    expect(
      planSurvivalFlow(snapshot(25, { sourceEnergy: 0 })).map(
        ({ budgetRequest }) => budgetRequest.issuer,
      ),
    ).toEqual(["economy/W1N1/transfer/spawn-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("transfer"),
        activeFlowPlanning("transfer"),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/transfer/spawn-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("harvest"),
        activeFlowPlanning("harvest"),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("transfer"),
        activeFlowPlanning("transfer", false),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);

    const wrongBudget = activeFlowPlanning("transfer");
    const wrongBudgetContract = wrongBudget.contracts[0];
    if (wrongBudgetContract === undefined) throw new Error("expected active flow contract");
    expect(
      planSurvivalFlow(snapshot(25), activeFlowExecution("transfer"), {
        ...wrongBudget,
        contracts: [
          {
            ...wrongBudgetContract,
            budgetBinding: {
              ...wrongBudgetContract.budgetBinding,
              category: "optional-growth",
            },
          },
        ],
      }).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);
  });

  it("retains active carried-energy work until the actor needs another acquisition batch", () => {
    for (const action of ["upgrade-controller", "build", "repair"] as const) {
      const work = activeCarriedEnergyWork(action);
      expect(planSurvivalFlow(snapshot(25), work.execution, work.planning)).toEqual([]);
      expect(
        planSurvivalFlow(snapshot(0), work.execution, work.planning).map(
          ({ budgetRequest }) => budgetRequest.issuer,
        ),
      ).toEqual(["economy/W1N1/harvest/source-near"]);
    }

    expect(planSurvivalFlow(snapshot(25)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/harvest/source-near"],
    );
  });

  it("excludes full and inactive sinks while retaining a farther active sink", () => {
    expect(planSurvivalFlow(snapshot(50, { sinkFree: 0 }))).toEqual([]);
    expect(planSurvivalFlow(snapshot(50, { spawnActive: false }))).toEqual([]);

    const base = snapshot(50, { spawnActive: false });
    const room = base.rooms[0];
    const inactive = room?.ownedSpawns[0];
    if (room === undefined || inactive === undefined) throw new Error("expected spawn fixture");
    const withFarActive: WorldSnapshot = {
      ...base,
      rooms: [
        {
          ...room,
          ownedSpawns: [
            inactive,
            {
              ...inactive,
              active: true,
              id: "spawn-far",
              name: "Spawn2",
              pos: position(20, 20),
            },
          ],
        },
      ],
    };
    expect(planSurvivalFlow(withFarActive).map(({ targetId }) => targetId)).toEqual(["spawn-far"]);

    const withOnlyInactiveExtension: WorldSnapshot = {
      ...base,
      rooms: [
        {
          ...room,
          ownedExtensions: [{ ...inactive, id: "extension-inactive" }],
          ownedSpawns: [],
        },
      ],
    };
    expect(planSurvivalFlow(withOnlyInactiveExtension)).toEqual([]);
  });

  it("keeps mobile harvesting until a leased static miner can take over", () => {
    const binding = (
      state: ContractPlanningView["contracts"][number]["state"],
    ): ContractPlanningView => ({
      status: "ready",
      contracts: [
        {
          budgetBinding: {
            category: "harvesting-filling",
            issuer: "mining/W1N1/source-near",
          },
          contractId: "static-near",
          execution: {
            action: "harvest",
            completion: "continuous",
            counterpartId: null,
            resourceType: null,
            version: 2,
            workPosition: position(10, 10),
          },
          issuer: "mining/W1N1/source-near",
          owner: { id: "W1N1", kind: "colony" },
          state,
          targetId: "source-near",
        },
      ],
    });
    const selectedTarget = (
      state: ContractPlanningView["contracts"][number]["state"],
      execution: ContractExecutionView = { leases: [], status: "ready" },
      observed: WorldSnapshot = snapshot(),
    ) => planSurvivalFlow(observed, execution, binding(state))[0]?.targetId;

    for (const state of ["proposed", "funded", "assigned", "active", "suspended"] as const)
      expect(selectedTarget(state)).toBe("source-near");
    for (const state of ["assigned", "active"] as const)
      expect(selectedTarget(state, activeStaticExecution(state), staticTakeoverSnapshot())).toBe(
        "source-far",
      );
    expect(selectedTarget("active", activeStaticExecution("active"), snapshot())).toBe(
      "source-near",
    );
    expect(
      selectedTarget(
        "active",
        activeStaticExecution("active"),
        staticTakeoverSnapshot({ moveParts: 0 }),
      ),
    ).toBe("source-far");
    for (const observed of [
      staticTakeoverSnapshot({ ticksToLive: 1 }),
      staticTakeoverSnapshot({ workParts: 0 }),
      staticTakeoverSnapshot({ sourcePosition: position(12, 11) }),
    ])
      expect(selectedTarget("active", activeStaticExecution("active"), observed)).toBe(
        "source-near",
      );
    const distantSourceExecution = activeStaticExecution("active");
    const distantSourceLease = distantSourceExecution.leases[0];
    if (distantSourceLease === undefined) throw new Error("expected static lease");
    expect(
      selectedTarget(
        "active",
        {
          ...distantSourceExecution,
          leases: [{ ...distantSourceLease, target: position(12, 12) }],
        },
        staticTakeoverSnapshot({ sourcePosition: position(12, 12) }),
      ),
    ).toBe("source-near");
    const expiredExecution = activeStaticExecution("active");
    const expiredLease = expiredExecution.leases[0];
    if (expiredLease === undefined) throw new Error("expected static lease");
    expect(
      selectedTarget(
        "active",
        { ...expiredExecution, leases: [{ ...expiredLease, leaseExpiresAt: 10 }] },
        staticTakeoverSnapshot(),
      ),
    ).toBe("source-near");
    const mobileExecution = activeFlowExecution("harvest");
    const mobileLease = mobileExecution.leases[0];
    if (mobileLease === undefined) throw new Error("expected mobile lease");
    const capacityFillers = Array.from({ length: 63 }, (_, index) => ({
      ...mobileLease,
      actorId: `actor-${String(index).padStart(2, "0")}`,
      actorName: `actor-${String(index).padStart(2, "0")}`,
      contractId: `filler-${String(index).padStart(2, "0")}`,
    }));
    const capacityExecution: ContractExecutionView = {
      leases: [
        ...capacityFillers,
        ...mobileExecution.leases,
        ...activeStaticExecution("active", "z-miner").leases,
      ],
      status: "ready",
    };
    const capacitySnapshot = staticTakeoverSnapshot({ minerId: "z-miner" });
    expect(selectedTarget("active", capacityExecution, capacitySnapshot)).toBe("source-near");
    expect(
      selectedTarget(
        "active",
        { ...capacityExecution, leases: [...capacityExecution.leases].reverse() },
        capacitySnapshot,
      ),
    ).toBe("source-near");
    const capacityMobileContract = activeFlowPlanning("harvest").contracts[0];
    const capacityStaticContract = binding("active").contracts[0];
    if (capacityMobileContract === undefined || capacityStaticContract === undefined)
      throw new Error("expected capacity contracts");
    expect(
      withoutSupersededSurvivalHarvestLeases(
        capacityExecution,
        {
          contracts: [capacityMobileContract, capacityStaticContract],
          status: "ready",
        },
        capacitySnapshot,
      ).leases.map(({ contractId }) => contractId),
    ).toContain("contract-harvest");

    const nearMobileIssuer = "economy/W1N1/harvest/source-near";
    const farMobileIssuer = "economy/W1N1/harvest/source-far";
    const nearMobileContract = {
      ...capacityMobileContract,
      budgetBinding: { category: "harvesting-filling" as const, issuer: nearMobileIssuer },
      contractId: "mobile-near",
      issuer: nearMobileIssuer,
      targetId: "source-near",
    };
    const farMobileContract = {
      ...nearMobileContract,
      budgetBinding: { category: "harvesting-filling" as const, issuer: farMobileIssuer },
      contractId: "mobile-far",
      issuer: farMobileIssuer,
      targetId: "source-far",
    };
    const farStaticContract = {
      ...capacityStaticContract,
      budgetBinding: {
        category: "harvesting-filling" as const,
        issuer: "mining/W1N1/source-far",
      },
      contractId: "static-far",
      execution: {
        ...capacityStaticContract.execution,
        workPosition: position(19, 20),
      },
      issuer: "mining/W1N1/source-far",
      targetId: "source-far",
    };
    const nearStaticLease = activeStaticExecution("active", "b-static").leases[0];
    if (nearStaticLease === undefined) throw new Error("expected near static lease");
    const farStaticLease = {
      ...nearStaticLease,
      actorId: "e-static",
      actorName: "e-static",
      contractId: "static-far",
      execution: { ...nearStaticLease.execution, workPosition: position(19, 20) },
      target: position(20, 20),
      targetId: "source-far",
    };
    const nearMobileLease = {
      ...mobileLease,
      actorId: "c-mobile",
      actorName: "c-mobile",
      contractId: "mobile-near",
    };
    const farMobileLease = {
      ...mobileLease,
      actorId: "d-mobile",
      actorName: "d-mobile",
      contractId: "mobile-far",
      target: position(20, 20),
      targetId: "source-far",
    };
    const cascadeFillers = capacityFillers.slice(0, 61);
    const cascadeExecution: ContractExecutionView = {
      leases: [farStaticLease, farMobileLease, ...cascadeFillers, nearMobileLease, nearStaticLease],
      status: "ready",
    };
    const capacityRoom = capacitySnapshot.rooms[0];
    const mobileTemplate = capacityRoom?.ownedCreeps.find(({ id }) => id === "worker-a");
    const staticTemplate = capacityRoom?.ownedCreeps.find(({ id }) => id === "z-miner");
    if (capacityRoom === undefined || mobileTemplate === undefined || staticTemplate === undefined)
      throw new Error("expected capacity actors");
    const cascadeSnapshot: WorldSnapshot = {
      ...capacitySnapshot,
      rooms: [
        {
          ...capacityRoom,
          ownedCreeps: [
            { ...staticTemplate, id: "e-static", name: "e-static", pos: position(19, 20) },
            { ...mobileTemplate, id: "d-mobile", name: "d-mobile", pos: position(18, 20) },
            { ...mobileTemplate, id: "c-mobile", name: "c-mobile" },
            { ...staticTemplate, id: "b-static", name: "b-static" },
          ],
        },
      ],
    };
    const cascadePlanning: ContractPlanningView = {
      contracts: [farStaticContract, farMobileContract, nearMobileContract, capacityStaticContract],
      status: "ready",
    };
    const cascadeRemaining = (leases: ContractExecutionView["leases"]) =>
      withoutSupersededSurvivalHarvestLeases(
        { leases, status: "ready" },
        cascadePlanning,
        cascadeSnapshot,
      ).leases.map(({ contractId }) => contractId);
    for (const leases of [cascadeExecution.leases, [...cascadeExecution.leases].reverse()]) {
      expect(cascadeRemaining(leases)).not.toContain("mobile-near");
      expect(cascadeRemaining(leases)).not.toContain("mobile-far");
      expect(cascadeRemaining(leases)).toEqual(
        expect.arrayContaining(["static-near", "static-far"]),
      );
    }
    const takeoverSnapshot = staticTakeoverSnapshot();
    const takeoverRoom = takeoverSnapshot.rooms[0];
    if (takeoverRoom === undefined) throw new Error("expected takeover room");
    const minerAway: WorldSnapshot = {
      ...takeoverSnapshot,
      rooms: [
        {
          ...takeoverRoom,
          ownedCreeps: takeoverRoom.ownedCreeps.map((actor) =>
            actor.id === "miner-a" ? { ...actor, pos: position(9, 10) } : actor,
          ),
        },
      ],
    };
    expect(selectedTarget("active", activeStaticExecution("active"), minerAway)).toBe(
      "source-near",
    );
    const reordered: WorldSnapshot = {
      ...takeoverSnapshot,
      rooms: [
        {
          ...takeoverRoom,
          ownedCreeps: [...takeoverRoom.ownedCreeps].reverse(),
          sources: [...takeoverRoom.sources].reverse(),
        },
      ],
    };
    expect(planSurvivalFlow(reordered, activeStaticExecution("active"), binding("active"))).toEqual(
      planSurvivalFlow(
        JSON.parse(JSON.stringify(takeoverSnapshot)) as WorldSnapshot,
        JSON.parse(JSON.stringify(activeStaticExecution("active"))) as ContractExecutionView,
        JSON.parse(JSON.stringify(binding("active"))) as ContractPlanningView,
      ),
    );

    let recoveredFallbackRequest:
      ReturnType<typeof authorizedSurvivalFlow>["requests"][number] | null = null;
    for (const state of ["funded", "suspended"] as const) {
      const legacyFallbackCandidate = planSurvivalFlow(
        snapshot(),
        { leases: [], status: "ready" },
        binding(state),
      )[0];
      if (legacyFallbackCandidate === undefined)
        throw new Error("expected legacy fallback candidate");
      const request = authorizedSurvivalFlow(
        [legacyFallbackCandidate],
        [{ ...legacyFallbackCandidate.budgetRequest, status: "active" }],
        binding(state),
        10,
      ).requests[0];
      expect(request?.issuerSequence).toBe(2);
      recoveredFallbackRequest = request ?? null;
    }
    const initialCandidate = planSurvivalFlow(snapshot())[0];
    if (initialCandidate === undefined || recoveredFallbackRequest === null)
      throw new Error("expected fallback generations");
    const initialRequest = authorizedSurvivalFlow(
      [initialCandidate],
      [{ ...initialCandidate.budgetRequest, status: "active" }],
      { contracts: [], status: "ready" },
      1,
    ).requests[0];
    if (initialRequest === undefined) throw new Error("expected initial fallback request");
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected contract ledger");
    const initialSubmission = opened.ledger.submit(initialRequest, 1);
    if (!initialSubmission.accepted) throw new Error("expected initial fallback submission");
    expect(
      opened.ledger.transition({
        contractId: initialSubmission.contractId,
        reason: "legacy-static-handoff",
        tick: 2,
        to: "cancelled",
      }),
    ).toMatchObject({ accepted: true, to: "cancelled" });
    const reconstructed = ContractLedger.open(
      JSON.parse(JSON.stringify(opened.ledger.view())) as unknown,
    );
    if (reconstructed.status !== "ready") throw new Error("expected reconstructed ledger");
    expect(reconstructed.ledger.submit(recoveredFallbackRequest, 3)).toMatchObject({
      accepted: true,
      outcome: "created",
    });

    const mobile = activeFlowPlanning("harvest").contracts[0];
    const staticContract = binding("active").contracts[0];
    if (mobile === undefined || staticContract === undefined)
      throw new Error("expected handoff contracts");
    const planning = { contracts: [mobile, staticContract], status: "ready" as const };
    const execution = {
      leases: [...activeFlowExecution("harvest").leases, ...activeStaticExecution("active").leases],
      status: "ready" as const,
    };
    expect(
      authorizedSurvivalFlow([], [], planning, 10, staticTakeoverSnapshot(), execution).transitions,
    ).toEqual([
      expect.objectContaining({
        contractId: mobile.contractId,
        reason: "static-miner-ready",
        to: "suspended",
      }),
    ]);
    expect(
      withoutSupersededSurvivalHarvestLeases(
        execution,
        planning,
        staticTakeoverSnapshot(),
      ).leases.map(({ contractId }) => contractId),
    ).toEqual(["static-near"]);

    const suspendedStatic = { ...staticContract, state: "suspended" as const };
    const recoveryCandidate = planSurvivalFlow(
      snapshot(),
      { leases: [], status: "ready" },
      { contracts: [suspendedStatic], status: "ready" },
    )[0];
    if (recoveryCandidate === undefined) throw new Error("expected fallback recovery candidate");
    const suspendedMobile = {
      ...mobile,
      budgetBinding: {
        category: "harvesting-filling" as const,
        issuer: recoveryCandidate.budgetRequest.issuer,
      },
      issuer: recoveryCandidate.budgetRequest.issuer,
      issuerSequence: recoveryCandidate.contractSequence,
      state: "suspended" as const,
      targetId: recoveryCandidate.targetId,
    };
    const recoveryPlanning = {
      contracts: [suspendedMobile, suspendedStatic],
      status: "ready" as const,
    };
    expect(
      authorizedSurvivalFlow(
        [recoveryCandidate],
        [{ ...recoveryCandidate.budgetRequest, status: "active" }],
        recoveryPlanning,
        11,
        snapshot(),
        { leases: [], status: "ready" },
      ).transitions,
    ).toEqual([
      expect.objectContaining({
        contractId: mobile.contractId,
        reason: "survival-work-remains",
        to: "funded",
      }),
    ]);
  });

  it("picks up only canonical energy drops beside a committed static work tile", () => {
    const drops = [
      { amount: 25, id: "drop-b", pos: position(9, 11), resourceType: "energy" as const },
      { amount: 25, id: "drop-a", pos: position(9, 10), resourceType: "energy" as const },
      { amount: 100, id: "drop-far", pos: position(20, 20), resourceType: "energy" as const },
      { amount: 100, id: "drop-mineral", pos: position(9, 10), resourceType: "H" as const },
    ];
    const planning = staticPlanning(["source-near", "source-far"]);
    const selected = (orderedDrops: typeof drops) =>
      planSurvivalFlow(snapshot(0, { droppedResources: orderedDrops }), undefined, planning)[0];

    expect(selected(drops)?.budgetRequest.issuer).toBe("economy/W1N1/pickup/drop-a");
    expect(selected([...drops].reverse())?.budgetRequest.issuer).toBe("economy/W1N1/pickup/drop-a");
    expect(
      planSurvivalFlow(snapshot(25, { droppedResources: drops }), undefined, planning)[0]
        ?.budgetRequest.issuer,
    ).toBe("economy/W1N1/transfer/spawn-near");
    expect(
      planSurvivalFlow(snapshot(), undefined, planning).some(({ action }) => action === "pickup"),
    ).toBe(false);

    const candidate = selected(drops);
    if (candidate === undefined) throw new Error("expected static drop pickup candidate");
    const authorized = authorizedSurvivalFlow(
      [candidate],
      [
        {
          category: "harvesting-filling",
          colonyId: candidate.colonyId,
          issuer: candidate.budgetRequest.issuer,
          status: "active",
        },
      ],
      { contracts: [], status: "ready" },
      10,
    );
    expect(authorized.requests[0]).toMatchObject({
      execution: { action: "pickup", completion: "target-depleted", resourceType: null },
      issuerKey: "pickup:drop-a",
      kind: "haul",
      requiredCapability: { carry: 1, work: 0 },
      targetId: "drop-a",
    });
    const request = authorized.requests[0];
    if (request === undefined) throw new Error("expected authorized pickup request");
    expect(() => normalizeContractRequest(request)).not.toThrow();
  });

  it("keeps static drop pickup identity stable across reset without generalizing into hauling", () => {
    const energyDrop = {
      amount: 50,
      id: "drop-stable",
      pos: position(9, 10),
      resourceType: "energy" as const,
    };
    const planning = staticPlanning(["source-near", "source-far"]);
    const observed = snapshot(0, {
      droppedResources: [{ ...energyDrop, id: "drop-distant", pos: position(20, 20) }, energyDrop],
      storedStructures: [
        {
          hits: 250_000,
          hitsMax: 250_000,
          id: "container-full",
          ownerUsername: "me",
          ownership: "owned",
          pos: position(9, 10),
          store: {
            capacity: 2_000,
            freeCapacity: 1_000,
            resources: [{ amount: 1_000, resourceType: "energy" }],
            usedCapacity: 1_000,
          },
          structureType: "container",
        },
      ],
    });
    const first = planSurvivalFlow(observed, { leases: [], status: "ready" }, planning)[0];
    const afterReset = planSurvivalFlow(observed, { leases: [], status: "ready" }, planning)[0];

    expect(first?.budgetRequest.issuer).toBe("economy/W1N1/pickup/drop-stable");
    expect(afterReset?.budgetRequest.issuer).toBe(first?.budgetRequest.issuer);
    expect(first?.targetId).toBe(afterReset?.targetId);
    expect(first?.action).not.toBe("withdraw");

    const storedStructures = observed.rooms[0]?.storedStructures ?? [];
    const noDrop = snapshot(0, {
      droppedResources: [],
      storedStructures,
    });
    expect(planSurvivalFlow(noDrop, undefined, planning)).toEqual([
      expect.objectContaining({ action: "harvest", targetId: "source-near" }),
    ]);
  });

  it("funds suspended work again and cancels a vanished endpoint without duplicating its binding", () => {
    const candidates = planSurvivalFlow(snapshot());
    const harvest = candidates.find(({ action }) => action === "harvest");
    if (harvest === undefined) throw new Error("expected harvest candidate");
    const reservations = candidates.map(({ budgetRequest }) => ({
      ...budgetRequest,
      status: "active",
    }));
    const flow = authorizedSurvivalFlow(
      candidates,
      reservations,
      {
        status: "ready",
        contracts: [
          {
            budgetBinding: {
              category: "harvesting-filling",
              issuer: harvest.budgetRequest.issuer,
            },
            contractId: "harvest",
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: harvest.budgetRequest.issuer,
            owner: { id: "W1N1", kind: "colony" },
            state: "suspended",
            targetId: "source-near",
          },
          {
            budgetBinding: {
              category: "harvesting-filling",
              issuer: "economy/W1N1/harvest/old",
            },
            contractId: "old",
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "economy/W1N1/harvest/old",
            owner: { id: "W1N1", kind: "colony" },
            state: "funded",
            targetId: "old",
          },
        ],
      },
      10,
      snapshot(),
    );
    expect(flow.requests).toHaveLength(1);
    expect(flow.transitions).toEqual([
      expect.objectContaining({ contractId: "harvest", to: "funded" }),
      expect.objectContaining({ contractId: "old", to: "cancelled" }),
    ]);
  });

  it("keeps a stable request until its bounded authorization is due for renewal", () => {
    const candidate = planSurvivalFlow(snapshot())[0];
    if (candidate === undefined) throw new Error("expected survival candidate");
    const current = {
      category: "harvesting-filling",
      colonyId: candidate.colonyId,
      issuer: candidate.budgetRequest.issuer,
      revision: 4,
      request: { ...candidate.budgetRequest, expiresAt: 20, revision: 4 },
      status: "active",
    };
    expect(
      renewSurvivalFlowBudgets([candidate], [current], 10, 12, 3)[0]?.budgetRequest,
    ).toMatchObject({ expiresAt: 20, revision: 4 });
    expect(
      renewSurvivalFlowBudgets([candidate], [current], 18, 12, 3)[0]?.budgetRequest,
    ).toMatchObject({ expiresAt: 30, revision: 5 });
  });

  it("caps local source or sink reservations at one worker per observed endpoint", () => {
    const single = snapshot();
    const room = single.rooms[0];
    const first = room?.ownedCreeps[0];
    const onlySource = room?.sources[0];
    if (room === undefined || first === undefined || onlySource === undefined)
      throw new Error("expected single-room fixture");
    const multi: WorldSnapshot = {
      ...single,
      rooms: [
        {
          ...room,
          ownedCreeps: [...room.ownedCreeps, { ...first, id: "worker-b", name: "worker-b" }],
          sources: [onlySource],
        },
      ],
    };
    expect(planSurvivalFlow(multi)).toHaveLength(1);
  });

  it("publishes endpoint demand that an eligible worker can take regardless of planner order", () => {
    const base = snapshot();
    const room = base.rooms[0];
    const template = room?.ownedCreeps[0];
    if (room === undefined || template === undefined) throw new Error("expected worker fixture");
    const carrier = {
      ...template,
      body: {
        ...template.body,
        activeParts: 2,
        size: 2,
        work: { active: 0, boosted: 0, total: 0 },
      },
      id: "carrier-a",
      name: "carrier-a",
    };
    const worker = { ...template, id: "worker-b", name: "worker-b" };
    const onlySource = room.sources.find(({ id }) => id === "source-near");
    if (onlySource === undefined) throw new Error("expected source fixture");
    const multi: WorldSnapshot = {
      ...base,
      rooms: [{ ...room, ownedCreeps: [carrier, worker], sources: [onlySource] }],
    };
    const candidate = planSurvivalFlow(multi)[0];
    if (candidate === undefined) throw new Error("expected endpoint demand");
    const flow = authorizedSurvivalFlow(
      [candidate],
      [{ ...candidate.budgetRequest, status: "active" }],
      { contracts: [], status: "ready" },
      10,
    );
    const request = flow.requests[0];
    if (request === undefined) throw new Error("expected work request");
    const normalized = normalizeContractRequest(request);
    const contract: WorkContractRecord = {
      ...normalized,
      history: [],
      id: contractIdFor(normalized.issuer, normalized.issuerKey, normalized.issuerSequence),
      lease: null,
      requestSignature: requestSignature(normalized),
      revision: 1,
      state: "funded",
    };
    const allocation = new WorkforceAllocator().allocate({
      actors: [workforceActorFromCreep(carrier), workforceActorFromCreep(worker)],
      contracts: [contract],
      tick: 10,
      travel: { estimate: () => 60 },
    });

    expect(candidate.actorId).toBe("carrier-a");
    expect(candidate.budgetRequest.issuer).toBe("economy/W1N1/harvest/source-near");
    expect(allocation.assignments).toEqual([
      expect.objectContaining({ actorId: "worker-b", assignmentCost: 60, contractId: contract.id }),
    ]);
  });

  it("keeps continuous work suspended while an endpoint is unavailable, then re-funds it", () => {
    const transfer = planSurvivalFlow(snapshot(50))[0];
    if (transfer === undefined) throw new Error("expected transfer candidate");
    const planning = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: { category: "harvesting-filling", issuer: transfer.budgetRequest.issuer },
          contractId: "fill",
          execution: {
            action: "transfer" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: "energy" as const,
            version: 1 as const,
          },
          issuer: transfer.budgetRequest.issuer,
          owner: { id: "W1N1", kind: "colony" as const },
          state: "suspended" as const,
          targetId: transfer.targetId,
        },
      ],
    };
    expect(authorizedSurvivalFlow([], [], planning, 20).transitions).toEqual([]);
    expect(
      authorizedSurvivalFlow(
        [transfer],
        [{ ...transfer.budgetRequest, status: "active" }],
        planning,
        21,
      ).transitions,
    ).toEqual([expect.objectContaining({ contractId: "fill", to: "funded" })]);
  });

  it("keeps endpoint demand reusable while a visible colony awaits a replacement worker", () => {
    const observed = snapshot();
    const room = observed.rooms[0];
    if (room === undefined) throw new Error("expected visible colony fixture");
    const withoutWorkers: WorldSnapshot = {
      ...observed,
      rooms: [{ ...room, ownedCreeps: [] }],
    };
    const planning = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: {
            category: "harvesting-filling" as const,
            issuer: "economy/W1N1/harvest/source-near",
          },
          contractId: "dead-harvest",
          execution: {
            action: "harvest" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 1 as const,
          },
          issuer: "economy/W1N1/harvest/source-near",
          owner: { id: "W1N1", kind: "colony" as const },
          state: "funded" as const,
          targetId: "source-near",
        },
      ],
    };
    expect(authorizedSurvivalFlow([], [], planning, 20, withoutWorkers).transitions).toEqual([]);
  });
});

function activeStaticExecution(
  state: "assigned" | "active",
  actorId = "miner-a",
): ContractExecutionView {
  return {
    status: "ready",
    leases: [
      {
        actorId,
        actorName: actorId,
        contractId: "static-near",
        deadline: 100,
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: null,
          resourceType: null,
          version: 2,
          workPosition: position(10, 10),
        },
        expiresAt: 101,
        leaseExpiresAt: 101,
        priority: { class: "survival", value: 950 },
        quantity: 50,
        range: 1,
        revision: 1,
        state,
        target: position(11, 11),
        targetId: "source-near",
      },
    ],
  };
}

function activeCarriedEnergyWork(action: "build" | "repair" | "upgrade-controller"): {
  readonly execution: ContractExecutionView;
  readonly planning: ContractPlanningView;
} {
  const contractId = `contract-${action}`;
  const targetId = action === "upgrade-controller" ? "controller" : `${action}-target`;
  const issuer =
    action === "repair" ? `maintenance/W1N1/${targetId}` : `growth/W1N1/${action}/${targetId}`;
  const executionTerms = {
    action,
    completion:
      action === "upgrade-controller" ? ("continuous" as const) : ("work-complete" as const),
    completionHits: action === "repair" ? 1_000 : null,
    counterpartId: null,
    resourceType: null,
    version: 1 as const,
  };
  return {
    execution: {
      status: "ready",
      leases: [
        {
          actorId: "worker-a",
          actorName: "worker",
          contractId,
          deadline: 100,
          execution: executionTerms,
          expiresAt: 101,
          leaseExpiresAt: 101,
          priority: { class: action === "repair" ? "survival" : "growth", value: 1_000 },
          quantity: 1,
          range: 3,
          revision: 1,
          state: "active",
          target: position(25, 25),
          targetId,
        },
      ],
    },
    planning: {
      status: "ready",
      contracts: [
        {
          budgetBinding: {
            category: action === "repair" ? "critical-maintenance" : "bootstrap-controller",
            issuer,
          },
          contractId,
          execution: executionTerms,
          issuer,
          owner: { id: "W1N1", kind: "colony" },
          state: "active",
          targetId,
        },
      ],
    },
  };
}

function activeFlowExecution(action: "harvest" | "pickup" | "transfer"): ContractExecutionView {
  const transfer = action === "transfer";
  return {
    status: "ready",
    leases: [
      {
        actorId: "worker-a",
        actorName: "worker",
        contractId: `contract-${action}`,
        deadline: 100,
        execution: {
          action,
          completion: "continuous",
          counterpartId: null,
          resourceType: transfer ? "energy" : null,
          version: 1,
        },
        expiresAt: 101,
        leaseExpiresAt: 101,
        priority: { class: "survival", value: 1_000 },
        quantity: 1,
        range: 1,
        revision: 1,
        state: "active",
        target: transfer
          ? position(11, 10)
          : action === "pickup"
            ? position(9, 10)
            : position(11, 11),
        targetId: transfer ? "spawn-near" : action === "pickup" ? "drop-near" : "source-near",
      },
    ],
  };
}

function activeFlowPlanning(
  action: "harvest" | "pickup" | "transfer",
  economy = true,
): ContractPlanningView {
  const transfer = action === "transfer";
  const issuer = `${economy ? "economy" : "operation"}/W1N1/${action}/target`;
  return {
    status: "ready",
    contracts: [
      {
        budgetBinding: {
          category: economy ? "harvesting-filling" : "optional-growth",
          issuer,
        },
        contractId: `contract-${action}`,
        execution: {
          action,
          completion: "continuous",
          counterpartId: null,
          resourceType: transfer ? "energy" : null,
          version: 1,
        },
        issuer,
        owner: { id: "W1N1", kind: economy ? "colony" : "operation" },
        state: "active",
        targetId: transfer ? "spawn-near" : action === "pickup" ? "drop-near" : "source-near",
      },
    ],
  };
}

function staticPlanning(sourceIds: readonly string[]): ContractPlanningView {
  return {
    status: "ready",
    contracts: sourceIds.map((sourceId) => ({
      budgetBinding: {
        category: "harvesting-filling",
        issuer: `mining/W1N1/${sourceId}`,
      },
      contractId: `static-${sourceId}`,
      execution: {
        action: "harvest",
        completion: "continuous",
        counterpartId: null,
        resourceType: null,
        version: 2,
        workPosition: position(9, 10),
      },
      issuer: `mining/W1N1/${sourceId}`,
      owner: { id: "W1N1", kind: "colony" },
      state: "active",
      targetId: sourceId,
    })),
  };
}

function staticTakeoverSnapshot(
  options: {
    readonly minerId?: string;
    readonly moveParts?: number;
    readonly sourcePosition?: ReturnType<typeof position>;
    readonly ticksToLive?: number;
    readonly workParts?: number;
  } = {},
): WorldSnapshot {
  const observed = snapshot();
  const room = observed.rooms[0];
  const worker = room?.ownedCreeps[0];
  if (room === undefined || worker === undefined) throw new Error("expected worker fixture");
  const workParts = options.workParts ?? 2;
  const moveParts = options.moveParts ?? 1;
  const minerId = options.minerId ?? "miner-a";
  const miner = {
    ...worker,
    body: {
      ...worker.body,
      activeParts: workParts + moveParts,
      carry: { active: 0, boosted: 0, total: 0 },
      move: { active: moveParts, boosted: 0, total: moveParts },
      size: workParts + moveParts,
      work: { active: workParts, boosted: 0, total: workParts },
    },
    id: minerId,
    name: minerId,
    pos: position(10, 10),
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: options.ticksToLive ?? worker.ticksToLive,
  };
  return {
    ...observed,
    rooms: [
      {
        ...room,
        ownedCreeps: [{ ...worker, pos: position(8, 10) }, miner],
        sources: room.sources.map((source) =>
          source.id === "source-near" && options.sourcePosition !== undefined
            ? { ...source, pos: options.sourcePosition }
            : source,
        ),
      },
    ],
  };
}

function snapshot(
  carriedEnergy = 0,
  options: {
    readonly droppedResources?: WorldSnapshot["rooms"][number]["droppedResources"];
    readonly sinkFree?: number;
    readonly sourceEnergy?: number;
    readonly spawnActive?: boolean;
    readonly storedStructures?: WorldSnapshot["rooms"][number]["storedStructures"];
  } = {},
): WorldSnapshot {
  const sinkFree = options.sinkFree ?? 300;
  const sinkEnergy = 300 - sinkFree;
  const emptyStore = {
    capacity: 300,
    freeCapacity: sinkFree,
    resources: sinkEnergy === 0 ? [] : [{ amount: sinkEnergy, resourceType: "energy" }],
    usedCapacity: sinkEnergy,
  };
  const workerStore = {
    capacity: 50,
    freeCapacity: 50 - carriedEnergy,
    resources: carriedEnergy === 0 ? [] : [{ amount: carriedEnergy, resourceType: "energy" }],
    usedCapacity: carriedEnergy,
  };
  const part = { active: 0, boosted: 0, total: 0 };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    schemaVersion: 1,
    rooms: [
      {
        name: "W1N1",
        observedAt: 10,
        energyAvailable: 0,
        energyCapacityAvailable: 300,
        controller: {
          id: "controller",
          level: 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(25, 25),
          progress: 0,
          progressTotal: 1,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 1000,
          upgradeBlocked: null,
        },
        constructionSites: [],
        droppedResources: options.droppedResources ?? [],
        hostileCreeps: [],
        ownedCreeps: [
          {
            id: "worker-a",
            name: "worker",
            ownerUsername: "me",
            pos: position(10, 10),
            spawning: false,
            ticksToLive: 100,
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            store: workerStore,
            body: {
              activeParts: 3,
              attack: part,
              carry: { ...part, active: 1, total: 1 },
              claim: part,
              heal: part,
              move: { ...part, active: 1, total: 1 },
              rangedAttack: part,
              size: 3,
              tough: part,
              work: { ...part, active: 1, total: 1 },
            },
          },
        ],
        ownedExtensions: [],
        ownedSpawns: [
          {
            id: "spawn-near",
            name: "Spawn1",
            pos: position(11, 10),
            active: options.spawnActive ?? true,
            hits: 5000,
            hitsMax: 5000,
            spawning: null,
            store: emptyStore,
          },
        ],
        ownedTowers: [],
        ruins: [],
        sources: [
          {
            id: "source-far",
            pos: position(20, 20),
            energy: options.sourceEnergy ?? 3000,
            energyCapacity: 3000,
            ticksToRegeneration: null,
          },
          {
            id: "source-near",
            pos: position(11, 11),
            energy: options.sourceEnergy ?? 3000,
            energyCapacity: 3000,
            ticksToRegeneration: null,
          },
        ],
        storedStructures: options.storedStructures ?? [],
        tombstones: [],
      },
    ],
    ownedRooms: [],
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: options.droppedResources?.length ?? 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 2,
        storedStructures: 0,
        tombstones: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
