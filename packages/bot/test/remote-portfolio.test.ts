import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  REMOTE_PORTFOLIO_LIMITS,
  RemotePortfolio,
  resolveRemotePortfolioOwner,
  type RemoteCandidateEvidence,
  type RemotePortfolioCapacity,
  type RemotePortfolioInput,
} from "../src/remotes";
import type { RoomIntelQueryResult } from "../src/world/intel";
import type { RoutePlanResult } from "../src/world/routes";
import { openMyrmexMemory } from "../src/state/memory";

const CAPACITY: RemotePortfolioCapacity = Object.freeze({
  energy: 10_000,
  spawnTicks: 1_000,
  cpuMilli: 1_000,
  memoryCodeUnits: 10_000,
  activeRemotes: 4,
});

describe("RemotePortfolio", () => {
  it("admits only a positive full-cost candidate and reports every cost component", () => {
    const result = new RemotePortfolio().plan({
      tick: 100,
      owner: {},
      candidates: [
        candidate("W1N2", {
          latency: 1_000,
          spawn: 1_000,
          body: 1_000,
          hauling: 1_000,
          reservation: 1_000,
          roads: 1_000,
          repair: 1_000,
          expectedLoss: 1_000,
          cpu: 1_000,
        }),
        candidate("W1N3", {
          latency: 2_000,
          spawn: 2_000,
          body: 2_000,
          hauling: 2_000,
          reservation: 2_000,
          roads: 2_000,
          repair: 2_000,
          expectedLoss: 2_000,
          cpu: 2_000,
        }),
      ],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(result.status).toBe("ready");
    expect(resolveRemotePortfolioOwner(result.owner)).toMatchObject({ status: "ready" });
    expect(result.owner?.records).toEqual([
      expect.objectContaining({
        roomName: "W1N2",
        state: "probing",
        reasonCode: "positive-probe",
        forecast: { revenue: 20_000, cost: 9_000, profit: 11_000 },
        commitment: { energy: 1_000, spawnTicks: 30, cpuMilli: 100, memoryCodeUnits: 256 },
      }),
      expect.objectContaining({
        roomName: "W1N3",
        state: "candidate",
        reasonCode: "negative-value",
        forecast: { revenue: 10_000, cost: 18_000, profit: -8_000 },
        commitment: null,
      }),
    ]);
    expect(result.objectives).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "probing", profit: 11_000 }),
    ]);
    expect(result.metrics).toMatchObject({
      candidates: 2,
      profitable: 1,
      probing: 1,
      active: 0,
      released: 0,
      reservedEnergy: 1_000,
      revenue: 30_000,
      cost: 27_000,
      profit: 3_000,
    });
  });

  it("ranks equal candidates canonically and sheds the loser without partial reservations", () => {
    const portfolio = new RemotePortfolio();
    const left = candidate("W1N2", costs(1_000));
    const right = candidate("W1N3", costs(1_000), { intel: intel("W1N3", 3_000, 2) });
    const capacity = { ...CAPACITY, activeRemotes: 1 };

    const ordered = portfolio.plan({
      tick: 100,
      owner: {},
      candidates: [left, right],
      capacity,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const reversed = new RemotePortfolio().plan({
      tick: 100,
      owner: {},
      candidates: [right, left],
      capacity,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(reversed).toEqual(ordered);
    expect(ordered.owner?.records).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "probing" }),
      expect.objectContaining({
        roomName: "W1N3",
        state: "candidate",
        reasonCode: "capacity-active",
        commitment: null,
      }),
    ]);
    expect(ordered.metrics).toMatchObject({ reservedEnergy: 1_000, probing: 1 });
  });

  it("retains an active remote inside hysteresis and sheds it for a materially better candidate", () => {
    const portfolio = new RemotePortfolio();
    const left = candidate("W1N2", costs(1_000));
    const active = plan(portfolio, 101, plan(portfolio, 100, {}, left).owner, left);
    const near = candidate(
      "W1N3",
      { ...costs(1_000), latency: 500 },
      { intel: intel("W1N3", 3_000, 2) },
    );
    const constrained = { ...CAPACITY, activeRemotes: 1 };
    const retained = portfolio.plan({
      tick: 102,
      owner: active.owner,
      candidates: [near, left],
      capacity: constrained,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const better = candidate(
      "W1N3",
      { ...costs(777), latency: 770 },
      { intel: intel("W1N3", 3_000, 2) },
    );
    const shed = portfolio.plan({
      tick: 103,
      owner: retained.owner,
      candidates: [left, better],
      capacity: constrained,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(retained.owner?.records).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "active", commitment: left.commitment }),
      expect.objectContaining({
        roomName: "W1N3",
        state: "candidate",
        reasonCode: "capacity-active",
      }),
    ]);
    expect(shed.owner?.records).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "suspended", commitment: null }),
      expect.objectContaining({
        roomName: "W1N3",
        state: "probing",
        commitment: better.commitment,
      }),
    ]);
    expect(shed.metrics.released).toBe(1);
  });

  it("does not count a skipped planning tick as positive probe evidence", () => {
    const portfolio = new RemotePortfolio();
    const input = candidate("W1N2", costs(1_000));
    const first = plan(portfolio, 100, {}, input);
    const afterGap = plan(portfolio, 102, first.owner, input);

    expect(afterGap.owner?.records[0]).toMatchObject({ state: "probing", positiveTicks: 1 });
  });

  it("does not let a retired high-value record consume capacity after it reappears", () => {
    const portfolio = new RemotePortfolio();
    const retired = plan(
      portfolio,
      100,
      {},
      {
        ...candidate("W1N2", costs(500)),
        expiresAt: 100,
      },
    );
    const fresh = candidate("W1N3", costs(1_000));
    const result = portfolio.plan({
      tick: 101,
      owner: retired.owner,
      candidates: [candidate("W1N2", costs(500)), fresh],
      capacity: { ...CAPACITY, activeRemotes: 1 },
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(result.owner?.records).toEqual([
      expect.objectContaining({ roomName: "W1N2", state: "retired", commitment: null }),
      expect.objectContaining({ roomName: "W1N3", state: "probing", commitment: fresh.commitment }),
    ]);
    expect(result.objectives.map(({ roomName }) => roomName)).toEqual(["W1N3"]);
  });

  it("activates after probing, releases on threat, cools down, and resumes idempotently", () => {
    const portfolio = new RemotePortfolio();
    const input = candidate("W1N2", costs(1_000));
    const first = plan(portfolio, 100, {}, input);
    const sameTick = plan(portfolio, 100, first.owner, input);
    const active = plan(portfolio, 101, sameTick.owner, input);
    const threatened = plan(portfolio, 102, active.owner, {
      ...input,
      evidenceRevision: "evidence/threat",
      threatRisk: 1,
    });
    const suspended = plan(portfolio, 103, threatened.owner, {
      ...input,
      evidenceRevision: "evidence/safe",
    });
    const cooldown = plan(portfolio, 105, suspended.owner, input);
    const resumed = plan(portfolio, 106, cooldown.owner, input);

    expect(sameTick.owner).toEqual(first.owner);
    expect(sameTick.changed).toBe(false);
    expect(active.owner?.records[0]).toMatchObject({
      state: "active",
      reasonCode: "positive-active",
    });
    expect(threatened.owner?.records[0]).toMatchObject({
      state: "threatened",
      reasonCode: "threat-risk",
      resumeAt: 105,
      commitment: null,
    });
    expect(threatened.metrics).toMatchObject({ released: 1, reservedEnergy: 0 });
    expect(suspended.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "cooldown-wait",
      resumeAt: 105,
    });
    expect(cooldown.owner?.records[0]).toMatchObject({
      state: "cooldown",
      commitment: input.commitment,
    });
    expect(resumed.owner?.records[0]).toMatchObject({
      state: "active",
      reasonCode: "resumed-active",
    });
  });

  it("applies same-tick threat, capacity loss, and omission without double-advancing probes", () => {
    const portfolio = new RemotePortfolio();
    const input = candidate("W1N2", costs(1_000));
    const active = plan(portfolio, 101, plan(portfolio, 100, {}, input).owner, input);
    const threatened = plan(portfolio, 101, active.owner, { ...input, threatRisk: 1 });
    const capacityLost = portfolio.plan({
      tick: 101,
      owner: active.owner,
      candidates: [input],
      capacity: { ...CAPACITY, activeRemotes: 0 },
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const omitted = portfolio.plan({
      tick: 101,
      owner: active.owner,
      candidates: [],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const tinyCommitment = { energy: 1, spawnTicks: 1, cpuMilli: 1, memoryCodeUnits: 1 };
    const resized = portfolio.plan({
      tick: 101,
      owner: active.owner,
      candidates: [{ ...input, commitment: tinyCommitment }],
      capacity: { ...tinyCommitment, activeRemotes: 1 },
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(threatened.owner?.records[0]).toMatchObject({ state: "threatened", commitment: null });
    expect(capacityLost.owner?.records[0]).toMatchObject({ state: "suspended", commitment: null });
    expect(omitted.owner?.records[0]).toMatchObject({ state: "suspended", commitment: null });
    expect(resized.owner?.records[0]).toMatchObject({
      state: "active",
      commitment: tinyCommitment,
    });
    expect(resized.metrics).toMatchObject({
      reservedEnergy: 1,
      reservedSpawnTicks: 1,
      reservedCpuMilli: 1,
      reservedMemoryCodeUnits: 1,
    });
    expect(threatened.metrics.released).toBe(1);
    expect(capacityLost.metrics.released).toBe(1);
    expect(omitted.metrics.released).toBe(1);
  });

  it("retires omitted expired records and evicts terminal evidence before blocking new work", () => {
    const portfolio = new RemotePortfolio();
    let owner: unknown = {};
    for (let batch = 0; batch < 4; batch += 1) {
      const result = portfolio.plan({
        tick: batch,
        owner,
        candidates: Array.from({ length: 8 }, (_, index) => ({
          ...candidate(`W${String(batch * 8 + index + 2)}N2`, costs(3_000)),
          expiresAt: 4,
        })),
        capacity: CAPACITY,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      });
      expect(result.status).toBe("ready");
      owner = result.owner;
    }
    const retired = portfolio.plan({
      tick: 4,
      owner,
      candidates: [],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const incoming = candidate("E40S40", costs(1_000));
    const admitted = portfolio.plan({
      tick: 5,
      owner: retired.owner,
      candidates: [incoming],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(retired.owner?.records).toHaveLength(32);
    expect(retired.owner?.records.every(({ state }) => state === "retired")).toBe(true);
    expect(admitted.status).toBe("ready");
    expect(admitted.owner?.records).toHaveLength(32);
    expect(admitted.owner?.records).toContainEqual(
      expect.objectContaining({ roomName: "E40S40", state: "probing" }),
    );
  });

  it("releases existing work when new candidates arrive at the record ceiling", () => {
    const portfolio = new RemotePortfolio();
    let owner: unknown = {};
    for (let batch = 0; batch < 4; batch += 1) {
      const result = portfolio.plan({
        tick: batch,
        owner,
        candidates: Array.from({ length: 8 }, (_, index) =>
          candidate(`W${String(batch * 8 + index + 2)}N3`, costs(1_000)),
        ),
        capacity: CAPACITY,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      });
      expect(result.status).toBe("ready");
      owner = result.owner;
    }
    const result = portfolio.plan({
      tick: 4,
      owner,
      candidates: Array.from({ length: 8 }, (_, index) =>
        candidate(`E${String(index + 2)}S3`, costs(1_000)),
      ),
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(result.status).toBe("ready");
    expect(result.owner?.records).toHaveLength(32);
    expect(result.objectives).toHaveLength(4);
    expect(result.metrics).toMatchObject({ released: 4, reservedEnergy: 4_000 });
    expect(result.owner?.records.filter(({ commitment }) => commitment !== null)).toHaveLength(4);
  });

  it("evicts oldest retired records to satisfy the owner byte ceiling", () => {
    const portfolio = new RemotePortfolio();
    let owner: unknown = {};
    for (let batch = 0; batch < 4; batch += 1) {
      const result = portfolio.plan({
        tick: batch,
        owner,
        candidates: Array.from({ length: 8 }, (_, index) => ({
          ...candidate(`E${String(batch * 8 + index + 2)}S2`, costs(1_000)),
          evidenceRevision: "\\".repeat(REMOTE_PORTFOLIO_LIMITS.maximumIdentityCodeUnits),
          expiresAt: batch,
        })),
        capacity: CAPACITY,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      });
      expect(result.status).toBe("ready");
      owner = result.owner;
    }

    expect(JSON.stringify(owner).length).toBeLessThanOrEqual(
      REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits,
    );
    expect((owner as { records: readonly unknown[] }).records.length).toBeLessThan(32);
  });

  it("fails stale, partial, unaffordable, missing, vanished, and expired evidence closed", () => {
    const portfolio = new RemotePortfolio();
    const base = candidate("W1N2", costs(1_000));
    const active = plan(portfolio, 101, plan(portfolio, 100, {}, base).owner, base);

    const stale = plan(portfolio, 102, active.owner, {
      ...base,
      intel: { ...base.intel, freshness: "stale" },
    });
    const vanished = plan(portfolio, 103, stale.owner, {
      ...base,
      intel: intel("W1N2", 0, 0),
    });
    const missing = portfolio.plan({
      tick: 102,
      owner: active.owner,
      candidates: [],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });
    const expired = plan(portfolio, 1_000, {}, { ...base, expiresAt: 1_000 });

    expect(stale.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "stale-intel",
      commitment: null,
    });
    expect(
      plan(portfolio, 102, active.owner, {
        ...base,
        intel: { ...intel("W1N2", 0, 0), freshness: "stale" },
      }).owner?.records[0],
    ).toMatchObject({ state: "suspended", reasonCode: "stale-intel" });
    expect(vanished.owner?.records[0]).toMatchObject({
      state: "retired",
      reasonCode: "source-vanished",
    });
    expect(missing.owner?.records[0]).toMatchObject({
      state: "suspended",
      reasonCode: "candidate-missing",
    });
    expect(expired.owner?.records[0]).toMatchObject({ state: "retired", reasonCode: "timeout" });

    const noControllerIntel = {
      ...base.intel,
      record: base.intel.record === null ? null : { ...base.intel.record, controller: null },
    };
    expect(
      plan(portfolio, 100, {}, { ...base, intel: noControllerIntel }).owner?.records[0],
    ).toMatchObject({ state: "candidate", reasonCode: "controller-blocked", commitment: null });

    for (const [reason, changed] of [
      ["partial-intel", { intel: { ...base.intel, quality: "partial" as const } }],
      ["route-unavailable", { route: { ...base.route, status: "no-route" as const, plan: null } }],
      ["controller-blocked", { controller: "blocked" as const }],
      ["donor-pressure", { donor: "brownout" as const }],
    ] as const) {
      expect(plan(portfolio, 100, {}, { ...base, ...changed }).owner?.records[0]).toMatchObject({
        state: "candidate",
        reasonCode: reason,
        commitment: null,
      });
    }
  });

  it.each([
    ["capacity-energy", { energy: 999 }],
    ["capacity-spawn", { spawnTicks: 29 }],
    ["capacity-cpu", { cpuMilli: 99 }],
    ["capacity-memory", { memoryCodeUnits: 255 }],
    ["capacity-active", { activeRemotes: 0 }],
  ] as const)("rejects %s without a partial commitment", (reason, constrained) => {
    const input = candidate("W1N2", costs(1_000));
    const result = new RemotePortfolio().plan({
      tick: 100,
      owner: {},
      candidates: [input],
      capacity: { ...CAPACITY, ...constrained },
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(result.owner?.records[0]).toMatchObject({
      state: "candidate",
      reasonCode: reason,
      commitment: null,
    });
    expect(result.metrics).toMatchObject({
      reservedEnergy: 0,
      reservedSpawnTicks: 0,
      reservedCpuMilli: 0,
      reservedMemoryCodeUnits: 0,
    });
  });

  it("rejects malformed runtime candidate and nested cost input without throwing", () => {
    const portfolio = new RemotePortfolio();
    const base: RemotePortfolioInput = {
      tick: 100,
      owner: {},
      candidates: [candidate("W1N2", costs(1_000))],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    };

    expect(
      portfolio.plan({ ...base, candidates: [null] } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    expect(
      portfolio.plan({
        ...base,
        candidates: [{ ...base.candidates[0], costs: null }],
      } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    expect(
      portfolio.plan({ ...base, capacity: null } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    expect(
      portfolio.plan({
        ...base,
        candidates: [
          {
            ...base.candidates[0],
            commitment: { ...base.candidates[0]?.commitment, duplicateAuthority: 1 },
          },
        ],
      } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    expect(
      portfolio.plan({
        ...base,
        candidates: [
          {
            ...base.candidates[0],
            route: {
              ...base.candidates[0]?.route,
              status: "ready",
              plan: { ...base.candidates[0]?.route.plan, risk: "unsafe" },
            },
          },
        ],
      } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    expect(
      portfolio.plan({
        ...base,
        candidates: [
          {
            ...base.candidates[0],
            intel: intel("W1N2", 3_000_000_000_000),
          },
        ],
      } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
    const cyclic = { ...base.candidates[0] } as Record<string, unknown>;
    cyclic.extra = cyclic;
    expect(
      portfolio.plan({ ...base, candidates: [cyclic] } as unknown as RemotePortfolioInput),
    ).toMatchObject({ status: "invalid-input", changed: false, owner: null });
  });

  it("stages only its validated remotes owner through the atomic Memory authority", () => {
    const memory = {} as Memory;
    const opened = openMyrmexMemory(memory, 100, "shard0");
    if (opened.status !== "ready") throw new Error("expected ready Memory");
    const portfolio = new RemotePortfolio();
    const result = portfolio.plan({
      tick: 100,
      owner: opened.manager.ownerView("remotes"),
      candidates: [candidate("W1N2", costs(1_000))],
      capacity: CAPACITY,
      policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
    });

    expect(portfolio.stage(opened.manager, result)).toEqual({ staged: true });
    expect(opened.manager.commitReconciliation()).toMatchObject({
      committed: true,
      owners: ["remotes"],
    });
    expect(memory.myrmex?.remotes).toEqual(result.owner);
  });

  it("preserves malformed/future owners and rejects bounded input overflow", () => {
    const portfolio = new RemotePortfolio();
    const input = candidate("W1N2", costs(1_000));

    expect(plan(portfolio, 100, { schemaVersion: 1 }, input)).toMatchObject({
      status: "owner-malformed",
      changed: false,
      owner: null,
    });
    expect(plan(portfolio, 100, { schemaVersion: 2 }, input)).toMatchObject({
      status: "owner-future-schema",
      changed: false,
      owner: null,
    });
    const futureTickOwner = plan(
      portfolio,
      101,
      plan(portfolio, 100, {}, input).owner,
      input,
    ).owner;
    expect(plan(portfolio, 100, futureTickOwner, input)).toMatchObject({
      status: "invalid-input",
      changed: false,
      owner: null,
    });
    expect(
      portfolio.plan({
        tick: 100,
        owner: {},
        candidates: Array.from({ length: 9 }, (_, index) =>
          candidate(`W${String(index + 2)}N2`, costs(1_000)),
        ),
        capacity: CAPACITY,
        policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
      }),
    ).toMatchObject({ status: "limit-exceeded", changed: false, owner: null });
  });
});

function plan(
  portfolio: RemotePortfolio,
  tick: number,
  owner: unknown,
  input: RemoteCandidateEvidence,
) {
  return portfolio.plan({
    tick,
    owner,
    candidates: [input],
    capacity: CAPACITY,
    policy: DEFAULT_REMOTE_PORTFOLIO_POLICY_V1,
  });
}

function costs(value: number): RemoteCandidateEvidence["costs"] {
  return {
    latency: value,
    spawn: value,
    body: value,
    hauling: value,
    reservation: value,
    roads: value,
    repair: value,
    expectedLoss: value,
    cpu: value,
  };
}

function candidate(
  roomName: string,
  costs: RemoteCandidateEvidence["costs"],
  overrides: Partial<RemoteCandidateEvidence> = {},
): RemoteCandidateEvidence {
  const sourceCount = roomName === "W1N2" ? 2 : 1;
  return {
    roomName,
    donorColonyId: "W1N1",
    evidenceRevision: `evidence/${roomName}`,
    expiresAt: 1_000,
    controller: "available",
    donor: "healthy",
    threatRisk: 0,
    intel: intel(roomName, 3_000, sourceCount),
    route: route(roomName),
    costs,
    commitment: { energy: 1_000, spawnTicks: 30, cpuMilli: 100, memoryCodeUnits: 256 },
    ...overrides,
  };
}

function intel(roomName: string, energyCapacity: number, sourceCount = 1): RoomIntelQueryResult {
  return {
    roomName,
    freshness: "current",
    quality: "complete",
    reason: "current-observation",
    generation: null,
    record: {
      schemaVersion: 1,
      shard: "shard0",
      roomName,
      observedAt: 100,
      eventsObservedAt: 99,
      complete: true,
      terrain: { cells: "0".repeat(2_500), revision: `terrain/${roomName}` },
      controller: {
        id: `controller/${roomName}`,
        level: 0,
        ownerUsername: null,
        ownership: "neutral",
        pos: { x: 25, y: 25 },
        reservationTicksToEnd: null,
        reservationUsername: null,
        safeMode: null,
      },
      mineral: null,
      mineralStatus: "complete",
      sources: Array.from({ length: sourceCount }, (_, index) => ({
        id: `source/${roomName}/${String(index)}`,
        energyCapacity,
        pos: { x: 10 + index, y: 10 },
      })),
      sourceStatus: "complete",
      structures: [],
      structureStatus: "complete",
      hostiles: [],
      hostileStatus: "complete",
      events: [],
      eventLogStatus: "observed",
    },
  };
}

function route(roomName: string): RoutePlanResult {
  return {
    status: "ready",
    reason: "route-computed",
    source: "search",
    plan: {
      schemaVersion: 1,
      requestId: `route/${roomName}`,
      originRoomName: "W1N1",
      destinationRoomName: roomName,
      roomNames: [roomName],
      totalCost: 100,
      risk: 0,
      estimate: {
        outboundTicks: 50,
        returnTicks: 100,
        roundTripTicks: 150,
        throughputMilliCapacityPerTick: 333,
        roadSteps: 0,
        plainSteps: 50,
        swampSteps: 0,
        roadBodyPartSteps: 0,
      },
    },
    metrics: {
      expandedRooms: 1,
      consideredEdges: 1,
      cacheHits: 0,
      routeRooms: 1,
      totalCost: 100,
      risk: 0,
      reason: "route-computed",
    },
  };
}
