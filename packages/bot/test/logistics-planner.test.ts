import { describe, expect, it } from "vitest";
import {
  MAX_ADMITTED_LOGISTICS_FLOWS,
  MAX_LOGISTICS_BODY_PARTS,
  MAX_LOGISTICS_EDGES,
  MAX_LOGISTICS_NODES,
  planLogistics,
} from "../src/logistics";
import type { LogisticsEdge, LogisticsNode, LogisticsPlanningInput } from "../src/logistics";

const node = (
  id: string,
  kind: LogisticsNode["kind"],
  overrides: Partial<LogisticsNode> = {},
): LogisticsNode => ({
  id,
  colonyId: "W1N1",
  resourceType: "energy",
  kind,
  observedAmount: kind === "sink" ? 0 : 100,
  freeCapacity: kind === "source" ? 0 : 100,
  observedAt: 100,
  priority: { class: "normal", deadline: 200 },
  position: { roomName: "W1N1", x: 10, y: 10 },
  ...overrides,
});

const edge = (
  id: string,
  sourceNodeId: string,
  sinkNodeId: string,
  overrides: Partial<LogisticsEdge> = {},
): LogisticsEdge => ({ id, sourceNodeId, sinkNodeId, roundTripTicks: 20, ...overrides });

const plan = (
  nodes: readonly LogisticsNode[],
  edges: readonly LogisticsEdge[],
  overrides: Partial<LogisticsPlanningInput> = {},
) =>
  planLogistics({ nodes, edges, tick: 100, maximumNodeAge: 5, planningHorizon: 100, ...overrides });

describe("LogisticsPlanner", () => {
  it("admits competing sinks and sources without reserving either side twice", () => {
    const result = plan(
      [
        node("source-a", "source", { observedAmount: 80 }),
        node("source-b", "source", { observedAmount: 70 }),
        node("sink-a", "sink", { freeCapacity: 100 }),
        node("sink-b", "sink", { freeCapacity: 30 }),
      ],
      [
        edge("a", "source-a", "sink-a"),
        edge("b", "source-b", "sink-a"),
        edge("c", "source-b", "sink-b"),
      ],
    );
    expect(result.projections.map(({ id, admittedAmount }) => [id, admittedAmount])).toEqual([
      ["a", 80],
      ["b", 20],
      ["c", 30],
    ]);
    expect(result.reservations).toEqual([
      { nodeId: "sink-a", sourceAmount: 0, sinkCapacity: 100 },
      { nodeId: "sink-b", sourceAmount: 0, sinkCapacity: 30 },
      { nodeId: "source-a", sourceAmount: 80, sinkCapacity: 0 },
      { nodeId: "source-b", sourceAmount: 50, sinkCapacity: 0 },
    ]);
  });

  it("admits mandatory pressure first and allows partial capacity", () => {
    const result = plan(
      [
        node("source", "source", { observedAmount: 75 }),
        node("normal", "sink", { freeCapacity: 60, priority: { class: "normal", deadline: 110 } }),
        node("mandatory", "sink", {
          freeCapacity: 50,
          priority: { class: "mandatory", deadline: 150 },
        }),
      ],
      [edge("normal-flow", "source", "normal"), edge("mandatory-flow", "source", "mandatory")],
    );
    expect(result.projections.map(({ id, admittedAmount }) => [id, admittedAmount])).toEqual([
      ["mandatory-flow", 50],
      ["normal-flow", 25],
    ]);
  });

  it("blocks stale, vanished, invalid, empty, and full nodes", () => {
    const result = plan(
      [
        node("stale", "source", { observedAt: 94 }),
        node("empty", "source", { observedAmount: 0 }),
        node("invalid", "source", { observedAmount: -1 }),
        node("sink", "sink"),
        node("full", "sink", { freeCapacity: 0 }),
      ],
      [
        edge("stale", "stale", "sink"),
        edge("vanished", "gone", "sink"),
        edge("invalid", "invalid", "sink"),
        edge("empty", "empty", "sink"),
        edge("full", "stale", "full"),
      ],
    );
    expect(result.projections.map(({ id, blocker }) => [id, blocker])).toEqual([
      ["empty", "empty-source"],
      ["full", "stale-node"],
      ["invalid", "invalid-node"],
      ["stale", "stale-node"],
      ["vanished", "vanished-node"],
    ]);
  });

  it("is canonical regardless of node and edge insertion order", () => {
    const nodes = [
      node("s2", "source"),
      node("t2", "sink"),
      node("s1", "source"),
      node("t1", "sink"),
    ];
    const edges = [edge("b", "s2", "t2"), edge("a", "s1", "t1")];
    expect(plan(nodes, edges)).toEqual(plan([...nodes].reverse(), [...edges].reverse()));
  });

  it("enforces node, edge, and admitted-flow hard caps", () => {
    const nodeCap = plan(
      Array.from({ length: MAX_LOGISTICS_NODES + 1 }, (_, index) =>
        node(`n${String(index).padStart(3, "0")}`, "source"),
      ),
      [],
    );
    expect(nodeCap.blockers.filter((item) => item.reason === "node-cap")).toHaveLength(1);

    const edgeCap = plan(
      [
        node("source", "source", { observedAmount: 100_000 }),
        node("sink", "sink", { freeCapacity: 100_000 }),
      ],
      Array.from({ length: MAX_LOGISTICS_EDGES + 1 }, (_, index) =>
        edge(`e${String(index).padStart(3, "0")}`, "source", "sink", { maximumAmount: 1 }),
      ),
    );
    expect(edgeCap.projections).toHaveLength(MAX_LOGISTICS_EDGES);
    expect(edgeCap.blockers.filter((item) => item.reason === "edge-cap")).toHaveLength(1);
    expect(edgeCap.projections.filter((item) => item.admittedAmount > 0)).toHaveLength(
      MAX_ADMITTED_LOGISTICS_FLOWS,
    );
    expect(edgeCap.blockers.filter((item) => item.reason === "flow-cap")).toHaveLength(
      MAX_LOGISTICS_EDGES - MAX_ADMITTED_LOGISTICS_FLOWS,
    );
  });

  it("converges body recommendations and respects useful-flow and 50-part bounds", () => {
    const small = plan(
      [
        node("source", "source", { observedAmount: 500 }),
        node("sink", "sink", { freeCapacity: 500 }),
      ],
      [edge("flow", "source", "sink", { roundTripTicks: 20 })],
      { planningHorizon: 100 },
    );
    expect(small.recommendations).toEqual([
      { colonyId: "W1N1", carry: 2, move: 2, admittedAmount: 500 },
    ]);

    const saturated = plan(
      [
        node("source", "source", { observedAmount: 100_000 }),
        node("sink", "sink", { freeCapacity: 100_000 }),
      ],
      [edge("flow", "source", "sink", { roundTripTicks: 1_000 })],
      { planningHorizon: 100 },
    );
    expect(saturated.recommendations[0]).toMatchObject({ carry: 25, move: 25 });
    expect(
      (saturated.recommendations[0]?.carry ?? 0) + (saturated.recommendations[0]?.move ?? 0),
    ).toBe(MAX_LOGISTICS_BODY_PARTS);
  });

  it("separates resources and colonies", () => {
    const result = plan(
      [
        node("energy", "source"),
        node("mineral-sink", "sink", { resourceType: "H" }),
        node("other-sink", "sink", { colonyId: "W2N2" }),
      ],
      [edge("resource", "energy", "mineral-sink"), edge("colony", "energy", "other-sink")],
    );
    expect(result.projections.map(({ id, blocker }) => [id, blocker])).toEqual([
      ["colony", "wrong-colony"],
      ["resource", "resource-mismatch"],
    ]);
  });

  it("returns only data projections, reservations, blockers, and body recommendations", () => {
    const result = plan(
      [node("source", "source"), node("sink", "sink")],
      [edge("flow", "source", "sink")],
    );
    expect(Object.keys(result).sort()).toEqual([
      "blockers",
      "projections",
      "recommendations",
      "reservations",
    ]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "WorkContract",
      "contract",
      "command",
      "population",
      "demand",
      "telemetry",
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
