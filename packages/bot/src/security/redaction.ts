const MAX_UNTRUSTED_CODE_UNITS = 512;
const MAX_OPAQUE_ID_CODE_UNITS = 96;

/**
 * Converts untrusted values into deterministic opaque references. It never returns source bytes,
 * so diagnostics may safely retain the result without leaking player data or terminal controls.
 */
export function opaqueId(domain: string, value: unknown): string {
  const safeDomain = safeDomainName(domain);
  const bytes = boundedString(value);
  return `${safeDomain}:${fnv1a32(bytes)}`.slice(0, MAX_OPAQUE_ID_CODE_UNITS);
}

/** A stable replacement for any untrusted rendering context, including thrown values. */
export function redactUntrusted(domain: string, value: unknown): string {
  return `redacted:${opaqueId(domain, value)}`;
}

/** Only source-controlled machine codes may cross a text rendering boundary verbatim. */
export function safeCode(value: unknown, fallback = "invalid-code"): string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : fallback;
}

function safeDomainName(value: string): string {
  return /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : "unknown";
}

function boundedString(value: unknown): string {
  try {
    if (typeof value !== "string") return `type:${typeof value}`;
    return value.slice(0, MAX_UNTRUSTED_CODE_UNITS);
  } catch {
    return "unreadable";
  }
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
