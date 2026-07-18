import {
  COLONY_DOMAIN_HEALTH_DOMAINS,
  type ColonyDomainHealthDomain,
  type ColonyDomainHealthProjection,
  type ColonyDomainHealthReason,
  type ColonyDomainHealthStatus,
} from "./contracts";

const MAX_RAW_DOMAIN_HEALTH_STATUSES = COLONY_DOMAIN_HEALTH_DOMAINS.length * 2;
const DOMAINS = new Set<string>(COLONY_DOMAIN_HEALTH_DOMAINS);

export function projectColonyDomainHealth(input: {
  readonly colonyId: string;
  readonly statuses: readonly unknown[];
  readonly tick: number;
}): ColonyDomainHealthProjection {
  assertIdentifier(input.colonyId);
  assertTick(input.tick);

  const grouped = new Map<ColonyDomainHealthDomain, unknown[]>();
  let invalidInput = input.statuses.length > MAX_RAW_DOMAIN_HEALTH_STATUSES;
  for (const value of input.statuses.slice(0, MAX_RAW_DOMAIN_HEALTH_STATUSES)) {
    const domain = domainFrom(value);
    if (domain === null) {
      invalidInput = true;
      continue;
    }
    const values = grouped.get(domain) ?? [];
    values.push(value);
    grouped.set(domain, values);
  }

  const domains = COLONY_DOMAIN_HEALTH_DOMAINS.map((domain) => {
    const values = grouped.get(domain) ?? [];
    const reasonCode =
      domain === COLONY_DOMAIN_HEALTH_DOMAINS[0] && invalidInput
        ? "invalid"
        : reasonFor(values, input.colonyId, input.tick);
    return freeze({
      domain,
      reasonCode,
      status: reasonCode === "healthy" ? ("healthy" as const) : ("blocked" as const),
    });
  });
  const blocked = domains.find(({ status }) => status === "blocked") ?? null;
  return freeze({
    version: 1,
    status: blocked === null ? "healthy" : "blocked",
    blocker:
      blocked === null
        ? null
        : {
            domain: blocked.domain,
            reasonCode: blocked.reasonCode as Exclude<ColonyDomainHealthReason, "healthy">,
          },
    domains,
  });
}

function reasonFor(
  values: readonly unknown[],
  colonyId: string,
  tick: number,
): ColonyDomainHealthReason {
  if (values.length === 0) return "missing";
  if (values.length !== 1) return "invalid";
  const value = values[0];
  if (!isDomainStatus(value) || value.colonyId !== colonyId) return "invalid";
  if (value.observedAt !== tick) return "stale";
  return value.status === "healthy" ? "healthy" : "failed";
}

function domainFrom(value: unknown): ColonyDomainHealthDomain | null {
  if (!isRecord(value)) return null;
  const domain = value["domain"];
  return typeof domain === "string" && DOMAINS.has(domain)
    ? (domain as ColonyDomainHealthDomain)
    : null;
}

function isDomainStatus(value: unknown): value is ColonyDomainHealthStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value["colonyId"] === "string" &&
    value["colonyId"].length > 0 &&
    value["colonyId"].length <= 64 &&
    value["colonyId"] === value["colonyId"].trim() &&
    typeof value["domain"] === "string" &&
    DOMAINS.has(value["domain"]) &&
    typeof value["observedAt"] === "number" &&
    Number.isSafeInteger(value["observedAt"]) &&
    value["observedAt"] >= 0 &&
    !Object.is(value["observedAt"], -0) &&
    (value["status"] === "healthy" || value["status"] === "failed")
  );
}

function assertIdentifier(value: string): void {
  if (value.length === 0 || value.length > 64 || value !== value.trim()) {
    throw new TypeError("domain health colony id must be a bounded identifier");
  }
}

function assertTick(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError("domain health tick must be a non-negative safe integer");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
