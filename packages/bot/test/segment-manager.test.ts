import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEGMENT_MANAGER_LIMITS,
  SegmentManager,
  createJsonSegmentCodec,
  type SegmentOwnerStateV1,
  type SegmentPriority,
  type SegmentStore,
} from "../src/segments";

interface StoredValue {
  readonly count: number;
  readonly label: string;
}

const codec = createJsonSegmentCodec<StoredValue>();

class SegmentHarness {
  readonly data = new Map<number, string>();
  active: readonly number[] = Object.freeze([]);
  nextActive: readonly number[] = Object.freeze([]);
  readonly raw = {
    segments: {} as Record<number, string>,
    setActiveSegments: (ids: number[]) => {
      this.nextActive = Object.freeze([...ids]);
    },
  };

  startTick(): void {
    this.raw.segments = Object.fromEntries(this.active.map((id) => [id, this.data.get(id) ?? ""]));
    this.nextActive = Object.freeze([]);
    vi.stubGlobal("RawMemory", this.raw);
  }

  finishTick(): void {
    for (const [id, value] of Object.entries(this.raw.segments)) {
      this.data.set(Number(id), value);
    }
    this.active = this.nextActive;
  }
}

interface TickSession {
  readonly manager: SegmentManager;
  readonly store: SegmentStore<string, StoredValue>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SegmentManager", () => {
  it("activates one tick ahead and publishes only a verified copy-on-write generation", () => {
    const harness = new SegmentHarness();
    let owner: SegmentOwnerStateV1 | Record<string, never> = {};

    let session = openTick(harness, owner, 100);
    expect(session.store.read("alpha")).toEqual({ status: "missing" });
    expect(session.store.write("alpha", { count: 1, label: "first" })).toEqual({
      accepted: true,
      status: "offered",
    });
    session.manager.reconcile();
    owner = session.manager.view();
    expect(session.store.read("alpha")).toEqual({
      status: "loading",
      reason: "service-unavailable",
    });
    expect(session.manager.metrics()).toMatchObject({
      activatedSegments: 1,
      manifestEntries: 1,
      writes: 0,
    });
    harness.finishTick();

    session = openTick(harness, owner, 101);
    expect(session.store.write("alpha", { count: 1, label: "first" })).toEqual({
      accepted: true,
      status: "offered",
    });
    session.manager.reconcile();
    owner = session.manager.view();
    expect(session.manager.metrics()).toMatchObject({ writes: 1 });
    expect(session.store.read("alpha")).toEqual({
      status: "loading",
      reason: "service-unavailable",
    });
    expect(session.store.write("alpha", { count: 2, label: "late" })).toEqual({
      accepted: false,
      status: "rejected",
      reason: "closed",
    });
    harness.finishTick();

    session = openTick(harness, owner, 102);
    expect(session.store.read("alpha")).toEqual({
      generation: 1,
      status: "ready",
      value: { count: 1, label: "first" },
    });
    for (let read = 1; read < SEGMENT_MANAGER_LIMITS.maximumReadsPerTick; read += 1) {
      expect(session.store.read("alpha").status).toBe("ready");
    }
    expect(session.store.read("alpha")).toEqual({
      status: "loading",
      reason: "read-budget",
    });
    session.manager.reconcile();
    owner = session.manager.view();
    expect(session.manager.metrics()).toMatchObject({
      activatedSegments: 1,
      readBudgetDenied: 1,
      readsReady: SEGMENT_MANAGER_LIMITS.maximumReadsPerTick,
    });
    expect(owner.entries).toHaveLength(1);
    expect(owner.entries[0]).toMatchObject({
      current: { generation: 1 },
      pending: null,
      previous: null,
    });
    expect(JSON.stringify(owner).length).toBeLessThanOrEqual(
      SEGMENT_MANAGER_LIMITS.maximumManifestCodeUnits,
    );
    harness.finishTick();
  });

  it("keeps the last valid generation through an interrupted publish and corrupt-current fallback", () => {
    const harness = new SegmentHarness();
    let owner: SegmentOwnerStateV1 | Record<string, never> = {};

    ({ owner } = publish(harness, owner, 200, { count: 1, label: "stable" }));
    const stableOwner = owner;

    let session = openTick(harness, owner, 203);
    session.store.write("alpha", { count: 2, label: "candidate" });
    session.manager.reconcile();
    owner = session.manager.view();
    harness.finishTick();

    session = openTick(harness, owner, 204);
    session.store.write("alpha", { count: 2, label: "candidate" });
    session.manager.reconcile();
    // Simulate a root commit interruption: raw bytes persist, the pending-written owner does not.
    harness.finishTick();
    owner = JSON.parse(JSON.stringify(owner)) as SegmentOwnerStateV1;

    session = openTick(harness, owner, 205);
    expect(session.store.read("alpha")).toMatchObject({ status: "loading" });
    expect(session.manager.view().entries[0]?.current?.generation).toBe(1);
    session.store.write("alpha", { count: 2, label: "candidate" });
    session.manager.reconcile();
    owner = session.manager.view();
    harness.finishTick();

    session = openTick(harness, owner, 206);
    expect(session.store.read("alpha")).toMatchObject({
      status: "ready",
      value: { count: 2, label: "candidate" },
    });
    session.manager.reconcile();
    owner = session.manager.view();
    harness.finishTick();

    const currentId = owner.entries[0]?.current?.segmentId;
    const previousId = owner.entries[0]?.previous?.segmentId;
    expect(currentId).toBeTypeOf("number");
    expect(previousId).toBeTypeOf("number");
    harness.data.set(currentId as number, "corrupt");

    session = openTick(harness, owner, 207);
    expect(session.store.read("alpha")).toMatchObject({ status: "loading" });
    session.manager.reconcile();
    owner = session.manager.view();
    expect(session.manager.metrics()).toMatchObject({ quarantined: 1 });
    harness.finishTick();

    session = openTick(harness, owner, 208);
    expect(session.store.read("alpha")).toMatchObject({
      status: "ready",
      value: { count: 1, label: "stable" },
    });
    session.manager.reconcile();
    expect(session.manager.metrics()).toMatchObject({ fallbackReads: 1 });
    expect(stableOwner.entries[0]?.current?.generation).toBe(1);
    harness.finishTick();
  });

  it("prioritizes consumers deterministically and sheds optional data first under pressure", () => {
    const forward = pressureOutcome(false);
    const reversed = pressureOutcome(true);

    expect(reversed).toEqual(forward);
    expect(forward.activated).toHaveLength(SEGMENT_MANAGER_LIMITS.maximumActiveSegments);
    expect(forward.readyByPriority).toEqual({
      "active-colony-remote": 2,
      "active-operation": 2,
      "optional-analysis": 4,
      "safety-intel": 2,
    });
    expect(forward.loadingByPriority).toEqual({
      "active-colony-remote": 0,
      "active-operation": 0,
      "optional-analysis": 2,
      "safety-intel": 0,
    });
    expect(forward.maximumWritesObserved).toBeLessThanOrEqual(
      SEGMENT_MANAGER_LIMITS.maximumWritesPerTick,
    );
  });

  it("admits at most two copy-on-write starts and drops optional work first", () => {
    expect(writePressureOwner(false)).toEqual(writePressureOwner(true));
    const outcome = writePressureOwner(false);
    expect(outcome.metrics).toMatchObject({
      activatedSegments: 2,
      deferredWrites: 1,
      pendingWrites: 2,
      writes: 0,
    });
    expect(outcome.storeIds).toEqual(["write-active-operation", "write-safety-intel"]);
  });

  it("bounds per-tick write offers before running unbounded consumer work", () => {
    const harness = new SegmentHarness();
    const session = openTick(harness, {}, 460);
    for (
      let request = 0;
      request < SEGMENT_MANAGER_LIMITS.maximumWriteRequestsPerTick;
      request += 1
    ) {
      expect(session.store.write("alpha", { count: 1, label: "bounded" })).toEqual({
        accepted: true,
        status: "offered",
      });
    }
    expect(session.store.write("alpha", { count: 1, label: "bounded" })).toEqual({
      accepted: false,
      status: "rejected",
      reason: "write-budget",
    });
    session.manager.reconcile();
    expect(session.manager.metrics()).toMatchObject({ rejectedWrites: 1 });
    harness.finishTick();
  });

  it("rejects an impossible envelope before full-manifest eviction", () => {
    const harness = new SegmentHarness();
    const tick = 465;
    const original = fullPhysicalOwner(tick);
    harness.startTick();
    const opened = SegmentManager.open(original, tick);
    if (opened.status === "unsupported") throw new Error("unexpected unsupported owner");
    opened.manager.beginTick();
    const store = opened.manager.register({
      codec: createJsonSegmentCodec<string>(),
      id: "oversized-safety",
      keyOf: (key: string) => key,
      maximumEncodedLength: SEGMENT_MANAGER_LIMITS.maximumSegmentCodeUnits,
      owner: "segment-manager-test",
      priority: "safety-intel",
      schemaVersion: 1,
    });
    expect(
      store.write("key", "x".repeat(SEGMENT_MANAGER_LIMITS.maximumSegmentCodeUnits - 2)),
    ).toEqual({
      accepted: true,
      status: "offered",
    });
    opened.manager.reconcile();
    expect(opened.manager.view()).toEqual(original);
    expect(opened.manager.metrics()).toMatchObject({ evictions: 0, rejectedWrites: 1 });
    harness.finishTick();
  });

  it("preserves a valid predecessor when current corrupts while a replacement is pending", () => {
    const harness = new SegmentHarness();
    let owner: SegmentOwnerStateV1 | Record<string, never> = {};
    ({ owner } = publish(harness, owner, 520, { count: 1, label: "predecessor" }));
    ({ owner } = publish(harness, owner, 523, { count: 2, label: "current" }));

    let session = openTick(harness, owner, 526);
    session.store.write("alpha", { count: 3, label: "replacement" });
    expect(session.store.read("alpha").status).toBe("loading");
    session.manager.reconcile();
    owner = session.manager.view();
    harness.finishTick();

    const corruptId = owner.entries[0]?.current?.segmentId;
    expect(corruptId).toBeTypeOf("number");
    harness.data.set(corruptId as number, "corrupt");

    session = openTick(harness, owner, 527);
    expect(session.store.read("alpha")).toEqual({
      status: "loading",
      reason: "fallback-pending",
    });
    session.store.write("alpha", { count: 3, label: "replacement" });
    session.manager.reconcile();
    owner = session.manager.view();
    expect(owner.entries[0]).toMatchObject({ current: null, previous: { generation: 1 } });
    harness.finishTick();

    session = openTick(harness, owner, 528);
    expect(session.manager.view().entries[0]).toMatchObject({
      current: { generation: 3 },
      pending: null,
      previous: { generation: 1 },
    });
    expect(session.store.read("alpha")).toMatchObject({
      status: "ready",
      value: { count: 3, label: "replacement" },
    });
    session.manager.reconcile();
    harness.finishTick();
  });

  it("does not reuse an evicted opening segment before its manifest removal commits", () => {
    const harness = new SegmentHarness();
    const tick = 470;
    const original = fullPhysicalOwner(tick);
    const originalBytes = envelopeFor("victim-00", "key", 3, {
      count: 7,
      label: "last-valid",
    });
    harness.data.set(0, originalBytes);
    harness.active = Object.freeze([0]);

    harness.startTick();
    const opened = SegmentManager.open(original, tick);
    if (opened.status === "unsupported") throw new Error("unexpected unsupported owner");
    opened.manager.beginTick();
    const incoming = opened.manager.register({
      codec,
      id: "new-safety",
      keyOf: (key: string) => key,
      maximumEncodedLength: 1_024,
      owner: "segment-manager-test",
      priority: "safety-intel",
      schemaVersion: 1,
    });
    expect(incoming.write("key", { count: 8, label: "replacement" }).accepted).toBe(true);
    opened.manager.reconcile();
    expect(opened.manager.metrics()).toMatchObject({ writes: 0 });
    expect(harness.raw.segments[0]).toBe(originalBytes);
    // Simulate root-commit failure by retaining the opening owner.
    harness.finishTick();

    let session = openStoreTick(harness, original, tick + 1, "victim-00", "safety-intel");
    expect(session.store.read("key")).toMatchObject({ status: "loading" });
    session.manager.reconcile();
    const retained = session.manager.view();
    harness.finishTick();

    session = openStoreTick(harness, retained, tick + 2, "victim-00", "safety-intel");
    expect(session.store.read("key")).toMatchObject({
      status: "ready",
      value: { count: 7, label: "last-valid" },
    });
    session.manager.reconcile();
    harness.finishTick();
  });

  it("recovers future-timestamp and malformed manifests without making storage boot-critical", () => {
    const timestampHarness = new SegmentHarness();
    let timestampOwner: SegmentOwnerStateV1 | Record<string, never> = {};
    ({ owner: timestampOwner } = publish(timestampHarness, timestampOwner, 480, {
      count: 1,
      label: "timestamp",
    }));
    const futureTimestamp = JSON.parse(JSON.stringify(timestampOwner)) as {
      entries: { lastAccessTick: number }[];
    };
    if (futureTimestamp.entries[0] === undefined) throw new Error("missing timestamp entry");
    futureTimestamp.entries[0].lastAccessTick = 9_999;
    expect(SegmentManager.open(futureTimestamp, 483).status).toBe("recovered");

    const harness = new SegmentHarness();
    harness.startTick();
    const opened = SegmentManager.open({ schemaVersion: 1, entries: "broken" }, 500);
    expect(opened.status).toBe("recovered");
    if (opened.status === "unsupported") throw new Error("unexpected unsupported owner");
    opened.manager.beginTick();
    opened.manager.reconcile();
    expect(opened.manager.view()).toMatchObject({
      entries: [],
      recoveryCount: 1,
      schemaVersion: 1,
    });
    expect(opened.manager.metrics()).toMatchObject({
      ownerStatus: "recovered",
      rawMemoryAvailable: true,
    });
    harness.finishTick();
  });
});

function openTick(
  harness: SegmentHarness,
  owner: SegmentOwnerStateV1 | Record<string, never>,
  tick: number,
  priority: SegmentPriority = "active-colony-remote",
): TickSession {
  harness.startTick();
  const opened = SegmentManager.open(owner, tick);
  if (opened.status === "unsupported") throw new Error("unexpected unsupported segment owner");
  opened.manager.beginTick();
  const store = opened.manager.register({
    codec,
    id: `test-${priority}`,
    keyOf: (key: string) => key,
    maximumEncodedLength: 1_024,
    owner: "segment-manager-test",
    priority,
    schemaVersion: 1,
  });
  return { manager: opened.manager, store };
}

function openStoreTick(
  harness: SegmentHarness,
  owner: SegmentOwnerStateV1,
  tick: number,
  id: string,
  priority: SegmentPriority,
): TickSession {
  harness.startTick();
  const opened = SegmentManager.open(owner, tick);
  if (opened.status === "unsupported") throw new Error("unexpected unsupported segment owner");
  opened.manager.beginTick();
  const store = opened.manager.register({
    codec,
    id,
    keyOf: (key: string) => key,
    maximumEncodedLength: 1_024,
    owner: "segment-manager-test",
    priority,
    schemaVersion: 1,
  });
  return { manager: opened.manager, store };
}

function fullPhysicalOwner(tick: number): SegmentOwnerStateV1 {
  const validEnvelope = envelopeFor("victim-00", "key", 3, {
    count: 7,
    label: "last-valid",
  });
  const payloadChecksum = checksum(codec.encode({ count: 7, label: "last-valid" }));
  const reference = (segmentId: number, generation: number, size = 1) => ({
    segmentId,
    schemaVersion: 1,
    generation,
    checksum: segmentId === 0 ? payloadChecksum : "00000000",
    size,
    writtenAtTick: tick,
  });
  return {
    schemaVersion: 1,
    revision: 1,
    recoveryCount: 0,
    entries: Array.from({ length: 32 }, (_, index) => ({
      storeId: `victim-${String(index).padStart(2, "0")}`,
      key: "key",
      priority: "optional-analysis" as const,
      lastAccessTick: tick,
      current: reference(index * 3, 3, index === 0 ? validEnvelope.length : 1),
      previous: reference(index * 3 + 1, 2),
      pending: {
        ...reference(index * 3 + 2, 4),
        state: "allocated" as const,
        createdAtTick: tick,
      },
    })),
    quarantine: [96, 97, 98, 99].map((segmentId) => ({
      segmentId,
      quarantinedAtTick: tick,
      retryAtTick: tick + SEGMENT_MANAGER_LIMITS.quarantineTicks,
      reason: "checksum" as const,
    })),
  };
}

function envelopeFor(storeId: string, key: string, generation: number, value: StoredValue): string {
  const payload = codec.encode(value);
  return JSON.stringify({
    version: 1,
    storeId,
    key,
    schemaVersion: 1,
    generation,
    checksum: checksum(payload),
    payload,
  });
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function publish(
  harness: SegmentHarness,
  initialOwner: SegmentOwnerStateV1 | Record<string, never>,
  startTick: number,
  value: StoredValue,
): { readonly owner: SegmentOwnerStateV1 } {
  let owner = initialOwner;
  for (let offset = 0; offset < 3; offset += 1) {
    const session = openTick(harness, owner, startTick + offset);
    session.store.write("alpha", value);
    session.manager.reconcile();
    owner = session.manager.view();
    harness.finishTick();
  }
  return { owner: owner as SegmentOwnerStateV1 };
}

function pressureOutcome(reverse: boolean): {
  readonly activated: readonly number[];
  readonly loadingByPriority: Readonly<Record<SegmentPriority, number>>;
  readonly maximumWritesObserved: number;
  readonly readyByPriority: Readonly<Record<SegmentPriority, number>>;
} {
  const priorities: readonly SegmentPriority[] = [
    "safety-intel",
    "safety-intel",
    "active-operation",
    "active-operation",
    "active-colony-remote",
    "active-colony-remote",
    "optional-analysis",
    "optional-analysis",
    "optional-analysis",
    "optional-analysis",
    "optional-analysis",
    "optional-analysis",
  ];
  const harness = new SegmentHarness();
  let owner: SegmentOwnerStateV1 | Record<string, never> = {};
  let tick = 300;
  let maximumWritesObserved = 0;

  // Publish all values through the same bounded copy-on-write path.
  for (let index = 0; index < priorities.length; index += 1) {
    const priority = priorities[index] as SegmentPriority;
    for (let phase = 0; phase < 3; phase += 1) {
      const session = openTick(harness, owner, tick, priority);
      session.store.write(`key-${String(index).padStart(2, "0")}`, {
        count: index,
        label: priority,
      });
      session.manager.reconcile();
      maximumWritesObserved = Math.max(maximumWritesObserved, session.manager.metrics().writes);
      owner = session.manager.view();
      harness.finishTick();
      tick += 1;
    }
  }

  harness.startTick();
  const opened = SegmentManager.open(owner, tick);
  if (opened.status === "unsupported") throw new Error("unexpected unsupported segment owner");
  opened.manager.beginTick();
  const order = [...priorities.keys()];
  if (reverse) order.reverse();
  const stores = new Map<SegmentPriority, SegmentStore<string, StoredValue>>();
  for (const priority of [...new Set(priorities)]) {
    stores.set(
      priority,
      opened.manager.register({
        codec,
        id: `test-${priority}`,
        keyOf: (key: string) => key,
        maximumEncodedLength: 1_024,
        owner: "segment-manager-test",
        priority,
        schemaVersion: 1,
      }),
    );
  }
  for (const index of order) {
    const priority = priorities[index] as SegmentPriority;
    stores.get(priority)?.read(`key-${String(index).padStart(2, "0")}`);
  }
  opened.manager.reconcile();
  const activated = harness.nextActive;
  owner = opened.manager.view();
  harness.finishTick();

  harness.startTick();
  const next = SegmentManager.open(owner, tick + 1);
  if (next.status === "unsupported") throw new Error("unexpected unsupported segment owner");
  next.manager.beginTick();
  const readyByPriority = emptyPriorityCounts();
  const loadingByPriority = emptyPriorityCounts();
  const registered = new Map<SegmentPriority, SegmentStore<string, StoredValue>>();
  for (const priority of [...new Set(priorities)]) {
    registered.set(
      priority,
      next.manager.register({
        codec,
        id: `test-${priority}`,
        keyOf: (key: string) => key,
        maximumEncodedLength: 1_024,
        owner: "segment-manager-test",
        priority,
        schemaVersion: 1,
      }),
    );
  }
  for (const index of priorities.keys()) {
    const priority = priorities[index] as SegmentPriority;
    const result = registered.get(priority)?.read(`key-${String(index).padStart(2, "0")}`);
    if (result?.status === "ready") readyByPriority[priority] += 1;
    else loadingByPriority[priority] += 1;
  }
  next.manager.reconcile();
  harness.finishTick();
  return { activated, loadingByPriority, maximumWritesObserved, readyByPriority };
}

function writePressureOwner(reverse: boolean): {
  readonly metrics: ReturnType<SegmentManager["metrics"]>;
  readonly storeIds: readonly string[];
} {
  const harness = new SegmentHarness();
  harness.startTick();
  const opened = SegmentManager.open({}, 450);
  if (opened.status === "unsupported") throw new Error("unexpected unsupported owner");
  opened.manager.beginTick();
  const ordered: readonly SegmentPriority[] = reverse
    ? ["optional-analysis", "active-operation", "safety-intel"]
    : ["safety-intel", "active-operation", "optional-analysis"];
  for (const priority of ordered) {
    const store = opened.manager.register({
      codec,
      id: `write-${priority}`,
      keyOf: (key: string) => key,
      maximumEncodedLength: 1_024,
      owner: "segment-manager-test",
      priority,
      schemaVersion: 1,
    });
    expect(store.write("key", { count: 1, label: priority }).accepted).toBe(true);
  }
  opened.manager.reconcile();
  const outcome = {
    metrics: opened.manager.metrics(),
    storeIds: opened.manager.view().entries.map(({ storeId }) => storeId),
  };
  harness.finishTick();
  return outcome;
}

function emptyPriorityCounts(): Record<SegmentPriority, number> {
  return {
    "active-colony-remote": 0,
    "active-operation": 0,
    "optional-analysis": 0,
    "safety-intel": 0,
  };
}
