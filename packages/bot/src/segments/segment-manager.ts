import type { MemoryManager, MemoryStageResult } from "../state/memory";
import {
  SEGMENT_ENVELOPE_SCHEMA_VERSION,
  SEGMENT_MANAGER_LIMITS,
  SEGMENT_PRIORITIES,
  type SegmentEnvelopeV1,
  type SegmentGenerationRef,
  type SegmentManagerMetrics,
  type SegmentOwnerStateV1,
  type SegmentOwnerStatus,
  type SegmentPendingGeneration,
  type SegmentPriority,
  type SegmentQuarantineEntry,
  type SegmentQuarantineReason,
  type SegmentReadResult,
  type SegmentService,
  type SegmentStore,
  type SegmentStoreContract,
  type SegmentWriteResult,
} from "./contracts";
import { freezeOwner, logicalIdentity, openSegmentOwner } from "./persistence";

const ACCESS_PERSIST_INTERVAL_TICKS = 25;

interface MutableEntry {
  storeId: string;
  key: string;
  priority: SegmentPriority;
  lastAccessTick: number;
  current: SegmentGenerationRef | null;
  previous: SegmentGenerationRef | null;
  pending: SegmentPendingGeneration | null;
}

interface RegisteredStore<Key = unknown, Value = unknown> {
  readonly id: string;
  readonly owner: string;
  readonly schemaVersion: number;
  readonly priority: SegmentPriority;
  readonly maximumEncodedLength: number;
  readonly keyOf: (key: Key) => string;
  readonly encode: (value: Value) => string;
  readonly decode: (encoded: string) => Value;
}

interface QueuedWrite {
  readonly identity: string;
  readonly storeId: string;
  readonly key: string;
  readonly priority: SegmentPriority;
  readonly schemaVersion: number;
  readonly payload: string;
  readonly checksum: string;
}

interface ActivationRequest {
  readonly segmentId: number;
  readonly priority: SegmentPriority;
  readonly phase: 0 | 1 | 2;
  readonly identity: string;
}

interface MutableCounters {
  activatedSegments: number;
  readsReady: number;
  readsLoading: number;
  readsMissing: number;
  readsCorrupt: number;
  readBudgetDenied: number;
  readCodeUnits: number;
  verifiedGenerations: number;
  verificationCodeUnits: number;
  writes: number;
  writeCodeUnits: number;
  deferredWrites: number;
  rejectedWrites: number;
  quarantined: number;
  fallbackReads: number;
  evictions: number;
  compactionSteps: number;
}

interface RawSegmentAccess {
  readonly segments: Record<number, string>;
  setActiveSegments(ids: number[]): void;
}

interface DecodedEnvelope {
  readonly envelope: SegmentEnvelopeV1;
  readonly payload: string;
}

export type SegmentManagerOpenResult =
  | {
      readonly status: "ready" | "initialized" | "recovered";
      readonly manager: SegmentManager;
    }
  | {
      readonly status: "unsupported";
      readonly foundSchemaVersion: number;
    };

export class SegmentManager {
  readonly #tick: number;
  readonly #ownerStatus: Exclude<SegmentOwnerStatus, "unsupported">;
  readonly #stores = new Map<string, RegisteredStore>();
  readonly #writes = new Map<string, QueuedWrite>();
  readonly #activationRequests = new Map<number, ActivationRequest>();
  readonly #entries: MutableEntry[];
  readonly #openingSegmentIds: ReadonlySet<number>;
  #quarantine: SegmentQuarantineEntry[];
  #revision: number;
  #recoveryCount: number;
  #changed: boolean;
  #begun = false;
  #reconciled = false;
  #readAttempts = 0;
  #writeAttempts = 0;
  #raw: RawSegmentAccess | null = null;
  #activeSegments: Readonly<Record<number, string>> = Object.freeze({});
  readonly #counters: MutableCounters = {
    activatedSegments: 0,
    readsReady: 0,
    readsLoading: 0,
    readsMissing: 0,
    readsCorrupt: 0,
    readBudgetDenied: 0,
    readCodeUnits: 0,
    verifiedGenerations: 0,
    verificationCodeUnits: 0,
    writes: 0,
    writeCodeUnits: 0,
    deferredWrites: 0,
    rejectedWrites: 0,
    quarantined: 0,
    fallbackReads: 0,
    evictions: 0,
    compactionSteps: 0,
  };

  private constructor(
    owner: SegmentOwnerStateV1,
    tick: number,
    status: Exclude<SegmentOwnerStatus, "unsupported">,
  ) {
    validateTick(tick);
    this.#tick = tick;
    this.#ownerStatus = status;
    this.#revision = owner.revision;
    this.#recoveryCount = owner.recoveryCount;
    this.#entries = owner.entries.map((entry) => ({ ...entry }));
    this.#quarantine = owner.quarantine.map((entry) => ({ ...entry }));
    this.#openingSegmentIds = new Set([
      ...this.#entries.flatMap(references).map(({ segmentId }) => segmentId),
      ...this.#quarantine.map(({ segmentId }) => segmentId),
    ]);
    this.#changed = status !== "ready";
  }

  public static open(value: unknown, tick: number): SegmentManagerOpenResult {
    validateTick(tick);
    const opened = openSegmentOwner(value, tick);
    if (opened.status === "unsupported") return opened;
    return {
      status: opened.status,
      manager: new SegmentManager(opened.owner, tick, opened.status),
    };
  }

  public get changed(): boolean {
    return this.#changed;
  }

  /** Captures this tick's available segment strings and validates pending copy-on-write data. */
  public beginTick(): void {
    if (this.#begun) throw new Error("SegmentManager beginTick may run only once");
    this.#begun = true;
    this.#raw = currentRawMemory();
    this.#activeSegments =
      this.#raw === null ? Object.freeze({}) : snapshotActive(this.#raw.segments);
    this.compactQuarantine();
    this.expirePendingWrites();
    this.verifyWrittenGenerations();
  }

  public register<Key, Value>(
    contract: SegmentStoreContract<Key, Value>,
  ): SegmentStore<Key, Value> {
    this.assertBeforeReconciliation();
    const normalized = normalizeContract(contract);
    if (this.#stores.has(normalized.id)) {
      throw new Error(`Segment store already registered: ${normalized.id}`);
    }
    if (this.#stores.size >= SEGMENT_MANAGER_LIMITS.maximumRegisteredStores) {
      throw new Error("Segment store registration capacity exceeded");
    }
    this.#stores.set(normalized.id, normalized as RegisteredStore);
    return Object.freeze({
      read: (key: Key) => this.read(normalized, key),
      write: (key: Key, value: Value) => this.write(normalized, key, value),
    });
  }

  public reconcile(): SegmentManagerMetrics {
    this.assertBegun();
    if (this.#reconciled) throw new Error("SegmentManager reconciliation may run only once");
    this.#reconciled = true;
    this.processWrites();
    this.requestPendingActivations();
    this.publishActivationPlan();
    if (this.#changed) {
      if (this.#revision >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Segment owner revision exhausted");
      }
      this.#revision += 1;
    }
    const serialized = this.view();
    if (JSON.stringify(serialized).length > SEGMENT_MANAGER_LIMITS.maximumManifestCodeUnits) {
      throw new RangeError("Segment manifest exceeds its persistent size bound");
    }
    return this.metrics();
  }

  public view(): SegmentOwnerStateV1 {
    return freezeOwner({
      schemaVersion: 1,
      revision: this.#revision,
      recoveryCount: this.#recoveryCount,
      entries: this.#entries,
      quarantine: this.#quarantine,
    });
  }

  public stage(manager: MemoryManager): MemoryStageResult {
    if (!this.#reconciled) throw new Error("SegmentManager must reconcile before staging");
    const transaction = manager.transaction("segments");
    transaction.replace(this.view());
    return transaction.stage();
  }

  public metrics(): SegmentManagerMetrics {
    const owner = this.view();
    return Object.freeze({
      ownerStatus: this.#ownerStatus,
      rawMemoryAvailable: this.#raw !== null,
      registeredStores: this.#stores.size,
      manifestEntries: owner.entries.length,
      manifestCodeUnits: JSON.stringify(owner).length,
      ...this.#counters,
      pendingWrites: owner.entries.filter(({ pending }) => pending !== null).length,
    });
  }

  private read<Key, Value>(
    store: RegisteredStore<Key, Value>,
    inputKey: Key,
  ): SegmentReadResult<Value> {
    if (this.#reconciled) {
      this.#counters.readsLoading += 1;
      return { status: "loading", reason: "service-unavailable" };
    }
    if (!this.#begun) {
      this.#counters.readsLoading += 1;
      return { status: "loading", reason: "activation-pending" };
    }
    if (this.#readAttempts >= SEGMENT_MANAGER_LIMITS.maximumReadsPerTick) {
      this.#counters.readBudgetDenied += 1;
      return { status: "loading", reason: "read-budget" };
    }
    this.#readAttempts += 1;
    const key = normalizeLogicalKey(store, inputKey);
    if (key === null) {
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason: "codec" };
    }
    const entry = this.findEntry(store.id, key);
    if (entry === undefined) {
      this.#counters.readsMissing += 1;
      return { status: "missing" };
    }
    this.touch(entry, store.priority);

    if (entry.current === null) {
      if (entry.previous !== null) return this.readFallback(store, entry);
      if (entry.pending !== null) {
        this.requestActivation(entry.pending.segmentId, entry.priority, 0, entryIdentity(entry));
        this.#counters.readsLoading += 1;
        return { status: "loading", reason: "write-pending" };
      }
      this.#counters.readsMissing += 1;
      return { status: "missing" };
    }
    if (entry.current.schemaVersion !== store.schemaVersion) {
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason: "schema" };
    }
    const decoded = this.decodeRegistered(store, entry, entry.current);
    if (decoded.status === "loading" || decoded.status === "budget") {
      this.requestActivation(entry.current.segmentId, entry.priority, 1, entryIdentity(entry));
      this.#counters.readsLoading += 1;
      if (decoded.status === "budget") this.#counters.readBudgetDenied += 1;
      return {
        status: "loading",
        reason: decoded.status === "budget" ? "read-budget" : "activation-pending",
      };
    }
    if (decoded.status === "corrupt") {
      const reason = decoded.reason;
      this.quarantineReference(entry.current, reason === "schema" ? "schema" : "checksum");
      entry.current = null;
      this.#changed = true;
      if (entry.previous !== null) {
        const fallback = this.readFallback(store, entry);
        if (fallback.status === "loading") return fallback;
        if (fallback.status === "ready") return fallback;
      }
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason };
    }
    this.requestActivation(entry.current.segmentId, entry.priority, 1, entryIdentity(entry));
    this.#counters.readsReady += 1;
    return { status: "ready", generation: entry.current.generation, value: decoded.value };
  }

  private readFallback<Key, Value>(
    store: RegisteredStore<Key, Value>,
    entry: MutableEntry,
  ): SegmentReadResult<Value> {
    const previous = entry.previous;
    if (previous === null) {
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason: "checksum" };
    }
    if (previous.schemaVersion !== store.schemaVersion) {
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason: "schema" };
    }
    const decoded = this.decodeRegistered(store, entry, previous);
    if (decoded.status === "loading" || decoded.status === "budget") {
      this.requestActivation(previous.segmentId, entry.priority, 0, entryIdentity(entry));
      this.#counters.readsLoading += 1;
      if (decoded.status === "budget") this.#counters.readBudgetDenied += 1;
      return {
        status: "loading",
        reason: decoded.status === "budget" ? "read-budget" : "fallback-pending",
      };
    }
    if (decoded.status === "corrupt") {
      this.quarantineReference(previous, decoded.reason === "schema" ? "schema" : "checksum");
      entry.previous = null;
      this.#changed = true;
      this.#counters.readsCorrupt += 1;
      return { status: "corrupt", reason: decoded.reason };
    }
    entry.current = previous;
    entry.previous = null;
    this.#changed = true;
    this.requestActivation(previous.segmentId, entry.priority, 0, entryIdentity(entry));
    this.#counters.fallbackReads += 1;
    this.#counters.readsReady += 1;
    return { status: "ready", generation: previous.generation, value: decoded.value };
  }

  private write<Key, Value>(
    store: RegisteredStore<Key, Value>,
    inputKey: Key,
    value: Value,
  ): SegmentWriteResult {
    if (this.#reconciled) return this.rejectWrite("closed");
    if (!this.#begun || this.#raw === null) return this.rejectWrite("service-unavailable");
    if (this.#writeAttempts >= SEGMENT_MANAGER_LIMITS.maximumWriteRequestsPerTick) {
      return this.rejectWrite("write-budget");
    }
    this.#writeAttempts += 1;
    const key = normalizeLogicalKey(store, inputKey);
    if (key === null) return this.rejectWrite("key");
    let payload: string;
    try {
      payload = store.encode(value);
      if (typeof payload !== "string") return this.rejectWrite("codec");
      const detached = store.decode(payload);
      if (store.encode(detached) !== payload) return this.rejectWrite("codec");
    } catch {
      return this.rejectWrite("codec");
    }
    if (payload.length > store.maximumEncodedLength) return this.rejectWrite("oversized");
    const identity = logicalIdentity(store.id, key);
    const queued: QueuedWrite = {
      identity,
      storeId: store.id,
      key,
      priority: store.priority,
      schemaVersion: store.schemaVersion,
      payload,
      checksum: checksumString(payload),
    };
    const existing = this.#writes.get(identity);
    if (existing !== undefined && existing.payload !== payload) return this.rejectWrite("conflict");
    this.#writes.set(identity, queued);
    return { accepted: true, status: "offered" };
  }

  private rejectWrite(
    reason: Extract<SegmentWriteResult, { accepted: false }>["reason"],
  ): SegmentWriteResult {
    this.#counters.rejectedWrites += 1;
    return { accepted: false, status: "rejected", reason };
  }

  private processWrites(): void {
    const queued = [...this.#writes.values()].sort(compareWrites);
    let admitted = 0;
    for (const write of queued) {
      if (admitted >= SEGMENT_MANAGER_LIMITS.maximumWritesPerTick) {
        this.#counters.deferredWrites += 1;
        continue;
      }
      let entry = this.findEntry(write.storeId, write.key);
      if (
        entry !== undefined &&
        entry.current !== null &&
        entry.current.schemaVersion === write.schemaVersion &&
        entry.current.checksum === write.checksum
      ) {
        this.touch(entry, write.priority);
        continue;
      }
      if (entry?.pending?.state === "written") {
        this.touch(entry, write.priority);
        continue;
      }

      const generation =
        entry?.pending?.generation ?? (entry === undefined ? 1 : nextGeneration(entry));
      const envelope = encodeEnvelope(write, generation);
      // Reject impossible work before capacity arbitration can evict valid data.
      if (
        envelope.length > SEGMENT_MANAGER_LIMITS.maximumSegmentCodeUnits ||
        this.#counters.writeCodeUnits + envelope.length >
          SEGMENT_MANAGER_LIMITS.maximumWriteCodeUnitsPerTick
      ) {
        this.#counters.rejectedWrites += 1;
        continue;
      }

      let createdEntry = false;
      if (entry === undefined) {
        if (!this.ensureEntryCapacity(write.priority, write.identity)) {
          this.#counters.rejectedWrites += 1;
          continue;
        }
        entry = {
          storeId: write.storeId,
          key: write.key,
          priority: write.priority,
          lastAccessTick: this.#tick,
          current: null,
          previous: null,
          pending: null,
        };
        this.#entries.push(entry);
        this.#entries.sort(compareEntries);
        createdEntry = true;
      }
      this.touch(entry, write.priority);
      if (entry.pending === null) {
        const segmentId = this.allocateSegment(write.priority, write.identity);
        if (segmentId === null) {
          if (createdEntry) {
            const index = this.#entries.indexOf(entry);
            if (index >= 0) this.#entries.splice(index, 1);
          }
          this.#counters.rejectedWrites += 1;
          continue;
        }
        entry.pending = {
          segmentId,
          schemaVersion: write.schemaVersion,
          generation,
          checksum: write.checksum,
          size: envelope.length,
          writtenAtTick: this.#tick,
          state: "allocated",
          createdAtTick: this.#tick,
        };
        this.#changed = true;
      }

      const pending = entry.pending;
      if (
        pending.checksum !== write.checksum ||
        pending.schemaVersion !== write.schemaVersion ||
        pending.size !== envelope.length
      ) {
        entry.pending = {
          ...pending,
          schemaVersion: write.schemaVersion,
          checksum: write.checksum,
          size: envelope.length,
          writtenAtTick: this.#tick,
        };
        this.#changed = true;
      }
      if (!hasActiveSegment(this.#activeSegments, pending.segmentId)) {
        this.requestActivation(pending.segmentId, entry.priority, 0, entryIdentity(entry));
        admitted += 1;
        continue;
      }
      if (this.#raw === null) continue;
      this.#raw.segments[pending.segmentId] = envelope;
      entry.pending = { ...entry.pending, state: "written", writtenAtTick: this.#tick };
      this.#counters.writes += 1;
      this.#counters.writeCodeUnits += envelope.length;
      this.#changed = true;
      admitted += 1;
    }
  }

  private verifyWrittenGenerations(): void {
    for (const entry of [...this.#entries].sort(comparePriorityEntries)) {
      const pending = entry.pending;
      if (pending?.state !== "written") continue;
      if (!hasActiveSegment(this.#activeSegments, pending.segmentId)) {
        this.requestActivation(pending.segmentId, entry.priority, 0, entryIdentity(entry));
        continue;
      }
      const raw = this.#activeSegments[pending.segmentId];
      if (raw === undefined) {
        this.requestActivation(pending.segmentId, entry.priority, 0, entryIdentity(entry));
        continue;
      }
      if (raw.length !== pending.size) {
        this.quarantineReference(pending, "checksum");
        entry.pending = null;
        this.#changed = true;
        continue;
      }
      if (
        this.#counters.verificationCodeUnits + raw.length >
        SEGMENT_MANAGER_LIMITS.maximumVerificationCodeUnitsPerTick
      ) {
        this.requestActivation(pending.segmentId, entry.priority, 0, entryIdentity(entry));
        continue;
      }
      this.#counters.verificationCodeUnits += raw.length;
      const decoded = decodeEnvelope(raw, entry, pending);
      if (decoded === null) {
        this.quarantineReference(pending, "checksum");
        entry.pending = null;
        this.#changed = true;
        continue;
      }
      // Keep exactly one verified predecessor. If current was quarantined while this write was
      // pending, preserve the still-valid predecessor instead of replacing it with null.
      if (
        entry.current !== null &&
        entry.previous !== null &&
        this.#counters.compactionSteps >= SEGMENT_MANAGER_LIMITS.maximumCompactionStepsPerTick
      ) {
        this.requestActivation(pending.segmentId, entry.priority, 0, entryIdentity(entry));
        continue;
      }
      if (entry.current !== null) {
        if (entry.previous !== null) this.#counters.compactionSteps += 1;
        entry.previous = entry.current;
      }
      entry.current = generationReference(pending);
      this.#counters.verifiedGenerations += 1;
      entry.pending = null;
      this.#changed = true;
    }
  }

  private expirePendingWrites(): void {
    for (const entry of this.#entries) {
      const pending = entry.pending;
      if (
        pending !== null &&
        this.#tick - pending.createdAtTick >= SEGMENT_MANAGER_LIMITS.pendingWriteTimeoutTicks
      ) {
        this.quarantineReference(pending, "pending-timeout");
        entry.pending = null;
        this.#changed = true;
      }
    }
  }

  private compactQuarantine(): void {
    const retained: SegmentQuarantineEntry[] = [];
    for (const entry of this.#quarantine) {
      if (
        entry.retryAtTick <= this.#tick &&
        this.#counters.compactionSteps < SEGMENT_MANAGER_LIMITS.maximumCompactionStepsPerTick
      ) {
        this.#counters.compactionSteps += 1;
        this.#changed = true;
      } else {
        retained.push(entry);
      }
    }
    this.#quarantine = retained;
  }

  private requestPendingActivations(): void {
    for (const entry of this.#entries) {
      if (entry.pending !== null) {
        this.requestActivation(entry.pending.segmentId, entry.priority, 0, entryIdentity(entry));
      }
    }
  }

  private publishActivationPlan(): void {
    if (this.#raw === null) return;
    const selected = [...this.#activationRequests.values()]
      .sort(compareActivations)
      .slice(0, SEGMENT_MANAGER_LIMITS.maximumActiveSegments)
      .map(({ segmentId }) => segmentId);
    this.#raw.setActiveSegments(selected);
    this.#counters.activatedSegments = selected.length;
  }

  private requestActivation(
    segmentId: number,
    priority: SegmentPriority,
    phase: 0 | 1 | 2,
    identity: string,
  ): void {
    const candidate = { segmentId, priority, phase, identity };
    const current = this.#activationRequests.get(segmentId);
    if (current === undefined || compareActivations(candidate, current) < 0) {
      this.#activationRequests.set(segmentId, candidate);
    }
  }

  private decodeRegistered<Key, Value>(
    store: RegisteredStore<Key, Value>,
    entry: MutableEntry,
    reference: SegmentGenerationRef,
  ):
    | { readonly status: "ready"; readonly value: Value }
    | { readonly status: "loading" }
    | { readonly status: "budget" }
    | { readonly status: "corrupt"; readonly reason: "checksum" | "codec" | "schema" } {
    if (!hasActiveSegment(this.#activeSegments, reference.segmentId)) return { status: "loading" };
    const raw = this.#activeSegments[reference.segmentId];
    if (raw === undefined) return { status: "loading" };
    if (raw.length !== reference.size) return { status: "corrupt", reason: "checksum" };
    if (
      this.#counters.readCodeUnits + raw.length >
      SEGMENT_MANAGER_LIMITS.maximumReadCodeUnitsPerTick
    ) {
      return { status: "budget" };
    }
    this.#counters.readCodeUnits += raw.length;
    const decoded = decodeEnvelope(raw, entry, reference);
    if (decoded === null) return { status: "corrupt", reason: "checksum" };
    if (decoded.envelope.schemaVersion !== store.schemaVersion) {
      return { status: "corrupt", reason: "schema" };
    }
    try {
      const value = store.decode(decoded.payload);
      if (store.encode(value) !== decoded.payload) return { status: "corrupt", reason: "codec" };
      return { status: "ready", value };
    } catch {
      return { status: "corrupt", reason: "codec" };
    }
  }

  private allocateSegment(priority: SegmentPriority, identity: string): number | null {
    const free = this.firstAllocatableSegmentId();
    if (free !== null) return free;
    // A reference removed earlier this tick must commit before its physical ID can be reused.
    if (this.hasDeferredFreeSegmentId()) return null;

    const predecessor =
      this.#counters.compactionSteps < SEGMENT_MANAGER_LIMITS.maximumCompactionStepsPerTick
        ? [...this.#entries]
            .filter((entry) => entry.previous !== null)
            .sort(compareEvictionCandidates)[0]
        : undefined;
    if (predecessor !== undefined && predecessor.previous !== null) {
      predecessor.previous = null;
      this.#counters.compactionSteps += 1;
      this.#changed = true;
      const compactedFree = this.firstAllocatableSegmentId();
      if (compactedFree !== null) return compactedFree;
    }

    const victim = this.evictionCandidate(priority, identity);
    if (victim === null) return null;
    this.removeEntry(victim);
    return this.firstAllocatableSegmentId();
  }

  private hasDeferredFreeSegmentId(): boolean {
    const used = this.usedSegmentIds();
    for (const segmentId of this.#openingSegmentIds) {
      if (!used.has(segmentId)) return true;
    }
    return false;
  }

  private firstAllocatableSegmentId(): number | null {
    const used = this.usedSegmentIds();
    for (let segmentId = 0; segmentId < 100; segmentId += 1) {
      if (!used.has(segmentId) && !this.#openingSegmentIds.has(segmentId)) return segmentId;
    }
    return null;
  }

  private ensureEntryCapacity(priority: SegmentPriority, identity: string): boolean {
    if (this.#entries.length < SEGMENT_MANAGER_LIMITS.maximumEntries) return true;
    const victim = this.evictionCandidate(priority, identity);
    if (victim === null) return false;
    this.removeEntry(victim);
    return true;
  }

  private evictionCandidate(priority: SegmentPriority, identity: string): MutableEntry | null {
    const requesterRank = priorityRank(priority);
    return (
      [...this.#entries]
        .filter(
          (entry) =>
            entryIdentity(entry) !== identity && priorityRank(entry.priority) >= requesterRank,
        )
        .sort(compareEvictionCandidates)[0] ?? null
    );
  }

  private removeEntry(entry: MutableEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) this.#entries.splice(index, 1);
    this.#counters.evictions += 1;
    this.#changed = true;
  }

  private quarantineReference(
    reference: SegmentGenerationRef,
    reason: SegmentQuarantineReason,
  ): void {
    this.#quarantine = this.#quarantine.filter(
      ({ segmentId }) => segmentId !== reference.segmentId,
    );
    this.#quarantine.push({
      segmentId: reference.segmentId,
      quarantinedAtTick: this.#tick,
      retryAtTick: this.#tick + SEGMENT_MANAGER_LIMITS.quarantineTicks,
      reason,
    });
    this.#quarantine.sort(compareQuarantine);
    if (this.#quarantine.length > SEGMENT_MANAGER_LIMITS.maximumQuarantineEntries) {
      throw new Error("Segment quarantine exceeded the physical segment count");
    }
    this.#counters.quarantined += 1;
    this.#changed = true;
  }

  private touch(entry: MutableEntry, priority: SegmentPriority): void {
    if (priorityRank(priority) < priorityRank(entry.priority)) {
      entry.priority = priority;
      this.#changed = true;
    }
    if (this.#tick - entry.lastAccessTick >= ACCESS_PERSIST_INTERVAL_TICKS) {
      entry.lastAccessTick = this.#tick;
      this.#changed = true;
    }
  }

  private findEntry(storeId: string, key: string): MutableEntry | undefined {
    return this.#entries.find((entry) => entry.storeId === storeId && entry.key === key);
  }

  private usedSegmentIds(): Set<number> {
    return new Set([
      ...this.#entries.flatMap(references).map(({ segmentId }) => segmentId),
      ...this.#quarantine.map(({ segmentId }) => segmentId),
    ]);
  }

  private assertBegun(): void {
    if (!this.#begun) throw new Error("SegmentManager beginTick must run before store access");
  }

  private assertBeforeReconciliation(): void {
    if (this.#reconciled) throw new Error("SegmentManager store registration is closed");
  }
}

export function unavailableSegmentService(): SegmentService {
  return Object.freeze({
    register<Key, Value>(): SegmentStore<Key, Value> {
      return Object.freeze({
        read(): SegmentReadResult<Value> {
          return { status: "loading", reason: "activation-pending" };
        },
        write(): SegmentWriteResult {
          return {
            accepted: false,
            status: "rejected",
            reason: "service-unavailable",
          };
        },
      });
    },
  });
}

export function unavailableSegmentMetrics(
  ownerStatus: "unavailable" | "unsupported" = "unavailable",
): SegmentManagerMetrics {
  return Object.freeze({
    ownerStatus,
    rawMemoryAvailable: false,
    registeredStores: 0,
    manifestEntries: 0,
    manifestCodeUnits: 0,
    activatedSegments: 0,
    readsReady: 0,
    readsLoading: 0,
    readsMissing: 0,
    readsCorrupt: 0,
    readBudgetDenied: 0,
    readCodeUnits: 0,
    verifiedGenerations: 0,
    verificationCodeUnits: 0,
    writes: 0,
    writeCodeUnits: 0,
    deferredWrites: 0,
    rejectedWrites: 0,
    quarantined: 0,
    fallbackReads: 0,
    evictions: 0,
    compactionSteps: 0,
    pendingWrites: 0,
  });
}

export function createJsonSegmentCodec<Value>(): {
  readonly encode: (value: Value) => string;
  readonly decode: (encoded: string) => Value;
} {
  return Object.freeze({
    encode: (value: Value) => JSON.stringify(value),
    decode: (encoded: string) => JSON.parse(encoded) as Value,
  });
}

function normalizeContract<Key, Value>(
  contract: SegmentStoreContract<Key, Value>,
): RegisteredStore<Key, Value> {
  if (
    contract.id.length === 0 ||
    contract.id !== contract.id.trim() ||
    contract.id.length > SEGMENT_MANAGER_LIMITS.maximumStoreIdCodeUnits
  ) {
    throw new TypeError("Segment store id must be a bounded non-empty trimmed string");
  }
  if (
    contract.owner.length === 0 ||
    contract.owner !== contract.owner.trim() ||
    contract.owner.length > 96
  ) {
    throw new TypeError("Segment store owner must be a bounded non-empty trimmed string");
  }
  if (!Number.isSafeInteger(contract.schemaVersion) || contract.schemaVersion <= 0) {
    throw new RangeError("Segment store schemaVersion must be a positive safe integer");
  }
  if (!SEGMENT_PRIORITIES.includes(contract.priority)) {
    throw new TypeError("Segment store priority is invalid");
  }
  if (
    !Number.isSafeInteger(contract.maximumEncodedLength) ||
    contract.maximumEncodedLength <= 0 ||
    contract.maximumEncodedLength > SEGMENT_MANAGER_LIMITS.maximumSegmentCodeUnits
  ) {
    throw new RangeError("Segment store encoded-length bound is invalid");
  }
  if (
    typeof contract.keyOf !== "function" ||
    typeof contract.codec.encode !== "function" ||
    typeof contract.codec.decode !== "function"
  ) {
    throw new TypeError("Segment store key and codec functions are required");
  }
  return Object.freeze({
    id: contract.id,
    owner: contract.owner,
    schemaVersion: contract.schemaVersion,
    priority: contract.priority,
    maximumEncodedLength: contract.maximumEncodedLength,
    keyOf: contract.keyOf.bind(contract),
    encode: contract.codec.encode.bind(contract.codec),
    decode: contract.codec.decode.bind(contract.codec),
  });
}

function normalizeLogicalKey<Key, Value>(
  store: RegisteredStore<Key, Value>,
  key: Key,
): string | null {
  try {
    const normalized = store.keyOf(key);
    if (
      typeof normalized !== "string" ||
      normalized.length === 0 ||
      normalized !== normalized.trim() ||
      normalized.length > SEGMENT_MANAGER_LIMITS.maximumKeyCodeUnits
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function encodeEnvelope(write: QueuedWrite, generation: number): string {
  const envelope: SegmentEnvelopeV1 = {
    version: SEGMENT_ENVELOPE_SCHEMA_VERSION,
    storeId: write.storeId,
    key: write.key,
    schemaVersion: write.schemaVersion,
    generation,
    checksum: write.checksum,
    payload: write.payload,
  };
  return JSON.stringify(envelope);
}

function decodeEnvelope(
  raw: string | undefined,
  entry: Pick<MutableEntry, "storeId" | "key">,
  reference: SegmentGenerationRef,
): DecodedEnvelope | null {
  if (typeof raw !== "string" || raw.length !== reference.size) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !record(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== SEGMENT_ENVELOPE_SCHEMA_VERSION ||
    value.storeId !== entry.storeId ||
    value.key !== entry.key ||
    value.schemaVersion !== reference.schemaVersion ||
    value.generation !== reference.generation ||
    value.checksum !== reference.checksum ||
    typeof value.payload !== "string" ||
    checksumString(value.payload) !== reference.checksum
  ) {
    return null;
  }
  return {
    envelope: {
      version: SEGMENT_ENVELOPE_SCHEMA_VERSION,
      storeId: value.storeId,
      key: value.key,
      schemaVersion: value.schemaVersion,
      generation: value.generation,
      checksum: value.checksum,
      payload: value.payload,
    },
    payload: value.payload,
  };
}

function checksumString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function generationReference(pending: SegmentPendingGeneration): SegmentGenerationRef {
  return Object.freeze({
    segmentId: pending.segmentId,
    schemaVersion: pending.schemaVersion,
    generation: pending.generation,
    checksum: pending.checksum,
    size: pending.size,
    writtenAtTick: pending.writtenAtTick,
  });
}

function nextGeneration(entry: MutableEntry): number {
  const current = Math.max(
    entry.current?.generation ?? 0,
    entry.previous?.generation ?? 0,
    entry.pending?.generation ?? 0,
  );
  if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError("Segment generation exhausted");
  return current + 1;
}

function currentRawMemory(): RawSegmentAccess | null {
  if (typeof RawMemory === "undefined") return null;
  const candidate: unknown = RawMemory;
  if (!record(candidate)) return null;
  const segments = candidate.segments;
  const setActiveSegments = candidate.setActiveSegments;
  if (!record(segments) || typeof setActiveSegments !== "function") return null;
  return {
    segments: segments as Record<number, string>,
    setActiveSegments(ids: number[]): void {
      setActiveSegments.call(candidate, ids);
    },
  };
}

function snapshotActive(segments: Record<number, string>): Readonly<Record<number, string>> {
  const snapshot: Record<number, string> = {};
  for (const key of Object.keys(segments).slice(0, 100)) {
    const segmentId = Number(key);
    const value = segments[segmentId];
    if (
      Number.isSafeInteger(segmentId) &&
      segmentId >= 0 &&
      segmentId <= 99 &&
      typeof value === "string"
    ) {
      snapshot[segmentId] = value;
    }
  }
  return Object.freeze(snapshot);
}

function hasActiveSegment(segments: Readonly<Record<number, string>>, segmentId: number): boolean {
  return Object.prototype.hasOwnProperty.call(segments, segmentId);
}

function references(entry: MutableEntry): SegmentGenerationRef[] {
  return [entry.current, entry.previous, entry.pending].filter(
    (reference): reference is SegmentGenerationRef => reference !== null,
  );
}

function entryIdentity(entry: Pick<MutableEntry, "storeId" | "key">): string {
  return logicalIdentity(entry.storeId, entry.key);
}

function priorityRank(priority: SegmentPriority): number {
  return SEGMENT_PRIORITIES.indexOf(priority);
}

function compareWrites(left: QueuedWrite, right: QueuedWrite): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    compareStrings(left.identity, right.identity)
  );
}

function compareActivations(left: ActivationRequest, right: ActivationRequest): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    left.phase - right.phase ||
    compareStrings(left.identity, right.identity) ||
    left.segmentId - right.segmentId
  );
}

function compareEntries(left: MutableEntry, right: MutableEntry): number {
  return compareStrings(left.storeId, right.storeId) || compareStrings(left.key, right.key);
}

function comparePriorityEntries(left: MutableEntry, right: MutableEntry): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    compareStrings(entryIdentity(left), entryIdentity(right))
  );
}

function compareEvictionCandidates(left: MutableEntry, right: MutableEntry): number {
  return (
    priorityRank(right.priority) - priorityRank(left.priority) ||
    left.lastAccessTick - right.lastAccessTick ||
    compareStrings(entryIdentity(left), entryIdentity(right))
  );
}

function compareQuarantine(left: SegmentQuarantineEntry, right: SegmentQuarantineEntry): number {
  return (
    left.retryAtTick - right.retryAtTick ||
    left.segmentId - right.segmentId ||
    compareStrings(left.reason, right.reason)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTick(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Segment tick must be a non-negative safe integer");
}
