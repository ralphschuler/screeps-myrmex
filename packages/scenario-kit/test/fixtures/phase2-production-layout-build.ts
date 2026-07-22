import { vi } from "vitest";
import { utf8ByteLength } from "../../../bot/src/config/canonical";
import {
  LAYOUT_ALGORITHM_REVISION,
  emptyLayoutsOwner,
  persistLayoutCommitment,
  type LayoutCommitment,
} from "../../../bot/src/layout";
import type { TickOutcome } from "../../../bot/src/runtime/tick";
import {
  establishedRcl2World,
  type EstablishedConstructionSiteProfile,
} from "../../../bot/test/support/established-rcl2-fixture";
import { canonicalHash, canonicalSerialize } from "../../src";

const FIRST_TICK = 60_000;
const MAXIMUM_TICKS = 40;
const ROOM = "W1N1";
const SITE_ID = "site-extension-18-20";
const WORKER_ID = "worker-a";
const GROWTH_ISSUER = `growth/${ROOM}/build/${SITE_ID}`;
const LAYOUT_FINGERPRINT = "phase2-layout-extension-migration-layout-v1";

const SITE = Object.freeze({
  controllerLevel: 3,
  id: SITE_ID,
  initialProgress: 2_900,
  pos: Object.freeze({ x: 18, y: 20 }),
  progressTotal: 3_000,
  structureType: "extension",
  workerBody: Object.freeze([
    "work",
    "work",
    "work",
    "work",
    "work",
    "carry",
    "carry",
    "move",
  ] as BodyPartConstant[]),
  workerEnergy: 100,
  workerPos: Object.freeze({ x: 17, y: 20 }),
}) satisfies EstablishedConstructionSiteProfile;

const COMMITMENT: LayoutCommitment = Object.freeze({
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: Object.freeze({ roomName: ROOM, x: 10, y: 20 }),
  blockers: Object.freeze([]),
  committedAt: 50_000,
  fingerprint: LAYOUT_FINGERPRINT,
  transform: 0,
});

interface AuthorityTraceSummary {
  readonly actionArbitratedAt: readonly number[];
  readonly budgetGrantedAt: readonly number[];
  readonly contractId: string;
  readonly contractSubmittedAt: number;
  readonly growthCandidateAt: readonly number[];
  readonly layoutCommitmentObservedAt: readonly number[];
  readonly leaseAssignedAt: readonly number[];
  readonly leaseExecutedAt: readonly number[];
  readonly liveBuildScheduledAt: readonly number[];
}

interface ProductionVariantSummary {
  readonly authorityTrace: AuthorityTraceSummary;
  readonly buildCalls: readonly {
    readonly energy: number;
    readonly progressAfter: number;
    readonly progressBefore: number;
    readonly targetId: string;
    readonly tick: number;
  }[];
  readonly completedAt: number;
  readonly finalGameplayPersistentHash: string;
  readonly finalProgress: number;
  readonly firstBuildAt: number;
  readonly siteCount: number;
}

interface MutableAuthorityTrace {
  readonly acceptedSubmissionAt: Map<string, number>;
  readonly actionArbitratedAt: Array<{ readonly contractId: string; readonly tick: number }>;
  readonly assignedAt: Array<{
    readonly actorId: string;
    readonly contractId: string;
    readonly tick: number;
  }>;
  readonly budgetGrantedAt: number[];
  readonly growthCandidateAt: number[];
  readonly layoutCommitmentObservedAt: number[];
  readonly leaseExecutedAt: Array<{ readonly contractId: string; readonly tick: number }>;
  readonly liveBuildScheduledAt: Array<{ readonly contractId: string; readonly tick: number }>;
}

export async function collectPhase2ProductionLayoutBuildEvidence() {
  const warm = await runVariant("warm");
  const reset = await runVariant("reset");
  const reordered = await runVariant("reordered");
  const summaries = [warm.summary, reset.summary, reordered.summary];
  const semanticBytes = summaries.map((summary) => canonicalSerialize(summary));
  const buildEnergy = warm.summary.buildCalls.reduce((total, call) => total + call.energy, 0);
  const authority = authorityStatus(warm.summary.authorityTrace, warm.summary.buildCalls);
  if (new Set(semanticBytes).size !== 1) {
    throw new Error(
      `production build semantic drift: ${canonicalSerialize({ reordered: reordered.summary, reset: reset.summary, warm: warm.summary })}`,
    );
  }

  return Object.freeze({
    scenario: Object.freeze({
      id: "phase2-production-layout-build-v1",
      site: Object.freeze({
        id: SITE.id,
        initialProgress: SITE.initialProgress,
        layoutFingerprint: LAYOUT_FINGERPRINT,
        pos: Object.freeze({ roomName: ROOM, ...SITE.pos }),
        progressTotal: SITE.progressTotal,
        structureType: SITE.structureType,
      }),
      variants: Object.freeze({
        warm: Object.freeze({ resetDuringBuild: false, reverseObservation: false }),
        reset: Object.freeze({ resetDuringBuild: true, reverseObservation: false }),
        reordered: Object.freeze({ resetDuringBuild: false, reverseObservation: true }),
      }),
      worker: Object.freeze({ body: SITE.workerBody, id: WORKER_ID }),
    }),
    authority,
    authorityTrace: warm.summary.authorityTrace,
    buildCalls: warm.summary.buildCalls,
    buildEnergy,
    completedStructureType: SITE.structureType,
    completion: Object.freeze({
      completedAt: warm.summary.completedAt,
      finalProgress: warm.summary.finalProgress,
      firstBuildAt: warm.summary.firstBuildAt,
      siteCount: warm.summary.siteCount,
    }),
    directProgressMutation:
      buildEnergy !== SITE.progressTotal - SITE.initialProgress ||
      warm.summary.buildCalls.some(
        (call) => call.progressAfter - call.progressBefore !== call.energy,
      ),
    finalGameplayPersistentHash: warm.summary.finalGameplayPersistentHash,
    maximumModeledCpuPerTick:
      Math.round(
        Math.max(
          warm.maximumModeledCpuPerTick,
          reset.maximumModeledCpuPerTick,
          reordered.maximumModeledCpuPerTick,
        ) * 1_000,
      ) / 1_000,
    maximumPersistentBytes: Math.max(
      warm.maximumPersistentBytes,
      reset.maximumPersistentBytes,
      reordered.maximumPersistentBytes,
    ),
    semanticBytesIdentical: new Set(semanticBytes).size === 1,
    semanticHashes: Object.freeze({
      reordered: canonicalHash(reordered.summary),
      reset: canonicalHash(reset.summary),
      warm: canonicalHash(warm.summary),
    }),
    siteObservedAbsentAfterCompletion: warm.siteObservedAbsentAfterCompletion,
  });
}

async function runVariant(kind: "reordered" | "reset" | "warm") {
  vi.resetModules();
  const world = establishedRcl2World({
    constructionSite: SITE,
    reverseCollections: kind === "reordered",
  });
  let memory = {} as Memory;
  let executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
  let resetApplied = false;
  let maximumModeledCpuPerTick = 0;
  let maximumPersistentBytes = 0;
  let firstBuildAt: number | null = null;
  const trace = emptyAuthorityTrace();

  for (let tick = FIRST_TICK; tick < FIRST_TICK + MAXIMUM_TICKS; tick += 1) {
    const priorBuildCalls = world.buildCalls().length;
    const outcome = executeTick({ game: world.game(tick), memory });
    observeAuthority(outcome, trace, tick);
    maximumModeledCpuPerTick = Math.max(maximumModeledCpuPerTick, outcome.kernel.cpuUsed);
    maximumPersistentBytes = Math.max(
      maximumPersistentBytes,
      utf8ByteLength(canonicalSerialize(memory)),
    );
    firstBuildAt ??= world.buildCalls()[0]?.tick ?? null;
    if (world.buildCalls().length > priorBuildCalls && hasExpectedLayoutCommitment(memory)) {
      trace.layoutCommitmentObservedAt.push(tick);
    }

    if (tick === FIRST_TICK) seedCommittedLayoutAndDisablePlanning(memory);
    if (kind === "reset" && !resetApplied && world.buildCalls().length > 0) {
      memory = JSON.parse(JSON.stringify(memory)) as Memory;
      vi.resetModules();
      executeTick = (await import("../../../bot/src/runtime/tick")).runTick;
      resetApplied = true;
    }
    if (world.siteCompletedAt() !== null) {
      const siteObservedAbsentAfterCompletion = siteAbsent(outcome);
      const summary = summaryOf(world, memory, trace, firstBuildAt);
      validateVariant(summary, siteObservedAbsentAfterCompletion, kind, resetApplied);
      return {
        maximumModeledCpuPerTick,
        maximumPersistentBytes,
        siteObservedAbsentAfterCompletion,
        summary,
      };
    }
  }
  throw new Error(`${kind} production layout build did not complete within its tick bound`);
}

function emptyAuthorityTrace(): MutableAuthorityTrace {
  return {
    acceptedSubmissionAt: new Map(),
    actionArbitratedAt: [],
    assignedAt: [],
    budgetGrantedAt: [],
    growthCandidateAt: [],
    layoutCommitmentObservedAt: [],
    leaseExecutedAt: [],
    liveBuildScheduledAt: [],
  };
}

function observeAuthority(outcome: TickOutcome, trace: MutableAuthorityTrace, tick: number): void {
  if ((outcome.telemetry?.activity.growthCandidates ?? 0) > 0) {
    trace.growthCandidateAt.push(tick);
  }
  if (
    outcome.colony.reservations.some(
      ({ category, issuer, status }) =>
        category === "optional-growth" && issuer === GROWTH_ISSUER && status === "active",
    )
  ) {
    trace.budgetGrantedAt.push(tick);
  }
  for (const submission of outcome.contracts?.submissions ?? []) {
    if (submission.accepted && !trace.acceptedSubmissionAt.has(submission.contractId)) {
      trace.acceptedSubmissionAt.set(submission.contractId, tick);
    }
  }
  for (const assignment of outcome.contracts?.allocation.assignments ?? []) {
    trace.assignedAt.push({
      actorId: assignment.actorId,
      contractId: assignment.contractId,
      tick,
    });
  }
  for (const lease of outcome.contractExecution.leases) {
    if (
      lease.actorId === WORKER_ID &&
      lease.execution.action === "build" &&
      lease.targetId === SITE_ID
    ) {
      trace.leaseExecutedAt.push({ contractId: lease.contractId, tick });
    }
  }
  for (const decision of outcome.movement.actionDecisions) {
    if (
      decision.intent.actorId === WORKER_ID &&
      decision.intent.kind === "build" &&
      decision.intent.targetId === SITE_ID &&
      decision.intent.contractId !== null &&
      decision.status === "accepted"
    ) {
      trace.actionArbitratedAt.push({ contractId: decision.intent.contractId, tick });
    }
  }
  for (const execution of outcome.movement.actionExecution) {
    if (
      execution.intent.actorId === WORKER_ID &&
      execution.intent.kind === "build" &&
      execution.intent.targetId === SITE_ID &&
      execution.intent.contractId !== null &&
      execution.status === "executed" &&
      execution.reason === "executed" &&
      execution.outcome?.name === "OK"
    ) {
      trace.liveBuildScheduledAt.push({ contractId: execution.intent.contractId, tick });
    }
  }
}

function seedCommittedLayoutAndDisablePlanning(memory: Memory): void {
  const root = memory.myrmex;
  if (root === undefined) throw new Error("production layout evidence root unavailable");
  const config = root.config as unknown as { candidate: unknown };
  config.candidate = {
    revision: 1,
    overrides: { features: { disabled: ["phase2.layout"] } },
  };
  (root as unknown as { layouts: unknown }).layouts = persistLayoutCommitment(
    emptyLayoutsOwner(),
    ROOM,
    COMMITMENT,
  );
}

function hasExpectedLayoutCommitment(memory: Memory): boolean {
  const layouts = memory.myrmex?.layouts as unknown as
    | {
        readonly records?: readonly {
          readonly algorithmRevision?: unknown;
          readonly anchor?: unknown;
          readonly fingerprint?: unknown;
          readonly roomName?: unknown;
          readonly transform?: unknown;
        }[];
      }
    | undefined;
  return (
    layouts?.records?.some(
      ({ algorithmRevision, anchor, fingerprint, roomName, transform }) =>
        algorithmRevision === COMMITMENT.algorithmRevision &&
        canonicalSerialize(anchor) === canonicalSerialize(COMMITMENT.anchor) &&
        fingerprint === COMMITMENT.fingerprint &&
        roomName === ROOM &&
        transform === COMMITMENT.transform,
    ) ?? false
  );
}

function authorityTraceSummary(trace: MutableAuthorityTrace): AuthorityTraceSummary {
  const contractIds = new Set([
    ...trace.leaseExecutedAt.map(({ contractId }) => contractId),
    ...trace.actionArbitratedAt.map(({ contractId }) => contractId),
    ...trace.liveBuildScheduledAt.map(({ contractId }) => contractId),
  ]);
  if (contractIds.size !== 1)
    throw new Error("production build did not retain one contract identity");
  const contractId = [...contractIds][0];
  if (contractId === undefined) throw new Error("production build contract identity unavailable");
  const contractSubmittedAt = trace.acceptedSubmissionAt.get(contractId);
  if (contractSubmittedAt === undefined) {
    throw new Error("production build contract submission was not observed");
  }
  const ticksFor = (rows: readonly { readonly contractId: string; readonly tick: number }[]) =>
    Object.freeze(rows.filter((row) => row.contractId === contractId).map(({ tick }) => tick));
  return Object.freeze({
    actionArbitratedAt: ticksFor(trace.actionArbitratedAt),
    budgetGrantedAt: Object.freeze([...trace.budgetGrantedAt]),
    contractId,
    contractSubmittedAt,
    growthCandidateAt: Object.freeze([...trace.growthCandidateAt]),
    layoutCommitmentObservedAt: Object.freeze([...trace.layoutCommitmentObservedAt]),
    leaseAssignedAt: Object.freeze(
      trace.assignedAt
        .filter(
          ({ actorId, contractId: assignedId }) =>
            actorId === WORKER_ID && assignedId === contractId,
        )
        .map(({ tick }) => tick),
    ),
    leaseExecutedAt: ticksFor(trace.leaseExecutedAt),
    liveBuildScheduledAt: ticksFor(trace.liveBuildScheduledAt),
  });
}

function authorityStatus(
  trace: AuthorityTraceSummary,
  buildCalls: ProductionVariantSummary["buildCalls"],
) {
  const buildTicks = buildCalls.map(({ tick }) => tick);
  const equalTicks = (ticks: readonly number[]) =>
    canonicalSerialize(ticks) === canonicalSerialize(buildTicks);
  return Object.freeze({
    actionArbitrated: equalTicks(trace.actionArbitratedAt),
    budgetGranted: trace.budgetGrantedAt.length > 0,
    contractSubmitted: Number.isSafeInteger(trace.contractSubmittedAt),
    creepBuildScheduled: equalTicks(trace.liveBuildScheduledAt),
    growthCandidateObserved: trace.growthCandidateAt.some((tick) =>
      trace.budgetGrantedAt.includes(tick),
    ),
    layoutCommitmentObserved: equalTicks(trace.layoutCommitmentObservedAt),
    leaseAssigned: trace.leaseAssignedAt.length > 0,
    leaseExecuted: buildTicks.every((tick) => trace.leaseExecutedAt.includes(tick)),
  });
}

function siteAbsent(outcome: TickOutcome): boolean {
  const room = outcome.snapshot.rooms.find(({ name }) => name === ROOM);
  return (
    room !== undefined &&
    !room.constructionSites.some(({ id }) => id === SITE_ID) &&
    room.ownedExtensions.some(
      ({ pos }) => pos.x === SITE.pos.x && pos.y === SITE.pos.y && pos.roomName === ROOM,
    )
  );
}

function summaryOf(
  world: ReturnType<typeof establishedRcl2World>,
  memory: Memory,
  trace: MutableAuthorityTrace,
  firstBuildAt: number | null,
): ProductionVariantSummary {
  const completedAt = world.siteCompletedAt();
  if (completedAt === null || firstBuildAt === null) {
    throw new Error("production layout build evidence is incomplete");
  }
  return Object.freeze({
    authorityTrace: authorityTraceSummary(trace),
    buildCalls: Object.freeze(world.buildCalls()),
    completedAt,
    finalGameplayPersistentHash: gameplayPersistentHash(memory),
    finalProgress: world.siteProgress(),
    firstBuildAt,
    siteCount: world.siteCount(),
  });
}

function gameplayPersistentHash(memory: Memory): string {
  const root = memory.myrmex;
  if (root === undefined) throw new Error("production gameplay state unavailable");
  return canonicalHash({
    colonies: root.colonies,
    config: root.config,
    contracts: root.contracts,
    layouts: root.layouts,
  });
}

function validateVariant(
  summary: ProductionVariantSummary,
  siteObservedAbsentAfterCompletion: boolean,
  kind: "reordered" | "reset" | "warm",
  resetApplied: boolean,
): void {
  if (summary.finalProgress !== SITE.progressTotal || summary.siteCount !== 0) {
    throw new Error(`${kind} production build did not reach exact completion`);
  }
  if (summary.buildCalls.reduce((total, call) => total + call.energy, 0) !== 100) {
    throw new Error(`${kind} production build energy drifted`);
  }
  const authority = authorityStatus(summary.authorityTrace, summary.buildCalls);
  if (Object.values(authority).some((value) => !value)) {
    throw new Error(
      `${kind} production build missed an exact authority seam: ${canonicalSerialize({ authority, trace: summary.authorityTrace })}`,
    );
  }
  if (!siteObservedAbsentAfterCompletion) {
    throw new Error(`${kind} completion was not observed from fresh world state`);
  }
  if ((kind === "reset") !== resetApplied) {
    throw new Error(`${kind} reset dimension drifted`);
  }
}
