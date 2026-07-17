import { describe, expect, it, vi } from "vitest";
import type { ArbitrationBatch } from "../src/execution";
import type {
  MatureMechanicsCatalog,
  MatureStructureCapability,
} from "../src/industry/mature-capabilities";
import {
  createPendingObserverAttempt,
  executeObserverIntents,
  isPendingObserverAttempt,
  markObserverAttemptRetryReady,
  projectObserverIntents,
  projectObserverTelemetry,
  reconcilePendingObserverAttempts,
  type ObservationRequestV1,
  type ObserverAuthorization,
  type ObserverExecutionAdapter,
  type ObserverIntent,
  type PendingObserverAttempt,
} from "../src/observer";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("observer authority", () => {
  it("deterministically selects at most one request per observer and ages waiting work", () => {
    const requests = [request("later", "W4N4", 100, 110), request("urgent", "W3N3", 100, 104)];
    const input = projectionInput(requests);
    const selected = projectObserverIntents(input);
    expect(
      projectObserverIntents({
        ...input,
        authorizations: [...input.authorizations].reverse(),
        requests: [...requests].reverse(),
      }),
    ).toEqual(selected);
    expect(
      selected.intents.map(({ exclusiveResourceKey, kind, payload }) => ({
        exclusiveResourceKey,
        kind,
        requestId: payload.requestId,
        targetRoomName: payload.targetRoomName,
      })),
    ).toEqual([
      {
        exclusiveResourceKey: "observer/observer-1",
        kind: "observer.observe-room",
        requestId: "urgent",
        targetRoomName: "W3N3",
      },
    ]);
    expect(selected.dispositions).toEqual([
      expect.objectContaining({ reason: "observer-busy", requestId: "later", status: "deferred" }),
      expect.objectContaining({
        observerId: "observer-1",
        requestId: "urgent",
        status: "accepted",
      }),
    ]);

    const old = {
      ...request("old", "W3N3", 0, 1_100),
      priority: { class: "speculation" as const, value: 0 },
    };
    const fresh = {
      ...request("fresh", "W4N4", 1_000, 1_100),
      priority: { class: "safety" as const, value: 10 },
    };
    expect(
      projectObserverIntents({
        ...projectionInput([fresh, old]),
        snapshot: snapshot({ tick: 1_000 }),
      }).intents[0]?.payload.requestId,
    ).toBe("old");

    const flexible = request("flexible", "W5N5", 100, 104);
    const constrained = request("constrained", "E8S8", 100, 105);
    const matched = projectObserverIntents({
      ...projectionInput([flexible, constrained]),
      capabilities: [
        capability(false, "observer-1", "W1N1"),
        capability(false, "observer-2", "W10N10"),
      ],
      snapshot: twoObserverSnapshot(),
    });
    expect(matched.intents.map(({ payload }) => [payload.requestId, payload.observerId])).toEqual([
      ["constrained", "observer-1"],
      ["flexible", "observer-2"],
    ]);
  });

  it("fails invalid, duplicate, stale, unauthorized, missing, inactive, RCL, and range cases closed", () => {
    const valid = request("valid", "W2N2");
    const invalid = request("invalid", "north");
    const duplicate = request("duplicate", "W2N3");
    const revisedDuplicate = { ...duplicate, revision: 2 };
    const stale = { ...request("stale", "W2N4"), snapshotRevision: "snapshot/99" };
    const unauthorized = request("unauthorized", "W2N5");
    const result = projectObserverIntents({
      ...projectionInput([]),
      authorizations: [valid, invalid, duplicate, stale].map(authorization),
      requests: [valid, invalid, duplicate, revisedDuplicate, stale, unauthorized],
    });
    expect(result.intents.map(({ payload }) => payload.requestId)).toEqual(["valid"]);
    expect(result.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "invalid-request", requestId: "invalid" }),
        expect.objectContaining({ reason: "duplicate-request", requestId: "duplicate" }),
        expect.objectContaining({ reason: "stale-request", requestId: "stale" }),
        expect.objectContaining({ reason: "unauthorized", requestId: "unauthorized" }),
      ]),
    );

    const cases = [
      {
        capabilities: [] as MatureStructureCapability[],
        reason: "missing-observer",
        snapshot: snapshot(),
        target: "W2N2",
      },
      {
        capabilities: [{ ...capability(), active: false }],
        reason: "inactive-observer",
        snapshot: snapshot({ active: false }),
        target: "W2N2",
      },
      {
        capabilities: [capability()],
        reason: "insufficient-rcl",
        snapshot: snapshot({ rcl: 7 }),
        target: "W2N2",
      },
      {
        capabilities: [capability()],
        reason: "out-of-range",
        snapshot: snapshot(),
        target: "E30S30",
      },
    ];
    for (const value of cases) {
      const candidate = request("candidate", value.target);
      expect(
        projectObserverIntents({
          ...projectionInput([candidate]),
          capabilities: value.capabilities,
          snapshot: value.snapshot,
        }).dispositions,
      ).toEqual([expect.objectContaining({ reason: value.reason })]);
    }

    const mixed = request("mixed", "W2N2");
    const unrelated = Array.from({ length: 33 }, (_, index) => ({
      ...capability(false, `factory-${String(index)}`, "W1N1"),
      id: `factory-${String(index)}`,
      kind: "factory" as const,
      range: 0,
    }));
    expect(
      projectObserverIntents({
        ...projectionInput([mixed]),
        capabilities: [capability(), ...unrelated],
      }).intents,
    ).toHaveLength(1);
  });

  it("uses active operate-observer range and suppresses already-fresh vision", () => {
    const distant = request("distant", "E30S30");
    expect(
      projectObserverIntents({
        ...projectionInput([distant]),
        capabilities: [capability(true)],
        snapshot: snapshot({ powered: true }),
      }).intents,
    ).toHaveLength(1);

    const boundary = request("boundary", "E8S8");
    const beyond = request("beyond", "E9S8");
    expect(projectObserverIntents(projectionInput([boundary])).intents).toHaveLength(1);
    expect(projectObserverIntents(projectionInput([beyond])).dispositions).toEqual([
      expect.objectContaining({ reason: "out-of-range" }),
    ]);

    const future = { ...request("future", "W3N3"), minimumObservationTick: 101 };
    expect(projectObserverIntents(projectionInput([future])).intents).toHaveLength(1);

    const fresh = request("fresh", "W3N3");
    expect(
      projectObserverIntents({
        ...projectionInput([fresh]),
        snapshot: snapshot({ visibleRoom: "W3N3" }),
      }),
    ).toMatchObject({
      intents: [],
      dispositions: [{ reason: "already-visible", status: "satisfied" }],
    });
  });

  it("executes accepted requests once, revalidates live state, and normalizes documented codes", () => {
    for (const code of [0, -1, -9, -10, -14] as const) {
      const observeRoom = vi.fn((): ScreepsReturnCode => code);
      const results = executeObserverIntents(
        batch([intent()]),
        100,
        adapter(liveObserver(observeRoom)),
      );
      expect(observeRoom).toHaveBeenCalledOnce();
      expect(observeRoom).toHaveBeenCalledWith("W3N3");
      expect(results[0]).toMatchObject({ returnCode: code });
    }
    const rejected = vi.fn((): ScreepsReturnCode => 0);
    expect(
      executeObserverIntents(batch([intent()]), 100, adapter(liveObserver(rejected, 7)))[0],
    ).toMatchObject({ reason: "ERR_INVALID_TARGET", status: "rejected" });
    expect(rejected).not.toHaveBeenCalled();

    const unaccepted = vi.fn((): ScreepsReturnCode => 0);
    expect(
      executeObserverIntents(
        { ...batch([intent()]), accepted: [] },
        100,
        adapter(liveObserver(unaccepted)),
      ),
    ).toEqual([]);
    expect(unaccepted).not.toHaveBeenCalled();

    const duplicateCall = vi.fn((): ScreepsReturnCode => 0);
    const first = intent();
    const second = {
      ...first,
      id: "observer-command/duplicate/1/100",
      exclusiveResourceKey: "observer/forged-key",
    };
    expect(
      executeObserverIntents(batch([first, second]), 100, adapter(liveObserver(duplicateCall))),
    ).toEqual([]);
    expect(duplicateCall).not.toHaveBeenCalled();
  });

  it("keeps OK pending until next-tick vision and bounds no-effect retries across reset", () => {
    const accepted = intent();
    const attempt = required(createPendingObserverAttempt(accepted, "OK"));
    expect(isPendingObserverAttempt(roundTrip(attempt))).toBe(true);
    expect(createPendingObserverAttempt(accepted, "ERR_NOT_IN_RANGE")).toBeNull();
    const maximumIdentityRequest = {
      ...request("x".repeat(160), "W3N3"),
      authorizationId: "authorization/maximum-id",
    };
    const maximumIdentityIntent = required(
      projectObserverIntents(projectionInput([maximumIdentityRequest])).intents[0],
    );
    expect(createPendingObserverAttempt(maximumIdentityIntent, "OK")).not.toBeNull();
    expect(
      reconcilePendingObserverAttempts({
        authorizations: [authorization(request("urgent", "W3N3"))],
        pendingAttempts: [attempt],
        snapshot: snapshot(),
      }),
    ).toEqual([expect.objectContaining({ reason: "awaiting-observation", status: "pending" })]);

    const noEffect = required(
      reconcilePendingObserverAttempts({
        authorizations: [authorization(request("urgent", "W3N3"), 101)],
        pendingAttempts: roundTrip([attempt]),
        snapshot: snapshot({ tick: 101 }),
      })[0],
    );
    expect(noEffect).toMatchObject({ reason: "no-effect", retry: 1, status: "retry" });
    const retryReady = required(markObserverAttemptRetryReady(attempt, noEffect));
    expect(retryReady).toMatchObject({ retry: 1, retryReady: true });
    expect(
      reconcilePendingObserverAttempts({
        authorizations: [authorization(request("urgent", "W3N3"), 111)],
        pendingAttempts: [retryReady],
        snapshot: snapshot({ tick: 111 }),
      }),
    ).toEqual([expect.objectContaining({ reason: "deadline", status: "cancelled" })]);

    const settled = reconcilePendingObserverAttempts({
      authorizations: [authorization(request("urgent", "W3N3"), 101)],
      pendingAttempts: [attempt],
      snapshot: snapshot({ tick: 101, visibleRoom: "W3N3" }),
    });
    expect(settled).toEqual([
      expect.objectContaining({ reason: "visible-next-tick", status: "settled" }),
    ]);

    let current = attempt;
    for (let tick = 101; tick <= 103; tick += 1) {
      const result = required(
        reconcilePendingObserverAttempts({
          authorizations: [authorization(request("urgent", "W3N3"), tick)],
          pendingAttempts: [current],
          snapshot: snapshot({ tick }),
        })[0],
      );
      if (tick === 103) {
        expect(result).toMatchObject({ reason: "retry-cap", status: "cancelled" });
      } else {
        current = reissued(required(markObserverAttemptRetryReady(current, result)), tick);
      }
    }

    expect(
      projectObserverTelemetry({
        dispositions: projectObserverIntents(projectionInput([request("urgent", "W3N3")]))
          .dispositions,
        execution: [],
        intents: [accepted],
        settlements: settled,
      }),
    ).toMatchObject({ intents: 1, settlements: { settled: 1 }, truncated: false });
  });
});

function projectionInput(requests: readonly ObservationRequestV1[]) {
  return {
    authorizations: requests.map(authorization),
    capabilities: [capability()],
    catalog: catalog(),
    requests,
    snapshot: snapshot(),
    snapshotRevision: "snapshot/100",
  };
}

function request(
  id: string,
  targetRoomName: string,
  requestedAt = 100,
  deadline = 110,
): ObservationRequestV1 {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    issuer: "intel/freshness",
    requestedAt,
    deadline,
    targetRoomName,
    minimumObservationTick: requestedAt,
    priority: { class: "speculation", value: 10 },
    authorizationId: `authorization/${id}`,
    authorizationRevision: 1,
    snapshotRevision: "snapshot/100",
  };
}
function authorization(value: ObservationRequestV1, tick = 100): ObserverAuthorization {
  return {
    id: value.authorizationId,
    revision: value.authorizationRevision,
    issuer: value.issuer,
    active: true,
    expiresAt: Math.max(value.deadline, tick),
  };
}
function capability(
  powered = false,
  id = "observer-1",
  roomName = "W1N1",
): MatureStructureCapability {
  return {
    active: true,
    availableProducts: [],
    cooldown: 0,
    effectLevels: powered ? ["7:1:20"] : [],
    fingerprint: powered ? `${id}-powered` : `${id}-capability`,
    id,
    kind: "observer",
    level: null,
    processablePower: 0,
    range: 10,
    roomName,
    stocked: false,
    storeFingerprint: "none",
  };
}
function catalog(): MatureMechanicsCatalog {
  return {
    fingerprint: "mechanics",
    recipes: [],
    resources: [],
    constants: {
      factoryCapacity: 50_000,
      nukerCooldown: 100_000,
      nukerEnergyCapacity: 300_000,
      nukerGhodiumCapacity: 5_000,
      nukerRange: 10,
      observerRange: 10,
      operateFactoryPower: 19,
      operateObserverPower: 7,
      operatePowerEffects: [1, 2, 3, 4, 5],
      operatePowerPower: 16,
      powerSpawnEnergyCapacity: 5_000,
      powerSpawnEnergyPerPower: 50,
      powerSpawnPowerCapacity: 100,
    },
  };
}
function snapshot(
  options: {
    readonly active?: boolean;
    readonly powered?: boolean;
    readonly rcl?: number;
    readonly tick?: number;
    readonly visibleRoom?: string;
  } = {},
): WorldSnapshot {
  const tick = options.tick ?? 100;
  const room = {
    constructionSites: [],
    controller: {
      id: "controller",
      level: options.rcl ?? 8,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: 0,
      progressTotal: 1,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 100_000,
      upgradeBlocked: null,
    },
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name: "W1N1",
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedObservers: [
      {
        active: options.active ?? true,
        effects: options.powered ? [{ effect: 7, level: 1, ticksRemaining: 20 }] : [],
        hits: 500,
        hitsMax: 500,
        id: "observer-1",
        pos: { roomName: "W1N1", x: 20, y: 20 },
      },
    ],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
  };
  const visible = options.visibleRoom;
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [room],
    rooms: visible === undefined ? [room] : [room, { ...room, name: visible, ownedObservers: [] }],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: visible === undefined ? 1 : 2,
        sources: 0,
        storedStructures: 0,
        total: 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: {
      absentRoomSemantics: "unknown",
      rooms:
        visible === undefined
          ? []
          : [{ age: 0, observedAt: tick, roomName: visible, status: "visible" }],
      scope: "current-tick",
    },
  };
}
function twoObserverSnapshot(): WorldSnapshot {
  const base = snapshot();
  const first = required(base.ownedRooms[0]);
  const firstObserver = required(first.ownedObservers?.[0]);
  const roomName = "W10N10";
  const second = {
    ...first,
    controller: {
      ...first.controller,
      id: "controller-2",
      pos: { roomName, x: 25, y: 25 },
    },
    name: roomName,
    ownedObservers: [
      {
        ...firstObserver,
        id: "observer-2",
        pos: { roomName, x: 20, y: 20 },
      },
    ],
  };
  return {
    ...base,
    ownedRooms: [first, second],
    rooms: [first, second],
  };
}
function intent(): ObserverIntent {
  return required(projectObserverIntents(projectionInput([request("urgent", "W3N3")])).intents[0]);
}
function batch(accepted: readonly ObserverIntent[]): ArbitrationBatch {
  return {
    tick: 100,
    submitted: accepted.length,
    acceptedBudget: accepted.length,
    accepted,
    decisions: [],
  };
}
function liveObserver(
  observeRoom: (roomName: string) => ScreepsReturnCode,
  rcl = 8,
): StructureObserver {
  return {
    id: "observer-1",
    my: true,
    effects: [],
    pos: { roomName: "W1N1" },
    room: { name: "W1N1", controller: { my: true, level: rcl } },
    isActive: () => true,
    observeRoom,
  } as unknown as StructureObserver;
}
function adapter(observer: StructureObserver): ObserverExecutionAdapter {
  return {
    currentCapabilityFingerprint: () => "observer-1-capability",
    currentMechanicsFingerprint: () => "mechanics",
    resolveObserver: (id) => (id === observer.id ? observer : null),
  };
}
function reissued(attempt: PendingObserverAttempt, tick: number): PendingObserverAttempt {
  return {
    attemptId: `observer-command/${attempt.requestId}/${String(attempt.requestRevision)}/${String(tick)}`,
    authorizationId: attempt.authorizationId,
    authorizationRevision: attempt.authorizationRevision,
    capabilityFingerprint: attempt.capabilityFingerprint,
    deadline: attempt.deadline,
    issuedAt: tick,
    issuer: attempt.issuer,
    mechanicsFingerprint: attempt.mechanicsFingerprint,
    observeAt: tick + 1,
    observerId: attempt.observerId,
    originRoomName: attempt.originRoomName,
    requestId: attempt.requestId,
    requestRevision: attempt.requestRevision,
    retry: attempt.retry,
    targetRoomName: attempt.targetRoomName,
  };
}
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected fixture value");
  return value;
}
