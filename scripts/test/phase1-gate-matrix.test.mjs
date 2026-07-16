import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDeployableBundle } from "../lib/bundle-boundaries.mjs";

const document = readFileSync(new URL("../../docs/phase1-gate-matrix.md", import.meta.url), "utf8");
const results = JSON.parse(
  readFileSync(new URL("../../docs/phase1-gate-results.json", import.meta.url), "utf8"),
);
const header = "| row-id";
const numericColumnCount = 12;
const rows = parseRows(document);

describe("Phase 1 aggregate gate matrix (#30)", () => {
  it("has complete, unique row metadata and bounded integer budgets", () => {
    expect(document).toContain(header);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.map((row) => row.status)).toContain("evidenced");
    expect(rows.map((row) => row.status)).toContain("partial");
    expect(rows.map((row) => row.status)).toContain("unevidenced");

    for (const row of rows) {
      expect(row.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(["evidenced", "partial", "unevidenced"]).toContain(row.status);
      expect(row.evidence).toMatch(/\[[^\]]+\]\([^\s)]+\)/u);
      expect(row.values).toHaveLength(numericColumnCount);
      for (const value of row.values) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      expect(row.values[6]).toBeLessThanOrEqual(100);
      expect(row.values[10]).toBeLessThanOrEqual(1);
    }
  });

  it("declares evidence policy after the table and keeps missing proof explicit", () => {
    expect(document.indexOf("## Evidence policy")).toBeGreaterThan(document.indexOf(header));
    expect(rows.find((row) => row.id === "aggregate-phase1-matrix")?.status).toBe("unevidenced");
    expect(document).toContain("Reset metadata may change the transcript hash");
    expect(document).toContain("packages/scenario-kit");
    expect(document).toContain("replacement lateness");
    expect(document).toContain("controller margin");
    expect(document).toContain("persistent-growth");
    expect(document).toContain("phase1-gate-results.json");
    expect(results.status).toBe("blocked");
    expect(results.rows.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(results.externalLive).toEqual({
      deployment: "unevidenced",
      engineTiming: "unevidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "unevidenced",
      rollbackIncident: "unevidenced",
    });
    for (const row of results.rows) {
      expect(Object.values(row.measurements)).toHaveLength(numericColumnCount);
      for (const [field, value] of Object.entries(row.measurements)) {
        expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
        if (value === null) expect(row.unevidenced).toContain(field);
      }
    }
  });

  it("composes the existing production-bundle exclusion check", () => {
    expect(() =>
      assertDeployableBundle({
        inputs: {
          "packages/bot/src/main.ts": { bytes: 1, imports: [] },
          "packages/bot/src/runtime/tick.ts": { bytes: 1, imports: [] },
        },
        outputs: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertDeployableBundle({
        inputs: {
          "packages/bot/src/main.ts": { bytes: 1, imports: [] },
          "packages/scenario-kit/src/index.ts": { bytes: 1, imports: [] },
        },
        outputs: {},
      }),
    ).toThrow(/development-only/u);
  });
});

function parseRows(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  expect(start).toBeGreaterThanOrEqual(0);
  const tableLines = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    tableLines.push(line);
  }
  return tableLines.map((line) => {
    const [id, status, evidence, ...values] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return { id, status, evidence, values: values.map(Number) };
  });
}
