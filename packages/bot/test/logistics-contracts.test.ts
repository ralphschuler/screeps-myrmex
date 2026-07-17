import { describe, expect, it } from "vitest";
import {
  projectLogisticsContracts,
  type LogisticsCommitmentProjection,
  type LogisticsCommitmentState,
  type LogisticsContractProjectionInput,
} from "../src/logistics";

const node = (id: string, kind: "source" | "sink", mandatory = true) => ({
  id,
  colonyId: "W1N1",
  resourceType: "energy",
  kind,
  observedAmount: kind === "source" ? 100 : 0,
  freeCapacity: kind === "sink" ? 100 : 0,
  observedAt: 10,
  priority: { class: mandatory ? ("mandatory" as const) : ("normal" as const), deadline: 20 },
  position: { roomName: "W1N1", x: kind === "source" ? 10 : 20, y: 10 },
});
const base = (
  change: Partial<LogisticsContractProjectionInput> = {},
): LogisticsContractProjectionInput => ({
  tick: 10,
  nodes: [node("source", "source"), node("sink", "sink")],
  endpoints: [
    {
      nodeId: "source",
      targetId: "drop-1",
      acquireAction: "pickup",
      resourceType: "energy",
      observedAmount: 100,
      freeCapacity: 0,
      observedAt: 10,
      position: { roomName: "W1N1", x: 10, y: 10 },
    },
    {
      nodeId: "sink",
      targetId: "spawn-1",
      resourceType: "energy",
      observedAmount: 0,
      freeCapacity: 100,
      observedAt: 10,
      position: { roomName: "W1N1", x: 20, y: 10 },
    },
  ],
  plan: {
    blockers: [],
    projections: [
      {
        id: "flow",
        colonyId: "W1N1",
        resourceType: "energy",
        sourceNodeId: "source",
        sinkNodeId: "sink",
        admittedAmount: 80,
        roundTripTicks: 20,
        blocker: null,
      },
    ],
    reservations: [
      { nodeId: "source", sourceAmount: 80, sinkCapacity: 0 },
      { nodeId: "sink", sourceAmount: 0, sinkCapacity: 80 },
    ],
    recommendations: [{ colonyId: "W1N1", carry: 2, move: 2, admittedAmount: 80 }],
  },
  previous: [],
  progress: [],
  ...change,
});

describe("logistics contract projection", () => {
  it("is reset stable, deduplicated, resource-specific, and capped to planner admission", () => {
    const first = projectLogisticsContracts(base());
    const state = first.commitments.map(durableState);
    const reset = projectLogisticsContracts(
      JSON.parse(JSON.stringify(base({ previous: state }))) as LogisticsContractProjectionInput,
    );
    expect(reset.commitments[0]?.request).toEqual(first.commitments[0]?.request);
    expect(first.commitments[0]?.request?.quantity).toBe(80);
    expect(first.commitments[0]?.request?.execution).toMatchObject({
      action: "pickup",
      flowId: "flow",
      resourceType: "energy",
      reservedAmount: 80,
      stage: "acquire",
    });
    expect(
      projectLogisticsContracts(
        base({
          previous: [state[0] as LogisticsCommitmentState, state[0] as LogisticsCommitmentState],
        }),
      ).commitments,
    ).toEqual([]);
  });

  it("moves acquire to partial delivery and starts a bounded next cycle", () => {
    const first = projectLogisticsContracts(base()).commitments[0];
    if (first === undefined) throw new Error("expected acquire commitment");
    const prior = durableState(first);
    const deliver = projectLogisticsContracts(
      base({
        previous: [prior],
        progress: [{ flowId: "flow", actorState: "alive", cargoAmount: 30, deliveredAmount: 0 }],
      }),
    );
    expect(deliver.commitments[0]?.request?.execution).toMatchObject({
      action: "transfer",
      reservedAmount: 80,
      stage: "deliver",
    });
    expect(deliver.retirements).toHaveLength(1);
    const deliveredCommitment = deliver.commitments[0];
    if (deliveredCommitment === undefined) throw new Error("expected deliver commitment");
    const deliverState = durableState(deliveredCommitment);
    const partial = projectLogisticsContracts(
      base({
        previous: [deliverState],
        progress: [{ flowId: "flow", actorState: "alive", cargoAmount: 0, deliveredAmount: 30 }],
      }),
    );
    expect(partial.commitments[0]).toMatchObject({
      cycle: 1,
      cycleAmount: 50,
      deliveredAmount: 30,
      stage: "acquire",
    });
    expect(partial.commitments[0]?.request?.quantity).toBe(50);
  });

  it.each([
    [
      "source vanished",
      { endpoints: base().endpoints.filter(({ nodeId }) => nodeId !== "source") },
      "source-vanished",
    ],
    [
      "source empty",
      {
        endpoints: base().endpoints.map((endpoint) =>
          endpoint.nodeId === "source" ? { ...endpoint, observedAmount: 0 } : endpoint,
        ),
      },
      "source-empty",
    ],
    [
      "resource mismatch",
      {
        endpoints: base().endpoints.map((endpoint) =>
          endpoint.nodeId === "source" ? { ...endpoint, resourceType: "H" } : endpoint,
        ),
      },
      "resource-mismatch",
    ],
  ] as const)("suspends when %s", (_label, change, reason) => {
    expect(projectLogisticsContracts(base(change)).commitments[0]).toMatchObject({
      reason,
      request: null,
    });
  });

  it("suspends full or vanished delivery targets without ghost cargo", () => {
    const acquired = projectLogisticsContracts(base()).commitments[0];
    if (acquired === undefined) throw new Error("expected acquire commitment");
    const acquire = durableState(acquired);
    for (const endpoints of [
      base().endpoints.map((endpoint) =>
        endpoint.nodeId === "sink" ? { ...endpoint, freeCapacity: 0 } : endpoint,
      ),
      base().endpoints.filter(({ nodeId }) => nodeId !== "sink"),
    ]) {
      const result = projectLogisticsContracts(
        base({
          endpoints,
          previous: [acquire],
          progress: [{ flowId: "flow", actorState: "alive", cargoAmount: 20, deliveredAmount: 0 }],
        }),
      );
      expect(result.commitments[0]?.request).toBeNull();
    }
  });

  it("reacquires after actor death and renews the same identity after lease expiry", () => {
    const first = projectLogisticsContracts(base()).commitments[0];
    if (first?.request === null || first === undefined) throw new Error("expected acquire request");
    const prior = durableState(first);
    const expired = projectLogisticsContracts(
      base({
        previous: [prior],
        progress: [
          { flowId: "flow", actorState: "lease-expired", cargoAmount: 0, deliveredAmount: 0 },
        ],
      }),
    );
    expect(expired.commitments[0]?.request?.issuerKey).toBe(first.request.issuerKey);
    const carrying = { ...prior, stage: "deliver" as const };
    const dead = projectLogisticsContracts(
      base({
        previous: [carrying],
        progress: [{ flowId: "flow", actorState: "dead", cargoAmount: 0, deliveredAmount: 0 }],
      }),
    );
    expect(dead.commitments[0]).toMatchObject({ cycle: 1, reason: "actor-dead", stage: "acquire" });
    expect(dead.commitments[0]?.request?.quantity).toBe(80);
  });

  it("gives mandatory flows the bounded planner slots and emits no non-goal commands", () => {
    const optional = node("optional", "sink", false);
    const result = projectLogisticsContracts(
      base({
        nodes: [...base().nodes, optional],
        endpoints: [
          ...base().endpoints,
          { ...required(base().endpoints[1]), nodeId: "optional", targetId: "storage-1" },
        ],
        plan: {
          ...base().plan,
          projections: [
            ...base().plan.projections,
            {
              ...required(base().plan.projections[0]),
              id: "optional-flow",
              sinkNodeId: "optional",
              admittedAmount: 20,
            },
          ],
          recommendations: [{ colonyId: "W1N1", carry: 1, move: 1, admittedAmount: 100 }],
        },
      }),
    );
    expect(result.commitments.find(({ flowId }) => flowId === "flow")?.recommendedCarry).toBe(1);
    expect(
      result.commitments.find(({ flowId }) => flowId === "optional-flow")?.recommendedCarry,
    ).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/link|terminal|repair|send|command/);
  });
});

function durableState(commitment: LogisticsCommitmentProjection): LogisticsCommitmentState {
  const { request: _request, reason: _reason, ...state } = commitment;
  void _request;
  void _reason;
  return state;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required logistics fixture value is missing");
  return value;
}
