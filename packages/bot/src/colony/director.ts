import { classifyPlayerRelation, isFeatureEnabled, type RuntimeConfig } from "../config";
import type { CpuBudget, CpuMode } from "../runtime/kernel";
import type { CreepSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";
import { BudgetLedger, reservationIdFor } from "./budget-ledger";
import {
  CPU_RESERVATION_UNITS_PER_CPU,
  BUDGET_CATEGORIES,
  MAX_BUDGET_REQUESTS_PER_TICK,
  MAX_COLONIES,
  RECOVERY_OBJECTIVE_CPU_UNITS,
  type BudgetDecision,
  type BudgetLedgerCapacity,
  type BudgetLedgerResult,
  type BudgetRequest,
  type ColonyDirectorResult,
  type ColonyObjective,
  type ColonyPlanReason,
  type ColonyPlanStatus,
  type ColonyRecord,
  type ColonyState,
  type ColonyTransitionReason,
  type ColonyView,
  type LedgerEntry,
  type SpawnBudgetCapacity,
} from "./contracts";
import { canonicalColoniesOwner, coloniesOwnerEquals, resolveColoniesOwner } from "./persistence";

export interface ColonyDirectorInput {
  readonly tick: number;
  readonly snapshot: WorldSnapshot;
  readonly config: RuntimeConfig;
  readonly owner: unknown;
  readonly cpuMode: CpuMode;
  readonly cpuBudget: CpuBudget;
  readonly requests?: readonly BudgetRequest[];
}

interface ColonyEvidence {
  readonly room: RoomSnapshot;
  readonly owned: boolean;
  readonly hasSpawn: boolean;
  readonly legalWorkforce: boolean;
  readonly activeThreat: boolean;
  readonly controllerRisk: boolean;
  readonly mature: boolean;
  readonly recoveryFloorRestored: boolean;
}

interface Transition {
  readonly state: ColonyState;
  readonly reasonCode: ColonyTransitionReason;
}

const EMPTY_TOTALS = Object.freeze({
  active: 0,
  pending: 0,
  energyReserved: 0,
  cpuReserved: 0,
  spawnTicksReserved: 0,
});

/**
 * Sole authority for current colony lifecycle state and colony-local budget authorization.
 * The director is deliberately stateless: reset safety comes from its canonical owner input.
 */
export class ColonyDirector {
  plan(input: ColonyDirectorInput): ColonyDirectorResult {
    assertTick(input.tick);
    if (!isFeatureEnabled(input.config, "phase1.colony")) {
      return emptyResult("disabled", "feature-disabled");
    }
    if (input.owner === null || input.owner === undefined) {
      return emptyResult("owner-unavailable", "owner-unavailable");
    }

    const resolved = resolveColoniesOwner(input.owner);
    if (resolved.owner === null) {
      const reason =
        resolved.status === "future-schema" ? "owner-future-schema" : "owner-malformed";
      return emptyResult(reason, reason);
    }
    if ((input.requests?.length ?? 0) > MAX_BUDGET_REQUESTS_PER_TICK * 2) {
      throw new RangeError(
        `raw colony requests exceed the bounded input cap of ${String(MAX_BUDGET_REQUESTS_PER_TICK * 2)}`,
      );
    }

    const currentOwner = resolved.owner;
    const visibleRooms = new Map(input.snapshot.rooms.map((room) => [room.name, room]));
    const persisted = new Map(currentOwner.colonies.map((colony) => [colony.roomName, colony]));
    const ownedRoomNames = input.snapshot.rooms
      .filter((room) => room.controller?.ownership === "owned")
      .map((room) => room.name);
    const persistedRoomNames = [...persisted.keys()].sort(compareStrings);
    const newOwnedRoomNames = sortedUnique(ownedRoomNames).filter(
      (roomName) => !persisted.has(roomName),
    );
    const roomNames = [
      ...persistedRoomNames,
      ...newOwnedRoomNames.slice(0, Math.max(0, MAX_COLONIES - persistedRoomNames.length)),
    ].sort(compareStrings);

    const records: ColonyRecord[] = [];
    const views: ColonyView[] = [];
    const evidence = new Map<string, ColonyEvidence>();

    for (const roomName of roomNames) {
      const previous = persisted.get(roomName) ?? null;
      const room = visibleRooms.get(roomName) ?? null;
      if (room === null) {
        if (previous !== null) {
          records.push(previous);
          views.push(viewForUnknown(previous));
        }
        continue;
      }

      const facts = observeEvidence(room, input.config, input.tick);
      evidence.set(roomName, facts);
      const transition = transitionFor(previous, facts);
      const record = applyTransition(
        previous,
        roomName,
        transition,
        input.tick,
        input.config.policyRevision,
      );
      records.push(record);
      views.push(viewForVisible(record, facts));
    }

    const knownNames = new Set(evidence.keys());
    const unknownLedger = currentOwner.ledger.filter((entry) => !knownNames.has(entry.colonyId));
    const knownLedger = currentOwner.ledger.filter((entry) => knownNames.has(entry.colonyId));
    const recordByName = new Map(records.map((record) => [record.roomName, record]));
    const preDecisions: BudgetDecision[] = [];
    const eligibleRequests: BudgetRequest[] = [];

    const validExternalRequests: BudgetRequest[] = [];
    for (const request of input.requests ?? []) {
      if (safeReservationId(request) === null) {
        preDecisions.push(invalidExternalDecision(request));
      } else {
        validExternalRequests.push(request);
      }
    }
    validExternalRequests.sort(compareBudgetRequestsSafely);
    for (const request of validExternalRequests.slice(MAX_BUDGET_REQUESTS_PER_TICK)) {
      preDecisions.push(deniedDecision(request, "request-cap-exceeded"));
    }
    for (const request of validExternalRequests.slice(0, MAX_BUDGET_REQUESTS_PER_TICK)) {
      const record = recordByName.get(request.colonyId);
      const facts = evidence.get(request.colonyId);
      const denial = requestDenial(record, facts, request, input.cpuMode);
      if (denial === null) {
        eligibleRequests.push(request);
      } else {
        preDecisions.push(deniedDecision(request, denial));
      }
    }

    const objectiveRequests: BudgetRequest[] = [];
    const objectiveRecords: Array<{
      readonly record: ColonyRecord;
      readonly request: BudgetRequest;
    }> = [];
    for (const record of records) {
      const facts = evidence.get(record.roomName);
      if (
        facts === undefined ||
        !facts.owned ||
        !facts.hasSpawn ||
        facts.legalWorkforce ||
        (record.state !== "bootstrapping" && record.state !== "recovering")
      ) {
        continue;
      }
      const request = recoveryRequest(record, knownLedger, input);
      objectiveRequests.push(request);
      objectiveRecords.push({ record, request });
    }

    const ledger = new BudgetLedger(knownLedger);
    const ledgerResult = ledger.reconcile({
      tick: input.tick,
      capacity: ledgerCapacity(records, evidence, input),
      requests: [...eligibleRequests, ...objectiveRequests],
    });
    const objectives = objectiveRecords.map(({ record, request }) =>
      objectiveFor(record, request, ledgerResult),
    );
    const combinedLedger = [...ledgerResult.entries, ...unknownLedger];
    const candidateAtCurrentRevision = canonicalColoniesOwner(
      currentOwner.revision,
      records,
      combinedLedger,
    );
    const ownerChanged = !coloniesOwnerEquals(currentOwner, candidateAtCurrentRevision);
    const replacement = ownerChanged
      ? canonicalColoniesOwner(
          checkedIncrement(currentOwner.revision, "colonies owner revision"),
          records,
          combinedLedger,
        )
      : currentOwner;
    const mustInitialize = resolved.status === "initialized";

    return deepFreeze({
      status: "planned",
      reasonCode: "planned",
      ownerRevision: replacement.revision,
      colonies: views,
      objectives,
      decisions: sortDecisions([...preDecisions, ...ledgerResult.decisions]),
      reservations: ledgerResult.entries,
      transitions: ledgerResult.transitions,
      totals: ledgerResult.totals,
      replacementOwner: ownerChanged || mustInitialize ? replacement : null,
    });
  }
}

export function emptyColonyPlanningResult(): ColonyDirectorResult {
  return emptyResult("not-run", "not-run");
}

function emptyResult(status: ColonyPlanStatus, reasonCode: ColonyPlanReason): ColonyDirectorResult {
  return deepFreeze({
    status,
    reasonCode,
    ownerRevision: null,
    colonies: [],
    objectives: [],
    decisions: [],
    reservations: [],
    transitions: [],
    totals: EMPTY_TOTALS,
    replacementOwner: null,
  });
}

function observeEvidence(room: RoomSnapshot, config: RuntimeConfig, tick: number): ColonyEvidence {
  const controller = room.controller;
  const owned = controller?.ownership === "owned";
  const legalWorkforce = room.ownedCreeps.some(isLegalWorker);
  const activeThreatParts = room.hostileCreeps.reduce((total, creep) => {
    const relation = classifyPlayerRelation(config, { username: creep.ownerUsername, tick });
    if (relation.targetingCeiling !== "local-defense") {
      return total;
    }
    return (
      total +
      creep.body.attack.active +
      creep.body.rangedAttack.active +
      creep.body.work.active +
      creep.body.claim.active
    );
  }, 0);
  const activeThreat = activeThreatParts >= config.policy.safeMode.minimumHostileOffenseParts;
  const controllerRisk =
    controller?.ticksToDowngrade === null ||
    controller?.ticksToDowngrade === undefined ||
    controller.ticksToDowngrade <= config.policy.recovery.controllerRiskWindowTicks;
  const hasSpawn = room.ownedSpawns.length > 0;
  const mature =
    owned &&
    controller.level === 8 &&
    hasSpawn &&
    legalWorkforce &&
    !controllerRisk &&
    !activeThreat;
  const spendable = Math.min(room.energyAvailable, room.energyCapacityAvailable);
  const recoveryFloor = Math.min(
    config.policy.recovery.protectedSpawnEnergy,
    room.energyCapacityAvailable,
  );
  return {
    room,
    owned,
    hasSpawn,
    legalWorkforce,
    activeThreat,
    controllerRisk,
    mature,
    recoveryFloorRestored: spendable >= recoveryFloor,
  };
}

function isLegalWorker(creep: CreepSnapshot): boolean {
  return (
    !creep.spawning &&
    creep.body.work.active >= 1 &&
    creep.body.carry.active >= 1 &&
    creep.body.move.active >= 1
  );
}

function transitionFor(previous: ColonyRecord | null, facts: ColonyEvidence): Transition {
  if (previous?.state === "lost") {
    return { state: "lost", reasonCode: "lost-terminal" };
  }
  if (!facts.owned) {
    return { state: "lost", reasonCode: "visible-ownership-lost" };
  }
  if (facts.activeThreat) {
    return { state: "threatened", reasonCode: "local-threat-observed" };
  }
  if (previous?.state === "threatened") {
    return { state: "recovering", reasonCode: "local-threat-cleared" };
  }
  if (previous?.state === "recovering") {
    if (!facts.hasSpawn || !facts.legalWorkforce || facts.controllerRisk) {
      return { state: "recovering", reasonCode: "survival-capability-lost" };
    }
    if (!facts.recoveryFloorRestored) {
      return { state: "recovering", reasonCode: "mandatory-floor-unrestored" };
    }
    return facts.mature
      ? { state: "mature", reasonCode: "maturity-evidence-met" }
      : { state: "developing", reasonCode: "survival-capability-restored" };
  }
  if (!facts.hasSpawn) {
    return previous === null
      ? { state: "discovering", reasonCode: "owned-room-discovered" }
      : { state: "recovering", reasonCode: "survival-capability-lost" };
  }
  if (!facts.legalWorkforce) {
    return previous === null ||
      previous.state === "discovering" ||
      previous.state === "bootstrapping"
      ? { state: "bootstrapping", reasonCode: "spawn-without-workforce" }
      : { state: "recovering", reasonCode: "survival-capability-lost" };
  }
  if (facts.controllerRisk) {
    return { state: "recovering", reasonCode: "controller-downgrade-risk" };
  }
  if (facts.mature) {
    return { state: "mature", reasonCode: "maturity-evidence-met" };
  }
  if (previous?.state === "mature") {
    return { state: "developing", reasonCode: "maturity-evidence-lost" };
  }
  return { state: "developing", reasonCode: "survival-capability-restored" };
}

function applyTransition(
  previous: ColonyRecord | null,
  roomName: string,
  transition: Transition,
  tick: number,
  policyRevision: string,
): ColonyRecord {
  if (
    previous !== null &&
    previous.state === transition.state &&
    previous.policyRevision === policyRevision
  ) {
    return previous;
  }
  if (previous !== null && previous.state === transition.state) {
    return deepFreeze({
      ...previous,
      revision: checkedIncrement(previous.revision, "colony record revision"),
      policyRevision,
    });
  }
  return deepFreeze({
    roomName,
    state: transition.state,
    stateSince: tick,
    revision: previous === null ? 1 : checkedIncrement(previous.revision, "colony record revision"),
    policyRevision,
    reasonCode: transition.reasonCode,
  });
}

function viewForUnknown(record: ColonyRecord): ColonyView {
  return deepFreeze({
    id: record.roomName,
    roomName: record.roomName,
    state: record.state,
    revision: record.revision,
    reasonCode: record.reasonCode,
    visibility: "unknown",
    legalWorkforce: null,
    activeThreat: null,
    controllerRisk: null,
  });
}

function viewForVisible(record: ColonyRecord, facts: ColonyEvidence): ColonyView {
  return deepFreeze({
    id: record.roomName,
    roomName: record.roomName,
    state: record.state,
    revision: record.revision,
    reasonCode: record.reasonCode,
    visibility: "visible",
    legalWorkforce: facts.owned ? facts.legalWorkforce : false,
    activeThreat: facts.activeThreat,
    controllerRisk: facts.owned ? facts.controllerRisk : null,
  });
}

function requestDenial(
  record: ColonyRecord | undefined,
  facts: ColonyEvidence | undefined,
  request: BudgetRequest,
  cpuMode: CpuMode,
): BudgetDecision["reasonCode"] | null {
  if (record?.state === "lost") {
    return "colony-lost";
  }
  if (record === undefined || facts === undefined || !facts.owned) {
    return "observation-unknown";
  }
  if (
    request.category === "optional-growth" &&
    record.state !== "developing" &&
    record.state !== "mature"
  ) {
    return "posture-preempted";
  }
  if (
    request.category === "optional-growth" &&
    (cpuMode === "recovery" || cpuMode === "emergency" || cpuMode === "constrained")
  ) {
    return "posture-preempted";
  }
  return null;
}

function deniedDecision(
  request: BudgetRequest,
  reasonCode: BudgetDecision["reasonCode"],
): BudgetDecision {
  return deepFreeze({
    reservationId: reservationIdFor(request),
    colonyId: request.colonyId,
    category: request.category,
    issuer: request.issuer,
    revision: request.revision,
    status: "denied",
    reasonCode,
    grant: null,
  });
}

function recoveryRequest(
  record: ColonyRecord,
  ledger: readonly LedgerEntry[],
  input: ColonyDirectorInput,
): BudgetRequest {
  const issuer = `colony/${record.roomName}/restore-workforce`;
  const existing = ledger.find(
    (entry) =>
      entry.colonyId === record.roomName &&
      entry.category === "emergency-spawn" &&
      entry.issuer === issuer,
  );
  const existingReservable =
    existing !== undefined && (existing.status === "active" || existing.status === "pending");
  const claimsChanged =
    existing !== undefined &&
    (existing.request.energy?.minimum !== 200 ||
      existing.request.energy.desired !==
        input.config.policy.recovery.emergencyWorkerEnergyBudget ||
      existing.request.cpu?.minimum !== RECOVERY_OBJECTIVE_CPU_UNITS ||
      existing.request.cpu.desired !== RECOVERY_OBJECTIVE_CPU_UNITS ||
      existing.request.spawn !== null);
  const renewalDue =
    existing !== undefined &&
    existing.request.expiresAt - input.tick <= input.config.policy.leases.renewalWindowTicks;
  const revision =
    existing === undefined
      ? record.revision
      : renewalDue || claimsChanged || !existingReservable
        ? Math.max(
            record.revision,
            checkedIncrement(existing.revision, "recovery request revision"),
          )
        : existing.revision;
  const expiresAt =
    existing !== undefined && !renewalDue && !claimsChanged && existingReservable
      ? existing.request.expiresAt
      : checkedAdd(input.tick, input.config.policy.leases.durationTicks, "recovery request expiry");
  return deepFreeze({
    colonyId: record.roomName,
    category: "emergency-spawn",
    issuer,
    revision,
    expiresAt,
    energy: {
      minimum: 200,
      desired: input.config.policy.recovery.emergencyWorkerEnergyBudget,
    },
    cpu: { minimum: RECOVERY_OBJECTIVE_CPU_UNITS, desired: RECOVERY_OBJECTIVE_CPU_UNITS },
    spawn: null,
  });
}

function ledgerCapacity(
  records: readonly ColonyRecord[],
  evidence: ReadonlyMap<string, ColonyEvidence>,
  input: ColonyDirectorInput,
): BudgetLedgerCapacity {
  const energy = records.flatMap((record) => {
    const facts = evidence.get(record.roomName);
    if (facts === undefined || !facts.owned || record.state === "lost") {
      return [];
    }
    const available = Math.max(
      0,
      Math.min(facts.room.energyAvailable, facts.room.energyCapacityAvailable),
    );
    return [
      {
        colonyId: record.roomName,
        available,
        protected: Math.min(input.config.policy.recovery.protectedSpawnEnergy, available),
      },
    ];
  });
  const spawns: SpawnBudgetCapacity[] = records.flatMap((record) => {
    const facts = evidence.get(record.roomName);
    if (facts === undefined || !facts.owned || record.state === "lost") {
      return [];
    }
    return facts.room.ownedSpawns.map((spawn) => ({
      colonyId: record.roomName,
      spawnId: spawn.id,
      blocked:
        spawn.spawning === null
          ? []
          : [
              {
                spawnId: spawn.id,
                startTick: input.tick,
                endTick: checkedAdd(
                  input.tick,
                  Math.max(1, spawn.spawning.remainingTime),
                  "observed spawn interval",
                ),
              },
            ],
    }));
  });
  const cpu = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(Math.max(0, input.cpuBudget.available) * CPU_RESERVATION_UNITS_PER_CPU),
  );
  return deepFreeze({ energy, cpu, spawns });
}

function objectiveFor(
  record: ColonyRecord,
  request: BudgetRequest,
  result: BudgetLedgerResult,
): ColonyObjective {
  const decision = result.decisions.find(
    (candidate) =>
      candidate.colonyId === request.colonyId &&
      candidate.category === request.category &&
      candidate.issuer === request.issuer &&
      candidate.revision === request.revision,
  );
  const reservationId =
    decision !== undefined && (decision.status === "granted" || decision.status === "retained")
      ? decision.reservationId
      : null;
  const funded = reservationId !== null;
  return deepFreeze({
    id: request.issuer,
    colonyId: record.roomName,
    kind: "restore-workforce",
    category: "emergency-spawn",
    revision: request.revision,
    reasonCode: "recovery-workforce-missing",
    status: funded ? "funded" : "blocked",
    budgetReasonCode: decision?.reasonCode ?? "invalid-request",
    reservationId,
    demand: { kind: "recovery-worker", work: 1, carry: 1, move: 1 },
  });
}

function sortDecisions(decisions: readonly BudgetDecision[]): readonly BudgetDecision[] {
  return [...decisions].sort(
    (left, right) =>
      compareStrings(left.reservationId, right.reservationId) || left.revision - right.revision,
  );
}

function compareBudgetRequestsSafely(left: BudgetRequest, right: BudgetRequest): number {
  const leftRank = BUDGET_CATEGORIES.indexOf(left.category);
  const rightRank = BUDGET_CATEGORIES.indexOf(right.category);
  return (
    leftRank - rightRank ||
    safeRequestNumber(left.expiresAt) - safeRequestNumber(right.expiresAt) ||
    compareStrings(safeRequestText(left.colonyId), safeRequestText(right.colonyId)) ||
    compareStrings(safeRequestText(left.issuer), safeRequestText(right.issuer)) ||
    safeRequestNumber(left.revision) - safeRequestNumber(right.revision) ||
    compareStrings(safeRequestKey(left), safeRequestKey(right))
  );
}

function safeRequestNumber(value: unknown): number {
  return isNonNegativeSafeInteger(value) ? value : -1;
}

function safeRequestText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeRequestKey(request: BudgetRequest): string {
  try {
    return JSON.stringify([
      request.category,
      request.expiresAt,
      request.colonyId,
      request.issuer,
      request.revision,
      request.energy === null ? null : [request.energy.minimum, request.energy.desired],
      request.spawn === null
        ? null
        : [request.spawn.spawnId, request.spawn.startTick, request.spawn.endTick],
      request.cpu === null ? null : [request.cpu.minimum, request.cpu.desired],
    ]);
  } catch {
    return "";
  }
}

function safeReservationId(request: BudgetRequest): string | null {
  try {
    return reservationIdFor(request);
  } catch {
    return null;
  }
}

function invalidExternalDecision(request: BudgetRequest): BudgetDecision {
  const colonyId = validDecisionText(request.colonyId, 64) ?? "invalid";
  const issuer = validDecisionText(request.issuer, 128) ?? "invalid";
  const category = BUDGET_CATEGORIES.includes(request.category)
    ? request.category
    : "optional-growth";
  const revision = isNonNegativeSafeInteger(request.revision) ? request.revision : 0;
  return deepFreeze({
    reservationId: `invalid/${String(colonyId.length)}:${colonyId}/${String(issuer.length)}:${issuer}/${String(revision)}`,
    colonyId,
    category,
    issuer,
    revision,
    status: "denied",
    reasonCode: "invalid-request",
    grant: null,
  });
}

function validDecisionText(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function checkedIncrement(value: number, subject: string): number {
  return checkedAdd(value, 1, subject);
}

function checkedAdd(left: number, right: number, subject: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${subject} exceeds the safe integer range`);
  }
  return result;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function assertTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0 || Object.is(tick, -0)) {
    throw new TypeError("ColonyDirector tick must be a non-negative safe integer");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
