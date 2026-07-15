import { describe, expect, it } from "vitest";
import { BudgetLedger, reservationIdFor } from "../src/colony/budget-ledger";
import {
  MAX_ACTIVE_RESERVATIONS,
  MAX_BUDGET_REQUESTS_PER_TICK,
  MAX_LEDGER_ENTRIES,
  MAX_RESERVATION_ID_CODE_UNITS,
  MAX_SPAWN_INTERVAL_TICKS,
  type BudgetCategory,
  type BudgetLedgerCapacity,
  type BudgetRequest,
  type ElasticBudgetClaim,
  type SpawnIntervalClaim,
} from "../src/colony/contracts";

describe("BudgetLedger", () => {
  it("arbitrates elastic energy and CPU identically when requests are reordered", () => {
    const emergency = request("emergency-spawn", "recovery", {
      energy: claim(200, 300),
      cpu: claim(50, 100),
    });
    const growth = request("optional-growth", "growth", {
      energy: claim(100, 300),
      cpu: claim(50, 200),
    });
    const capacity = capacities({ available: 500, protected: 300, cpu: 250 });

    const forward = new BudgetLedger().reconcile({
      tick: 100,
      capacity,
      requests: [emergency, growth],
    });
    const reversed = new BudgetLedger().reconcile({
      tick: 100,
      capacity,
      requests: [growth, emergency],
    });

    expect(reversed).toEqual(forward);
    expect(forward.decisions).toMatchObject([
      {
        issuer: "recovery",
        status: "granted",
        reasonCode: "granted",
        grant: { energy: 300, cpu: 100 },
      },
      {
        issuer: "growth",
        status: "granted",
        reasonCode: "granted-reduced",
        grant: { energy: 200, cpu: 150 },
      },
    ]);
    expect(forward.totals).toMatchObject({
      active: 2,
      energyReserved: 500,
      cpuReserved: 250,
    });
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.entries[0]?.request.energy)).toBe(true);
  });

  it("protects the mandatory energy floor from optional work", () => {
    const growth = request("optional-growth", "growth", {
      energy: claim(201, 250),
    });
    const result = new BudgetLedger().reconcile({
      tick: 100,
      capacity: capacities({ available: 500, protected: 300 }),
      requests: [growth],
    });

    expect(result.decisions).toMatchObject([
      { issuer: "growth", status: "denied", reasonCode: "protected-energy-floor" },
    ]);
    expect(result.entries).toMatchObject([
      { issuer: "growth", status: "pending", grant: { energy: 0 } },
    ]);
    expect(result.totals.energyReserved).toBe(0);
  });

  it("uses half-open spawn intervals and reports observed and allocated conflicts", () => {
    const replacement = request("replacement", "replacement", {
      energy: claim(100, 100),
      spawn: interval("spawn-1", 100, 110),
    });
    const overlap = request("optional-growth", "overlap", {
      energy: claim(100, 100),
      spawn: interval("spawn-1", 100, 110),
    });
    const touching = request("optional-growth", "touching", {
      energy: claim(100, 100),
      spawn: interval("spawn-1", 110, 120),
    });
    const capacity = capacities({
      available: 1_000,
      protected: 0,
      spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
    });
    const result = new BudgetLedger().reconcile({
      tick: 100,
      capacity,
      requests: [touching, overlap, replacement],
    });

    expect(result.decisions).toMatchObject([
      { issuer: "replacement", status: "granted" },
      { issuer: "overlap", status: "denied", reasonCode: "spawn-interval-overlap" },
      { issuer: "touching", status: "granted" },
    ]);
    expect(result.totals.spawnTicksReserved).toBe(20);

    const retainedIsNowObservedBusy = new BudgetLedger(
      result.entries.filter((entry) => entry.issuer === "replacement"),
    ).reconcile({
      tick: 101,
      capacity: capacities({
        available: 1_000,
        protected: 0,
        spawns: [
          {
            colonyId: "W1N1",
            spawnId: "spawn-1",
            blocked: [interval("spawn-1", 100, 110)],
          },
        ],
      }),
      requests: [replacement],
    });
    expect(retainedIsNowObservedBusy.decisions).toMatchObject([
      { issuer: "replacement", status: "denied", reasonCode: "spawn-observed-busy" },
    ]);
    expect(retainedIsNowObservedBusy.entries[0]).toMatchObject({ status: "pending" });
  });

  it("uses deterministic energy, spawn, then CPU denial precedence", () => {
    const allClaims = request("replacement", "all-claims", {
      energy: claim(200, 200),
      cpu: claim(50, 50),
      spawn: interval("spawn-1", 100, 110),
    });
    const noEnergy = new BudgetLedger().reconcile({
      tick: 100,
      capacity: capacities({ available: 100, protected: 100 }),
      requests: [allClaims],
    });
    expect(noEnergy.decisions[0]).toMatchObject({ reasonCode: "insufficient-energy" });

    const noSpawn = new BudgetLedger().reconcile({
      tick: 100,
      capacity: capacities({ available: 200, protected: 200 }),
      requests: [allClaims],
    });
    expect(noSpawn.decisions[0]).toMatchObject({ reasonCode: "spawn-not-observed" });

    const noCpu = new BudgetLedger().reconcile({
      tick: 100,
      capacity: capacities({
        available: 200,
        protected: 200,
        spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
      }),
      requests: [allClaims],
    });
    expect(noCpu.decisions[0]).toMatchObject({ reasonCode: "insufficient-cpu" });
  });

  it("preempts optional growth and retries an unfunded emergency without duplication", () => {
    const growth = request("optional-growth", "growth", {
      energy: claim(200, 200),
    });
    const emergency = request("emergency-spawn", "recovery", {
      energy: claim(200, 300),
    });
    const ledger = new BudgetLedger();
    const growthOnly = ledger.reconcile({
      tick: 100,
      capacity: capacities({ available: 300, protected: 0 }),
      requests: [growth],
    });
    expect(growthOnly.entries[0]).toMatchObject({ issuer: "growth", status: "active" });

    const preempted = ledger.reconcile({
      tick: 101,
      capacity: capacities({ available: 300, protected: 300 }),
      requests: [growth, emergency],
    });
    expect(preempted.entries).toMatchObject([
      { issuer: "recovery", status: "active", grant: { energy: 300 } },
      { issuer: "growth", status: "pending", grant: { energy: 0 } },
    ]);
    expect(preempted.totals).toMatchObject({ active: 1, pending: 1, energyReserved: 300 });

    const recoveryLedger = new BudgetLedger();
    const brownout = recoveryLedger.reconcile({
      tick: 100,
      capacity: capacities({ available: 150, protected: 150 }),
      requests: [emergency],
    });
    expect(brownout.entries).toMatchObject([
      { status: "pending", reasonCode: "insufficient-energy" },
    ]);

    const repeatedBrownout = recoveryLedger.reconcile({
      tick: 101,
      capacity: capacities({ available: 150, protected: 150 }),
      requests: [emergency],
    });
    expect(repeatedBrownout.entries).toEqual(brownout.entries);

    const funded = recoveryLedger.reconcile({
      tick: 102,
      capacity: capacities({ available: 300, protected: 300 }),
      requests: [emergency],
    });
    expect(funded.entries).toHaveLength(1);
    expect(funded.entries[0]).toMatchObject({
      status: "active",
      createdAt: 100,
      updatedAt: 102,
      grant: { energy: 300 },
    });
  });

  it("retains byte-stable grants across canonical key reordering and rejects revision reuse", () => {
    const original = request("replacement", "worker-7", {
      energy: claim(200, 200),
    });
    const ledger = new BudgetLedger();
    const first = ledger.reconcile({
      tick: 100,
      capacity: capacities({ available: 250, protected: 200 }),
      requests: [original],
    });
    const reorderedKeys: BudgetRequest = {
      spawn: null,
      cpu: null,
      energy: { desired: 200, minimum: 200 },
      expiresAt: 200,
      revision: 1,
      issuer: "worker-7",
      category: "replacement",
      colonyId: "W1N1",
    };
    const retained = ledger.reconcile({
      tick: 101,
      capacity: capacities({ available: 250, protected: 200 }),
      requests: [reorderedKeys],
    });

    expect(retained.entries[0]).toEqual(first.entries[0]);
    expect(retained.decisions).toMatchObject([
      { status: "retained", reasonCode: "already-granted" },
    ]);

    const reused = ledger.reconcile({
      tick: 102,
      capacity: capacities({ available: 250, protected: 200 }),
      requests: [{ ...original, energy: claim(200, 250) }],
    });
    expect(reused.entries[0]).toEqual(first.entries[0]);
    expect(reused.decisions.map((decision) => decision.reasonCode)).toEqual([
      "already-granted",
      "revision-reused",
    ]);

    const revisionTwo = { ...original, revision: 2, energy: claim(200, 250) };
    const superseded = ledger.reconcile({
      tick: 103,
      capacity: capacities({ available: 250, protected: 200 }),
      requests: [revisionTwo],
    });
    expect(superseded.entries).toMatchObject([{ revision: 2, status: "active" }]);
    expect(superseded.transitions).toContainEqual({
      reservationId: reservationIdFor(original),
      action: "release",
      reasonCode: "superseded",
    });

    const beforeStaleReplay = superseded.entries[0];
    const stale = ledger.reconcile({
      tick: 104,
      capacity: capacities({ available: 250, protected: 200 }),
      requests: [original],
    });
    expect(stale.entries[0]).toEqual(beforeStaleReplay);
    expect(stale.decisions.map((decision) => decision.reasonCode)).toEqual([
      "stale-revision",
      "already-granted",
    ]);
  });

  it("supports cumulative consume, release, expire, and reconcile lifecycles idempotently", () => {
    const funded = request("replacement", "worker-8", {
      energy: claim(200, 200),
      cpu: claim(50, 50),
      spawn: interval("spawn-1", 100, 110),
      expiresAt: 105,
    });
    const capacity = capacities({
      available: 300,
      protected: 200,
      cpu: 50,
      spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
    });
    const ledger = new BudgetLedger();
    const granted = ledger.reconcile({ tick: 100, capacity, requests: [funded] });
    const reservationId = granted.entries[0]?.reservationId ?? "missing";
    const partiallyConsumed = ledger.consume(
      reservationId,
      { energy: 100, cpu: 10, spawn: false },
      101,
    );
    expect(partiallyConsumed.entries[0]).toMatchObject({ status: "active" });
    expect(partiallyConsumed.totals).toMatchObject({
      energyReserved: 100,
      cpuReserved: 40,
      spawnTicksReserved: 10,
    });

    const repeatedConsumption = ledger.consume(
      reservationId,
      { energy: 100, cpu: 10, spawn: false },
      102,
    );
    expect(repeatedConsumption.entries).toEqual(partiallyConsumed.entries);
    expect(repeatedConsumption.transitions).toMatchObject([{ reasonCode: "already-consumed" }]);

    const consumed = ledger.consume(reservationId, { energy: 200, cpu: 50, spawn: true }, 103);
    expect(consumed.entries[0]).toMatchObject({ status: "consumed" });
    expect(consumed.totals).toMatchObject({
      active: 0,
      energyReserved: 0,
      cpuReserved: 0,
      spawnTicksReserved: 0,
    });
    expect(ledger.release(reservationId, 104).entries).toEqual(consumed.entries);

    const releasable = new BudgetLedger().reconcile({
      tick: 100,
      capacity,
      requests: [funded],
    }).entries;
    const releaseLedger = new BudgetLedger(releasable);
    const released = releaseLedger.reconcile({ tick: 101, capacity, requests: [] });
    expect(released.entries[0]).toMatchObject({
      status: "released",
      reasonCode: "objective-satisfied",
    });
    expect(releaseLedger.release(reservationId, 102).entries).toEqual(released.entries);

    const expiringLedger = new BudgetLedger(releasable);
    const expired = expiringLedger.expire(106);
    expect(expired.entries[0]).toMatchObject({
      status: "expired",
      reasonCode: "expired",
      grant: { energy: 0, cpu: 0, spawn: null },
    });
    expect(expiringLedger.expire(107).entries).toEqual(expired.entries);
  });

  it("bounds admitted requests and active reservations deterministically", () => {
    const requests = Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK + 1 }, (_, index) =>
      request("optional-growth", `issuer-${String(index).padStart(3, "0")}`, {
        energy: claim(0, 0),
      }),
    );
    const result = new BudgetLedger().reconcile({
      tick: 100,
      capacity: capacities({ available: 0, protected: 0 }),
      requests: [...requests].reverse(),
    });

    expect(result.entries).toHaveLength(MAX_ACTIVE_RESERVATIONS);
    expect(result.totals.active).toBe(MAX_ACTIVE_RESERVATIONS);
    expect(
      result.decisions.filter((decision) => decision.reasonCode === "request-cap-exceeded"),
    ).toHaveLength(1);
  });

  it("enforces the ledger-entry cap at its exact 512/513 boundary", () => {
    const firstBatch = Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK }, (_, index) =>
      request("optional-growth", `first-${String(index).padStart(3, "0")}`, {
        energy: claim(0, 0),
      }),
    );
    const secondBatch = Array.from({ length: MAX_BUDGET_REQUESTS_PER_TICK }, (_, index) =>
      request("optional-growth", `second-${String(index).padStart(3, "0")}`, {
        energy: claim(0, 0),
      }),
    );
    const capacity = capacities({ available: 0, protected: 0 });
    const ledger = new BudgetLedger();

    ledger.reconcile({ tick: 100, capacity, requests: firstBatch });
    ledger.reconcile({ tick: 101, capacity, requests: [] });
    ledger.reconcile({ tick: 102, capacity, requests: secondBatch });
    const atCap = ledger.reconcile({ tick: 103, capacity, requests: [] });
    expect(atCap.entries).toHaveLength(MAX_LEDGER_ENTRIES);

    const overCap = ledger.reconcile({
      tick: 104,
      capacity,
      requests: [
        request("optional-growth", "entry-513", {
          energy: claim(0, 0),
        }),
      ],
    });
    expect(overCap.entries).toHaveLength(MAX_LEDGER_ENTRIES);
    expect(overCap.decisions).toMatchObject([
      { issuer: "entry-513", status: "denied", reasonCode: "ledger-entry-cap-exceeded" },
    ]);
  });

  it("accepts a 150-tick spawn interval and rejects a 151-tick interval", () => {
    const capacity = capacities({
      spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
    });
    const maximum = request("replacement", "maximum-interval", {
      spawn: interval("spawn-1", 100, 100 + MAX_SPAWN_INTERVAL_TICKS),
    });
    const tooLong = request("replacement", "overlong-interval", {
      spawn: interval("spawn-1", 100, 101 + MAX_SPAWN_INTERVAL_TICKS),
    });

    expect(
      new BudgetLedger().reconcile({ tick: 100, capacity, requests: [maximum] }).decisions,
    ).toMatchObject([{ status: "granted", reasonCode: "granted" }]);
    expect(
      new BudgetLedger().reconcile({ tick: 100, capacity, requests: [tooLong] }).decisions,
    ).toMatchObject([{ status: "denied", reasonCode: "invalid-request" }]);
    expect(() => reservationIdFor(tooLong)).toThrow(/invalid request/u);
  });

  it("derives bounded deterministic ids for maximum-length Unicode identities", () => {
    const maximum = request("critical-maintenance", "界".repeat(128), {
      colonyId: "域".repeat(64),
      energy: claim(1, 1),
      revision: Number.MAX_SAFE_INTEGER,
    });
    const id = reservationIdFor(maximum);

    expect(id).toBe(reservationIdFor({ ...maximum }));
    expect(id.length).toBeLessThanOrEqual(MAX_RESERVATION_ID_CODE_UNITS);
  });
});

function request(
  category: BudgetCategory,
  issuer: string,
  overrides: Partial<BudgetRequest> = {},
): BudgetRequest {
  return {
    colonyId: "W1N1",
    category,
    issuer,
    revision: 1,
    expiresAt: 200,
    energy: null,
    cpu: null,
    spawn: null,
    ...overrides,
  };
}

function claim(minimum: number, desired: number): ElasticBudgetClaim {
  return { minimum, desired };
}

function interval(spawnId: string, startTick: number, endTick: number): SpawnIntervalClaim {
  return { spawnId, startTick, endTick };
}

function capacities(
  overrides: {
    readonly available?: number;
    readonly protected?: number;
    readonly cpu?: number;
    readonly spawns?: BudgetLedgerCapacity["spawns"];
  } = {},
): BudgetLedgerCapacity {
  return {
    energy: [
      {
        colonyId: "W1N1",
        available: overrides.available ?? 0,
        protected: overrides.protected ?? 0,
      },
    ],
    cpu: overrides.cpu ?? 0,
    spawns: overrides.spawns ?? [],
  };
}
