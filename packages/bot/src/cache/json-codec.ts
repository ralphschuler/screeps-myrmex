import type { CacheCodec } from "./contracts";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [field: string]: JsonValue };

/**
 * Stores a detached JSON representation so callers cannot mutate a cached value in place.
 */
export function createJsonCacheCodec<Value extends JsonValue>(): CacheCodec<Value> {
  return {
    encode(value): string {
      return JSON.stringify(value);
    },
    decode(encoded): Value {
      return JSON.parse(encoded) as Value;
    },
  };
}
