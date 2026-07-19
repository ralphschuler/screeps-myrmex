import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_CONTRACTS,
  MAX_CONTRACT_HISTORY,
  MAX_CONTRACT_ISSUERS,
  MAX_CONTRACT_OUTCOMES,
  MAX_CONTRACT_REQUESTS_PER_TICK,
  MAX_CONTRACT_TRANSITIONS_PER_TICK,
  WORK_CONTRACT_STATES,
  ContractLedger,
  contractIdFor,
  isLegalContractTransition,
  requestSignature,
  serializeContractLedgerState,
  type ActiveWorkContractState,
  type CapabilityVector,
  type ContractFundingView,
  type TerminalWorkContractState,
  type TravelEstimateView,
  type WorkforceActor,
  type WorkContractRequest,
  type WorkContractState,
} from "../src/contracts";
import { openMyrmexMemory } from "../src/state/memory";

const ACTIVE_STATES = ["proposed", "funded", "assigned", "active", "suspended"] as const;

const LEGAL_TRANSITIONS = {
  proposed: ["funded", "cancelled", "expired"],
  funded: ["assigned", "suspended", "cancelled", "expired"],
  assigned: ["active", "suspended", "cancelled", "expired", "failed"],
  active: ["completed", "suspended", "cancelled", "expired", "failed"],
  suspended: ["funded", "cancelled", "expired", "failed"],
} as const satisfies Readonly<Record<ActiveWorkContractState, readonly WorkContractState[]>>;

const ZERO_TRAVEL: TravelEstimateView = Object.freeze({
  estimate: () => 0,
});

describe("ContractLedger", () => {
  it("initializes an empty owner as schema v1 and round-trips canonical state", () => {
    const ledger = openLedger({});

    expect(ledger.changed).toBe(true);
    expect(ledger.view()).toEqual({
      active: [],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    });

    const serialized = serializeContractLedgerState(ledger.view());
    const persisted = JSON.parse(JSON.stringify(serialized)) as unknown;
    const reopened = openLedger(persisted);

    expect(reopened.changed).toBe(false);
    expect(reopened.view()).toEqual(ledger.view());
    expect(serializeContractLedgerState(reopened.view())).toEqual(serialized);
  });

  it("makes issuer retries idempotent and rejects changed terms for the same issuer key", () => {
    const ledger = openLedger({});
    const request = makeRequest();
    const created = ledger.submit(request, 10);

    expect(created).toEqual({
      accepted: true,
      contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
      outcome: "created",
    });
    const afterCreation = JSON.stringify(ledger.view());

    expect(ledger.submit(request, 11)).toEqual({
      accepted: true,
      contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
      outcome: "duplicate-active",
    });
    expect(JSON.stringify(ledger.view())).toBe(afterCreation);

    expect(ledger.submit(makeRequest({ quantity: 2 }), 11)).toEqual({
      accepted: false,
      contractId: contractIdFor(request.issuer, request.issuerKey, request.issuerSequence),
      reason: "idempotency-conflict",
    });
    expect(JSON.stringify(ledger.view())).toBe(afterCreation);
  });

  it("rejects late lower issuer sequences while accepting reordered ascending batch work", () => {
    const lateLedger = openLedger({});
    const later = makeRequest({
      budgetBinding: uniqueBudgetBinding(2),
      issuerKey: "later",
      issuerSequence: 2,
    });
    submitOrThrow(lateLedger, later, 1);
    const beforeRegression = JSON.stringify(lateLedger.view());
    const earlier = makeRequest({
      budgetBinding: uniqueBudgetBinding(1),
      issuerKey: "earlier",
      issuerSequence: 1,
    });

    expect(lateLedger.submit(earlier, 1)).toEqual({
      accepted: false,
      contractId: contractIdFor(earlier.issuer, earlier.issuerKey, earlier.issuerSequence),
      reason: "issuer-sequence-regressed",
    });
    expect(JSON.stringify(lateLedger.view())).toBe(beforeRegression);

    const batchLedger = openLedger({});
    const result = batchLedger.reconcile({
      actors: [],
      funding: activeFunding(),
      requests: [later, earlier],
      tick: 1,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(result.submissions).toEqual([
      expect.objectContaining({ accepted: true, outcome: "created" }),
      expect.objectContaining({ accepted: true, outcome: "created" }),
    ]);
    expect(
      batchLedger
        .view()
        .active.map(({ issuerSequence }) => issuerSequence)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("allows one active contract per stable BudgetLedger binding and reuses it sequentially", () => {
    const ledger = openLedger({});
    const first = makeRequest({ issuerKey: "binding-first" });
    const second = makeRequest({ issuerKey: "binding-second", issuerSequence: 2 });
    const firstId = submitOrThrow(ledger, first, 1);
    const beforeConflict = JSON.stringify(ledger.view());

    expect(ledger.submit(second, 1)).toEqual({
      accepted: false,
      contractId: contractIdFor(second.issuer, second.issuerKey, second.issuerSequence),
      reason: "funding-binding-conflict",
    });
    expect(JSON.stringify(ledger.view())).toBe(beforeConflict);

    transitionOrThrow(ledger, firstId, "cancelled", 2);
    expect(ledger.submit(second, 2)).toMatchObject({ accepted: true, outcome: "created" });
  });

  it("atomically replaces one funded binding with its exact next issuer sequence", () => {
    const predecessor = makeRequest({
      execution: {
        action: "harvest",
        completion: "continuous",
        counterpartId: null,
        resourceType: null,
        version: 2,
        workPosition: { roomName: "W1N1", x: 9, y: 9 },
      },
    });
    const { id: predecessorId, ledger } = createAssignedLedger(predecessor);
    const successor = makeRequest({
      execution: {
        action: "harvest",
        completion: "continuous",
        counterpartId: null,
        resourceType: null,
        version: 2,
        workPosition: { roomName: "W1N1", x: 11, y: 11 },
      },
      issuerSequence: 2,
    });
    const successorId = contractIdFor(
      successor.issuer,
      successor.issuerKey,
      successor.issuerSequence,
    );
    const beforeExecute = ledger.executionView();
    const result = ledger.reconcile({
      actors: [makeActor("incumbent")],
      funding: activeFunding(),
      replacements: [
        {
          predecessorContractId: predecessorId,
          reason: "source-service-handoff",
          successor,
          tick: 4,
        },
      ],
      requests: [],
      tick: 4,
      transitions: [{ contractId: successorId, reason: "successor-funded", tick: 4, to: "funded" }],
      travel: ZERO_TRAVEL,
    });

    expect(beforeExecute.leases).toEqual([
      expect.objectContaining({ contractId: predecessorId, actorId: "incumbent" }),
    ]);
    expect(result.replacements).toEqual([
      { accepted: true, predecessorContractId: predecessorId, successorContractId: successorId },
    ]);
    expect(ledger.view().active).toEqual([
      expect.objectContaining({
        id: successorId,
        issuerSequence: 2,
        state: "assigned",
      }),
    ]);
    expect(ledger.view().active[0]?.lease).toMatchObject({ actorId: "incumbent" });
    expect(ledger.view().outcomes).toEqual([
      expect.objectContaining({
        id: predecessorId,
        reason: "source-service-handoff",
        state: "cancelled",
      }),
    ]);

    const rejected = createAssignedLedger(predecessor);
    const beforeRejected = JSON.stringify(rejected.ledger.view());
    const invalidSuccessor = { ...successor, issuerSequence: 3 };
    expect(
      rejected.ledger.reconcile({
        actors: [makeActor("incumbent")],
        funding: activeFunding(),
        replacements: [
          {
            predecessorContractId: rejected.id,
            reason: "invalid-handoff",
            successor: invalidSuccessor,
            tick: 4,
          },
        ],
        requests: [],
        tick: 4,
        transitions: [],
        travel: ZERO_TRAVEL,
      }).replacements,
    ).toEqual([
      {
        accepted: false,
        predecessorContractId: rejected.id,
        reason: "relationship-mismatch",
      },
    ]);
    expect(JSON.stringify(rejected.ledger.view())).toBe(beforeRejected);

    const wrongTick = createAssignedLedger(predecessor);
    const beforeWrongTick = JSON.stringify(wrongTick.ledger.view());
    expect(
      wrongTick.ledger.reconcile({
        actors: [makeActor("incumbent")],
        funding: activeFunding(),
        replacements: [
          {
            predecessorContractId: wrongTick.id,
            reason: "future-handoff",
            successor,
            tick: 5,
          },
        ],
        requests: [],
        tick: 4,
        transitions: [],
        travel: ZERO_TRAVEL,
      }).replacements,
    ).toEqual([
      {
        accepted: false,
        predecessorContractId: wrongTick.id,
        reason: "invalid-replacement",
      },
    ]);
    expect(JSON.stringify(wrongTick.ledger.view())).toBe(beforeWrongTick);
  });

  it("publishes the legal transition matrix and leaves state byte-identical after rejection", () => {
    for (const from of ACTIVE_STATES) {
      for (const to of WORK_CONTRACT_STATES) {
        expect(isLegalContractTransition(from, to), `${from} -> ${to}`).toBe(
          LEGAL_TRANSITIONS[from].includes(to as never),
        );
      }
    }

    const ledger = openLedger({});
    const id = submitOrThrow(ledger, makeRequest(), 1);
    const proposedBytes = JSON.stringify(ledger.view());

    expect(
      ledger.transition({ contractId: id, reason: "skip-required-state", tick: 2, to: "active" }),
    ).toEqual({
      accepted: false,
      contractId: id,
      reason: "illegal-transition",
    });
    expect(JSON.stringify(ledger.view())).toBe(proposedBytes);

    expect(
      ledger.transition({ contractId: id, reason: "unvalidated-funding", tick: 2, to: "funded" }),
    ).toEqual({
      accepted: false,
      contractId: id,
      reason: "funding-authorization-required",
    });
    expect(JSON.stringify(ledger.view())).toBe(proposedBytes);
    fundContractOrThrow(ledger, id, 2);
    const fundedBytes = JSON.stringify(ledger.view());
    expect(
      ledger.transition({ contractId: id, reason: "direct-assignment", tick: 3, to: "assigned" }),
    ).toEqual({
      accepted: false,
      contractId: id,
      reason: "assignment-required",
    });
    expect(JSON.stringify(ledger.view())).toBe(fundedBytes);
  });

  it("moves every terminal state into a compact outcome and deduplicates terminal retries", () => {
    const cases: readonly TerminalWorkContractState[] = [
      "completed",
      "cancelled",
      "expired",
      "failed",
    ];

    for (const terminal of cases) {
      const request = makeRequest({ issuerKey: `terminal-${terminal}` });
      const ledger =
        terminal === "completed" || terminal === "failed"
          ? createAssignedLedger(request).ledger
          : openLedger({});
      const id =
        terminal === "completed" || terminal === "failed"
          ? contractIdFor(request.issuer, request.issuerKey, request.issuerSequence)
          : submitOrThrow(ledger, request, 1);

      if (terminal === "completed") {
        transitionOrThrow(ledger, id, "active", 4);
      }

      const result = ledger.transition({
        contractId: id,
        reason: `terminal-${terminal}`,
        tick: 5,
        to: terminal,
      });

      expect(result).toMatchObject({ accepted: true, contractId: id, to: terminal });
      expect(ledger.view().active).toEqual([]);
      expect(ledger.view().outcomes).toEqual([
        expect.objectContaining({
          id,
          issuer: request.issuer,
          issuerKey: request.issuerKey,
          reason: `terminal-${terminal}`,
          state: terminal,
          tick: 5,
        }),
      ]);
      expect(Object.keys(ledger.view().outcomes[0] ?? {}).sort()).toEqual([
        "id",
        "issuer",
        "issuerKey",
        "issuerSequence",
        "reason",
        "requestSignature",
        "revision",
        "state",
        "tick",
      ]);
      expect(ledger.submit(request, 6)).toEqual({
        accepted: true,
        contractId: id,
        outcome: "duplicate-terminal",
      });
      expect(ledger.submit(makeRequest({ ...request, quantity: request.quantity + 1 }), 6)).toEqual(
        {
          accepted: false,
          contractId: id,
          reason: "idempotency-conflict",
        },
      );
    }
  });

  it.each([
    {
      actors: [makeActor("replacement")],
      reason: "actor-missing",
      scenario: "death",
    },
    {
      actors: [
        makeActor("incumbent", { capability: capability({ work: 0 }) }),
        makeActor("replacement"),
      ],
      reason: "actor-capability-lost",
      scenario: "capability loss",
    },
    {
      actors: [makeActor("incumbent", { ticksToLive: 7 }), makeActor("replacement")],
      reason: "actor-ttl-insufficient",
      scenario: "insufficient TTL",
    },
  ] as const)("releases and reassigns a lease after $scenario", ({ actors, reason }) => {
    const request = makeRequest();
    const { ledger, id } = createAssignedLedger(request);
    expect(ledger.view().active[0]?.lease?.actorId).toBe("incumbent");

    const reconciliation = ledger.reconcile({
      actors,
      funding: activeFunding(),
      requests: [],
      tick: 4,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(reconciliation.releases).toEqual([{ contractId: id, reason }]);
    expect(reconciliation.allocation.assignments).toEqual([
      expect.objectContaining({ actorId: "replacement", contractId: id }),
    ]);
    expect(ledger.view().active[0]).toMatchObject({
      id,
      lease: { actorId: "replacement", actorName: "replacement" },
      state: "assigned",
    });
    expect(ledger.view().active[0]?.history.slice(-3)).toEqual([
      expect.objectContaining({ from: "assigned", reason, to: "suspended" }),
      expect.objectContaining({ from: "suspended", reason: "work-remains-funded", to: "funded" }),
      expect.objectContaining({ from: "funded", reason: "workforce-assigned", to: "assigned" }),
    ]);
  });

  it("releases and deterministically reassigns on the first expired lease tick", () => {
    const { ledger, id } = createAssignedLedger(makeRequest());
    expect(ledger.view().active[0]?.lease?.expiresAt).toBe(13);

    const reconciliation = ledger.reconcile({
      actors: [makeActor("replacement")],
      funding: activeFunding(),
      requests: [],
      tick: 13,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(reconciliation.releases).toEqual([{ contractId: id, reason: "lease-expired" }]);
    expect(reconciliation.allocation.assignments).toEqual([
      expect.objectContaining({ actorId: "replacement", contractId: id }),
    ]);
    expect(ledger.view().active[0]).toMatchObject({
      lease: { actorId: "replacement", expiresAt: 23 },
      state: "assigned",
    });
  });

  it.each([
    {
      label: "missing",
      funding: {
        authorizations: [],
        owners: [{ id: "W1N1", visibility: "visible" }],
        status: "ready",
      } satisfies ContractFundingView,
      reason: "funding-reservation-missing",
    },
    {
      label: "pending",
      funding: activeFunding({ status: "pending" }),
      reason: "funding-reservation-inactive",
    },
    {
      label: "consumed",
      funding: activeFunding({ status: "consumed" }),
      reason: "funding-reservation-inactive",
    },
    {
      label: "released",
      funding: activeFunding({ status: "released" }),
      reason: "funding-reservation-inactive",
    },
    {
      label: "expired status",
      funding: activeFunding({ status: "expired" }),
      reason: "funding-reservation-expired",
    },
    {
      label: "expired tick",
      funding: activeFunding({ expiresAt: 9 }),
      reason: "funding-reservation-expired",
    },
    {
      label: "wrong stable binding",
      funding: activeFunding({ issuer: "another-budget" }),
      reason: "funding-reservation-missing",
    },
  ] as const)(
    "rejects $label authorization before funding or assignment",
    ({ funding, reason }) => {
      const ledger = openLedger({});
      const id = submitOrThrow(ledger, makeRequest(), 1);
      const before = JSON.stringify(ledger.view());

      const result = ledger.reconcile({
        actors: [makeActor("candidate")],
        funding,
        requests: [],
        tick: 10,
        transitions: [{ contractId: id, reason: "request-funding", tick: 10, to: "funded" }],
        travel: ZERO_TRAVEL,
      });

      expect(result.transitions).toEqual([{ accepted: false, contractId: id, reason }]);
      expect(result.allocation.assignments).toEqual([]);
      expect(JSON.stringify(ledger.view())).toBe(before);
    },
  );

  it("does not let a colony reservation fund a different owner scope", () => {
    const ledger = openLedger({});
    const id = submitOrThrow(
      ledger,
      makeRequest({ owner: { id: "operation:1", kind: "operation" } }),
      1,
    );
    const before = JSON.stringify(ledger.view());
    const result = ledger.reconcile({
      actors: [makeActor("candidate")],
      funding: activeFunding(),
      requests: [],
      tick: 2,
      transitions: [{ contractId: id, reason: "request-funding", tick: 2, to: "funded" }],
      travel: ZERO_TRAVEL,
    });

    expect(result.transitions).toEqual([
      { accepted: false, contractId: id, reason: "funding-owner-not-colony" },
    ]);
    expect(result.allocation.assignments).toEqual([]);
    expect(JSON.stringify(ledger.view())).toBe(before);
  });

  it("accepts a matching live reservation and survives a rotating reservation revision", () => {
    const ledger = openLedger({});
    const request = makeRequest();
    const id = submitOrThrow(ledger, request, 1);
    const funded = ledger.reconcile({
      actors: [makeActor("incumbent")],
      funding: activeFunding({ reservationId: "reservation:test:1", revision: 1 }),
      requests: [],
      tick: 2,
      transitions: [{ contractId: id, reason: "budget-ready", tick: 2, to: "funded" }],
      travel: ZERO_TRAVEL,
    });

    expect(funded.transitions).toEqual([
      { accepted: true, contractId: id, from: "proposed", to: "funded" },
    ]);
    expect(funded.funding).toEqual([
      {
        contractId: id,
        reason: "authorized",
        reservationId: "reservation:test:1",
        status: "authorized",
      },
    ]);
    expect(ledger.view().active[0]).toMatchObject({
      id,
      lease: { actorId: "incumbent" },
      state: "assigned",
    });

    const renewed = ledger.reconcile({
      actors: [makeActor("incumbent")],
      funding: activeFunding({ reservationId: "reservation:test:2", revision: 2 }),
      requests: [request],
      tick: 3,
      transitions: [],
      travel: ZERO_TRAVEL,
    });
    expect(renewed.submissions).toEqual([
      { accepted: true, contractId: id, outcome: "duplicate-active" },
    ]);
    expect(renewed.funding[0]).toMatchObject({
      reason: "authorized",
      reservationId: "reservation:test:2",
    });
    expect(ledger.view().active).toHaveLength(1);
    expect(ledger.view().active[0]?.lease?.actorId).toBe("incumbent");
  });

  it("suspends funded unassigned work when the live reservation disappears", () => {
    const ledger = openLedger({});
    const id = submitOrThrow(ledger, makeRequest(), 1);
    fundContractOrThrow(ledger, id, 2);
    expect(ledger.view().active[0]).toMatchObject({ lease: null, state: "funded" });

    const revoked = ledger.reconcile({
      actors: [makeActor("candidate")],
      funding: {
        authorizations: [],
        owners: [{ id: "W1N1", visibility: "visible" }],
        status: "ready",
      },
      requests: [],
      tick: 3,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(revoked.allocation.assignments).toEqual([]);
    expect(revoked.funding[0]).toMatchObject({
      reason: "reservation-missing",
      status: "denied",
    });
    expect(ledger.view().active[0]).toMatchObject({ lease: null, state: "suspended" });
  });

  it("revokes a lease, preserves unknown visibility, and restores only after reauthorization", () => {
    const { ledger, id } = createAssignedLedger(makeRequest());
    const assignedBytes = JSON.stringify(ledger.view());
    const hidden = ledger.reconcile({
      actors: [makeActor("replacement")],
      funding: activeFunding({ visibility: "unknown" }),
      requests: [],
      tick: 4,
      transitions: [],
      travel: ZERO_TRAVEL,
    });
    expect(hidden.funding[0]).toMatchObject({
      reason: "owner-observation-unknown",
      status: "unavailable",
    });
    expect(hidden.allocation.assignments).toEqual([]);
    expect(JSON.stringify(ledger.view())).toBe(assignedBytes);

    const revoked = ledger.reconcile({
      actors: [makeActor("incumbent"), makeActor("replacement")],
      funding: activeFunding({ status: "released" }),
      requests: [],
      tick: 5,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(revoked.releases).toEqual([{ contractId: id, reason: "budget-authorization-lost" }]);
    expect(revoked.allocation.assignments).toEqual([]);
    expect(ledger.view().active[0]).toMatchObject({ lease: null, state: "suspended" });

    const suspendedBytes = JSON.stringify(ledger.view());
    const unknown = ledger.reconcile({
      actors: [makeActor("replacement")],
      funding: activeFunding({ visibility: "unknown" }),
      requests: [],
      tick: 6,
      transitions: [],
      travel: ZERO_TRAVEL,
    });
    expect(unknown.funding).toEqual([
      {
        contractId: id,
        reason: "owner-observation-unknown",
        reservationId: null,
        status: "unavailable",
      },
    ]);
    expect(unknown.allocation.assignments).toEqual([]);
    expect(JSON.stringify(ledger.view())).toBe(suspendedBytes);

    const restored = ledger.reconcile({
      actors: [makeActor("replacement")],
      funding: activeFunding({ reservationId: "reservation:test:renewed", revision: 2 }),
      requests: [],
      tick: 7,
      transitions: [{ contractId: id, reason: "budget-restored", tick: 7, to: "funded" }],
      travel: ZERO_TRAVEL,
    });
    expect(restored.transitions).toEqual([
      { accepted: true, contractId: id, from: "suspended", to: "funded" },
    ]);
    expect(ledger.view().active[0]).toMatchObject({
      lease: { actorId: "replacement" },
      state: "assigned",
    });
  });

  it("rejects a malformed duplicate authorization view before mutating the ledger", () => {
    const ledger = openLedger({});
    const id = submitOrThrow(ledger, makeRequest(), 1);
    const before = JSON.stringify(ledger.view());
    const authorization = activeFunding().authorizations[0];
    if (authorization === undefined) {
      throw new Error("expected authorization fixture");
    }

    expect(() =>
      ledger.reconcile({
        actors: [],
        funding: {
          authorizations: [authorization, { ...authorization, reservationId: "duplicate" }],
          owners: [{ id: "W1N1", visibility: "visible" }],
          status: "ready",
        },
        requests: [],
        tick: 2,
        transitions: [{ contractId: id, reason: "budget-ready", tick: 2, to: "funded" }],
        travel: ZERO_TRAVEL,
      }),
    ).toThrow(/duplicate identities/u);
    expect(JSON.stringify(ledger.view())).toBe(before);
  });

  it("enforces request and active caps across owner reopen boundaries", () => {
    let ledger = openLedger({});

    for (let index = 0; index < MAX_CONTRACT_REQUESTS_PER_TICK; index += 1) {
      submitOrThrow(
        ledger,
        makeRequest({
          budgetBinding: uniqueBudgetBinding(index),
          issuerKey: `active-${String(index)}`,
          issuerSequence: index + 1,
        }),
        1,
      );
    }
    const beforeRequestLimit = JSON.stringify(ledger.view());
    expect(ledger.submit(makeRequest({ issuerKey: "request-overflow" }), 1)).toEqual({
      accepted: false,
      contractId: null,
      reason: "request-limit",
    });
    expect(JSON.stringify(ledger.view())).toBe(beforeRequestLimit);

    let next = MAX_CONTRACT_REQUESTS_PER_TICK;
    while (next < MAX_ACTIVE_CONTRACTS) {
      ledger = reopenLedger(ledger);
      const end = Math.min(next + MAX_CONTRACT_REQUESTS_PER_TICK, MAX_ACTIVE_CONTRACTS);
      for (; next < end; next += 1) {
        submitOrThrow(
          ledger,
          makeRequest({
            budgetBinding: uniqueBudgetBinding(next),
            issuerKey: `active-${String(next)}`,
            issuerSequence: next + 1,
          }),
          2,
        );
      }
    }

    expect(ledger.view().active).toHaveLength(MAX_ACTIVE_CONTRACTS);
    ledger = reopenLedger(ledger);
    const atCapacity = JSON.stringify(ledger.view());
    expect(
      ledger.submit(
        makeRequest({
          issuerKey: "active-overflow",
          issuerSequence: MAX_ACTIVE_CONTRACTS + 1,
        }),
        3,
      ),
    ).toEqual({
      accepted: false,
      contractId: contractIdFor("planner", "active-overflow", MAX_ACTIVE_CONTRACTS + 1),
      reason: "capacity",
    });
    expect(JSON.stringify(ledger.view())).toBe(atCapacity);
  });

  it("resets producer quotas only when the ledger advances to a later tick", () => {
    const ledger = openLedger({});
    for (let index = 0; index < MAX_CONTRACT_REQUESTS_PER_TICK; index += 1) {
      submitOrThrow(
        ledger,
        makeRequest({
          budgetBinding: uniqueBudgetBinding(index),
          issuerKey: `quota-${String(index)}`,
          issuerSequence: index + 1,
        }),
        1,
      );
    }
    expect(ledger.submit(makeRequest({ issuerKey: "same-tick-overflow" }), 1)).toMatchObject({
      accepted: false,
      reason: "request-limit",
    });
    expect(
      ledger.submit(
        makeRequest({
          budgetBinding: uniqueBudgetBinding(MAX_CONTRACT_REQUESTS_PER_TICK),
          issuerKey: "later-tick",
          issuerSequence: MAX_CONTRACT_REQUESTS_PER_TICK + 1,
        }),
        2,
      ),
    ).toMatchObject({ accepted: true, outcome: "created" });

    for (let index = 0; index < MAX_CONTRACT_TRANSITIONS_PER_TICK; index += 1) {
      expect(
        ledger.transition({
          contractId: `missing-${String(index)}`,
          reason: "quota-probe",
          tick: 3,
          to: "cancelled",
        }),
      ).toMatchObject({ accepted: false, reason: "contract-not-found" });
    }
    expect(
      ledger.transition({
        contractId: "same-tick-overflow",
        reason: "quota-probe",
        tick: 3,
        to: "cancelled",
      }),
    ).toMatchObject({ accepted: false, reason: "transition-limit" });
    expect(
      ledger.transition({
        contractId: "later-tick-missing",
        reason: "quota-probe",
        tick: 4,
        to: "cancelled",
      }),
    ).toMatchObject({ accepted: false, reason: "contract-not-found" });
    expect(
      ledger.transition({
        contractId: "backwards-tick",
        reason: "quota-probe",
        tick: 3,
        to: "cancelled",
      }),
    ).toMatchObject({ accepted: false, reason: "invalid-transition" });
  });

  it("fails closed when the bounded issuer authority set is full", () => {
    const ledger = openLedger({});
    for (let index = 0; index < MAX_CONTRACT_ISSUERS; index += 1) {
      submitOrThrow(
        ledger,
        makeRequest({
          budgetBinding: uniqueBudgetBinding(index),
          issuer: `planner:${String(index)}`,
          issuerKey: "first",
          issuerSequence: 1,
        }),
        1,
      );
    }
    const overflow = makeRequest({
      budgetBinding: uniqueBudgetBinding(MAX_CONTRACT_ISSUERS),
      issuer: "planner:overflow",
      issuerKey: "first",
      issuerSequence: 1,
    });
    const before = JSON.stringify(ledger.view());

    expect(ledger.submit(overflow, 2)).toEqual({
      accepted: false,
      contractId: contractIdFor(overflow.issuer, overflow.issuerKey, overflow.issuerSequence),
      reason: "issuer-capacity",
    });
    expect(JSON.stringify(ledger.view())).toBe(before);
  });

  it("retains bounded transition history and the newest bounded terminal outcomes", () => {
    const historyLedger = openLedger({});
    const historyId = submitOrThrow(historyLedger, makeRequest(), 1);
    fundContractOrThrow(historyLedger, historyId, 2);
    for (let index = 0; index < MAX_CONTRACT_HISTORY; index += 1) {
      transitionOrThrow(historyLedger, historyId, "suspended", 3 + index * 2);
      fundContractOrThrow(historyLedger, historyId, 4 + index * 2);
    }

    const record = historyLedger.view().active[0];
    expect(record?.history).toHaveLength(MAX_CONTRACT_HISTORY);
    expect(record?.history[0]).not.toMatchObject({ from: null, to: "proposed" });
    const finalHistoryEvent = record?.history[record.history.length - 1];
    expect(finalHistoryEvent).toMatchObject({ from: "suspended", to: "funded" });

    let outcomeLedger = openLedger({});
    let firstId = "";
    let firstRequest: WorkContractRequest | null = null;
    for (let index = 0; index < MAX_CONTRACT_OUTCOMES; index += 1) {
      const request = makeRequest({
        deadline: MAX_CONTRACT_OUTCOMES + 20,
        expiresAt: MAX_CONTRACT_OUTCOMES + 21,
        issuerKey: `outcome-${String(index)}`,
        issuerSequence: index + 1,
      });
      const id = submitOrThrow(outcomeLedger, request, index + 1);
      firstId ||= id;
      firstRequest ??= request;
      transitionOrThrow(outcomeLedger, id, "cancelled", index + 1);
    }
    expect(outcomeLedger.view().outcomes).toHaveLength(MAX_CONTRACT_OUTCOMES);

    outcomeLedger = reopenLedger(outcomeLedger);
    const newestRequest = makeRequest({
      deadline: MAX_CONTRACT_OUTCOMES + 20,
      expiresAt: MAX_CONTRACT_OUTCOMES + 21,
      issuerKey: "outcome-newest",
      issuerSequence: MAX_CONTRACT_OUTCOMES + 1,
    });
    const newestId = submitOrThrow(outcomeLedger, newestRequest, MAX_CONTRACT_OUTCOMES + 10);
    transitionOrThrow(outcomeLedger, newestId, "cancelled", MAX_CONTRACT_OUTCOMES + 10);

    expect(outcomeLedger.view().outcomes).toHaveLength(MAX_CONTRACT_OUTCOMES);
    expect(outcomeLedger.view().outcomes.some(({ id }) => id === firstId)).toBe(false);
    const outcomes = outcomeLedger.view().outcomes;
    expect(outcomes[outcomes.length - 1]?.id).toBe(newestId);
    if (firstRequest === null) {
      throw new Error("expected the first terminal request fixture");
    }
    const beforeRetry = JSON.stringify(outcomeLedger.view());
    expect(outcomeLedger.submit(firstRequest, MAX_CONTRACT_OUTCOMES + 11)).toEqual({
      accepted: false,
      contractId: firstId,
      reason: "retired-identity",
    });
    expect(JSON.stringify(outcomeLedger.view())).toBe(beforeRetry);
    expect(
      outcomeLedger.submit(
        makeRequest({
          deadline: MAX_CONTRACT_OUTCOMES + 20,
          expiresAt: MAX_CONTRACT_OUTCOMES + 21,
          issuerKey: "outcome-after-frontier",
          issuerSequence: MAX_CONTRACT_OUTCOMES + 2,
        }),
        MAX_CONTRACT_OUTCOMES + 11,
      ),
    ).toMatchObject({ accepted: true, outcome: "created" });
  });

  it("uses one binary ID order for same-tick outcomes and persisted validation", () => {
    const ledger = openLedger({});
    const upper = submitOrThrow(
      ledger,
      makeRequest({
        budgetBinding: uniqueBudgetBinding(1),
        issuerKey: "case-A",
        issuerSequence: 1,
      }),
      1,
    );
    const lower = submitOrThrow(
      ledger,
      makeRequest({
        budgetBinding: uniqueBudgetBinding(2),
        issuerKey: "case-a",
        issuerSequence: 2,
      }),
      1,
    );
    transitionOrThrow(ledger, lower, "cancelled", 2);
    transitionOrThrow(ledger, upper, "cancelled", 2);

    expect(ledger.view().outcomes.map(({ id }) => id)).toEqual([upper, lower]);
    expect(() => serializeContractLedgerState(ledger.view())).not.toThrow();
    expect(reopenLedger(ledger).view()).toEqual(ledger.view());
  });

  it("rejects malformed and future owner data without changing its bytes", () => {
    const malformed = {
      active: "not-an-array",
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    };
    const malformedBytes = JSON.stringify(malformed);
    const invalid = ContractLedger.open(malformed);

    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid") {
      expect(invalid.error).toMatchObject({ code: "invalid-array", path: "$.active" });
    }
    expect(JSON.stringify(malformed)).toBe(malformedBytes);

    const future = { active: [{ opaque: true }], outcomes: [], schemaVersion: 2 };
    const futureBytes = JSON.stringify(future);
    expect(ContractLedger.open(future)).toEqual({ foundSchemaVersion: 2, status: "unsupported" });
    expect(JSON.stringify(future)).toBe(futureBytes);
  });

  it("rejects malformed or identity-mismatched terminal request signatures", () => {
    const ledger = openLedger({});
    const request = makeRequest();
    const id = submitOrThrow(ledger, request, 1);
    transitionOrThrow(ledger, id, "cancelled", 2);

    for (const [signature, code] of [
      ["not-a-request", "invalid-outcome-request-signature"],
      [
        requestSignature(makeRequest({ issuerKey: "forged", issuerSequence: 2 })),
        "invalid-outcome-request-identity",
      ],
    ] as const) {
      const owner = JSON.parse(JSON.stringify(ledger.view())) as {
        outcomes: { requestSignature: string }[];
      };
      const outcome = owner.outcomes[0];
      if (outcome === undefined) {
        throw new Error("expected terminal outcome fixture");
      }
      outcome.requestSignature = signature;
      const before = JSON.stringify(owner);
      const opened = ContractLedger.open(owner);

      expect(opened.status).toBe("invalid");
      if (opened.status === "invalid") {
        expect(opened.error).toMatchObject({ code, path: "$.outcomes[0].requestSignature" });
      }
      expect(JSON.stringify(owner)).toBe(before);
    }
  });

  it("rejects non-canonical nested owner data and backwards transition time", () => {
    const ledger = openLedger({});
    const id = submitOrThrow(ledger, makeRequest(), 5);
    const before = JSON.stringify(ledger.view());

    expect(
      ledger.transition({ contractId: id, reason: "older-than-proposal", tick: 4, to: "funded" }),
    ).toEqual({ accepted: false, contractId: id, reason: "invalid-transition" });
    expect(JSON.stringify(ledger.view())).toBe(before);

    const reconciled = ledger.reconcile({
      actors: [],
      funding: activeFunding(),
      requests: [],
      tick: 5,
      transitions: [{ contractId: id, reason: "future-event", tick: 6, to: "funded" }],
      travel: ZERO_TRAVEL,
    });
    expect(reconciled.transitions).toEqual([
      { accepted: false, contractId: id, reason: "invalid-transition" },
    ]);
    expect(JSON.stringify(ledger.view())).toBe(before);

    const malformed = JSON.parse(JSON.stringify(ledger.view())) as {
      active: { owner: Record<string, unknown> }[];
    };
    const active = malformed.active[0];
    if (active === undefined) {
      throw new Error("expected active contract fixture");
    }
    active.owner.extra = true;
    const opened = ContractLedger.open(malformed);
    expect(opened.status).toBe("invalid");
    if (opened.status === "invalid") {
      expect(opened.error).toMatchObject({
        code: "unexpected-keys",
        path: "$.active[0].owner",
      });
    }

    const expired = openLedger({});
    const expiredId = submitOrThrow(
      expired,
      makeRequest({ deadline: 5, expiresAt: 6, issuerKey: "direct-expiry" }),
      1,
    );
    expect(
      expired.transition({
        contractId: expiredId,
        reason: "too-late",
        tick: 6,
        to: "cancelled",
      }),
    ).toEqual({ accepted: false, contractId: expiredId, reason: "invalid-transition" });
  });

  it("expires mandatory lifecycle work even after the producer transition quota is exhausted", () => {
    const ledger = openLedger({});
    const request = makeRequest({ deadline: 2, expiresAt: 3 });
    const id = submitOrThrow(ledger, request, 1);
    for (let index = 0; index < MAX_CONTRACT_TRANSITIONS_PER_TICK; index += 1) {
      expect(
        ledger.transition({
          contractId: `missing-${String(index)}`,
          reason: "quota-probe",
          tick: 2,
          to: "cancelled",
        }),
      ).toMatchObject({ accepted: false, reason: "contract-not-found" });
    }

    ledger.reconcile({
      actors: [],
      funding: activeFunding(),
      requests: [],
      tick: 3,
      transitions: [],
      travel: ZERO_TRAVEL,
    });

    expect(ledger.view().active).toEqual([]);
    expect(ledger.view().outcomes).toEqual([
      expect.objectContaining({ id, reason: "contract-expired", state: "expired", tick: 3 }),
    ]);
  });

  it("gives expiry precedence over producer transitions on the first invalid tick", () => {
    const ledger = openLedger({});
    const request = makeRequest({ deadline: 2, expiresAt: 3 });
    const id = submitOrThrow(ledger, request, 1);

    const reconciliation = ledger.reconcile({
      actors: [],
      funding: activeFunding(),
      requests: [],
      tick: 3,
      transitions: [{ contractId: id, reason: "late-cancellation", tick: 3, to: "cancelled" }],
      travel: ZERO_TRAVEL,
    });

    expect(reconciliation.transitions).toEqual([
      { accepted: false, contractId: id, reason: "contract-not-found" },
    ]);
    expect(ledger.view().outcomes).toEqual([
      expect.objectContaining({ id, reason: "contract-expired", state: "expired", tick: 3 }),
    ]);
  });

  it("stages the complete contracts owner through MemoryManager without writing before commit", () => {
    const memory = {} as Memory;
    const openedMemory = openMyrmexMemory(memory, 50, "shard3");
    if (openedMemory.status !== "ready") {
      throw new Error(`expected ready memory, got ${openedMemory.status}`);
    }
    const manager = openedMemory.manager;
    const ledger = openLedger(manager.ownerView("contracts"));
    const request = makeRequest();
    submitOrThrow(ledger, request, 50);
    const expectedOwner = serializeContractLedgerState(ledger.view());
    const rootBeforeStage = memory.myrmex;

    expect(ledger.stage(manager)).toEqual({ staged: true });
    expect(memory.myrmex).toBe(rootBeforeStage);
    expect(memory.myrmex?.contracts).toEqual({});
    expect(manager.commitReconciliation()).toEqual({
      committed: true,
      owners: ["contracts"],
      revision: 1,
    });
    expect(memory.myrmex?.contracts).toEqual(expectedOwner);

    const reopened = ContractLedger.open(memory.myrmex?.contracts);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") {
      expect(reopened.ledger.view()).toEqual(ledger.view());
    }
  });

  it("projects only explicitly executable leased work in stable actor order", () => {
    const first = createAssignedLedger(
      makeRequest({
        execution: {
          action: "harvest",
          completion: "continuous",
          counterpartId: null,
          resourceType: null,
          version: 1,
        },
      }),
    );
    const secondRequest = makeRequest({
      budgetBinding: uniqueBudgetBinding(2),
      execution: {
        action: "harvest",
        completion: "target-depleted",
        counterpartId: null,
        resourceType: null,
        version: 1,
      },
      issuerKey: "second-source",
      issuerSequence: 2,
      targetId: "source-2",
    });
    const secondId = submitOrThrow(first.ledger, secondRequest, 4);
    const funding = {
      authorizations: [
        ...activeFunding().authorizations,
        ...activeFunding({ issuer: "planner:budget:2" }).authorizations,
      ],
      owners: [{ id: "W1N1", visibility: "visible" as const }],
      status: "ready" as const,
    };
    first.ledger.reconcile({
      actors: [makeActor("incumbent"), makeActor("actor-a")],
      funding,
      requests: [],
      tick: 5,
      transitions: [{ contractId: secondId, reason: "test-funded", tick: 5, to: "funded" }],
      travel: ZERO_TRAVEL,
    });

    const view = first.ledger.executionView();
    expect(view.status).toBe("ready");
    expect(
      view.leases.map(({ actorId, contractId, execution }) => ({
        action: execution.action,
        actorId,
        completion: execution.completion,
        contractId,
      })),
    ).toEqual([
      {
        action: "harvest",
        actorId: "actor-a",
        completion: "target-depleted",
        contractId: secondId,
      },
      {
        action: "harvest",
        actorId: "incumbent",
        completion: "continuous",
        contractId: first.id,
      },
    ]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.leases)).toBe(true);
    expect(reopenLedger(first.ledger).executionView()).toEqual(view);

    const legacy = createAssignedLedger(makeRequest()).ledger.executionView();
    expect(legacy).toEqual({ leases: [], status: "ready" });
  });

  it("rejects malformed or ambiguous execution terms without changing contract state", () => {
    const ledger = openLedger({});
    const before = JSON.stringify(ledger.view());
    const invalid = makeRequest({
      execution: {
        action: "transfer",
        completion: "target-full",
        counterpartId: null,
        resourceType: "energy",
        version: 1,
      },
    });
    const missingResource = makeRequest({
      kind: "fill",
      execution: {
        action: "transfer",
        completion: "target-full",
        counterpartId: null,
        resourceType: null,
        version: 1,
      },
    });

    expect(ledger.submit(invalid, 1)).toMatchObject({ accepted: false, reason: "invalid-request" });
    expect(ledger.submit(missingResource, 1)).toMatchObject({
      accepted: false,
      reason: "invalid-request",
    });
    expect(JSON.stringify(ledger.view())).toBe(before);
  });
});

function openLedger(value: unknown): ContractLedger {
  const opened = ContractLedger.open(value);
  if (opened.status !== "ready") {
    throw new Error(`expected ready contract ledger, got ${opened.status}`);
  }
  return opened.ledger;
}

function reopenLedger(ledger: ContractLedger): ContractLedger {
  return openLedger(
    JSON.parse(JSON.stringify(serializeContractLedgerState(ledger.view()))) as unknown,
  );
}

function submitOrThrow(ledger: ContractLedger, request: WorkContractRequest, tick: number): string {
  const result = ledger.submit(request, tick);
  if (!result.accepted) {
    throw new Error(`contract submission failed: ${result.reason}`);
  }
  return result.contractId;
}

function fundContractOrThrow(ledger: ContractLedger, contractId: string, tick: number): void {
  const result = ledger.reconcile({
    actors: [],
    funding: activeFunding(),
    requests: [],
    tick,
    transitions: [{ contractId, reason: "test-funded", tick, to: "funded" }],
    travel: ZERO_TRAVEL,
  }).transitions[0];
  if (result?.accepted !== true) {
    throw new Error(`contract funding failed: ${result?.reason ?? "missing-result"}`);
  }
}

function activeFunding(
  overrides: Partial<{
    readonly category: string;
    readonly colonyId: string;
    readonly expiresAt: number;
    readonly issuer: string;
    readonly reservationId: string;
    readonly revision: number;
    readonly status: "active" | "consumed" | "expired" | "pending" | "released";
    readonly visibility: "unknown" | "visible";
  }> = {},
): Extract<ContractFundingView, { readonly status: "ready" }> {
  const colonyId = overrides.colonyId ?? "W1N1";
  return {
    authorizations: [
      {
        category: overrides.category ?? "harvesting-filling",
        colonyId,
        expiresAt: overrides.expiresAt ?? 1_000,
        issuer: overrides.issuer ?? "planner:budget",
        reservationId: overrides.reservationId ?? "reservation:test:1",
        revision: overrides.revision ?? 1,
        status: overrides.status ?? "active",
      },
    ],
    owners: [{ id: colonyId, visibility: overrides.visibility ?? "visible" }],
    status: "ready",
  };
}

function uniqueBudgetBinding(index: number): WorkContractRequest["budgetBinding"] {
  return { category: "harvesting-filling", issuer: `planner:budget:${String(index)}` };
}

function transitionOrThrow(
  ledger: ContractLedger,
  contractId: string,
  to: WorkContractState,
  tick: number,
): void {
  const result = ledger.transition({ contractId, reason: `test-${to}`, tick, to });
  if (!result.accepted) {
    throw new Error(`contract transition failed: ${result.reason}`);
  }
}

function createAssignedLedger(request: WorkContractRequest): {
  readonly id: string;
  readonly ledger: ContractLedger;
} {
  const ledger = openLedger({});
  const id = submitOrThrow(ledger, request, 1);
  fundContractOrThrow(ledger, id, 2);
  ledger.reconcile({
    actors: [makeActor("incumbent")],
    funding: activeFunding(),
    requests: [],
    tick: 3,
    transitions: [],
    travel: ZERO_TRAVEL,
  });
  if (ledger.view().active[0]?.state !== "assigned") {
    throw new Error("expected workforce reconciliation to assign the funded contract");
  }
  return { id, ledger };
}

function makeRequest(overrides: Partial<WorkContractRequest> = {}): WorkContractRequest {
  return {
    budgetBinding: { category: "harvesting-filling", issuer: "planner:budget" },
    conditions: {
      cancellation: "cancelled",
      failure: "failed",
      success: "completed",
    },
    deadline: 100,
    earliestStart: 0,
    estimatedWorkTicks: 5,
    expiresAt: 101,
    issuer: "planner",
    issuerKey: "harvest-source",
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: {
      duration: 10,
      switchingPenalty: 2,
      ttlSafetyMargin: 3,
    },
    maxAssignmentCost: 25,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: ["source-visible"],
    priority: { class: "survival", value: 100 },
    quantity: 1,
    range: 1,
    requiredCapability: capability({ work: 1 }),
    target: { roomName: "W1N1", x: 10, y: 10 },
    targetId: "source-1",
    ...overrides,
  };
}

function makeActor(id: string, overrides: Partial<WorkforceActor> = {}): WorkforceActor {
  return {
    capability: capability({ move: 1, work: 1 }),
    id,
    name: id,
    pos: { roomName: "W1N1", x: 10, y: 10 },
    spawning: false,
    ticksToLive: 100,
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    attack: 0,
    carry: 0,
    claim: 0,
    heal: 0,
    move: 0,
    rangedAttack: 0,
    tough: 0,
    work: 0,
    ...overrides,
  };
}
