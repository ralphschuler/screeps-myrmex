import {
  MAX_CONTRACT_REQUESTS_PER_TICK,
  MAX_CONTRACT_TRANSITIONS_PER_TICK,
  WORK_CONTRACT_STATES,
  compareStrings,
  normalizeContractRequest,
  requestSignature,
  type ContractReplacementRequest,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "./contracts";

export interface ContractRequestProducer {
  replace(request: ContractReplacementRequest): void;
  submit(request: WorkContractRequest): void;
  transition(request: ContractTransitionRequest): void;
}

export interface StagedContractRequests {
  readonly replacements: number;
  readonly requests: number;
  readonly transitions: number;
  commit(): void;
  discard(): void;
}

export interface ContractRequestProducerScope {
  readonly producer: ContractRequestProducer;
  readonly systemId: string;
  discard(): void;
  stage(): StagedContractRequests;
}

export interface ContractRequestBatch {
  readonly replacements: readonly ContractReplacementRequest[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

export interface ContractRequestChannel {
  openProducer(systemId: string): ContractRequestProducerScope;
  seal(): ContractRequestBatch;
}

interface MutableScope {
  replacements: ContractReplacementRequest[];
  requests: WorkContractRequest[];
  state: "committed" | "discarded" | "open" | "staged";
  transitions: ContractTransitionRequest[];
}

export function createContractRequestChannel(): ContractRequestChannel {
  const scopes = new Map<string, MutableScope>();
  let committedRequests = 0;
  let committedTransitions = 0;
  let sealed = false;

  return Object.freeze({
    openProducer(systemId: string): ContractRequestProducerScope {
      assertUnsealed(sealed);
      validateSystemId(systemId);
      if (scopes.has(systemId)) {
        throw new Error(`Contract request producer ${systemId} is already open`);
      }
      const scope: MutableScope = {
        replacements: [],
        requests: [],
        state: "open",
        transitions: [],
      };
      scopes.set(systemId, scope);

      const discard = (): void => {
        if (scope.state === "open" || scope.state === "staged") {
          scope.state = "discarded";
          scope.replacements = [];
          scope.requests = [];
          scope.transitions = [];
        }
      };

      return Object.freeze({
        systemId,
        producer: Object.freeze({
          replace(request: ContractReplacementRequest): void {
            assertScopeOpen(scope, systemId);
            if (
              scope.requests.length + scope.replacements.length >=
              MAX_CONTRACT_REQUESTS_PER_TICK
            ) {
              throw new RangeError(
                `Contract producer ${systemId} exceeded ${String(MAX_CONTRACT_REQUESTS_PER_TICK)} requests`,
              );
            }
            if (
              scope.transitions.length + scope.replacements.length >=
              MAX_CONTRACT_TRANSITIONS_PER_TICK
            ) {
              throw new RangeError(
                `Contract producer ${systemId} exceeded ${String(MAX_CONTRACT_TRANSITIONS_PER_TICK)} transitions`,
              );
            }
            scope.replacements.push(normalizeReplacement(request));
          },
          submit(request: WorkContractRequest): void {
            assertScopeOpen(scope, systemId);
            if (
              scope.requests.length + scope.replacements.length >=
              MAX_CONTRACT_REQUESTS_PER_TICK
            ) {
              throw new RangeError(
                `Contract producer ${systemId} exceeded ${String(MAX_CONTRACT_REQUESTS_PER_TICK)} requests`,
              );
            }
            scope.requests.push(normalizeContractRequest(request));
          },
          transition(request: ContractTransitionRequest): void {
            assertScopeOpen(scope, systemId);
            if (
              scope.transitions.length + scope.replacements.length >=
              MAX_CONTRACT_TRANSITIONS_PER_TICK
            ) {
              throw new RangeError(
                `Contract producer ${systemId} exceeded ${String(MAX_CONTRACT_TRANSITIONS_PER_TICK)} transitions`,
              );
            }
            scope.transitions.push(normalizeTransition(request));
          },
        }),
        discard(): void {
          discard();
        },
        stage(): StagedContractRequests {
          assertScopeOpen(scope, systemId);
          scope.replacements = [...scope.replacements];
          scope.requests = [...scope.requests];
          scope.transitions = [...scope.transitions];
          scope.state = "staged";
          let resolved = false;
          return Object.freeze({
            replacements: scope.replacements.length,
            requests: scope.requests.length,
            transitions: scope.transitions.length,
            commit(): void {
              if (resolved) {
                throw new Error(`Contract request stage for ${systemId} is already resolved`);
              }
              if (scope.state !== "staged" || sealed) {
                throw new Error(`Contract request stage for ${systemId} is already closed`);
              }
              if (
                committedRequests + scope.requests.length + scope.replacements.length >
                MAX_CONTRACT_REQUESTS_PER_TICK
              ) {
                throw new RangeError(
                  `Contract channel committed request capacity of ${String(MAX_CONTRACT_REQUESTS_PER_TICK)} exceeded by ${systemId}`,
                );
              }
              if (
                committedTransitions + scope.transitions.length + scope.replacements.length >
                MAX_CONTRACT_TRANSITIONS_PER_TICK
              ) {
                throw new RangeError(
                  `Contract channel committed transition capacity of ${String(MAX_CONTRACT_TRANSITIONS_PER_TICK)} exceeded by ${systemId}`,
                );
              }

              // Publish the producer atomically only after both aggregate checks pass. A failed
              // producer remains unresolved and is discarded when the channel seals; already
              // committed safety/lifecycle work remains available to reconciliation.
              resolved = true;
              scope.state = "committed";
              committedRequests += scope.requests.length + scope.replacements.length;
              committedTransitions += scope.transitions.length + scope.replacements.length;
            },
            discard(): void {
              if (!resolved) {
                resolved = true;
                discard();
              }
            },
          });
        },
      });
    },
    seal(): ContractRequestBatch {
      assertUnsealed(sealed);
      sealed = true;
      const committed = [...scopes.entries()].filter(([, scope]) => scope.state === "committed");
      for (const [, scope] of scopes) {
        discardScope(scope);
      }
      const replacements = committed
        .flatMap(([, scope]) => scope.replacements)
        .sort(compareReplacements);
      const requests = committed.flatMap(([, scope]) => scope.requests).sort(compareRequests);
      const transitions = committed
        .flatMap(([, scope]) => scope.transitions)
        .sort(compareTransitions);

      return Object.freeze({
        replacements: Object.freeze(replacements),
        requests: Object.freeze(requests),
        transitions: Object.freeze(transitions),
      });
    },
  });
}

function normalizeReplacement(request: ContractReplacementRequest): ContractReplacementRequest {
  const transition = normalizeTransition({
    contractId: request.predecessorContractId,
    reason: request.reason,
    tick: request.tick,
    to: "cancelled",
  });
  return Object.freeze({
    predecessorContractId: transition.contractId,
    reason: transition.reason,
    successor: normalizeContractRequest(request.successor),
    tick: transition.tick,
  });
}

function normalizeTransition(request: ContractTransitionRequest): ContractTransitionRequest {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    throw new RangeError("Contract transition tick must be a non-negative safe integer");
  }
  if (
    typeof request.contractId !== "string" ||
    request.contractId.length === 0 ||
    request.contractId.length > 512 ||
    request.contractId !== request.contractId.trim()
  ) {
    throw new TypeError("Contract transition requires a bounded, trimmed contractId");
  }
  if (
    typeof request.reason !== "string" ||
    request.reason.length === 0 ||
    request.reason.length > 128 ||
    request.reason !== request.reason.trim()
  ) {
    throw new TypeError("Contract transition reason must be a bounded, trimmed string");
  }
  if (typeof request.to !== "string" || !WORK_CONTRACT_STATES.includes(request.to)) {
    throw new TypeError("Contract transition requires a supported state");
  }
  return Object.freeze({
    contractId: request.contractId,
    reason: request.reason,
    tick: request.tick,
    to: request.to,
  });
}

function compareReplacements(
  left: ContractReplacementRequest,
  right: ContractReplacementRequest,
): number {
  return (
    left.tick - right.tick ||
    compareStrings(left.predecessorContractId, right.predecessorContractId) ||
    compareRequests(left.successor, right.successor) ||
    compareStrings(left.reason, right.reason)
  );
}

function compareRequests(left: WorkContractRequest, right: WorkContractRequest): number {
  return (
    compareStrings(left.issuer, right.issuer) ||
    left.issuerSequence - right.issuerSequence ||
    compareStrings(left.issuerKey, right.issuerKey) ||
    compareStrings(requestSignature(left), requestSignature(right))
  );
}

function compareTransitions(
  left: ContractTransitionRequest,
  right: ContractTransitionRequest,
): number {
  return (
    left.tick - right.tick ||
    compareStrings(left.contractId, right.contractId) ||
    compareStrings(left.to, right.to) ||
    compareStrings(left.reason, right.reason)
  );
}

function validateSystemId(systemId: string): void {
  if (systemId.length === 0 || systemId.length > 128 || systemId !== systemId.trim()) {
    throw new TypeError("Contract request producer requires a bounded, trimmed system id");
  }
}

function assertScopeOpen(scope: MutableScope, systemId: string): void {
  if (scope.state !== "open") {
    throw new Error(`Contract request producer ${systemId} is already closed`);
  }
}

function discardScope(scope: MutableScope): void {
  if (scope.state === "open" || scope.state === "staged") {
    scope.state = "discarded";
    scope.replacements = [];
    scope.requests = [];
    scope.transitions = [];
  }
}

function assertUnsealed(sealed: boolean): void {
  if (sealed) {
    throw new Error("Contract request channel is already sealed");
  }
}
