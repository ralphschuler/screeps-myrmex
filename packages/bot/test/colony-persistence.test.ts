import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/colony/budget-ledger";
import type { BudgetRequest, ColonyRecord } from "../src/colony/contracts";
import { canonicalColoniesOwner, resolveColoniesOwner } from "../src/colony/persistence";

const COLONY: ColonyRecord = {
  roomName: "W1N1",
  state: "developing",
  stateSince: 90,
  revision: 1,
  policyRevision: "policy-1",
  reasonCode: "survival-capability-restored",
};

const REQUEST: BudgetRequest = {
  colonyId: "W1N1",
  category: "replacement",
  issuer: "agents/replacement-1",
  revision: 1,
  expiresAt: 200,
  energy: { minimum: 200, desired: 300 },
  cpu: { minimum: 50, desired: 100 },
  spawn: { spawnId: "spawn-1", startTick: 100, endTick: 109 },
};

describe("colonies owner persistence", () => {
  it("accepts a canonical funded entry across a JSON heap reset", () => {
    const owner = fundedOwner();
    const reset = JSON.parse(JSON.stringify(owner)) as unknown;

    const resolved = resolveColoniesOwner(reset);

    expect(resolved.status).toBe("ready");
    expect(resolved.owner).toEqual(owner);
    expect(Object.isFrozen(resolved.owner)).toBe(true);
    expect(Object.isFrozen(resolved.owner?.ledger[0]?.request)).toBe(true);
  });

  it.each([
    [
      "forged reservation identity",
      (entry: MutableEntry) => {
        entry.reservationId = "reservation/forged";
      },
    ],
    [
      "active grant below its atomic minimum",
      (entry: MutableEntry) => {
        entry.grant.energy = 199;
      },
    ],
    [
      "active grant missing its requested spawn interval",
      (entry: MutableEntry) => {
        entry.grant.spawn = null;
      },
    ],
    [
      "consumed status without complete cumulative consumption",
      (entry: MutableEntry) => {
        entry.status = "consumed";
      },
    ],
    [
      "active status after complete cumulative consumption",
      (entry: MutableEntry) => {
        entry.consumed = { energy: 300, cpu: 100, spawn: true };
      },
    ],
  ])("rejects %s fail-closed", (_label, mutate) => {
    const candidate = JSON.parse(JSON.stringify(fundedOwner())) as MutableOwner;
    const entry = candidate.ledger[0];
    if (entry === undefined) {
      throw new Error("funded owner fixture is missing its ledger entry");
    }
    mutate(entry);

    expect(resolveColoniesOwner(candidate)).toEqual({ status: "malformed", owner: null });
  });

  it("rejects non-data initializers and accessors without invoking them", () => {
    const hidden = {};
    Object.defineProperty(hidden, "secret", { value: true, enumerable: false });
    const getter = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute owner accessors");
      },
    });

    for (const candidate of [new Date(0), hidden, getter, Object.create({ inherited: true })]) {
      expect(resolveColoniesOwner(candidate)).toEqual({ status: "malformed", owner: null });
    }
  });

  it("rejects the first colony beyond the persistent owner cap", () => {
    const colonies = Array.from({ length: 65 }, (_, index) => ({
      ...COLONY,
      roomName: `W${String(index).padStart(2, "0")}N1`,
    }));

    expect(resolveColoniesOwner(canonicalColoniesOwner(1, colonies, []))).toEqual({
      status: "malformed",
      owner: null,
    });
  });
});

function fundedOwner() {
  const result = new BudgetLedger().reconcile({
    tick: 100,
    capacity: {
      energy: [{ colonyId: "W1N1", available: 300, protected: 300 }],
      cpu: 100,
      spawns: [{ colonyId: "W1N1", spawnId: "spawn-1", blocked: [] }],
    },
    requests: [REQUEST],
  });
  return canonicalColoniesOwner(1, [COLONY], result.entries);
}

interface MutableEntry {
  reservationId: string;
  status: string;
  grant: {
    energy: number;
    cpu: number;
    spawn: { spawnId: string; startTick: number; endTick: number } | null;
  };
  consumed: { energy: number; cpu: number; spawn: boolean };
}

interface MutableOwner {
  ledger: MutableEntry[];
}
