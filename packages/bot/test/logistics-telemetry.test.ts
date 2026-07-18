import { describe, expect, it } from "vitest";
import { runTick } from "../src/runtime/tick";
import {
  MAX_LOGISTICS_TELEMETRY_FLOWS,
  reduceLogisticsTelemetry,
  TelemetryService,
  type LogisticsFlowObservation,
  type LogisticsTelemetryState,
} from "../src/telemetry";

describe("logistics telemetry reducer", () => {
  it("reports current demand and reset-safe settled deltas with weighted latency", () => {
    const initial = reduceLogisticsTelemetry({
      tick: 100,
      cpuUsed: 0.2,
      observations: [flow("b", 80, 50), flow("a", 50, 50)],
    });
    expect(initial.telemetry).toMatchObject({
      activeFlows: 2,
      activeContracts: 2,
      requested: 130,
      scheduled: 100,
      pickedUp: 0,
      delivered: 0,
      shortfall: 30,
      loss: 0,
      latencyTicks: null,
      cpuUsed: 0.2,
    });

    const next = reduceLogisticsTelemetry({
      tick: 105,
      cpuUsed: 0.3,
      previous: JSON.parse(JSON.stringify(initial.state)) as LogisticsTelemetryState,
      observations: [
        { ...flow("a", 50, 50), pickedUp: 50, delivered: 20 },
        { ...flow("b", 80, 50), pickedUp: 50, delivered: 10, loss: 5 },
      ],
    });
    expect(next.telemetry).toMatchObject({
      pickedUp: 100,
      delivered: 30,
      loss: 5,
      latencyTicks: 5,
    });

    const unchanged = reduceLogisticsTelemetry({
      tick: 106,
      cpuUsed: 0.1,
      previous: next.state,
      observations: next.state.flows,
    });
    expect(unchanged.telemetry).toMatchObject({
      pickedUp: 0,
      delivered: 0,
      loss: 0,
      latencyTicks: null,
    });
  });

  it("canonicalizes duplicate/reordered flows before applying the hard bound", () => {
    const observations = Array.from({ length: MAX_LOGISTICS_TELEMETRY_FLOWS + 2 }, (_, index) =>
      flow(`flow-${String(index).padStart(3, "0")}`, 50, 50),
    );
    const first = observations[0];
    const second = observations[1];
    if (first === undefined || second === undefined) throw new Error("expected flow fixtures");
    const left = reduceLogisticsTelemetry({
      tick: 200,
      cpuUsed: 0,
      maximumFlows: 2,
      observations: [second, first, first, ...observations.slice(2)],
    });
    const right = reduceLogisticsTelemetry({
      tick: 200,
      cpuUsed: 0,
      maximumFlows: 2,
      observations: [...observations].reverse(),
    });
    expect(left).toEqual(right);
    expect(left.telemetry.flows.map(({ flowId }) => flowId)).toEqual(["flow-000", "flow-001"]);
    expect(left.telemetry).toMatchObject({ observedFlows: 2, droppedFlows: 64 });
    expect(Object.isFrozen(left.telemetry.flows)).toBe(true);
  });

  it("rejects malformed quantities and CPU rather than publishing misleading evidence", () => {
    expect(() =>
      reduceLogisticsTelemetry({
        tick: 1,
        cpuUsed: Number.NaN,
        observations: [],
      }),
    ).toThrow(/CPU/u);
    expect(() =>
      reduceLogisticsTelemetry({
        tick: 1,
        cpuUsed: 0,
        observations: [{ ...flow("a", 50, 50), delivered: -1 }],
      }),
    ).toThrow(/safe integer/u);
  });
});

describe("TelemetryService logistics persistence", () => {
  it("migrates the owner, restores flow deltas, and trims flow samples to its byte budget", () => {
    const outcome = runTick({ game: game(300), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const {
      activity: _activity,
      logistics: _logistics,
      recoveryProgress: _recoveryProgress,
      reporterTransitions: _reporterTransitions,
      status: _status,
      ...base
    } = telemetry;
    void _activity;
    void _logistics;
    void _recoveryProgress;
    void _reporterTransitions;
    void _status;
    const input = {
      base: {
        ...base,
        telemetryPolicy: { ...base.telemetryPolicy, maximumHistoryBytes: 2_000 },
      },
      colony: outcome.colony,
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      staticMining: { cpuUsed: 0, observations: [] },
      logistics: {
        cpuUsed: 1,
        observations: Array.from({ length: 64 }, (_, index) => ({
          ...flow(`flow-${String(index).padStart(3, "0")}`, 50, 50),
          firstRequestedAt: 300,
        })),
      },
      reporterSignals: [],
    } as const;
    const service = new TelemetryService();
    const first = service.record({}, input);
    expect(first.owner).toMatchObject({
      schemaVersion: 5,
      logistics: { schemaVersion: 1 },
    });
    expect(JSON.stringify(first.owner).length).toBeLessThanOrEqual(2_000);
    const retained = (first.owner.logistics as unknown as { flows: unknown[] }).flows.length;
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(64);

    const next = service.record(first.owner, {
      ...input,
      base: { ...input.base, tick: 301 },
      logistics: {
        cpuUsed: 0.5,
        observations: input.logistics.observations.map((observation) => ({
          ...observation,
          pickedUp: 50,
          delivered: 50,
          active: false,
        })),
      },
    });
    expect(next.telemetry.logistics).toMatchObject({
      cpuUsed: 0.5,
      pickedUp: retained * 50,
      delivered: retained * 50,
      latencyTicks: 1,
    });
  });
});

function flow(flowId: string, requested: number, scheduled: number): LogisticsFlowObservation {
  return {
    flowId,
    contractId: `contract-${flowId}`,
    requested,
    scheduled,
    pickedUp: 0,
    delivered: 0,
    loss: 0,
    firstRequestedAt: 100,
    active: true,
  };
}

function game(time: number) {
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}
