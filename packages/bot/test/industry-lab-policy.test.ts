import { describe, expect, it } from "vitest";
import type { LabClusterAssignment, ReactionCatalog } from "../src/industry/lab-cluster";
import {
  LAB_POLICY_CAPS,
  reconcileLabPolicy,
  selectForwardReaction,
  type BoostManifest,
  type LabPolicyRoomObservation,
  type ReactionObjective,
  type ReconcileLabPolicyInput,
} from "../src/industry/lab-policy";
import type { LabResourceDemandDisposition } from "../src/logistics/resource-demands";

const ASSIGNMENT: LabClusterAssignment = {
  boostLabIds: ["lab-c"],
  fingerprint: "lab-cluster-v1:one",
  layoutFingerprint: "layout-v1",
  productLabIds: ["lab-c"],
  reagentLabIds: ["lab-a", "lab-b"],
  roomName: "W1N1",
};

const CATALOG: ReactionCatalog = {
  fingerprint: "catalog-v1",
  recipes: [
    { cooldown: 20, product: "OH", reagents: ["H", "O"] },
    { cooldown: 10, product: "UH", reagents: ["H", "U"] },
    { cooldown: 5, product: "UH2O", reagents: ["OH", "UH"] },
    { cooldown: 60, product: "XUH2O", reagents: ["UH2O", "X"] },
  ],
};

describe("bounded lab policy", () => {
  it("selects the canonical deepest missing forward dependency and emits per-demand budgets", () => {
    const result = reconcile({ reactionObjectives: [reaction()] });

    expect(result.commitments).toEqual([
      expect.objectContaining({
        batchAmount: 300,
        kind: "reaction",
        product: "UH",
        reagents: ["H", "U"],
        targetProduct: "XUH2O",
      }),
    ]);
    expect(result.demands.map(({ id, resourceType }) => [id, resourceType])).toEqual([
      ["lab-policy:reaction:r1:reagent-a", "H"],
      ["lab-policy:reaction:r1:reagent-b", "U"],
    ]);
    expect(result.budgets.map(({ identity }) => identity)).toEqual([
      "industry:reaction/demand/reagent-a",
      "industry:reaction/demand/reagent-b",
    ]);
    expect(result.dispositions).toEqual([
      expect.objectContaining({ objectiveId: "reaction", status: "staging" }),
    ]);
  });

  it("preempts a discretionary reaction with one funded exact boost group", () => {
    const result = reconcile({
      boostManifests: [boost()],
      reactionObjectives: [reaction({ priority: 999 })],
    });

    expect(result.commitments).toEqual([
      expect.objectContaining({
        compound: "XUH2O",
        kind: "boost",
        partCount: 3,
        partType: "attack",
        settledParts: 1,
      }),
    ]);
    expect(result.demands.map(({ amount, resourceType }) => [amount, resourceType])).toEqual([
      [60, "XUH2O"],
      [40, "energy"],
    ]);
    expect(result.dispositions).toEqual([
      expect.objectContaining({ objectiveId: "boost", status: "staging" }),
      expect.objectContaining({
        objectiveId: "reaction",
        reason: "preempted",
        status: "cancelled",
      }),
    ]);
  });

  it("becomes data-only ready when every #251 demand is satisfied", () => {
    const first = reconcile({ boostManifests: [boost()] });
    const stagingDispositions = first.demands.map(
      ({ id, revision, resourceType }): LabResourceDemandDisposition => ({
        demandId: id,
        effectiveMode: "fill",
        effectiveResourceType: resourceType,
        remainingAmount: 0,
        revision,
        status: "satisfied",
      }),
    );
    const ready = reconcile({
      boostManifests: [boost()],
      commitments: first.commitments,
      stagingDispositions,
    });

    expect(ready.dispositions).toEqual([
      expect.objectContaining({ blockers: [], status: "ready" }),
    ]);
    expect(JSON.stringify(ready)).not.toMatch(/command|contract|intent|telemetry/);
  });

  it("completes from observed target stock or exact observed boost parts", () => {
    const reactionComplete = reconcile({
      reactionObjectives: [reaction()],
      rooms: [room({ stocks: [{ amount: 300, protectedAmount: 0, resourceType: "XUH2O" }] })],
    });
    const boostComplete = reconcile({
      boostManifests: [boost({ partCount: 1 })],
    });

    expect(reactionComplete).toMatchObject({ commitments: [], demands: [] });
    expect(reactionComplete.dispositions[0]).toMatchObject({ status: "completed" });
    expect(boostComplete.dispositions[0]).toMatchObject({ status: "completed" });
  });

  it("does not infer reaction settlement from aggregate stock after commitment", () => {
    const first = reconcile({ reactionObjectives: [reaction()] });
    const replay = reconcile({
      commitments: first.commitments,
      reactionObjectives: [reaction()],
      rooms: [room({ stocks: [{ amount: 300, protectedAmount: 0, resourceType: "XUH2O" }] })],
    });

    expect(replay.dispositions[0]).toMatchObject({ status: "staging" });
    expect(replay.commitments).toHaveLength(1);
  });

  it("drains the exact observed product-lab contaminant through normal logistics", () => {
    const result = reconcile({
      reactionObjectives: [reaction()],
      rooms: [room({ labs: labs({ productMineral: "O", productAmount: 125 }) })],
    });

    expect(result.demands).toContainEqual(
      expect.objectContaining({
        amount: 125,
        id: "lab-policy:reaction:r1:product-0",
        mode: "drain",
        priority: "normal",
        resourceType: "O",
      }),
    );
  });

  it("fails closed for deadlines, lost creeps, changed fingerprints, and staging failure", () => {
    expect(reconcile({ boostManifests: [boost({ deadline: 99 })] }).dispositions[0]).toMatchObject({
      reason: "expired-deadline",
      status: "cancelled",
    });
    expect(
      reconcile({ boostManifests: [boost()], rooms: [room({ creeps: [] })] }).dispositions[0],
    ).toMatchObject({ reason: "lost-creep" });

    const first = reconcile({ reactionObjectives: [reaction()] });
    const changed = reconcile({
      commitments: first.commitments,
      reactionObjectives: [reaction()],
      rooms: [
        room({
          assignment: { ...ASSIGNMENT, fingerprint: "lab-cluster-v1:changed" },
        }),
      ],
    });
    expect(changed.dispositions[0]).toMatchObject({ reason: "cluster-changed" });

    const blocked = reconcile({
      reactionObjectives: [reaction()],
      stagingDispositions: [
        {
          demandId: "lab-policy:reaction:r1:reagent-a",
          effectiveMode: "fill",
          effectiveResourceType: "H",
          remainingAmount: 300,
          revision: 1,
          status: "blocked",
        },
      ],
    });
    expect(blocked.dispositions[0]).toMatchObject({ reason: "staging-failed" });
  });

  it("rejects duplicate identities and global caps without selecting a winner", () => {
    const duplicate = reconcile({ reactionObjectives: [reaction(), reaction()] });
    expect(duplicate.commitments).toEqual([]);
    expect(duplicate.dispositions).toEqual([
      expect.objectContaining({ reason: "duplicate-identity", status: "cancelled" }),
    ]);

    const overflow = reconcile({
      reactionObjectives: Array.from(
        { length: LAB_POLICY_CAPS.maximumObjectives + 1 },
        (_, index) => reaction({ id: `reaction-${String(index)}` }),
      ),
    });
    expect(overflow).toMatchObject({ commitments: [], demands: [], dispositions: [] });
    expect(overflow.blockers).toEqual([{ identity: "input", reason: "cap-exceeded" }]);
  });

  it("is byte-stable across reordered inputs, clones, and heap reset", () => {
    const objectives = [reaction({ id: "z", priority: 1 }), reaction({ id: "a", priority: 2 })];
    const first = reconcile({ reactionObjectives: objectives });
    const reset = reconcile({
      commitments: roundTrip(first.commitments),
      reactionObjectives: roundTrip([...objectives].reverse()),
      rooms: roundTrip([room()]),
      stagingDispositions: [],
    });

    expect(JSON.stringify(reset)).toBe(JSON.stringify(first));
  });

  it("bounds dependency depth and treats protected stock as unavailable", () => {
    expect(
      selectForwardReaction(
        "XUH2O",
        300,
        CATALOG,
        new Map([
          ["UH", 300],
          ["OH", 300],
        ]),
      )?.recipe.product,
    ).toBe("UH2O");
    const protectedResult = reconcile({
      reactionObjectives: [reaction()],
      rooms: [
        room({
          stocks: [
            { amount: 300, protectedAmount: 0, resourceType: "OH" },
            { amount: 300, protectedAmount: 300, resourceType: "UH" },
          ],
        }),
      ],
    });
    expect(protectedResult.commitments[0]).toMatchObject({ product: "UH" });
  });
});

function reconcile(overrides: Partial<ReconcileLabPolicyInput> = {}) {
  return reconcileLabPolicy({
    boostManifests: [],
    commitments: [],
    reactionObjectives: [],
    rooms: [room()],
    stagingDispositions: [],
    tick: 100,
    ...overrides,
  });
}

function reaction(overrides: Partial<ReactionObjective> = {}): ReactionObjective {
  return {
    amount: 300,
    colonyId: "W1N1",
    deadline: 500,
    funded: true,
    id: "reaction",
    industryBudgetId: "industry:reaction",
    priority: 10,
    product: "XUH2O",
    revision: 1,
    ...overrides,
  };
}

function boost(overrides: Partial<BoostManifest> = {}): BoostManifest {
  return {
    colonyId: "W1N1",
    compound: "XUH2O",
    creepFingerprint: "creep-v1",
    creepId: "creep-1",
    deadline: 200,
    funded: true,
    id: "boost",
    industryBudgetId: "industry:boost",
    partCount: 3,
    partType: "attack",
    priority: 1,
    revision: 1,
    ...overrides,
  };
}

function room(overrides: Partial<LabPolicyRoomObservation> = {}): LabPolicyRoomObservation {
  return {
    assignment: ASSIGNMENT,
    catalog: CATALOG,
    colonyId: "W1N1",
    creeps: [
      {
        body: [
          { boost: "XUH2O", type: "attack" },
          { boost: null, type: "attack" },
          { boost: null, type: "attack" },
          { boost: null, type: "move" },
        ],
        fingerprint: "creep-v1",
        id: "creep-1",
      },
    ],
    endpointId: "storage",
    labs: labs(),
    stocks: [
      { amount: 300, protectedAmount: 0, resourceType: "OH" },
      { amount: 0, protectedAmount: 0, resourceType: "UH" },
    ],
    ...overrides,
  };
}

function labs(options: { productAmount?: number; productMineral?: string | null } = {}) {
  return [
    { active: true, id: "lab-a", mineralAmount: 0, mineralType: null },
    { active: true, id: "lab-b", mineralAmount: 0, mineralType: null },
    {
      active: true,
      id: "lab-c",
      mineralAmount: options.productAmount ?? 0,
      mineralType: options.productMineral ?? null,
    },
  ];
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
