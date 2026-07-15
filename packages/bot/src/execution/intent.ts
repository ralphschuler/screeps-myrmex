import {
  INTENT_PRIORITY_CLASSES,
  type IntentData,
  type IntentEnvelope,
  type IntentPrecondition,
} from "./contracts";

/**
 * Copies JSON-safe proposal data into a detached, recursively frozen envelope.
 * This prevents a producer from changing a proposal after submission.
 */
export function defineIntent<Kind extends string, Payload extends IntentData>(
  input: IntentEnvelope<Kind, Payload>,
): IntentEnvelope<Kind, Payload> {
  assertNonEmpty(input.id, "intent id");
  assertNonEmpty(input.kind, "intent kind");
  assertNonEmpty(input.issuer, "intent issuer");
  assertNonEmpty(input.target, "intent target");
  assertNonEmpty(input.snapshotRevision, "snapshot revision");
  assertNonEmpty(input.exclusiveResourceKey, "exclusive resource key");
  assertNonEmpty(input.budget.id, "budget id");
  assertSafeTick(input.tick, "intent tick");
  assertSafeTick(input.deadline, "intent deadline");
  assertFinite(input.priority.value, "priority value");
  assertFinite(input.budget.cost, "budget cost");
  if (input.budget.cost < 0) {
    throw new Error("budget cost must be non-negative");
  }
  if (!INTENT_PRIORITY_CLASSES.includes(input.priority.class)) {
    throw new Error(`unknown priority class: ${input.priority.class}`);
  }

  const preconditions = input.preconditions
    .map((precondition) => clonePrecondition(precondition))
    .sort((left, right) => compareStableStrings(left.key, right.key));
  for (let index = 1; index < preconditions.length; index += 1) {
    if (preconditions[index - 1]?.key === preconditions[index]?.key) {
      throw new Error(`duplicate precondition key: ${String(preconditions[index]?.key)}`);
    }
  }
  const envelope: IntentEnvelope<Kind, Payload> = {
    id: input.id,
    kind: input.kind,
    issuer: input.issuer,
    tick: input.tick,
    target: input.target,
    snapshotRevision: input.snapshotRevision,
    exclusiveResourceKey: input.exclusiveResourceKey,
    priority: Object.freeze({ ...input.priority }),
    deadline: input.deadline,
    budget: Object.freeze({ ...input.budget }),
    preconditions: Object.freeze(preconditions),
    payload: cloneIntentData(input.payload) as Payload,
  };

  return Object.freeze(envelope);
}

function clonePrecondition(precondition: IntentPrecondition): IntentPrecondition {
  assertNonEmpty(precondition.key, "precondition key");
  return Object.freeze({
    key: precondition.key,
    expected: cloneIntentData(precondition.expected),
  });
}

function cloneIntentData(value: IntentData, ancestors = new Set<object>()): IntentData {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    assertFinite(value, "intent data number");
    return value;
  }

  if (ancestors.has(value)) {
    throw new Error("intent data must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (isIntentDataArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("intent data arrays must use a plain array prototype");
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length > value.length + 1) {
        throw new Error("intent data arrays must not contain custom fields");
      }
      const clone: IntentData[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new Error("intent data arrays must be dense");
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("intent data arrays must contain enumerable data items");
        }
        clone.push(cloneIntentData(descriptor.value as IntentData, ancestors));
      }
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("intent data objects must use a plain object prototype");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error("intent data objects must not contain symbol fields");
    }
    const clone: Record<string, IntentData> = {};
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`intent data field ${key} must be an enumerable data property`);
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        value: cloneIntentData(descriptor.value as IntentData, ancestors),
        writable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

function isIntentDataArray(value: IntentData): value is readonly IntentData[] {
  return Array.isArray(value);
}

function compareStableStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be non-empty and trimmed`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

function assertSafeTick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}
