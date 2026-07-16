import { describe, expect, it } from "vitest";
import {
  INTENT_PRIORITY_CLASSES,
  createIntentChannel,
  defineIntent,
  type ArbitrationBatch,
  type IntentChannel,
  type IntentEnvelope,
  type IntentPriorityClass,
} from "../src/execution";
import { RuntimeKernel, type CpuSource, type TickSystem } from "../src/runtime/kernel";

type TestPayload = {
  readonly action: string;
};

describe("intent arbitration", () => {
  it("resolves equal-priority conflicts identically when producers are reordered", () => {
    const alpha = makeIntent("intent:a", { exclusiveResourceKey: "creep:alice:action" });
    const beta = makeIntent("intent:b", { exclusiveResourceKey: "creep:alice:action" });

    expect(decide([beta, alpha])).toEqual(decide([alpha, beta]));
    expect(decide([beta, alpha])).toEqual([
      ["intent:a", "accepted", null],
      ["intent:b", "rejected", "exclusive-resource-conflict"],
    ]);
  });

  it("rejects every occurrence of a duplicate id", () => {
    const first = makeIntent("duplicate", { target: "creep:a" });
    const second = makeIntent("duplicate", {
      target: "creep:b",
      exclusiveResourceKey: "creep:b:action",
    });
    const batch = arbitrate([first, second]);

    expect(batch.submitted).toBe(2);
    expect(batch.accepted).toEqual([]);
    expect(batch.decisions).toHaveLength(2);
    expect(batch.decisions.every((decision) => decision.reason === "duplicate-id")).toBe(true);
  });

  it("rejects expired intents at the deadline's exclusive boundary", () => {
    const batch = arbitrate([makeIntent("expired", { deadline: 99 })]);

    expect(batch.decisions).toMatchObject([
      { status: "rejected", reason: "expired", intent: { id: "expired" } },
    ]);
  });

  it("rejects a failed data-only precondition without touching live Game data", () => {
    const conditioned = makeIntent("conditioned", {
      preconditions: [{ key: "actor-owned", expected: true }],
    });
    const channel = createChannel();
    commitIntents(channel, [conditioned]);

    const batch = channel.arbiter.arbitrate({
      tick: 100,
      snapshotRevision: "snapshot:100",
      evaluatePrecondition: (precondition) => ({
        satisfied: false,
        detail: `failed:${precondition.key}`,
      }),
    });

    expect(batch.decisions).toMatchObject([
      {
        status: "rejected",
        reason: "precondition-failed",
        detail: "redacted:precondition-detail:0636a67b",
      },
    ]);
  });

  it("applies its bounded overload policy and produces exactly one result per submission", () => {
    const intents = [
      makeIntent("a", { exclusiveResourceKey: "resource:a", priorityValue: 30 }),
      makeIntent("b", { exclusiveResourceKey: "resource:b", priorityValue: 20 }),
      makeIntent("c", { exclusiveResourceKey: "resource:c", priorityValue: 10 }),
    ];
    const channel = createIntentChannel<"test", TestPayload>({
      maximumSubmitted: intents.length,
      maximumAccepted: 1,
      maximumBudget: 1,
      overloadPolicy: "defer",
    });
    commitIntents(channel, intents);

    const batch = channel.arbiter.arbitrate({ tick: 100, snapshotRevision: "snapshot:100" });

    expect(batch.decisions).toHaveLength(intents.length);
    expect(batch.accepted.map((intent) => intent.id)).toEqual(["a"]);
    expect(batch.decisions.map(({ status, reason }) => [status, reason])).toEqual([
      ["accepted", null],
      ["deferred", "capacity-overload"],
      ["deferred", "capacity-overload"],
    ]);
  });

  it("exposes no producer capability to finalize or drain the append-only buffer", () => {
    const channel = createChannel();
    const scope = channel.openProducer("test-planner");
    const producer = scope.producer as unknown as Record<string, unknown>;

    expect(Object.keys(producer)).toEqual(["submit"]);
    expect(Object.isFrozen(producer)).toBe(true);
    expect(producer).not.toHaveProperty("arbitrate");
    expect(producer).not.toHaveProperty("finalize");
    expect(producer).not.toHaveProperty("drain");
  });

  it("fail-closes a producer that submits several proposals and then fails", () => {
    const channel = createChannel();
    const failedScope = channel.openProducer("planner.faulting");

    expect(() => {
      failedScope.producer.submit(makeIntent("failed:a"));
      failedScope.producer.submit(makeIntent("failed:b"));
      failedScope.producer.submit(makeIntent("failed:c"));
      throw new Error("injected producer fault");
    }).toThrow("injected producer fault");

    commitIntents(channel, [makeIntent("healthy")], "planner.healthy");
    const batch = channel.arbiter.arbitrate({
      tick: 100,
      snapshotRevision: "snapshot:100",
    });

    expect(batch.submitted).toBe(1);
    expect(batch.accepted.map(({ id }) => id)).toEqual(["healthy"]);
    expect(batch.decisions.map(({ intent }) => intent.id)).toEqual(["healthy"]);
    expect(() => failedScope.stage()).toThrow(/only be staged once/u);
  });

  it("isolates a failed planner's private intents across the kernel boundary", () => {
    const channel = createChannel();
    const cpu: CpuSource = {
      bucket: 6_000,
      limit: 20,
      tickLimit: 100,
      getUsed: () => 0,
    };
    let executionBatch: ArbitrationBatch<"test", TestPayload> | null = null;
    let executeTailCommitted = false;
    const systems: readonly TickSystem<Record<string, never>>[] = [
      {
        descriptor: {
          id: "planner.optional",
          phase: "plan",
          criticality: "economic",
          cadence: 1,
          estimate: 0.1,
          admitInRecovery: false,
          mandatoryTail: false,
        },
        run: () => {
          const scope = channel.openProducer("planner.optional");
          scope.producer.submit(makeIntent("failed:one"));
          scope.producer.submit(makeIntent("failed:two"));
          throw new Error("injected planner failure");
        },
      },
      {
        descriptor: {
          id: "execution.mandatory-tail",
          phase: "execute",
          criticality: "mandatory",
          cadence: 1,
          estimate: 0.1,
          admitInRecovery: true,
          mandatoryTail: true,
        },
        run: () => {
          const batch = channel.arbiter.arbitrate({
            tick: 100,
            snapshotRevision: "snapshot:100",
          });
          return {
            commit: () => {
              executionBatch = batch;
              executeTailCommitted = true;
            },
          };
        },
      },
    ];

    const report = new RuntimeKernel(systems).run({
      tick: 100,
      context: {},
      cpu,
      inputRevision: "snapshot:100",
    });

    expect(report.systems).toMatchObject([
      { systemId: "planner.optional", status: "failed", fault: { stage: "run" } },
      { systemId: "execution.mandatory-tail", status: "completed" },
    ]);
    expect(executeTailCommitted).toBe(true);
    expect(executionBatch).toMatchObject({ submitted: 0, accepted: [], decisions: [] });
  });

  it("publishes a staged batch atomically when channel capacity is exhausted", () => {
    const channel = createIntentChannel<"test", TestPayload>({
      maximumSubmitted: 3,
      maximumAccepted: 3,
      maximumBudget: 3,
      overloadPolicy: "reject",
    });
    commitIntents(
      channel,
      [makeIntent("committed:a"), makeIntent("committed:b")],
      "planner.committed",
    );
    const overflow = channel.openProducer("planner.overflow");
    overflow.producer.submit(makeIntent("overflow:a"));
    overflow.producer.submit(makeIntent("overflow:b"));
    const staged = overflow.stage();

    expect(staged.count).toBe(2);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(() => {
      staged.commit();
    }).toThrow(/committed submission capacity/u);

    const batch = channel.arbiter.arbitrate({
      tick: 100,
      snapshotRevision: "snapshot:100",
    });
    expect(batch.submitted).toBe(2);
    expect(batch.decisions.map(({ intent }) => intent.id)).toEqual(["committed:a", "committed:b"]);
    expect(batch.decisions.some(({ intent }) => intent.id.startsWith("overflow:"))).toBe(false);
  });

  it("uses the shared safety-to-speculation policy ordering", () => {
    const reversed = INTENT_PRIORITY_CLASSES.slice().reverse();
    const channel = createIntentChannel<"test", TestPayload>({
      maximumSubmitted: reversed.length,
      maximumAccepted: reversed.length,
      maximumBudget: reversed.length,
      overloadPolicy: "reject",
    });
    const scope = channel.openProducer("test-planner");
    for (const priorityClass of reversed) {
      scope.producer.submit(
        makeIntent(priorityClass, {
          priorityClass,
          exclusiveResourceKey: `resource:${priorityClass}`,
        }),
      );
    }
    scope.stage().commit();

    const batch = channel.arbiter.arbitrate({ tick: 100, snapshotRevision: "snapshot:100" });

    expect(batch.accepted.map((intent) => intent.priority.class)).toEqual([
      "safety",
      "defense",
      "survival",
      "replacement",
      "maintenance",
      "growth",
      "speculation",
    ]);
  });

  it("detaches and recursively freezes proposal data", () => {
    const payload = { action: "move" };
    const intent = makeIntent("immutable", { payload });
    payload.action = "attack";

    expect(intent.payload).toEqual({ action: "move" });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.payload)).toBe(true);
    expect(Object.isFrozen(intent.priority)).toBe(true);
  });

  it("bounds submissions and snapshots raw envelopes at the producer boundary", () => {
    const channel = createIntentChannel<"test", TestPayload>({
      maximumSubmitted: 1,
      maximumAccepted: 1,
      maximumBudget: 1,
      overloadPolicy: "reject",
    });
    const payload = { action: "move" };
    const raw = { ...makeIntent("raw"), payload };
    const scope = channel.openProducer("test-planner");

    scope.producer.submit(raw);
    payload.action = "attack";

    expect(() => {
      scope.producer.submit(makeIntent("overflow"));
    }).toThrow(/capacity/u);
    scope.stage().commit();
    expect(
      channel.arbiter.arbitrate({ tick: 100, snapshotRevision: "snapshot:100" }).accepted[0]
        ?.payload,
    ).toEqual({ action: "move" });
  });
});

function decide(intents: readonly IntentEnvelope<"test", TestPayload>[]): readonly unknown[] {
  return arbitrate(intents).decisions.map((decision) => [
    decision.intent.id,
    decision.status,
    decision.reason,
  ]);
}

function arbitrate(intents: readonly IntentEnvelope<"test", TestPayload>[]) {
  const channel = createChannel();
  commitIntents(channel, intents);
  return channel.arbiter.arbitrate({ tick: 100, snapshotRevision: "snapshot:100" });
}

function commitIntents(
  channel: IntentChannel<"test", TestPayload>,
  intents: readonly IntentEnvelope<"test", TestPayload>[],
  systemId = "test-planner",
): void {
  const scope = channel.openProducer(systemId);
  for (const intent of intents) {
    scope.producer.submit(intent);
  }
  scope.stage().commit();
}

function createChannel() {
  return createIntentChannel<"test", TestPayload>({
    maximumSubmitted: 20,
    maximumAccepted: 20,
    maximumBudget: 20,
    overloadPolicy: "defer",
  });
}

function makeIntent(
  id: string,
  options: {
    readonly deadline?: number;
    readonly exclusiveResourceKey?: string;
    readonly payload?: TestPayload;
    readonly preconditions?: IntentEnvelope<"test", TestPayload>["preconditions"];
    readonly priorityClass?: IntentPriorityClass;
    readonly priorityValue?: number;
    readonly target?: string;
  } = {},
): IntentEnvelope<"test", TestPayload> {
  return defineIntent({
    id,
    kind: "test",
    issuer: "test-planner",
    tick: 100,
    target: options.target ?? "creep:worker",
    snapshotRevision: "snapshot:100",
    exclusiveResourceKey: options.exclusiveResourceKey ?? `resource:${id}`,
    priority: {
      class: options.priorityClass ?? "maintenance",
      value: options.priorityValue ?? 10,
    },
    deadline: options.deadline ?? 105,
    budget: { id: "tick:100", cost: 1 },
    preconditions: options.preconditions ?? [],
    payload: options.payload ?? { action: "wait" },
  });
}
