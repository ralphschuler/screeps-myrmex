import {
  BUDGET_CATEGORIES,
  MAX_ACTIVE_RESERVATIONS,
  MAX_BUDGET_ISSUER_CODE_UNITS,
  MAX_BUDGET_REQUESTS_PER_TICK,
  MAX_LEDGER_ENTRIES,
  MAX_LEDGER_TRANSITIONS_PER_TICK,
  MAX_SPAWN_INTERVAL_TICKS,
  type BudgetCategory,
  type BudgetConsumption,
  type BudgetDecision,
  type BudgetGrant,
  type BudgetLedgerCapacity,
  type BudgetLedgerResult,
  type BudgetReasonCode,
  type BudgetRequest,
  type LedgerEntry,
  type LedgerTransition,
  type SpawnIntervalClaim,
} from "./contracts";
import { ledgerIssuerKey } from "./persistence";
import { formatReservationId } from "./reservation-id";

export interface BudgetLedgerReconciliationInput {
  readonly tick: number;
  readonly capacity: BudgetLedgerCapacity;
  readonly requests: readonly BudgetRequest[];
}

interface AllocationCandidate {
  readonly request: BudgetRequest;
  readonly reservationId: string;
  readonly existing: LedgerEntry | null;
}

interface ProvisionalAllocation {
  readonly grant: BudgetGrant | null;
  readonly reasonCode: BudgetReasonCode;
}

const ZERO_GRANT: BudgetGrant = Object.freeze({ energy: 0, cpu: 0, spawn: null });
const ZERO_CONSUMPTION: BudgetConsumption = Object.freeze({ energy: 0, cpu: 0, spawn: false });
const PROTECTED_CATEGORIES: ReadonlySet<BudgetCategory> = new Set([
  "emergency-spawn",
  "defense",
  "replacement",
]);

/**
 * The sole authority for colony energy, CPU, and exact spawn-interval reservations.
 *
 * Reconciliation treats the supplied request set as the complete desired set for the tick. Existing
 * active or pending reservations not present in that set are released. The class owns an isolated
 * clone of the supplied entries, and every result is deeply frozen.
 */
export class BudgetLedger {
  private entries: readonly LedgerEntry[];

  public constructor(existingEntries: readonly LedgerEntry[] = []) {
    if (existingEntries.length > MAX_LEDGER_ENTRIES) {
      throw new RangeError(
        `ledger entries exceed the structural cap of ${String(MAX_LEDGER_ENTRIES)}`,
      );
    }
    const entries = existingEntries.map(cloneEntry).sort(compareEntries);
    assertUniqueEntries(entries);
    this.entries = entries;
  }

  public reconcile(input: BudgetLedgerReconciliationInput): BudgetLedgerResult {
    assertTick(input.tick);
    if (input.requests.length > MAX_BUDGET_REQUESTS_PER_TICK * 2) {
      throw new RangeError(
        `raw budget requests exceed the bounded input cap of ${String(MAX_BUDGET_REQUESTS_PER_TICK * 2)}`,
      );
    }
    const capacity = normalizeCapacity(input.capacity);
    const expiry = expireEntries(this.entries, input.tick);
    const transitions = [...expiry.transitions];
    const decisions: BudgetDecision[] = [];
    const entryByKey = new Map(expiry.entries.map((entry) => [ledgerIssuerKey(entry), entry]));

    const validRequests: BudgetRequest[] = [];
    const invalidRequests: BudgetRequest[] = [];
    for (const request of input.requests) {
      if (isValidRequest(request)) {
        validRequests.push(cloneRequest(request));
      } else {
        invalidRequests.push(request);
      }
    }
    invalidRequests.sort(compareRequestData);
    for (const request of invalidRequests) {
      decisions.push(invalidDecision(request));
    }
    validRequests.sort(compareRequests);
    const admitted = validRequests.slice(0, MAX_BUDGET_REQUESTS_PER_TICK);
    for (const request of validRequests.slice(MAX_BUDGET_REQUESTS_PER_TICK)) {
      decisions.push(deniedDecision(request, "request-cap-exceeded"));
    }

    const candidates: AllocationCandidate[] = [];
    const candidateKeys = new Set<string>();
    const preserveKeys = new Set<string>();
    const grouped = groupRequests(admitted);

    for (const [key, group] of grouped) {
      const existing = entryByKey.get(key) ?? null;
      const highestRevision = group.reduce(
        (highest, request) => Math.max(highest, request.revision),
        0,
      );
      const highest = uniqueRequests(
        group.filter((request) => request.revision === highestRevision),
      );

      for (const request of group) {
        if (request.revision < highestRevision) {
          decisions.push(deniedDecision(request, "stale-revision"));
        }
      }

      if (highest.length !== 1) {
        for (const request of highest) {
          decisions.push(deniedDecision(request, "revision-reused"));
        }
        if (existing !== null) {
          retainExistingReservation(existing, candidates, candidateKeys, preserveKeys);
        }
        continue;
      }

      const request = highest[0];
      if (request === undefined) {
        continue;
      }
      if (request.expiresAt < input.tick) {
        decisions.push(deniedDecision(request, "expired"));
        if (existing !== null) {
          retainExistingReservation(existing, candidates, candidateKeys, preserveKeys);
        }
        continue;
      }
      if (existing !== null && request.revision < existing.revision) {
        decisions.push(deniedDecision(request, "stale-revision"));
        retainExistingReservation(existing, candidates, candidateKeys, preserveKeys);
        continue;
      }
      if (existing !== null && request.revision === existing.revision) {
        if (!requestsEqual(request, existing.request)) {
          decisions.push(deniedDecision(request, "revision-reused"));
          retainExistingReservation(existing, candidates, candidateKeys, preserveKeys);
          continue;
        }
        if (!isReservable(existing.status)) {
          decisions.push(terminalDecision(existing));
          preserveKeys.add(key);
          continue;
        }
      }

      const candidate: AllocationCandidate = {
        request,
        reservationId: reservationIdFor(request),
        existing: existing !== null && request.revision === existing.revision ? existing : null,
      };
      if (
        existing !== null &&
        request.revision > existing.revision &&
        isReservable(existing.status)
      ) {
        pushTransition(transitions, {
          reservationId: existing.reservationId,
          action: "release",
          reasonCode: "superseded",
        });
      }
      candidates.push(candidate);
      candidateKeys.add(key);
    }

    for (const [key, entry] of [...entryByKey.entries()].sort(compareMapEntries)) {
      if (!isReservable(entry.status) || candidateKeys.has(key) || preserveKeys.has(key)) {
        continue;
      }
      const reasonCode = "objective-satisfied";
      const released = releasedEntry(entry, input.tick, reasonCode);
      entryByKey.set(key, released);
      pushTransition(transitions, {
        reservationId: entry.reservationId,
        action: "release",
        reasonCode,
      });
    }

    candidates.sort(compareCandidates);
    const energyAllocated = new Map<string, number>();
    const protectedAllocated = new Map<string, number>();
    const spawnAllocated = new Map<string, SpawnIntervalClaim[]>();
    let cpuAllocated = 0;
    let activeReservations = 0;

    for (const candidate of candidates) {
      const key = ledgerIssuerKey(candidate.request);
      const addingEntry = !entryByKey.has(key);
      if (addingEntry && entryByKey.size >= MAX_LEDGER_ENTRIES) {
        decisions.push(deniedDecision(candidate.request, "ledger-entry-cap-exceeded"));
        continue;
      }
      if (activeReservations >= MAX_ACTIVE_RESERVATIONS) {
        const denied = denyCandidate(candidate, input.tick, "reservation-cap-exceeded");
        entryByKey.set(key, denied.entry);
        decisions.push(denied.decision);
        appendOptionalTransition(transitions, denied.transition);
        continue;
      }

      const allocation = allocateCandidate(candidate, {
        tick: input.tick,
        capacity,
        energyAllocated,
        protectedAllocated,
        cpuAllocated,
        spawnAllocated,
      });
      if (allocation.grant === null) {
        const denied = denyCandidate(candidate, input.tick, allocation.reasonCode);
        entryByKey.set(key, denied.entry);
        decisions.push(denied.decision);
        appendOptionalTransition(transitions, denied.transition);
        continue;
      }

      const previous = candidate.existing;
      const consumed = previous?.consumed ?? ZERO_CONSUMPTION;
      const reasonCode = isReducedGrant(candidate.request, allocation.grant)
        ? "granted-reduced"
        : "granted";
      const unchanged =
        previous !== null &&
        previous.status === "active" &&
        grantsEqual(previous.grant, allocation.grant);
      const entry: LedgerEntry = unchanged
        ? previous
        : {
            reservationId: candidate.reservationId,
            colonyId: candidate.request.colonyId,
            category: candidate.request.category,
            issuer: candidate.request.issuer,
            revision: candidate.request.revision,
            request: cloneRequest(candidate.request),
            grant: cloneGrant(allocation.grant),
            consumed: cloneConsumption(consumed),
            createdAt: previous?.createdAt ?? input.tick,
            updatedAt: input.tick,
            status: "active",
            reasonCode,
          };
      entryByKey.set(key, entry);
      activeReservations += 1;
      const outstandingEnergy = allocation.grant.energy - consumed.energy;
      const outstandingCpu = allocation.grant.cpu - consumed.cpu;
      energyAllocated.set(
        candidate.request.colonyId,
        (energyAllocated.get(candidate.request.colonyId) ?? 0) + outstandingEnergy,
      );
      if (PROTECTED_CATEGORIES.has(candidate.request.category)) {
        protectedAllocated.set(
          candidate.request.colonyId,
          (protectedAllocated.get(candidate.request.colonyId) ?? 0) + outstandingEnergy,
        );
      }
      cpuAllocated += outstandingCpu;
      if (allocation.grant.spawn !== null && !consumed.spawn) {
        const allocated = spawnAllocated.get(allocation.grant.spawn.spawnId) ?? [];
        allocated.push(allocation.grant.spawn);
        spawnAllocated.set(allocation.grant.spawn.spawnId, allocated);
      }

      const decision: BudgetDecision = {
        reservationId: candidate.reservationId,
        colonyId: candidate.request.colonyId,
        category: candidate.request.category,
        issuer: candidate.request.issuer,
        revision: candidate.request.revision,
        status: unchanged ? "retained" : "granted",
        reasonCode: unchanged ? "already-granted" : reasonCode,
        grant: cloneGrant(allocation.grant),
      };
      decisions.push(decision);
      pushTransition(transitions, {
        reservationId: candidate.reservationId,
        action: unchanged ? "retain" : "grant",
        reasonCode: decision.reasonCode,
      });
    }

    const result = makeResult([...entryByKey.values()], decisions, transitions);
    this.entries = result.entries;
    return result;
  }

  public consume(
    reservationId: string,
    cumulative: BudgetConsumption,
    tick: number,
  ): BudgetLedgerResult {
    assertTick(tick);
    if (!isValidConsumption(cumulative)) {
      throw new TypeError("budget consumption must contain non-negative safe cumulative values");
    }
    const entries = [...this.entries];
    const index = entries.findIndex((entry) => entry.reservationId === reservationId);
    if (index < 0) {
      return this.finishOperation(entries, [
        { reservationId, action: "consume", reasonCode: "reservation-not-found" },
      ]);
    }
    const entry = entries[index];
    if (entry === undefined) {
      throw new Error("ledger entry index invariant failed");
    }
    const terminalReason = terminalIdempotencyReason(entry.status);
    if (terminalReason !== null) {
      return this.finishOperation(entries, [
        { reservationId, action: "consume", reasonCode: terminalReason },
      ]);
    }
    if (consumptionRegressed(cumulative, entry.consumed)) {
      return this.finishOperation(entries, [
        { reservationId, action: "consume", reasonCode: "consumption-regressed" },
      ]);
    }
    if (consumptionExceeded(cumulative, entry.grant)) {
      return this.finishOperation(entries, [
        { reservationId, action: "consume", reasonCode: "consumption-exceeded" },
      ]);
    }
    if (consumptionsEqual(cumulative, entry.consumed)) {
      return this.finishOperation(entries, [
        { reservationId, action: "consume", reasonCode: "already-consumed" },
      ]);
    }

    const consumed = cloneConsumption(cumulative);
    entries[index] = {
      ...entry,
      consumed,
      updatedAt: tick,
      status: grantFullyConsumed(entry.grant, consumed) ? "consumed" : "active",
      reasonCode: "consumed",
    };
    return this.finishOperation(entries, [
      { reservationId, action: "consume", reasonCode: "consumed" },
    ]);
  }

  public release(
    reservationId: string,
    tick: number,
    reasonCode: BudgetReasonCode = "released",
  ): BudgetLedgerResult {
    assertTick(tick);
    const entries = [...this.entries];
    const index = entries.findIndex((entry) => entry.reservationId === reservationId);
    if (index < 0) {
      return this.finishOperation(entries, [
        { reservationId, action: "release", reasonCode: "reservation-not-found" },
      ]);
    }
    const entry = entries[index];
    if (entry === undefined) {
      throw new Error("ledger entry index invariant failed");
    }
    const terminalReason = terminalIdempotencyReason(entry.status);
    if (terminalReason !== null) {
      return this.finishOperation(entries, [
        { reservationId, action: "release", reasonCode: terminalReason },
      ]);
    }
    entries[index] = releasedEntry(entry, tick, reasonCode);
    return this.finishOperation(entries, [{ reservationId, action: "release", reasonCode }]);
  }

  public expire(tick: number): BudgetLedgerResult {
    assertTick(tick);
    const expiry = expireEntries(this.entries, tick);
    const result = makeResult(expiry.entries, [], expiry.transitions);
    this.entries = result.entries;
    return result;
  }

  public snapshot(): BudgetLedgerResult {
    return makeResult(this.entries, [], []);
  }

  private finishOperation(
    entries: readonly LedgerEntry[],
    transitions: readonly LedgerTransition[],
  ): BudgetLedgerResult {
    const result = makeResult(entries, [], transitions);
    this.entries = result.entries;
    return result;
  }
}

export function reservationIdFor(request: BudgetRequest): string {
  if (!isValidRequest(request)) {
    throw new TypeError("cannot derive a reservation id from an invalid request");
  }
  return formatReservationId(request);
}

function allocateCandidate(
  candidate: AllocationCandidate,
  state: {
    readonly tick: number;
    readonly capacity: BudgetLedgerCapacity;
    readonly energyAllocated: ReadonlyMap<string, number>;
    readonly protectedAllocated: ReadonlyMap<string, number>;
    readonly cpuAllocated: number;
    readonly spawnAllocated: ReadonlyMap<string, readonly SpawnIntervalClaim[]>;
  },
): ProvisionalAllocation {
  const { request, existing } = candidate;
  const consumed = existing?.consumed ?? ZERO_CONSUMPTION;
  const energyCapacity = state.capacity.energy.find(
    (candidateCapacity) => candidateCapacity.colonyId === request.colonyId,
  );
  let energy = consumed.energy;
  if (request.energy !== null) {
    if (energyCapacity === undefined) {
      return { grant: null, reasonCode: "insufficient-energy" };
    }
    const alreadyAllocated = state.energyAllocated.get(request.colonyId) ?? 0;
    const rawAvailable = energyCapacity.available - alreadyAllocated;
    const minimumOutstanding = Math.max(0, request.energy.minimum - consumed.energy);
    const desiredOutstanding = Math.max(0, request.energy.desired - consumed.energy);
    let available = rawAvailable;
    if (!PROTECTED_CATEGORIES.has(request.category)) {
      const usedProtected = state.protectedAllocated.get(request.colonyId) ?? 0;
      const floorRemaining = Math.max(0, energyCapacity.protected - usedProtected);
      available = Math.max(0, rawAvailable - floorRemaining);
      if (available < minimumOutstanding && rawAvailable >= minimumOutstanding) {
        return { grant: null, reasonCode: "protected-energy-floor" };
      }
    }
    if (available < minimumOutstanding) {
      return { grant: null, reasonCode: "insufficient-energy" };
    }
    energy += Math.min(desiredOutstanding, available);
  }

  let spawn: SpawnIntervalClaim | null = null;
  if (request.spawn !== null) {
    const spawnClaim = request.spawn;
    spawn = cloneInterval(spawnClaim);
    if (!consumed.spawn) {
      const observed = state.capacity.spawns.find(
        (candidateCapacity) =>
          candidateCapacity.colonyId === request.colonyId &&
          candidateCapacity.spawnId === spawnClaim.spawnId,
      );
      if (observed === undefined) {
        return { grant: null, reasonCode: "spawn-not-observed" };
      }
      const retainingCurrentInterval =
        existing?.status === "active" &&
        existing.grant.spawn !== null &&
        intervalsEqual(existing.grant.spawn, spawnClaim);
      if (spawnClaim.startTick < state.tick && !retainingCurrentInterval) {
        return { grant: null, reasonCode: "invalid-request" };
      }
      if (observed.blocked.some((blocked) => intervalsOverlap(blocked, spawnClaim))) {
        return { grant: null, reasonCode: "spawn-observed-busy" };
      }
      const allocated = state.spawnAllocated.get(spawnClaim.spawnId) ?? [];
      if (allocated.some((interval) => intervalsOverlap(interval, spawnClaim))) {
        return { grant: null, reasonCode: "spawn-interval-overlap" };
      }
    }
  }

  let cpu = consumed.cpu;
  if (request.cpu !== null) {
    const available = state.capacity.cpu - state.cpuAllocated;
    const minimumOutstanding = Math.max(0, request.cpu.minimum - consumed.cpu);
    const desiredOutstanding = Math.max(0, request.cpu.desired - consumed.cpu);
    if (available < minimumOutstanding) {
      return { grant: null, reasonCode: "insufficient-cpu" };
    }
    cpu += Math.min(desiredOutstanding, available);
  }

  return { grant: { energy, cpu, spawn }, reasonCode: "granted" };
}

function denyCandidate(
  candidate: AllocationCandidate,
  tick: number,
  reasonCode: BudgetReasonCode,
): {
  readonly entry: LedgerEntry;
  readonly decision: BudgetDecision;
  readonly transition: LedgerTransition | null;
} {
  const previous = candidate.existing;
  const hasConsumption =
    previous !== null &&
    (previous.consumed.energy > 0 || previous.consumed.cpu > 0 || previous.consumed.spawn);
  const entry: LedgerEntry = hasConsumption
    ? releasedEntry(previous, tick, "capacity-reconciled")
    : previous !== null &&
        previous.status === "pending" &&
        previous.reasonCode === reasonCode &&
        grantsEqual(previous.grant, ZERO_GRANT)
      ? previous
      : {
          reservationId: candidate.reservationId,
          colonyId: candidate.request.colonyId,
          category: candidate.request.category,
          issuer: candidate.request.issuer,
          revision: candidate.request.revision,
          request: cloneRequest(candidate.request),
          grant: cloneGrant(ZERO_GRANT),
          consumed: cloneConsumption(ZERO_CONSUMPTION),
          createdAt: previous?.createdAt ?? tick,
          updatedAt: tick,
          status: "pending",
          reasonCode,
        };
  return {
    entry,
    decision: deniedDecision(candidate.request, reasonCode),
    transition:
      previous?.status === "active"
        ? {
            reservationId: previous.reservationId,
            action: "release",
            reasonCode: "capacity-reconciled",
          }
        : null,
  };
}

function groupRequests(requests: readonly BudgetRequest[]): ReadonlyMap<string, BudgetRequest[]> {
  const grouped = new Map<string, BudgetRequest[]>();
  for (const request of requests) {
    const key = ledgerIssuerKey(request);
    const group = grouped.get(key) ?? [];
    group.push(request);
    grouped.set(key, group);
  }
  return new Map([...grouped.entries()].sort(compareMapEntries));
}

function uniqueRequests(requests: readonly BudgetRequest[]): BudgetRequest[] {
  const unique: BudgetRequest[] = [];
  for (const request of requests) {
    if (!unique.some((candidate) => requestsEqual(candidate, request))) {
      unique.push(request);
    }
  }
  return unique;
}

function retainExistingReservation(
  existing: LedgerEntry,
  candidates: AllocationCandidate[],
  candidateKeys: Set<string>,
  preserveKeys: Set<string>,
): void {
  const key = ledgerIssuerKey(existing);
  if (!isReservable(existing.status)) {
    preserveKeys.add(key);
    return;
  }
  if (candidateKeys.has(key)) {
    return;
  }
  candidates.push({
    request: cloneRequest(existing.request),
    reservationId: existing.reservationId,
    existing,
  });
  candidateKeys.add(key);
}

function expireEntries(
  entries: readonly LedgerEntry[],
  tick: number,
): { readonly entries: readonly LedgerEntry[]; readonly transitions: readonly LedgerTransition[] } {
  const next: LedgerEntry[] = [];
  const transitions: LedgerTransition[] = [];
  for (const entry of entries) {
    if (!isReservable(entry.status) || entry.request.expiresAt >= tick) {
      next.push(entry);
      continue;
    }
    const hasConsumption =
      entry.consumed.energy > 0 || entry.consumed.cpu > 0 || entry.consumed.spawn;
    next.push(
      hasConsumption
        ? releasedEntry(entry, tick, "expired")
        : {
            ...entry,
            grant: cloneGrant(ZERO_GRANT),
            updatedAt: tick,
            status: "expired",
            reasonCode: "expired",
          },
    );
    pushTransition(transitions, {
      reservationId: entry.reservationId,
      action: "expire",
      reasonCode: "expired",
    });
  }
  return { entries: next, transitions };
}

function releasedEntry(
  entry: LedgerEntry,
  tick: number,
  reasonCode: BudgetReasonCode,
): LedgerEntry {
  return {
    ...entry,
    updatedAt: tick,
    status: "released",
    reasonCode,
  };
}

function makeResult(
  entries: readonly LedgerEntry[],
  decisions: readonly BudgetDecision[],
  transitions: readonly LedgerTransition[],
): BudgetLedgerResult {
  const sortedEntries = entries.map(cloneEntry).sort(compareEntries);
  const sortedDecisions = decisions.map(cloneDecision).sort(compareDecisions);
  const frozenTransitions = transitions.map((transition) => ({ ...transition }));
  const totals = {
    active: 0,
    pending: 0,
    energyReserved: 0,
    cpuReserved: 0,
    spawnTicksReserved: 0,
  };
  for (const entry of sortedEntries) {
    if (entry.status === "pending") {
      totals.pending += 1;
    }
    if (entry.status !== "active") {
      continue;
    }
    totals.active += 1;
    totals.energyReserved += entry.grant.energy - entry.consumed.energy;
    totals.cpuReserved += entry.grant.cpu - entry.consumed.cpu;
    if (entry.grant.spawn !== null && !entry.consumed.spawn) {
      totals.spawnTicksReserved += entry.grant.spawn.endTick - entry.grant.spawn.startTick;
    }
  }
  return deepFreeze({
    entries: sortedEntries,
    decisions: sortedDecisions,
    transitions: frozenTransitions,
    totals,
  });
}

function normalizeCapacity(capacity: BudgetLedgerCapacity): BudgetLedgerCapacity {
  if (!isSafeNonNegativeInteger(capacity.cpu)) {
    throw new TypeError("CPU capacity must be a non-negative safe integer");
  }
  const energy = capacity.energy.map((entry) => {
    if (
      !isIdentifier(entry.colonyId, 64) ||
      !isSafeNonNegativeInteger(entry.available) ||
      !isSafeNonNegativeInteger(entry.protected) ||
      entry.protected > entry.available
    ) {
      throw new TypeError("invalid colony energy capacity");
    }
    return { ...entry };
  });
  energy.sort((left, right) => compareStrings(left.colonyId, right.colonyId));
  assertUniqueStrings(
    energy.map((entry) => entry.colonyId),
    "energy colony",
  );

  const spawns = capacity.spawns.map((entry) => {
    if (!isIdentifier(entry.colonyId, 64) || !isIdentifier(entry.spawnId, 128)) {
      throw new TypeError("invalid spawn capacity identity");
    }
    const blocked = entry.blocked.map((interval) => {
      if (!isValidInterval(interval) || interval.spawnId !== entry.spawnId) {
        throw new TypeError("invalid blocked spawn interval");
      }
      return cloneInterval(interval);
    });
    blocked.sort(compareIntervals);
    return { colonyId: entry.colonyId, spawnId: entry.spawnId, blocked };
  });
  spawns.sort(compareSpawnCapacities);
  assertUniqueStrings(
    spawns.map((entry) => `${entry.colonyId}\u0000${entry.spawnId}`),
    "spawn capacity",
  );
  return { energy, cpu: capacity.cpu, spawns };
}

function invalidDecision(request: BudgetRequest): BudgetDecision {
  const colonyId = isIdentifier(request.colonyId, 64) ? request.colonyId : "invalid";
  const category = BUDGET_CATEGORIES.includes(request.category)
    ? request.category
    : "optional-growth";
  const issuer = isIdentifier(request.issuer, MAX_BUDGET_ISSUER_CODE_UNITS)
    ? request.issuer
    : "invalid";
  const revision = isSafeNonNegativeInteger(request.revision) ? request.revision : 0;
  return {
    reservationId: `invalid/${String(colonyId.length)}:${colonyId}/${String(issuer.length)}:${issuer}/${String(revision)}`,
    colonyId,
    category,
    issuer,
    revision,
    status: "denied",
    reasonCode: "invalid-request",
    grant: null,
  };
}

function deniedDecision(request: BudgetRequest, reasonCode: BudgetReasonCode): BudgetDecision {
  return {
    reservationId: reservationIdFor(request),
    colonyId: request.colonyId,
    category: request.category,
    issuer: request.issuer,
    revision: request.revision,
    status: "denied",
    reasonCode,
    grant: null,
  };
}

function terminalDecision(entry: LedgerEntry): BudgetDecision {
  return {
    reservationId: entry.reservationId,
    colonyId: entry.colonyId,
    category: entry.category,
    issuer: entry.issuer,
    revision: entry.revision,
    status: "denied",
    reasonCode: terminalIdempotencyReason(entry.status) ?? "already-released",
    grant: null,
  };
}

function terminalIdempotencyReason(status: LedgerEntry["status"]): BudgetReasonCode | null {
  switch (status) {
    case "consumed":
      return "already-consumed";
    case "released":
      return "already-released";
    case "expired":
      return "already-expired";
    case "active":
    case "pending":
      return null;
  }
}

function isReservable(status: LedgerEntry["status"]): boolean {
  return status === "active" || status === "pending";
}

function isValidRequest(request: BudgetRequest): boolean {
  return (
    isIdentifier(request.colonyId, 64) &&
    BUDGET_CATEGORIES.includes(request.category) &&
    isIdentifier(request.issuer, MAX_BUDGET_ISSUER_CODE_UNITS) &&
    isSafeNonNegativeInteger(request.revision) &&
    isSafeNonNegativeInteger(request.expiresAt) &&
    (request.energy === null || isValidClaim(request.energy)) &&
    (request.cpu === null || isValidClaim(request.cpu)) &&
    (request.spawn === null || isValidInterval(request.spawn)) &&
    (request.energy !== null || request.cpu !== null || request.spawn !== null)
  );
}

function isValidClaim(claim: { readonly minimum: number; readonly desired: number }): boolean {
  return (
    isSafeNonNegativeInteger(claim.minimum) &&
    isSafeNonNegativeInteger(claim.desired) &&
    claim.minimum <= claim.desired
  );
}

function isValidInterval(interval: SpawnIntervalClaim): boolean {
  return (
    isIdentifier(interval.spawnId, 128) &&
    isSafeNonNegativeInteger(interval.startTick) &&
    isSafeNonNegativeInteger(interval.endTick) &&
    interval.endTick > interval.startTick &&
    interval.endTick - interval.startTick <= MAX_SPAWN_INTERVAL_TICKS
  );
}

function isValidConsumption(consumption: BudgetConsumption): boolean {
  return (
    isSafeNonNegativeInteger(consumption.energy) &&
    isSafeNonNegativeInteger(consumption.cpu) &&
    typeof consumption.spawn === "boolean"
  );
}

function consumptionRegressed(current: BudgetConsumption, previous: BudgetConsumption): boolean {
  return (
    current.energy < previous.energy ||
    current.cpu < previous.cpu ||
    (previous.spawn && !current.spawn)
  );
}

function consumptionExceeded(consumed: BudgetConsumption, grant: BudgetGrant): boolean {
  return (
    consumed.energy > grant.energy ||
    consumed.cpu > grant.cpu ||
    (consumed.spawn && grant.spawn === null)
  );
}

function grantFullyConsumed(grant: BudgetGrant, consumed: BudgetConsumption): boolean {
  return (
    consumed.energy === grant.energy &&
    consumed.cpu === grant.cpu &&
    (grant.spawn === null || consumed.spawn)
  );
}

function isReducedGrant(request: BudgetRequest, grant: BudgetGrant): boolean {
  return grant.energy < (request.energy?.desired ?? 0) || grant.cpu < (request.cpu?.desired ?? 0);
}

function intervalsOverlap(left: SpawnIntervalClaim, right: SpawnIntervalClaim): boolean {
  return left.startTick < right.endTick && right.startTick < left.endTick;
}

function intervalsEqual(left: SpawnIntervalClaim, right: SpawnIntervalClaim): boolean {
  return (
    left.spawnId === right.spawnId &&
    left.startTick === right.startTick &&
    left.endTick === right.endTick
  );
}

function nullableIntervalsEqual(
  left: SpawnIntervalClaim | null,
  right: SpawnIntervalClaim | null,
): boolean {
  return left === null || right === null ? left === right : intervalsEqual(left, right);
}

function claimsEqual(
  left: { readonly minimum: number; readonly desired: number } | null,
  right: { readonly minimum: number; readonly desired: number } | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.minimum === right.minimum && left.desired === right.desired;
}

function requestsEqual(left: BudgetRequest, right: BudgetRequest): boolean {
  return (
    left.colonyId === right.colonyId &&
    left.category === right.category &&
    left.issuer === right.issuer &&
    left.revision === right.revision &&
    left.expiresAt === right.expiresAt &&
    claimsEqual(left.energy, right.energy) &&
    claimsEqual(left.cpu, right.cpu) &&
    nullableIntervalsEqual(left.spawn, right.spawn)
  );
}

function grantsEqual(left: BudgetGrant, right: BudgetGrant): boolean {
  return (
    left.energy === right.energy &&
    left.cpu === right.cpu &&
    nullableIntervalsEqual(left.spawn, right.spawn)
  );
}

function consumptionsEqual(left: BudgetConsumption, right: BudgetConsumption): boolean {
  return left.energy === right.energy && left.cpu === right.cpu && left.spawn === right.spawn;
}

function compareCandidates(left: AllocationCandidate, right: AllocationCandidate): number {
  return compareRequests(left.request, right.request);
}

function compareRequests(left: BudgetRequest, right: BudgetRequest): number {
  return (
    BUDGET_CATEGORIES.indexOf(left.category) - BUDGET_CATEGORIES.indexOf(right.category) ||
    left.expiresAt - right.expiresAt ||
    compareStrings(left.colonyId, right.colonyId) ||
    compareStrings(left.issuer, right.issuer) ||
    left.revision - right.revision ||
    compareRequestData(left, right)
  );
}

function compareRequestData(left: BudgetRequest, right: BudgetRequest): number {
  return compareStrings(canonicalRequestData(left), canonicalRequestData(right));
}

function canonicalRequestData(request: BudgetRequest): string {
  return JSON.stringify([
    request.colonyId,
    request.category,
    request.issuer,
    request.revision,
    request.expiresAt,
    request.energy === null ? null : [request.energy.minimum, request.energy.desired],
    request.cpu === null ? null : [request.cpu.minimum, request.cpu.desired],
    request.spawn === null
      ? null
      : [request.spawn.spawnId, request.spawn.startTick, request.spawn.endTick],
  ]);
}

function compareEntries(left: LedgerEntry, right: LedgerEntry): number {
  return compareStrings(ledgerIssuerKey(left), ledgerIssuerKey(right));
}

function compareDecisions(left: BudgetDecision, right: BudgetDecision): number {
  return (
    BUDGET_CATEGORIES.indexOf(left.category) - BUDGET_CATEGORIES.indexOf(right.category) ||
    compareStrings(left.colonyId, right.colonyId) ||
    compareStrings(left.issuer, right.issuer) ||
    left.revision - right.revision ||
    compareStrings(left.reasonCode, right.reasonCode)
  );
}

function compareIntervals(left: SpawnIntervalClaim, right: SpawnIntervalClaim): number {
  return (
    left.startTick - right.startTick ||
    left.endTick - right.endTick ||
    compareStrings(left.spawnId, right.spawnId)
  );
}

function compareSpawnCapacities(
  left: BudgetLedgerCapacity["spawns"][number],
  right: BudgetLedgerCapacity["spawns"][number],
): number {
  return (
    compareStrings(left.colonyId, right.colonyId) || compareStrings(left.spawnId, right.spawnId)
  );
}

function compareMapEntries<T>(left: readonly [string, T], right: readonly [string, T]): number {
  return compareStrings(left[0], right[0]);
}

function assertUniqueEntries(entries: readonly LedgerEntry[]): void {
  assertUniqueStrings(
    entries.map((entry) => ledgerIssuerKey(entry)),
    "ledger issuer",
  );
  const active = entries.filter((entry) => entry.status === "active").length;
  if (active > MAX_ACTIVE_RESERVATIONS) {
    throw new RangeError(
      `active reservations exceed the cap of ${String(MAX_ACTIVE_RESERVATIONS)}`,
    );
  }
}

function assertUniqueStrings(values: readonly string[], subject: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) {
      throw new TypeError(`duplicate ${subject} entry`);
    }
  }
}

function pushTransition(transitions: LedgerTransition[], transition: LedgerTransition): void {
  if (transitions.length >= MAX_LEDGER_TRANSITIONS_PER_TICK) {
    throw new RangeError(
      `ledger transitions exceed the structural cap of ${String(MAX_LEDGER_TRANSITIONS_PER_TICK)}`,
    );
  }
  transitions.push(transition);
}

function appendOptionalTransition(
  transitions: LedgerTransition[],
  transition: LedgerTransition | null,
): void {
  if (transition !== null) {
    pushTransition(transitions, transition);
  }
}

function assertTick(tick: number): void {
  if (!isSafeNonNegativeInteger(tick)) {
    throw new TypeError("ledger tick must be a non-negative safe integer");
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !hasControlCodeUnit(value) &&
    !hasLoneSurrogate(value)
  );
}

function hasControlCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function cloneEntry(entry: LedgerEntry): LedgerEntry {
  return {
    ...entry,
    request: cloneRequest(entry.request),
    grant: cloneGrant(entry.grant),
    consumed: cloneConsumption(entry.consumed),
  };
}

function cloneRequest(request: BudgetRequest): BudgetRequest {
  return {
    ...request,
    energy: request.energy === null ? null : { ...request.energy },
    cpu: request.cpu === null ? null : { ...request.cpu },
    spawn: request.spawn === null ? null : cloneInterval(request.spawn),
  };
}

function cloneGrant(grant: BudgetGrant): BudgetGrant {
  return {
    energy: grant.energy,
    cpu: grant.cpu,
    spawn: grant.spawn === null ? null : cloneInterval(grant.spawn),
  };
}

function cloneConsumption(consumed: BudgetConsumption): BudgetConsumption {
  return { ...consumed };
}

function cloneInterval(interval: SpawnIntervalClaim): SpawnIntervalClaim {
  return { ...interval };
}

function cloneDecision(decision: BudgetDecision): BudgetDecision {
  return {
    ...decision,
    grant: decision.grant === null ? null : cloneGrant(decision.grant),
  };
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
