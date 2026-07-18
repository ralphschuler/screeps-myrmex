import { describe, expect, it } from "vitest";
import {
  COLONY_DOMAIN_HEALTH_DOMAINS,
  projectColonyDomainHealth,
  type ColonyDomainHealthStatus,
} from "../src/colony";

const TICK = 100;

function healthyStatuses(tick = TICK): readonly ColonyDomainHealthStatus[] {
  return COLONY_DOMAIN_HEALTH_DOMAINS.map((domain) => ({
    colonyId: "W1N1",
    domain,
    observedAt: tick,
    status: "healthy" as const,
  }));
}

describe("colony domain health", () => {
  it("canonicalizes complete direct status independently of input order and heap identity", () => {
    const ordered = projectColonyDomainHealth({
      colonyId: "W1N1",
      statuses: healthyStatuses(),
      tick: TICK,
    });
    const resetAndReversed = projectColonyDomainHealth({
      colonyId: "W1N1",
      statuses: JSON.parse(
        JSON.stringify([...healthyStatuses()].reverse()),
      ) as ColonyDomainHealthStatus[],
      tick: TICK,
    });

    expect(ordered).toEqual({
      version: 1,
      status: "healthy",
      blocker: null,
      domains: COLONY_DOMAIN_HEALTH_DOMAINS.map((domain) => ({
        domain,
        reasonCode: "healthy",
        status: "healthy",
      })),
    });
    expect(JSON.stringify(resetAndReversed)).toBe(JSON.stringify(ordered));
    expect(Object.isFrozen(ordered.domains)).toBe(true);
  });

  it("fails closed on missing, stale, failed, duplicate, and malformed evidence", () => {
    const cases: readonly [
      string,
      readonly unknown[],
      { readonly domain: string; readonly reasonCode: string },
    ][] = [
      [
        "missing",
        healthyStatuses().filter(({ domain }) => domain !== "logistics"),
        { domain: "logistics", reasonCode: "missing" },
      ],
      [
        "stale",
        healthyStatuses().map((status) =>
          status.domain === "mining" ? { ...status, observedAt: TICK - 1 } : status,
        ),
        { domain: "mining", reasonCode: "stale" },
      ],
      [
        "failed",
        healthyStatuses().map((status) =>
          status.domain === "links" ? { ...status, status: "failed" as const } : status,
        ),
        { domain: "links", reasonCode: "failed" },
      ],
      [
        "duplicate",
        [...healthyStatuses(), healthyStatuses()[0]],
        { domain: "layout", reasonCode: "invalid" },
      ],
      [
        "malformed",
        [...healthyStatuses().slice(1), { domain: "layout", observedAt: TICK, status: "healthy" }],
        { domain: "layout", reasonCode: "invalid" },
      ],
    ];

    for (const [, statuses, blocker] of cases) {
      expect(projectColonyDomainHealth({ colonyId: "W1N1", statuses, tick: TICK })).toMatchObject({
        status: "blocked",
        blocker,
      });
    }
  });

  it("bounds raw status input before canonical evaluation", () => {
    const statuses = Array.from({ length: 17 }, () => healthyStatuses()[0]);
    const projected = projectColonyDomainHealth({ colonyId: "W1N1", statuses, tick: TICK });

    expect(projected).toMatchObject({
      status: "blocked",
      blocker: { domain: "layout", reasonCode: "invalid" },
    });
    expect(projected.domains).toHaveLength(COLONY_DOMAIN_HEALTH_DOMAINS.length);
  });
});
