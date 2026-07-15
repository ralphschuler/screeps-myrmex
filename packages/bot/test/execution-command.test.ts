import { describe, expect, it, vi } from "vitest";
import {
  createIntentChannel,
  executeAcceptedIntentBatch,
  normalizeScreepsReturnCode,
  projectReconciliation,
  type CacheInvalidationRequest,
  type CommandBatchRequest,
} from "../src/execution";

type TestCommand = {
  readonly actorId: string;
  readonly action: "move";
};

describe("command execution", () => {
  it("normalizes a legal Screeps command failure as result data", () => {
    const issue = vi.fn(() => -9);
    const results = executeCommands({
      tick: 100,
      commands: [{ intentId: "move:1", command: { actorId: "creep:1", action: "move" } }],
      adapter: { issue },
    });

    expect(issue).toHaveBeenCalledOnce();
    expect(results).toEqual([
      {
        intentId: "move:1",
        tick: 100,
        command: { actorId: "creep:1", action: "move" },
        status: "rejected",
        reason: "ERR_NOT_IN_RANGE",
        returnCode: -9,
        cpuUsed: 0,
        outcome: { state: "game-rejected", code: -9, name: "ERR_NOT_IN_RANGE" },
      },
    ]);
  });

  it("captures adapter exceptions and still returns exactly one result for every command", () => {
    const results = executeCommands({
      tick: 101,
      commands: [
        { intentId: "one", command: { actorId: "creep:1", action: "move" } },
        { intentId: "two", command: { actorId: "creep:2", action: "move" } },
      ],
      adapter: {
        issue(command) {
          if (command.actorId === "creep:1") {
            throw new Error("adapter unavailable");
          }
          return 0;
        },
      },
    });

    expect(results).toHaveLength(2);
    expect(results.map(({ intentId, status }) => [intentId, status])).toEqual([
      ["one", "failed"],
      ["two", "executed"],
    ]);
    expect(results[0]?.outcome).toMatchObject({
      state: "adapter-fault",
      error: "Error: adapter unavailable",
    });
  });

  it("rejects unknown adapter codes without confusing them with game failures", () => {
    expect(normalizeScreepsReturnCode(-13)).toEqual({
      state: "invalid-return-code",
      code: -13,
      name: null,
    });
    expect(normalizeScreepsReturnCode(Number.NaN)).toEqual({
      state: "invalid-return-code",
      code: null,
      name: null,
    });
  });

  it("never issues rejected or deferred intents through the public executor", () => {
    const channel = createIntentChannel({
      maximumSubmitted: 2,
      maximumAccepted: 2,
      maximumBudget: 2,
      overloadPolicy: "reject",
    });
    const producerScope = channel.openProducer("test.command-planner");
    for (const [id, value] of [
      ["winner", 2],
      ["loser", 1],
    ] as const) {
      producerScope.producer.submit({
        id,
        kind: "test-command",
        issuer: "test",
        tick: 102,
        target: "creep:1",
        snapshotRevision: "world:test",
        exclusiveResourceKey: "actor:creep:1",
        priority: { class: "survival", value },
        deadline: 102,
        budget: { id: "test", cost: 1 },
        preconditions: [],
        payload: { actorId: "creep:1", action: "move" },
      });
    }
    producerScope.stage().commit();
    const arbitration = channel.arbiter.arbitrate({
      tick: 102,
      snapshotRevision: "world:test",
    });
    const issued: string[] = [];

    const results = executeAcceptedIntentBatch({
      tick: 102,
      arbitration,
      commandFor: (intent) => intent.payload as TestCommand,
      adapter: {
        issue(command) {
          issued.push(command.actorId);
          return 0;
        },
      },
    });

    expect(arbitration.decisions.find(({ intent }) => intent.id === "loser")).toMatchObject({
      status: "rejected",
    });
    expect(issued).toEqual(["creep:1"]);
    expect(results.map(({ intentId }) => intentId)).toEqual(["winner"]);
  });

  it("projects result-driven deltas and invalidations without a persistence capability", () => {
    const [result] = executeCommands({
      tick: 102,
      commands: [{ intentId: "move:3", command: { actorId: "creep:3", action: "move" } }],
      adapter: { issue: () => 0 },
    });
    if (result === undefined) {
      throw new Error("test command did not produce a result");
    }
    const invalidation: CacheInvalidationRequest = {
      namespace: "paths",
      key: "creep:3",
      sourceIntentId: result.intentId,
      reason: "move-scheduled",
    };

    const projections = projectReconciliation([result], {
      fromResult: (commandResult) => ({
        intentId: commandResult.intentId,
        delta: { lastMoveTick: commandResult.tick },
        cacheInvalidations: [invalidation],
      }),
    });

    expect(projections).toEqual([
      {
        intentId: "move:3",
        delta: { lastMoveTick: 102 },
        cacheInvalidations: [invalidation],
      },
    ]);
    expect(projections[0]).not.toHaveProperty("commit");
    expect(projections[0]).not.toHaveProperty("memory");
  });
});

function executeCommands(
  request: CommandBatchRequest<TestCommand>,
): ReturnType<typeof executeAcceptedIntentBatch<TestCommand>> {
  const channel = createIntentChannel({
    maximumSubmitted: request.commands.length,
    maximumAccepted: request.commands.length,
    maximumBudget: request.commands.length,
    overloadPolicy: "reject",
  });
  const producerScope = channel.openProducer("test.command-planner");
  for (const { intentId, command } of request.commands) {
    producerScope.producer.submit({
      id: intentId,
      kind: "test-command",
      issuer: "test",
      tick: request.tick,
      target: command.actorId,
      snapshotRevision: "world:test",
      exclusiveResourceKey: `actor:${command.actorId}`,
      priority: { class: "survival", value: 0 },
      deadline: request.tick,
      budget: { id: "test", cost: 1 },
      preconditions: [],
      payload: command,
    });
  }
  producerScope.stage().commit();
  const arbitration = channel.arbiter.arbitrate({
    tick: request.tick,
    snapshotRevision: "world:test",
  });
  return executeAcceptedIntentBatch({
    tick: request.tick,
    arbitration,
    commandFor: (intent) => intent.payload as TestCommand,
    adapter: request.adapter,
    ...(request.cpu === undefined ? {} : { cpu: request.cpu }),
  });
}
