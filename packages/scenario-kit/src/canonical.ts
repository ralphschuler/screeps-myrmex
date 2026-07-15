export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * Serialize JSON-compatible data with lexicographically ordered object keys.
 *
 * Unlike JSON.stringify, this deliberately rejects values that would otherwise
 * be dropped or normalized ambiguously (undefined, sparse arrays, non-finite
 * numbers, symbols, functions, class instances, and cyclic structures).
 */
export function canonicalSerialize(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

/** Return a JSON-compatible clone normalized by {@link canonicalSerialize}. */
export function canonicalClone<Value>(value: Value): Value {
  return JSON.parse(canonicalSerialize(value)) as Value;
}

/**
 * Produce a deterministic, non-cryptographic content hash.
 *
 * FNV-1a is applied to JavaScript UTF-16 code units. The algorithm label is
 * included so stored transcripts remain self-describing if the hash changes.
 */
export function canonicalHash(value: unknown): string {
  const serialized = canonicalSerialize(value);
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }

  return `fnv1a64-utf16:${hash.toString(16).padStart(16, "0")}`;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Canonical data at ${path} contains a non-finite number.`);
      }

      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`Canonical data at ${path} contains unsupported ${typeof value}.`);
    case "object":
      return serializeObject(value, path, ancestors);
  }

  throw new TypeError(`Canonical data at ${path} has an unknown type.`);
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError(`Canonical data at ${path} contains a cycle.`);
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return serializeArray(value, path, ancestors);
    }

    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical data at ${path} must use plain objects.`);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError(`Canonical data at ${path} contains symbol keys.`);
    }

    const entries = (ownKeys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `Canonical data at ${path}.${key} must be an enumerable data property.`,
        );
      }
      return `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`, ancestors)}`;
    });

    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: readonly unknown[], path: string, ancestors: Set<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`Canonical data at ${path} must use a plain array.`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length > value.length + 1) {
    throw new TypeError(
      `Canonical data at ${path} must use a dense array without custom properties.`,
    );
  }

  const items: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      throw new TypeError(`Canonical data at ${path}[${String(index)}] contains a sparse slot.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Canonical data at ${path}[${String(index)}] must be an enumerable data item.`,
      );
    }

    items.push(serialize(descriptor.value, `${path}[${String(index)}]`, ancestors));
  }

  return `[${items.join(",")}]`;
}
