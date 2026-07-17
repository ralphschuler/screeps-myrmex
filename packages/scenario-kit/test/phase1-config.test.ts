import { describe, expect, it } from "vitest";
import {
  FEATURE_GATE_IDS,
  classifyPlayerRelation,
  type FeatureGateId,
  type FeatureGateReason,
  type RelationDecision,
  type RuntimeConfigResolutionMetadata,
} from "../../bot/src/config";
import { RuntimeConfigAuthority } from "../../bot/src/config/authority";
import {
  assertForbiddenOutcome,
  canonicalSerialize,
  defineReplayScenario,
  runScenario,
  type ReplayScenario,
} from "../src";

interface ConfigWorld {
  readonly owner: Readonly<Record<string, unknown>>;
}

interface CandidateInput {
  readonly revision: number;
  readonly overrides: Readonly<Record<string, unknown>>;
}

interface ConfigInput {
  readonly candidate?: CandidateInput | null;
  readonly staleLastValid: boolean;
  readonly reputation: Readonly<Record<string, unknown>> | null;
}

interface GateOutcome {
  readonly id: FeatureGateId;
  readonly enabled: boolean;
  readonly reason: FeatureGateReason;
  readonly blockedBy: FeatureGateId | null;
}

interface ConfigOutcome {
  readonly configBytes: string;
  readonly configRevision: string;
  readonly sourceRevision: string;
  readonly policyRevision: string;
  readonly metadata: RuntimeConfigResolutionMetadata;
  readonly gates: readonly GateOutcome[];
  readonly relations: {
    readonly self: RelationDecision;
    readonly ally: RelationDecision;
    readonly nap: RelationDecision;
    readonly unknown: RelationDecision;
  };
}

interface ConfigHeap {
  readonly authority: RuntimeConfigAuthority;
}

const VALID_OVERRIDES = {
  policy: { recovery: { protectedSpawnEnergy: 350 } },
  relations: {
    self: ["Myrmex"],
    allies: ["Friendly"],
    naps: ["Pact"],
  },
  features: { disabled: ["phase1.growth"] },
} as const;

describe("Phase 1 runtime config scenario", () => {
  it("retains accepted policy and configured exclusions across rejection and heap reset", () => {
    const warm = runScenario(runtimeConfigScenario(false));
    const reset = runScenario(runtimeConfigScenario(true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);

    expect(reset.outcomes.map(({ metadata }) => [metadata.status, metadata.reasonCode])).toEqual([
      ["source-defaults", "owner-initialized"],
      ["candidate-accepted", "candidate-valid"],
      ["last-valid-retained", "no-candidate"],
      ["last-valid-retained", "candidate-invalid"],
      ["last-valid-retained", "candidate-invalid"],
      ["source-defaults", "candidate-invalid"],
    ]);
    expect(reset.outcomes[2]?.configBytes).toBe(reset.outcomes[1]?.configBytes);
    expect(reset.outcomes[2]?.configRevision).toBe(reset.outcomes[1]?.configRevision);
    expect(reset.outcomes[3]?.configRevision).toBe(reset.outcomes[1]?.configRevision);
    expect(reset.outcomes[4]?.configRevision).toBe(reset.outcomes[1]?.configRevision);
    expect(reset.outcomes[5]?.configBytes).toBe(reset.outcomes[0]?.configBytes);
    expect(
      reset.outcomes.every(({ sourceRevision }) => sourceRevision === "runtime-config-source-v24"),
    ).toBe(true);

    for (const outcome of reset.outcomes.slice(1, 5)) {
      expect(outcome.relations.self).toMatchObject({
        relation: "self",
        targetingCeiling: "excluded",
      });
      expect(outcome.relations.ally).toMatchObject({
        relation: "ally",
        targetingCeiling: "excluded",
      });
      expect(outcome.relations.nap).toMatchObject({
        relation: "nap",
        targetingCeiling: "excluded",
      });
      expect(outcome.relations.unknown.targetingCeiling).toBe("local-defense");
      expect(outcome.relations.ally.configRevision).toBe(outcome.configRevision);
      expect(outcome.relations.ally.policyRevision).toBe(outcome.policyRevision);
    }

    assertForbiddenOutcome(
      reset.outcomes,
      (outcome) =>
        Object.values(outcome.relations).some(
          ({ targetingCeiling }) => targetingCeiling === "authorized-operation",
        ),
      { label: "Phase 1 offensive targeting authorization" },
    );
    expect(
      reset.outcomes.every((outcome) =>
        outcome.gates.every(({ id, enabled, reason, blockedBy }) =>
          id === "phase2.industry"
            ? (enabled && reason === "enabled") ||
              (!enabled && reason === "prerequisite-blocked" && blockedBy !== null)
            : id === "phase2.maintenance"
              ? (enabled && reason === "enabled") ||
                (!enabled && reason === "prerequisite-blocked" && blockedBy !== null)
              : id === "phase2.links"
                ? (enabled && reason === "enabled") ||
                  (!enabled &&
                    reason === "prerequisite-blocked" &&
                    blockedBy !== null &&
                    [
                      "phase2.layout",
                      "phase2.mining",
                      "phase2.logistics",
                      "phase1.telemetry",
                    ].includes(blockedBy))
                : id === "phase2.logistics"
                  ? (enabled && reason === "enabled") ||
                    (!enabled && reason === "prerequisite-blocked" && blockedBy === "phase2.mining")
                  : id === "phase2.mining"
                    ? (enabled && reason === "enabled") ||
                      (!enabled &&
                        reason === "prerequisite-blocked" &&
                        blockedBy === "phase2.layout")
                    : id === "phase2.layout"
                      ? (enabled && reason === "enabled") ||
                        (!enabled &&
                          reason === "prerequisite-blocked" &&
                          blockedBy === "phase2.colony")
                      : id === "phase2.colony"
                        ? (enabled && reason === "enabled") ||
                          (!enabled &&
                            reason === "prerequisite-blocked" &&
                            blockedBy === "phase1.growth")
                        : id === "phase1.colony" ||
                            id === "phase1.contracts" ||
                            id === "phase1.spawn" ||
                            id === "phase1.movement" ||
                            id === "phase1.agents" ||
                            id === "phase1.economy" ||
                            id === "phase1.safety" ||
                            id === "phase1.recovery" ||
                            id === "phase1.telemetry" ||
                            id === "phase1.critical-maintenance"
                          ? enabled && reason === "enabled"
                          : (enabled && reason === "enabled") ||
                            (!enabled && reason === "operator-disabled"),
        ),
      ),
    ).toBe(true);
  });
});

function runtimeConfigScenario(
  resetHeap: boolean,
): ReplayScenario<ConfigWorld, ConfigInput, ConfigOutcome, ConfigHeap> {
  const ticks: readonly ConfigInput[] = [
    { staleLastValid: false, reputation: null },
    {
      candidate: { revision: 1, overrides: VALID_OVERRIDES },
      staleLastValid: false,
      reputation: null,
    },
    {
      candidate: null,
      staleLastValid: false,
      reputation: { schemaVersion: 1, relation: "war", assessedAt: 0, expiresAt: 1 },
    },
    {
      candidate: { revision: 2, overrides: { ...VALID_OVERRIDES, unexpected: true } },
      staleLastValid: false,
      reputation: { schemaVersion: 1, relation: "war" },
    },
    {
      candidate: {
        revision: 3,
        overrides: {
          ...VALID_OVERRIDES,
          policy: {
            recovery: { protectedSpawnEnergy: 400 },
            tower: { emergencyReserveEnergy: 1_001 },
          },
        },
      },
      staleLastValid: false,
      reputation: {
        schemaVersion: 1,
        relation: "war",
        assessedAt: 1_004,
        expiresAt: 1_100,
      },
    },
    {
      candidate: {
        revision: 4,
        overrides: { policy: { recovery: { protectedSpawnEnergy: 199 } } },
      },
      staleLastValid: true,
      reputation: null,
    },
  ];

  return defineReplayScenario<ConfigWorld, ConfigInput, ConfigOutcome, ConfigHeap>({
    id: "phase1/config/fail-closed-reset-equivalence",
    seed: "phase1-runtime-config",
    initialWorld: { owner: {} },
    ticks: ticks.map((input, index) => ({
      gameTime: 1_000 + index,
      input,
      cpuBudget: 2,
      resetHeap: resetHeap && index === 2,
    })),
    createHeap: () => ({ authority: new RuntimeConfigAuthority() }),
    resetHeap: () => ({ authority: new RuntimeConfigAuthority() }),
    step: ({ gameTime, heap, input, world }) => {
      const owner = cloneRecord(world.owner);
      if (input.candidate !== undefined) {
        owner.candidate = cloneValue(input.candidate);
      }
      if (input.staleLastValid) {
        const lastValid = readRecord(owner.lastValid);
        if (lastValid === null) {
          throw new Error("scenario expected an accepted last-valid config");
        }
        owner.lastValid = { ...lastValid, sourceRevision: "obsolete-source-revision" };
      }

      const resolution = heap.authority.resolve(owner, gameTime);
      const nextOwner =
        resolution.replacementOwner === null ? owner : cloneOwner(resolution.replacementOwner);
      const relationFor = (username: string): RelationDecision =>
        classifyPlayerRelation(resolution.config, {
          username,
          tick: gameTime,
          reputation: input.reputation,
        });

      return {
        nextWorld: { owner: nextOwner },
        outcome: {
          configBytes: canonicalSerialize(resolution.config),
          configRevision: resolution.config.revision,
          sourceRevision: resolution.config.sourceRevision,
          policyRevision: resolution.config.policyRevision,
          metadata: resolution.metadata,
          gates: FEATURE_GATE_IDS.map((id) => ({
            id,
            enabled: resolution.config.features.gates[id].enabled,
            reason: resolution.config.features.gates[id].reason,
            blockedBy: resolution.config.features.gates[id].blockedBy,
          })),
          relations: {
            self: relationFor("Myrmex"),
            ally: relationFor("Friendly"),
            nap: relationFor("Pact"),
            unknown: relationFor("Unknown"),
          },
        },
        cpuUsed: 1,
      };
    },
  });
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return cloneValue(value);
}

function cloneOwner(value: unknown): Record<string, unknown> {
  const clone = cloneValue(value);
  const owner = readRecord(clone);
  if (owner === null) {
    throw new TypeError("runtime config replacement owner must be a data object");
  }
  return owner;
}

function cloneValue<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
