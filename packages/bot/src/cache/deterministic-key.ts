import type { DeterministicCacheKey } from "./contracts";

export function deterministicCacheKey(value: DeterministicCacheKey): string {
  return serialize(value, new Set<object>());
}

function serialize(value: DeterministicCacheKey, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "boolean:true" : "boolean:false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Cache keys cannot contain non-finite numbers");
      }
      return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "object":
      return serializeObject(value, ancestors);
    default:
      throw new TypeError("Cache keys cannot contain unsupported values");
  }
}

function serializeObject(
  value: readonly DeterministicCacheKey[] | { readonly [field: string]: DeterministicCacheKey },
  ancestors: Set<object>,
): string {
  if (ancestors.has(value)) {
    throw new TypeError("Cache keys cannot contain cycles");
  }

  ancestors.add(value);
  try {
    if (isKeyArray(value)) {
      return serializeArray(value, ancestors);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cache key objects must be plain records");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Cache key objects cannot contain symbol fields");
    }

    const keys = (ownKeys as string[]).sort(compareStrings);
    const fields = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Cache key objects must contain enumerable data fields only");
      }

      return `${JSON.stringify(key)}:${serialize(
        descriptor.value as DeterministicCacheKey,
        ancestors,
      )}`;
    });
    return `object:{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: readonly DeterministicCacheKey[], ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new TypeError("Cache key arrays cannot contain symbol fields");
  }

  const expectedOwnKeys = value.length + 1;
  if (ownKeys.length !== expectedOwnKeys) {
    throw new TypeError("Cache key arrays must be dense and contain no custom fields");
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Cache key arrays must contain enumerable data items");
    }
    items.push(serialize(descriptor.value as DeterministicCacheKey, ancestors));
  }
  return `array:[${items.join(",")}]`;
}

function isKeyArray(
  value: readonly DeterministicCacheKey[] | { readonly [field: string]: DeterministicCacheKey },
): value is readonly DeterministicCacheKey[] {
  return Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
