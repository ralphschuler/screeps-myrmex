import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { authorizedSurvivalGrowth, planSurvivalGrowth, renewGrowthBudgets } from "../src/growth";
import {
  contractIdFor,
  type ContractPlanningRecord,
  type ContractPlanningView,
  type WorkContractRequest,
} from "../src/contracts";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("survival growth", () => {
  it("prioritizes downgrade-risk upgrading ahead of every owned layout structure site", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(world({ downgrade: 10, sites: true }), config);
    expect(
      planned.map(({ action, budgetRequest, targetId }) => [
        action,
        budgetRequest.category,
        targetId,
      ]),
    ).toEqual([
      ["upgrade-controller", "controller-risk", "controller-a"],
      ["build", "optional-growth", "site-spawn"],
      ["build", "optional-growth", "site-storage"],
    ]);
  });

  it("uses only funded candidates and cancels a vanished completed site", () => {
    const config = buildRuntimeConfig();
    const candidates = renewGrowthBudgets(
      planSurvivalGrowth(world({ sites: true }), config),
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const funded = authorizedSurvivalGrowth(
      candidates,
      candidates.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(funded.requests.map(({ execution }) => execution?.action)).toEqual(["build", "build"]);

    const cleanup = authorizedSurvivalGrowth(
      [],
      [],
      {
        status: "ready",
        contracts: [
          {
            budgetBinding: { category: "optional-growth", issuer: "growth/W1N1/build/site-spawn" },
            contractId: "contract-site",
            execution: {
              action: "build",
              completion: "work-complete",
              completionHits: null,
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "growth/W1N1/build/site-spawn",
            owner: { id: "W1N1", kind: "colony" },
            state: "active",
            targetId: "site-spawn",
          },
        ],
      },
      101,
    );
    expect(cleanup.transitions).toEqual([
      { contractId: "contract-site", reason: "growth-target-resolved", tick: 101, to: "cancelled" },
    ]);
  });

  it("does not create placement work and suppresses growth during a present hostile", () => {
    const config = buildRuntimeConfig();
    expect(planSurvivalGrowth(world({ hostile: true }), config)).toEqual([]);
    expect(
      planSurvivalGrowth(world(), config).every(({ action }) => action === "upgrade-controller"),
    ).toBe(true);
  });

  it("keeps thirteen spawnable RCL2 controller lease slots funded while the room pool refills", () => {
    const config = buildRuntimeConfig();
    const full = planSurvivalGrowth(
      world({ controllerLevel: 2, energy: 550, energyCapacity: 550, spawn: true }),
      config,
    );
    const drained = planSurvivalGrowth(
      world({ controllerLevel: 2, energy: 0, energyCapacity: 550, spawn: true }),
      config,
    );

    expect(full).toHaveLength(13);
    expect(drained).toEqual(full);
    expect(full.map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      Array.from(
        { length: 13 },
        (_, slot) =>
          `growth/W1N1/upgrade-controller/controller-a/slot/${String(slot).padStart(2, "0")}`,
      ),
    );
    expect(full.every(({ budgetRequest }) => budgetRequest.energy === null)).toBe(true);
    expect(full[0]?.requiredCapability).toMatchObject({ carry: 3, move: 2, work: 1 });
    expect(
      full
        .slice(1)
        .every(
          ({ requiredCapability }) =>
            requiredCapability.work === 3 &&
            requiredCapability.carry === 2 &&
            requiredCapability.move === 3,
        ),
    ).toBe(true);

    const renewed = renewGrowthBudgets(
      full,
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    expect(renewed.every(({ budgetRequest }) => budgetRequest.expiresAt === 1_000_000_000)).toBe(
      true,
    );
    const authorized = authorizedSurvivalGrowth(
      renewed,
      renewed.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(authorized.requests).toHaveLength(13);
    expect(authorized.requests[0]?.requiredCapability).toMatchObject({
      carry: 3,
      move: 2,
      work: 1,
    });
    expect(authorized.requests[0]?.priority).toEqual({ class: "growth", value: 500 });
    expect(authorized.requests.every(({ leasePolicy }) => leasePolicy.duration === 50)).toBe(true);
    expect(authorized.requests.every(({ maxAssignmentCost }) => maxAssignmentCost === 1_500)).toBe(
      true,
    );
    expect(
      authorized.requests.slice(1).every(({ requiredCapability }) => requiredCapability.work === 3),
    ).toBe(true);
    expect(
      authorized.requests.slice(1).every(({ priority }) => priority.class === "survival"),
    ).toBe(true);
    expect(authorized.requests.slice(1).every(({ priority }) => priority.value === 1_100)).toBe(
      true,
    );

    const firstSlot = renewed[1];
    const firstSlotRequest = authorized.requests[1];
    if (firstSlot === undefined || firstSlotRequest === undefined)
      throw new Error("expected first heavy RCL2 slot");
    const temporarilyUnfunded = authorizedSurvivalGrowth(
      [firstSlot],
      [],
      { status: "ready", contracts: [planningRecord(firstSlotRequest)] },
      101,
    );
    expect(temporarilyUnfunded).toMatchObject({ requests: [], replacements: [], transitions: [] });
    const stableActive = authorizedSurvivalGrowth(
      [firstSlot],
      [
        {
          category: firstSlot.budgetRequest.category,
          colonyId: firstSlot.colonyId,
          issuer: firstSlot.budgetRequest.issuer,
          status: "active",
        },
      ],
      { status: "ready", contracts: [planningRecord(firstSlotRequest)] },
      101,
    );
    expect(stableActive).toMatchObject({ requests: [], replacements: [], transitions: [] });
    const renewedAfterSpawn = renewGrowthBudgets(
      [firstSlot],
      [
        {
          category: firstSlot.budgetRequest.category,
          colonyId: firstSlot.colonyId,
          issuer: firstSlot.budgetRequest.issuer,
          request: firstSlot.budgetRequest,
          revision: firstSlot.budgetRequest.revision,
          status: "consumed",
        },
      ],
      101,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const secondRevision = renewedAfterSpawn[0];
    if (secondRevision === undefined) throw new Error("expected renewed heavy RCL2 slot");
    expect(secondRevision.budgetRequest.revision).toBe(2);
    const handoff = authorizedSurvivalGrowth(
      renewedAfterSpawn,
      renewedAfterSpawn.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [planningRecord(firstSlotRequest)] },
      101,
    );
    expect(handoff.requests).toEqual([]);
    expect(handoff.replacements).toMatchObject([
      {
        predecessorContractId: contractIdFor(
          firstSlotRequest.issuer,
          firstSlotRequest.issuerKey,
          1,
        ),
        reason: "growth-budget-renewed",
        successor: { issuerSequence: 2, requiredCapability: { work: 3 } },
      },
    ]);
    expect(handoff.transitions).toContainEqual({
      contractId: contractIdFor(firstSlotRequest.issuer, firstSlotRequest.issuerKey, 2),
      reason: "growth-work-remains",
      tick: 101,
      to: "funded",
    });

    const caughtUp = authorizedSurvivalGrowth(
      [
        {
          ...secondRevision,
          budgetRequest: { ...secondRevision.budgetRequest, revision: 4 },
        },
      ],
      [
        {
          category: firstSlot.budgetRequest.category,
          colonyId: firstSlot.colonyId,
          issuer: firstSlot.budgetRequest.issuer,
          status: "active" as const,
        },
      ],
      { status: "ready", contracts: [planningRecord(firstSlotRequest)] },
      102,
    );
    expect(caughtUp.replacements[0]?.successor.issuerSequence).toBe(2);
    expect(caughtUp.transitions).toEqual([]);
  });

  it("bridges RCL1 only from carried energy after the 300-energy spawn reserve is full", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 1,
      }),
      config,
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      action: "upgrade-controller",
      reasonCode: "rcl1-bootstrap-controller",
      budgetRequest: {
        category: "bootstrap-controller",
        energy: null,
      },
    });
    const funded = renewGrowthBudgets(
      planned,
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const authorized = authorizedSurvivalGrowth(
      funded,
      funded.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(authorized.requests).toEqual([expect.objectContaining({ maxAssignmentCost: 1_500 })]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 299,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 1,
        }),
        config,
      ),
    ).toEqual([]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 0,
        }),
        config,
      ),
    ).toEqual([]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 2,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 1,
        }),
        config,
      ),
    ).toEqual([]);
  });

  it("funds one RCL1 controller-risk path from carried energy at the protected reserve", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        downgrade: config.policy.recovery.controllerRiskWindowTicks,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 4,
      }),
      config,
    );

    expect(planned).toMatchObject([
      {
        action: "upgrade-controller",
        reasonCode: "controller-risk",
        budgetRequest: {
          category: "controller-risk",
          energy: null,
        },
      },
    ]);
    expect(planned).toHaveLength(1);
    const withoutCargo = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        downgrade: config.policy.recovery.controllerRiskWindowTicks,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 0,
      }),
      config,
    );
    expect(withoutCargo).toMatchObject([
      {
        reasonCode: "controller-risk",
        budgetRequest: { category: "controller-risk", energy: null },
      },
    ]);

    const initial = renewGrowthBudgets(
      planned,
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    if (initial === undefined) throw new Error("expected controller-risk budget");
    const duringCargoLoss = renewGrowthBudgets(
      withoutCargo,
      [
        {
          category: initial.budgetRequest.category,
          colonyId: initial.colonyId,
          issuer: initial.budgetRequest.issuer,
          request: initial.budgetRequest,
          revision: initial.budgetRequest.revision,
          status: "active",
        },
      ],
      101,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    expect(duringCargoLoss?.budgetRequest).toEqual(initial.budgetRequest);

    const belowFloor = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        downgrade: config.policy.recovery.controllerRiskWindowTicks,
        energy: 299,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 4,
      }),
      config,
    );
    expect(belowFloor).toMatchObject([
      { reasonCode: "controller-risk", budgetRequest: { energy: null } },
    ]);

    const legacyPendingRequest = {
      ...initial.budgetRequest,
      energy: { minimum: 1, desired: config.policy.growth.maximumEnergyPerTick },
    };
    const recoveredPending = renewGrowthBudgets(
      planned,
      [
        {
          category: legacyPendingRequest.category,
          colonyId: initial.colonyId,
          issuer: initial.budgetRequest.issuer,
          request: legacyPendingRequest,
          revision: legacyPendingRequest.revision,
          status: "pending",
        },
      ],
      101,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    expect(recoveredPending?.budgetRequest).toMatchObject({
      energy: null,
      expiresAt: 101 + config.policy.leases.durationTicks,
      revision: 2,
    });
    if (recoveredPending === undefined) throw new Error("expected recovered pending budget");
    expect(
      authorizedSurvivalGrowth(
        [recoveredPending],
        [
          {
            category: recoveredPending.budgetRequest.category,
            colonyId: recoveredPending.colonyId,
            issuer: recoveredPending.budgetRequest.issuer,
            status: "active",
          },
        ],
        { status: "ready", contracts: [] },
        101,
      ).requests,
    ).toMatchObject([
      {
        issuerSequence: 2,
        priority: { class: "survival", value: 1_600 },
      },
    ]);
  });

  it("atomically hands one RCL1 bootstrap contract to controller-risk funding", () => {
    const config = buildRuntimeConfig();
    const bootstrap = renewGrowthBudgets(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 4,
        }),
        config,
      ),
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    if (bootstrap === undefined) throw new Error("expected RCL1 bootstrap candidate");
    const predecessorRequest = authorizedSurvivalGrowth(
      [bootstrap],
      [
        {
          category: bootstrap.budgetRequest.category,
          colonyId: bootstrap.colonyId,
          issuer: bootstrap.budgetRequest.issuer,
          status: "active",
        },
      ],
      { status: "ready", contracts: [] },
      100,
    ).requests[0];
    if (predecessorRequest === undefined) throw new Error("expected bootstrap contract request");

    const risk = renewGrowthBudgets(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          downgrade: config.policy.recovery.controllerRiskWindowTicks,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 4,
        }),
        config,
      ),
      [
        {
          category: bootstrap.budgetRequest.category,
          colonyId: bootstrap.colonyId,
          issuer: bootstrap.budgetRequest.issuer,
          request: bootstrap.budgetRequest,
          revision: bootstrap.budgetRequest.revision,
          status: "active",
        },
      ],
      101,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    if (risk === undefined) throw new Error("expected controller-risk candidate");
    const handoff = authorizedSurvivalGrowth(
      [risk],
      [
        {
          category: risk.budgetRequest.category,
          colonyId: risk.colonyId,
          issuer: risk.budgetRequest.issuer,
          status: "active",
        },
      ],
      {
        status: "ready",
        contracts: [planningRecord(predecessorRequest)],
      },
      101,
    );

    expect(risk.budgetRequest).toMatchObject({
      category: "controller-risk",
      expiresAt: 101 + config.policy.leases.durationTicks,
      revision: 2,
    });
    expect(handoff.requests).toEqual([]);
    expect(handoff.replacements).toMatchObject([
      {
        fundingHandoff: "rcl1-controller-risk-bootstrap",
        reason: "growth-budget-renewed",
        successor: {
          budgetBinding: { category: "controller-risk" },
          issuerSequence: 2,
        },
      },
    ]);
    const riskRequest = handoff.replacements[0]?.successor;
    if (riskRequest === undefined) throw new Error("expected controller-risk successor");

    const renewedRisk = renewGrowthBudgets(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          downgrade: config.policy.recovery.controllerRiskWindowTicks,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 4,
        }),
        config,
      ),
      [
        {
          category: risk.budgetRequest.category,
          colonyId: risk.colonyId,
          issuer: risk.budgetRequest.issuer,
          request: risk.budgetRequest,
          revision: risk.budgetRequest.revision,
          status: "active",
        },
      ],
      141,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    if (renewedRisk === undefined) throw new Error("expected renewed risk budget");
    const riskRenewal = authorizedSurvivalGrowth(
      [renewedRisk],
      [
        {
          category: renewedRisk.budgetRequest.category,
          colonyId: renewedRisk.colonyId,
          issuer: renewedRisk.budgetRequest.issuer,
          status: "active",
        },
      ],
      { status: "ready", contracts: [planningRecord(riskRequest)] },
      141,
    );
    expect(riskRenewal.requests).toEqual([]);
    expect(riskRenewal.replacements).toMatchObject([
      { successor: { budgetBinding: { category: "controller-risk" }, issuerSequence: 3 } },
    ]);
    expect(riskRenewal.replacements[0]).not.toHaveProperty("fundingHandoff");
    const renewedRiskRequest = riskRenewal.replacements[0]?.successor;
    if (renewedRiskRequest === undefined) throw new Error("expected renewed risk successor");

    const resumedBootstrap = renewGrowthBudgets(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 4,
        }),
        config,
      ),
      [
        {
          category: renewedRisk.budgetRequest.category,
          colonyId: renewedRisk.colonyId,
          issuer: renewedRisk.budgetRequest.issuer,
          request: renewedRisk.budgetRequest,
          revision: renewedRisk.budgetRequest.revision,
          status: "active",
        },
      ],
      142,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    )[0];
    if (resumedBootstrap === undefined) throw new Error("expected resumed bootstrap budget");
    const resumed = authorizedSurvivalGrowth(
      [resumedBootstrap],
      [
        {
          category: resumedBootstrap.budgetRequest.category,
          colonyId: resumedBootstrap.colonyId,
          issuer: resumedBootstrap.budgetRequest.issuer,
          status: "active",
        },
      ],
      { status: "ready", contracts: [planningRecord(renewedRiskRequest)] },
      142,
    );
    expect(resumed.requests).toEqual([]);
    expect(resumed.replacements).toMatchObject([
      {
        fundingHandoff: "rcl1-controller-risk-bootstrap",
        successor: { budgetBinding: { category: "bootstrap-controller" }, issuerSequence: 4 },
      },
    ]);
  });

  it("bootstraps RCL2 extension work from carried energy without claiming the protected reserve", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(
      world({
        controllerLevel: 2,
        energy: 300,
        energyCapacity: 300,
        extensionSite: true,
        spawn: true,
        workerEnergy: 5,
      }),
      config,
    );

    expect(planned).toMatchObject([
      {
        action: "build",
        reasonCode: "rcl2-infrastructure-bootstrap",
        requiredCapability: { carry: 1, move: 1, work: 1 },
        targetId: "site-extension",
        budgetRequest: {
          category: "optional-growth",
          energy: null,
          issuer: "growth/W1N1/rcl2-bootstrap/build/site-extension",
        },
      },
    ]);
    const funded = renewGrowthBudgets(
      planned,
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const authorized = authorizedSurvivalGrowth(
      funded,
      funded.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(authorized.requests).toEqual([
      expect.objectContaining({
        maxAssignmentCost: 1_500,
        priority: { class: "growth", value: 1_200 },
      }),
    ]);

    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 2,
          energy: 299,
          energyCapacity: 300,
          extensionSite: true,
          spawn: true,
          workerEnergy: 5,
        }),
        config,
      ),
    ).toMatchObject([
      {
        reasonCode: "rcl2-infrastructure-bootstrap",
        budgetRequest: { energy: null },
      },
    ]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 2,
          energy: 300,
          energyCapacity: 300,
          extensionSite: true,
          hostile: true,
          spawn: true,
          workerEnergy: 5,
        }),
        config,
      ),
    ).toEqual([]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 2,
          energy: 400,
          energyCapacity: 400,
          extensionSite: true,
          spawn: true,
          workerEnergy: 5,
        }),
        config,
      ),
    ).toMatchObject([
      {
        action: "build",
        reasonCode: "rcl2-infrastructure-bootstrap",
        requiredCapability: { carry: 1, move: 2, work: 2 },
        budgetRequest: {
          energy: null,
          issuer: "growth/W1N1/rcl2-bootstrap/build/site-extension",
        },
      },
    ]);
  });

  it("retains RCL2 bootstrap work through temporary worker loss and retires it when normal growth resumes", () => {
    const config = buildRuntimeConfig();
    const planning: ContractPlanningView = {
      status: "ready",
      contracts: [
        {
          budgetBinding: {
            category: "optional-growth",
            issuer: "growth/W1N1/rcl2-bootstrap/build/site-extension",
          },
          contractId: "bootstrap-RCL2-extension",
          execution: {
            action: "build",
            completion: "work-complete",
            counterpartId: null,
            resourceType: null,
            version: 1,
          },
          issuer: "growth/W1N1/rcl2-bootstrap/build/site-extension",
          owner: { id: "W1N1", kind: "colony" },
          state: "suspended",
          targetId: "site-extension",
        },
      ],
    };

    const workerlessCandidates = planSurvivalGrowth(
      world({
        controllerLevel: 2,
        energy: 0,
        energyCapacity: 300,
        extensionSite: true,
        spawn: true,
        workerEnergy: 0,
      }),
      config,
    );
    expect(workerlessCandidates).toMatchObject([
      { reasonCode: "rcl2-infrastructure-bootstrap", budgetRequest: { energy: null } },
    ]);

    const resumedCandidates = planSurvivalGrowth(
      world({
        controllerLevel: 2,
        energy: 300,
        energyCapacity: 300,
        extensionSite: true,
        spawn: true,
        workerEnergy: 5,
      }),
      config,
    );
    const resumed = authorizedSurvivalGrowth(
      resumedCandidates,
      resumedCandidates.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active",
      })),
      planning,
      111,
      world({
        controllerLevel: 2,
        energy: 300,
        energyCapacity: 300,
        extensionSite: true,
        spawn: true,
        workerEnergy: 5,
      }),
      config,
    );
    expect(resumed.requests).toEqual([]);
    expect(resumed.transitions).toEqual([
      {
        contractId: "bootstrap-RCL2-extension",
        reason: "growth-work-remains",
        tick: 111,
        to: "funded",
      },
    ]);

    const normalWorld = world({
      controllerLevel: 2,
      energy: 550,
      energyCapacity: 550,
      extensionSite: true,
      spawn: true,
      workerEnergy: 5,
    });
    const normalCandidates = planSurvivalGrowth(normalWorld, config);
    const normal = authorizedSurvivalGrowth(
      normalCandidates,
      normalCandidates.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active",
      })),
      planning,
      112,
      normalWorld,
      config,
    );
    expect(normal.requests).toHaveLength(14);
    expect(normal.requests[0]).toMatchObject({ issuer: "growth/W1N1/build/site-extension" });
    expect(
      normal.requests
        .slice(1)
        .every(({ issuer }) =>
          issuer.startsWith("growth/W1N1/upgrade-controller/controller-a/slot/"),
        ),
    ).toBe(true);
    expect(normal.transitions).toEqual([
      {
        contractId: "bootstrap-RCL2-extension",
        reason: "growth-target-resolved",
        tick: 112,
        to: "cancelled",
      },
    ]);

    expect(
      authorizedSurvivalGrowth(
        [],
        [],
        planning,
        113,
        world({
          controllerLevel: 2,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 5,
        }),
        config,
      ).transitions,
    ).toEqual([
      {
        contractId: "bootstrap-RCL2-extension",
        reason: "growth-target-resolved",
        tick: 113,
        to: "cancelled",
      },
    ]);
  });

  it("renews RCL1 bootstrap work with a fresh feasible horizon and one atomic successor", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 50,
      }),
      config,
    );
    const initial = renewGrowthBudgets(
      planned,
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const first = initial[0];
    if (first === undefined) throw new Error("expected RCL1 bootstrap candidate");
    expect(first.budgetRequest.expiresAt - 1 - 100).toBeGreaterThan(49);

    const predecessor = {
      budgetBinding: {
        category: "bootstrap-controller" as const,
        issuer: first.budgetRequest.issuer,
      },
      contractId: contractIdFor(first.budgetRequest.issuer, first.targetId, 1),
      execution: {
        action: "upgrade-controller" as const,
        completion: "continuous" as const,
        completionHits: null,
        counterpartId: null,
        resourceType: null,
        version: 1 as const,
      },
      issuer: first.budgetRequest.issuer,
      issuerSequence: 1,
      owner: { id: "W1N1", kind: "colony" as const },
      state: "funded" as const,
      targetId: first.targetId,
    };
    const renewed = renewGrowthBudgets(
      planned,
      [
        {
          category: "bootstrap-controller",
          colonyId: "W1N1",
          issuer: first.budgetRequest.issuer,
          revision: 1,
          request: { ...first.budgetRequest, expiresAt: 150, revision: 1 },
          status: "active",
        },
      ],
      140,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const successor = renewed[0];
    if (successor === undefined) throw new Error("expected renewed RCL1 bootstrap candidate");
    expect(successor.budgetRequest).toMatchObject({ revision: 2 });
    // If the predecessor lived until tick 150, the old 50-tick renewal left only 39 deadline
    // ticks. The atomic successor must retain enough fresh time for travel plus one work tick.
    expect(successor.budgetRequest.expiresAt - 1 - 150).toBeGreaterThan(40);

    const authorized = authorizedSurvivalGrowth(
      renewed,
      [
        {
          category: "bootstrap-controller",
          colonyId: "W1N1",
          issuer: successor.budgetRequest.issuer,
          status: "active",
        },
      ],
      { status: "ready", contracts: [predecessor] },
      140,
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 50,
      }),
      config,
    );
    const successorId = contractIdFor(successor.budgetRequest.issuer, successor.targetId, 2);
    expect(authorized.requests).toEqual([]);
    expect(authorized.replacements).toHaveLength(1);
    expect(authorized.replacements[0]).toMatchObject({
      predecessorContractId: predecessor.contractId,
      reason: "growth-budget-renewed",
      successor: {
        deadline: successor.budgetRequest.expiresAt - 1,
        issuerSequence: 2,
      },
      tick: 140,
    });
    expect(authorized.transitions).toContainEqual({
      contractId: successorId,
      reason: "growth-work-remains",
      tick: 140,
      to: "funded",
    });
  });

  it("keeps bootstrap demand reusable across temporary infeasibility and cancels when bootstrap phase exits", () => {
    const config = buildRuntimeConfig();
    const candidates = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 1,
      }),
      config,
    );
    const bootstrap = candidates.find(
      ({ budgetRequest }) => budgetRequest.category === "bootstrap-controller",
    );
    if (bootstrap === undefined) {
      throw new Error("expected bootstrap candidate");
    }
    const planning: ContractPlanningView = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: {
            category: "bootstrap-controller",
            issuer: bootstrap.budgetRequest.issuer,
          },
          contractId: "bootstrap-RCL1",
          execution: {
            action: "upgrade-controller" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 1,
          },
          issuer: bootstrap.budgetRequest.issuer,
          owner: { id: "W1N1", kind: "colony" },
          state: "funded" as const,
          targetId: bootstrap.targetId,
        },
      ],
    };

    const transitionsDuringTemporaryHiccup = authorizedSurvivalGrowth(
      [],
      [],
      planning,
      110,
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 0,
      }),
    ).transitions;
    expect(transitionsDuringTemporaryHiccup).toEqual([]);

    const transitionsAfterBootstrapPhase = authorizedSurvivalGrowth(
      [],
      [],
      planning,
      111,
      world({
        controllerLevel: 2,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 0,
      }),
    ).transitions;
    expect(transitionsAfterBootstrapPhase).toEqual([
      expect.objectContaining({
        contractId: "bootstrap-RCL1",
        reason: "growth-target-resolved",
        tick: 111,
        to: "cancelled",
      }),
    ]);
  });
});

function planningRecord(request: WorkContractRequest): ContractPlanningRecord {
  if (request.execution === undefined || request.targetId === null)
    throw new Error("growth planning record requires executable target terms");
  return {
    ...request,
    contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
    execution: request.execution,
    state: "funded",
    targetId: request.targetId,
  };
}

function world(
  options: {
    controllerLevel?: number;
    downgrade?: number;
    energy?: number;
    energyCapacity?: number;
    extensionSite?: boolean;
    hostile?: boolean;
    sites?: boolean;
    spawn?: boolean;
    workerEnergy?: number;
  } = {},
): WorldSnapshot {
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
    observedAt: 100,
    ownedConstructionSiteCount: (options.sites ? 4 : 0) + (options.extensionSite ? 1 : 0),
    ownedRooms: [],
    rooms: [
      {
        constructionSites: options.extensionSite
          ? [
              {
                id: "site-extension",
                ownerUsername: "me",
                ownership: "owned",
                pos: position(12, 10),
                progress: 45,
                progressTotal: 50,
                structureType: "extension",
              },
            ]
          : options.sites
            ? [
                {
                  id: "site-storage",
                  ownerUsername: "me",
                  ownership: "owned",
                  pos: position(13, 10),
                  progress: 0,
                  progressTotal: 100,
                  structureType: "storage",
                },
                {
                  id: "site-lab",
                  ownerUsername: "me",
                  ownership: "owned",
                  pos: position(14, 10),
                  progress: 0,
                  progressTotal: 100,
                  structureType: "lab",
                },
                {
                  id: "site-road",
                  ownerUsername: "me",
                  ownership: "owned",
                  pos: position(11, 10),
                  progress: 0,
                  progressTotal: 100,
                  structureType: "road",
                },
                {
                  id: "site-spawn",
                  ownerUsername: "me",
                  ownership: "owned",
                  pos: position(12, 10),
                  progress: 0,
                  progressTotal: 100,
                  structureType: "spawn",
                },
              ]
            : [],
        controller: {
          id: "controller-a",
          level: options.controllerLevel ?? 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(10, 10),
          progress: 0,
          progressTotal: 100,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: options.downgrade ?? 10_000,
          upgradeBlocked: null,
        },
        energyAvailable: options.energy ?? 800,
        energyCapacityAvailable: options.energyCapacity ?? 800,
        hostileCreeps: options.hostile ? [hostile()] : [],
        name: "W1N1",
        observedAt: 100,
        ownedCreeps:
          options.workerEnergy === undefined ? [] : [worker(options.workerEnergy, position(9, 10))],
        ownedExtensions: [],
        ownedSpawns: options.spawn ? [spawn()] : [],
        ownedTowers: [],
        roads: [],
        sources: [],
        storedStructures: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: (options.sites ? 4 : 0) + (options.extensionSite ? 1 : 0),
        controllers: 1,
        hostileCreeps: options.hostile ? 1 : 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: 0,
        storedStructures: 0,
        total: 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
function spawn() {
  return {
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    name: "Spawn1",
    pos: position(5, 5),
    spawning: null,
    store: { capacity: 300, freeCapacity: 0, resources: [], usedCapacity: 300 },
  };
}
function worker(carriedEnergy: number, pos: ReturnType<typeof position>) {
  const none = { active: 0, boosted: 0, total: 0 };
  const one = { active: 1, boosted: 0, total: 1 };
  return {
    body: {
      activeParts: 3,
      attack: none,
      carry: one,
      claim: none,
      heal: none,
      move: one,
      rangedAttack: none,
      size: 3,
      tough: none,
      work: one,
    },
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "worker",
    name: "worker",
    ownerUsername: "me",
    pos,
    spawning: false,
    store: {
      capacity: 50,
      freeCapacity: 50 - carriedEnergy,
      resources: carriedEnergy === 0 ? [] : [{ amount: carriedEnergy, resourceType: "energy" }],
      usedCapacity: carriedEnergy,
    },
    ticksToLive: 1_000,
  };
}
function hostile() {
  const none = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 1,
      attack: { active: 1, boosted: 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 1,
      tough: none,
      work: none,
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "hostile",
    name: "hostile",
    ownerUsername: "enemy",
    pos: position(20, 20),
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 100,
  };
}
