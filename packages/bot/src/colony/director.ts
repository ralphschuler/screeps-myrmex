import { classifyPlayerRelation, isFeatureEnabled, type RuntimeConfig } from "../config";
import type { CpuBudget, CpuMode } from "../runtime/kernel";
import type { CreepSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";
import { BudgetLedger, reservationIdFor } from "./budget-ledger";
import {
  CPU_RESERVATION_UNITS_PER_CPU,
  BUDGET_CATEGORIES,
  MAX_BUDGET_REQUESTS_PER_TICK,
  MAX_COLONIES,
  MAX_SPAWN_INTERVAL_TICKS,
  RECOVERY_OBJECTIVE_CPU_UNITS,
  type BudgetDecision,
  type BudgetLedgerCapacity,
  type BudgetLedgerResult,
  type BudgetRequest,
  type ColoniesOwnerV1,
  type ColonyDirectorResult,
  type ColonyObjective,
  type ColonyPlanReason,
  type ColonyPlanStatus,
  type ColonyRecord,
  type ColonyState,
  type ColonyTransitionReason,
  type ColonyView,
  type LedgerEntry,
  type LedgerTransition,
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
  /** Undefined requests a provisional energy/CPU view; an array requests exact spawn authorization. */
  readonly recoverySpawnSelections?: readonly RecoverySpawnSelection[];
  /** Stable objective IDs already represented by an observed or durable expected creep. */
  readonly satisfiedRecoveryObjectiveIds?: readonly string[];
}

export interface RecoverySpawnSelection {
  readonly objectiveId: string;
  readonly colonyId: string;
  readonly energyCost: number;
  readonly spawn: {
    readonly spawnId: string;
    readonly startTick: number;
    readonly endTick: number;
  };
}

export type ColonySpawnCommandSettlement =
  | {
      readonly reservationId: string;
      readonly status: "scheduled";
      readonly energyCost: number;
    }
  | {
      readonly reservationId: string;
      readonly status: "not-scheduled";
    };

interface AuthorizedRecoverySpawn {
  readonly reservationId: string;
  readonly energyCost: number;
  readonly spawn: RecoverySpawnSelection["spawn"];
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
    if (
      input.recoverySpawnSelections !== undefined ||
      input.satisfiedRecoveryObjectiveIds !== undefined
    ) {
      throw new TypeError("exact recovery planning requires a tick-local ColonyDirector session");
    }
    return this.begin(input).settle(input.tick, []);
  }

  begin(input: ColonyDirectorInput): ColonyDirectorSession {
    assertTick(input.tick);
    if (!isFeatureEnabled(input.config, "phase1.colony")) {
      return emptySession(emptyResult("disabled", "feature-disabled"), input.tick);
    }
    if (input.owner === null || input.owner === undefined) {
      return emptySession(emptyResult("owner-unavailable", "owner-unavailable"), input.tick);
    }

    const resolved = resolveColoniesOwner(input.owner);
    if (resolved.owner === null) {
      const reason =
        resolved.status === "future-schema" ? "owner-future-schema" : "owner-malformed";
      return emptySession(emptyResult(reason, reason), input.tick);
    }
    if ((input.requests?.length ?? 0) > MAX_BUDGET_REQUESTS_PER_TICK * 2) {
      throw new RangeError(
        `raw colony requests exceed the bounded input cap of ${String(MAX_BUDGET_REQUESTS_PER_TICK * 2)}`,
      );
    }
    const exactRecoveryMode = input.recoverySpawnSelections !== undefined;
    const recoverySelections = normalizeRecoverySelections(
      input.recoverySpawnSelections ?? [],
      input,
    );
    const satisfiedRecoveryObjectives = normalizeSatisfiedObjectiveIds(
      input.satisfiedRecoveryObjectiveIds ?? [],
    );

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
      if (request.issuer === recoveryObjectiveId(request.colonyId)) {
        preDecisions.push(deniedDecision(request, "invalid-request"));
        continue;
      }
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
      readonly admitted: boolean;
    }> = [];
    const usedRecoverySelections = new Set<string>();
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
      const objectiveId = recoveryObjectiveId(record.roomName);
      if (satisfiedRecoveryObjectives.has(objectiveId)) {
        continue;
      }
      const selection = recoverySelections.get(objectiveId) ?? null;
      if (selection !== null) {
        if (selection.colonyId !== record.roomName) {
          throw new TypeError("recovery spawn selection colony does not match its objective");
        }
        usedRecoverySelections.add(objectiveId);
      }
      const request = recoveryRequest(record, knownLedger, input, selection);
      const admitted = !exactRecoveryMode || selection !== null;
      if (admitted) {
        objectiveRequests.push(request);
      }
      objectiveRecords.push({ record, request, admitted });
    }
    if (usedRecoverySelections.size !== recoverySelections.size) {
      throw new TypeError("recovery spawn selection does not match an active colony objective");
    }

    const ledger = new BudgetLedger(knownLedger);
    const ledgerResult = ledger.reconcile({
      tick: input.tick,
      capacity: ledgerCapacity(records, evidence, input),
      requests: [...eligibleRequests, ...objectiveRequests],
    });
    const objectives = objectiveRecords.map(({ record, request, admitted }) =>
      objectiveFor(record, request, ledgerResult, admitted),
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

    const result: ColonyDirectorResult = deepFreeze({
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
    const authorizedRecoverySpawns = objectives.flatMap((objective) => {
      if (objective.reservationId === null) {
        return [];
      }
      const selection = recoverySelections.get(objective.id);
      return selection === undefined
        ? []
        : [
            {
              reservationId: objective.reservationId,
              energyCost: selection.energyCost,
              spawn: selection.spawn,
            },
          ];
    });
    return new ColonyDirectorSession(
      result,
      currentOwner,
      replacement,
      mustInitialize,
      authorizedRecoverySpawns,
      input.tick,
    );
  }
}

/**
 * Tick-local continuation owned by ColonyDirector. It keeps the one authoritative ledger draft
 * private until irreversible spawn results can be settled before the owner is staged.
 */
export class ColonyDirectorSession {
  public readonly result: ColonyDirectorResult;
  private readonly draftResult: ColonyDirectorResult;
  private settlementKey: string | null = null;
  private settledResult: ColonyDirectorResult | null = null;

  public constructor(
    result: ColonyDirectorResult,
    private readonly baseOwner: ColoniesOwnerV1 | null,
    private readonly draftOwner: ColoniesOwnerV1 | null,
    private readonly mustInitialize: boolean,
    private readonly authorizedRecoverySpawns: readonly AuthorizedRecoverySpawn[],
    private readonly plannedAt = 0,
  ) {
    this.draftResult = result;
    this.result =
      result.replacementOwner === null ? result : deepFreeze({ ...result, replacementOwner: null });
    Object.freeze(this.authorizedRecoverySpawns);
  }

  public settle(
    tick: number,
    settlements: readonly ColonySpawnCommandSettlement[],
  ): ColonyDirectorResult {
    assertTick(tick);
    if (tick !== this.plannedAt) {
      throw new TypeError("spawn settlement tick must equal its colony plan tick");
    }
    const validatedSettlements = validateSpawnSettlements(settlements);

    const authorized = new Map(
      this.authorizedRecoverySpawns.map((entry) => [entry.reservationId, entry]),
    );
    const byReservation = new Map<string, ColonySpawnCommandSettlement>();
    for (const settlement of validatedSettlements) {
      if (byReservation.has(settlement.reservationId)) {
        throw new TypeError("duplicate spawn settlement reservation id");
      }
      if (!authorized.has(settlement.reservationId)) {
        throw new TypeError("spawn settlement references an unauthorized reservation");
      }
      byReservation.set(
        settlement.reservationId,
        settlement.status === "scheduled"
          ? {
              reservationId: settlement.reservationId,
              status: "scheduled",
              energyCost: settlement.energyCost,
            }
          : { reservationId: settlement.reservationId, status: "not-scheduled" },
      );
    }
    const normalized = [...byReservation.values()].sort((left, right) =>
      compareStrings(left.reservationId, right.reservationId),
    );
    const settlementKey = JSON.stringify([tick, normalized]);
    if (this.settlementKey !== null) {
      if (this.settlementKey !== settlementKey || this.settledResult === null) {
        throw new TypeError("ColonyDirector session was already settled differently");
      }
      return this.settledResult;
    }
    if (
      this.baseOwner === null ||
      this.draftOwner === null ||
      this.draftResult.status !== "planned"
    ) {
      if (normalized.length > 0) {
        throw new TypeError("spawn results cannot settle without a planned colonies owner");
      }
      this.settlementKey = settlementKey;
      this.settledResult = this.draftResult;
      return this.draftResult;
    }

    if (this.authorizedRecoverySpawns.length === 0) {
      this.settlementKey = settlementKey;
      this.settledResult = this.draftResult;
      return this.draftResult;
    }
    const ledger = new BudgetLedger(this.draftOwner.ledger);
    const settlementTransitions: LedgerTransition[] = [];
    for (const authorization of [...this.authorizedRecoverySpawns].sort((left, right) =>
      compareStrings(left.reservationId, right.reservationId),
    )) {
      const settlement = byReservation.get(authorization.reservationId);
      if (settlement?.status !== "scheduled") {
        const released = ledger.release(authorization.reservationId, tick);
        settlementTransitions.push(...released.transitions);
        continue;
      }
      if (settlement.energyCost !== authorization.energyCost) {
        throw new TypeError("scheduled spawn settlement changed its authorized energy cost");
      }
      const entry = ledger
        .snapshot()
        .entries.find(({ reservationId }) => reservationId === authorization.reservationId);
      if (
        entry === undefined ||
        entry.grant.spawn === null ||
        !spawnClaimsEqual(entry.grant.spawn, authorization.spawn) ||
        authorization.energyCost > entry.grant.energy
      ) {
        throw new TypeError("scheduled spawn settlement exceeds its atomic grant");
      }
      const consumed = ledger.consume(
        authorization.reservationId,
        {
          energy: authorization.energyCost,
          cpu: entry.grant.cpu,
          spawn: true,
        },
        tick,
      );
      settlementTransitions.push(...consumed.transitions);
      const consumedEntry = consumed.entries.find(
        ({ reservationId }) => reservationId === authorization.reservationId,
      );
      if (
        !consumed.transitions.some(
          (transition) =>
            transition.reservationId === authorization.reservationId &&
            transition.action === "consume" &&
            transition.reasonCode === "consumed",
        ) ||
        consumedEntry === undefined ||
        consumedEntry.consumed.energy !== authorization.energyCost ||
        consumedEntry.consumed.cpu !== entry.grant.cpu ||
        !consumedEntry.consumed.spawn
      ) {
        throw new TypeError("scheduled spawn settlement was not consumed atomically");
      }
      if (consumedEntry.status === "active") {
        const released = ledger.release(authorization.reservationId, tick);
        settlementTransitions.push(...released.transitions);
      }
    }

    const ownerLedger = ledger.snapshot().entries;
    const candidateAtBaseRevision = canonicalColoniesOwner(
      this.baseOwner.revision,
      this.draftOwner.colonies,
      ownerLedger,
    );
    const ownerChanged = !coloniesOwnerEquals(this.baseOwner, candidateAtBaseRevision);
    const replacement = ownerChanged
      ? canonicalColoniesOwner(
          checkedIncrement(this.baseOwner.revision, "colonies owner revision"),
          this.draftOwner.colonies,
          ownerLedger,
        )
      : this.baseOwner;
    const visibleColonyIds = new Set(
      this.draftResult.colonies
        .filter(({ visibility }) => visibility === "visible")
        .map(({ id }) => id),
    );
    const visibleReservations = ownerLedger.filter(({ colonyId }) =>
      visibleColonyIds.has(colonyId),
    );
    const visibleSnapshot = new BudgetLedger(visibleReservations).snapshot();

    const result: ColonyDirectorResult = deepFreeze({
      ...this.draftResult,
      ownerRevision: replacement.revision,
      reservations: visibleSnapshot.entries,
      transitions: [...this.draftResult.transitions, ...settlementTransitions],
      totals: visibleSnapshot.totals,
      replacementOwner: ownerChanged || this.mustInitialize ? replacement : null,
    });
    this.settlementKey = settlementKey;
    this.settledResult = result;
    return result;
  }
}

export function emptyColonyPlanningResult(): ColonyDirectorResult {
  return emptyResult("not-run", "not-run");
}

function emptySession(result: ColonyDirectorResult, tick: number): ColonyDirectorSession {
  return new ColonyDirectorSession(result, null, null, false, [], tick);
}

function normalizeRecoverySelections(
  selections: readonly RecoverySpawnSelection[],
  input: ColonyDirectorInput,
): ReadonlyMap<string, RecoverySpawnSelection> {
  if (selections.length > MAX_COLONIES) {
    throw new RangeError("recovery spawn selections exceed the colony cap");
  }
  const normalized = new Map<string, RecoverySpawnSelection>();
  for (const selection of selections) {
    if (
      !isBoundedIdentifier(selection.objectiveId, 128) ||
      !isBoundedIdentifier(selection.colonyId, 64) ||
      !isNonNegativeSafeInteger(selection.energyCost) ||
      selection.energyCost === 0 ||
      selection.energyCost > input.config.policy.spawn.maximumBodyEnergy ||
      !isBoundedIdentifier(selection.spawn.spawnId, 128) ||
      selection.spawn.startTick !== input.tick ||
      !isNonNegativeSafeInteger(selection.spawn.endTick) ||
      selection.spawn.endTick <= selection.spawn.startTick ||
      selection.spawn.endTick - selection.spawn.startTick > MAX_SPAWN_INTERVAL_TICKS
    ) {
      throw new TypeError("invalid exact recovery spawn selection");
    }
    if (normalized.has(selection.objectiveId)) {
      throw new TypeError("duplicate recovery spawn selection objective id");
    }
    normalized.set(
      selection.objectiveId,
      deepFreeze({
        objectiveId: selection.objectiveId,
        colonyId: selection.colonyId,
        energyCost: selection.energyCost,
        spawn: { ...selection.spawn },
      }),
    );
  }
  return normalized;
}

function normalizeSatisfiedObjectiveIds(values: readonly string[]): ReadonlySet<string> {
  if (values.length > MAX_COLONIES) {
    throw new RangeError("satisfied recovery objective IDs exceed the colony cap");
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (!isBoundedIdentifier(value, 128) || normalized.has(value)) {
      throw new TypeError("invalid or duplicate satisfied recovery objective id");
    }
    normalized.add(value);
  }
  return normalized;
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
  selection: RecoverySpawnSelection | null,
): BudgetRequest {
  const issuer = recoveryObjectiveId(record.roomName);
  const minimumEnergy = selection?.energyCost ?? 200;
  const desiredEnergy = Math.max(
    minimumEnergy,
    input.config.policy.recovery.emergencyWorkerEnergyBudget,
  );
  const spawn = selection?.spawn ?? null;
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
    (existing.request.energy?.minimum !== minimumEnergy ||
      existing.request.energy.desired !== desiredEnergy ||
      existing.request.cpu?.minimum !== RECOVERY_OBJECTIVE_CPU_UNITS ||
      existing.request.cpu.desired !== RECOVERY_OBJECTIVE_CPU_UNITS ||
      !spawnClaimsEqual(existing.request.spawn, spawn));
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
      minimum: minimumEnergy,
      desired: desiredEnergy,
    },
    cpu: { minimum: RECOVERY_OBJECTIVE_CPU_UNITS, desired: RECOVERY_OBJECTIVE_CPU_UNITS },
    spawn,
  });
}

function recoveryObjectiveId(roomName: string): string {
  return `colony/${roomName}/restore-workforce`;
}

function spawnClaimsEqual(
  left: RecoverySpawnSelection["spawn"] | null,
  right: RecoverySpawnSelection["spawn"] | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.spawnId === right.spawnId &&
      left.startTick === right.startTick &&
      left.endTick === right.endTick)
  );
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
  admitted = true,
): ColonyObjective {
  const decision = admitted
    ? result.decisions.find(
        (candidate) =>
          candidate.colonyId === request.colonyId &&
          candidate.category === request.category &&
          candidate.issuer === request.issuer &&
          candidate.revision === request.revision,
      )
    : undefined;
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
    budgetReasonCode: decision?.reasonCode ?? (admitted ? "invalid-request" : "spawn-not-observed"),
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

function validateSpawnSettlements(input: unknown): readonly ColonySpawnCommandSettlement[] {
  if (!Array.isArray(input)) {
    throw new TypeError("spawn settlements must be an array");
  }
  const rawSettlements: readonly unknown[] = input;
  if (rawSettlements.length > MAX_BUDGET_REQUESTS_PER_TICK) {
    throw new RangeError("spawn settlement input exceeds the bounded reservation cap");
  }

  return rawSettlements.map((value) => {
    if (!isRecord(value)) {
      throw new TypeError("invalid spawn settlement");
    }
    const settlement = value;
    const reservationId = settlement["reservationId"];
    if (typeof reservationId !== "string") {
      throw new TypeError("invalid spawn settlement reservation id");
    }
    const status = settlement["status"];
    if (status !== "scheduled" && status !== "not-scheduled") {
      throw new TypeError("invalid spawn settlement status");
    }
    if (status === "not-scheduled") {
      return { reservationId, status };
    }
    const energyCost = settlement["energyCost"];
    if (!isNonNegativeSafeInteger(energyCost) || energyCost === 0) {
      throw new TypeError("spawn settlement energy cost must be a positive safe integer");
    }
    return { reservationId, status, energyCost };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  );
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
