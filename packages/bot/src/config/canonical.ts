const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function canonicalSerialize(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function canonicalHash(value: unknown): string {
  const serialized = canonicalSerialize(value);
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }

  return `fnv1a64-utf16:${hash.toString(16).padStart(16, "0")}`;
}

export function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Clone JSON-like data without changing object insertion order. */
export function cloneDataPreservingOrder<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    const source = value as readonly unknown[];
    const clone: unknown[] = [];
    for (const item of source) {
      clone.push(cloneDataPreservingOrder(item));
    }
    return clone as Value;
  }
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      clone[key] = cloneDataPreservingOrder((value as Record<string, unknown>)[key]);
    }
    return clone as Value;
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical configuration contains a non-finite number");
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      return serializeObject(value, ancestors);
    default:
      throw new TypeError(`Canonical configuration contains unsupported ${typeof value}`);
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError("Canonical configuration contains a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Canonical configuration arrays must contain dense data items");
        }
        items.push(serialize(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical configuration cannot contain symbol fields");
    }
    const entries = (keys as string[]).sort(compareStrings).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Canonical configuration objects must contain data fields");
      }
      return `${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
