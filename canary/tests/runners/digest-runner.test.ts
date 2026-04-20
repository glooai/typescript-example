import { expect, it } from "vitest";
import {
  buildRunPrefixes,
  collectYellowNotes,
  formatDigestTopLevel,
  humanBytes,
  percentile,
  summarize,
} from "../../src/runners/digest-runner.js";
import type { RunArtifact } from "../../src/sinks/gcs.js";
import type { ProbeOutcome } from "../../src/probes/types.js";

const NOW = new Date("2026-04-21T07:00:00Z");

function makeOutcome(partial: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    signature: "v2/auto",
    label: "V2 · auto",
    endpoint: "https://example.com",
    apiVersion: "v2",
    httpStatus: 200,
    verdict: "PASS",
    severity: "GREEN",
    durationMs: 1000,
    details: {},
    completedAt: Math.floor(NOW.getTime() / 1000),
    ...partial,
  };
}

function makeArtifact(outcomes: ProbeOutcome[]): RunArtifact {
  return {
    runId: "r",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes,
  };
}

it("computes percentiles over small sample sets", () => {
  expect(percentile([], 0.5)).toBe(0);
  expect(percentile([100], 0.99)).toBe(100);
  expect(percentile([100, 200, 300], 0.5)).toBe(200);
  expect(percentile([100, 200, 300, 400, 500], 0.99)).toBe(500);
});

it("formats human-readable byte sizes", () => {
  expect(humanBytes(512)).toBe("512B");
  expect(humanBytes(2048)).toBe("2.0KB");
  expect(humanBytes(5 * 1024 * 1024)).toBe("5.0MB");
  expect(humanBytes(3 * 1024 * 1024 * 1024)).toBe("3.00GB");
});

it("builds a deduplicated 24h worth of hourly GCS prefixes", () => {
  const prefixes = buildRunPrefixes(NOW);
  expect(prefixes.length).toBeGreaterThanOrEqual(24);
  // Each entry is a YYYY/MM/DD/HH-style prefix
  for (const p of prefixes) {
    expect(p).toMatch(/^runs\/\d{4}\/\d{2}\/\d{2}\/\d{2}$/);
  }
  // Latest hour (the one `NOW` sits in) is included
  expect(prefixes).toContain("runs/2026/04/21/07");
});

it("summarizes severity + verdict counts and per-probe latency quantiles", () => {
  const artifact = makeArtifact([
    makeOutcome({ signature: "v2/auto", durationMs: 100 }),
    makeOutcome({ signature: "v2/auto", durationMs: 200 }),
    makeOutcome({
      signature: "v1/sonnet-4",
      verdict: "FAIL",
      severity: "RED",
      durationMs: 1500,
    }),
  ]);

  const summary = summarize(
    [artifact],
    { objectCount: 10, oldestAgeDays: 5, totalBytes: 1024 },
    NOW
  );

  expect(summary.runsFound).toBe(1);
  expect(summary.probesRun).toBe(3);
  expect(summary.severityCounts.GREEN).toBe(2);
  expect(summary.severityCounts.RED).toBe(1);
  expect(summary.verdictCounts.PASS).toBe(2);
  expect(summary.verdictCounts.FAIL).toBe(1);

  const auto = summary.perProbe.find((p) => p.signature === "v2/auto");
  expect(auto?.passing).toBe(2);
  expect(auto?.failing).toBe(0);
  expect(auto?.p50Ms).toBe(100);
});

it("collects YELLOW-severity notes for the digest thread", () => {
  const artifact = makeArtifact([
    makeOutcome({ signature: "v2/auto", severity: "GREEN" }),
    makeOutcome({
      signature: "v2/auto",
      severity: "YELLOW",
      verdict: "PASS",
      durationMs: 9500,
    }),
  ]);
  const notes = collectYellowNotes([artifact]);
  expect(notes.length).toBe(1);
  expect(notes[0]).toContain("9500ms");
});

it("formats the top-level digest post differently when all-green vs. red", () => {
  const greenSummary = summarize(
    [makeArtifact([makeOutcome({ signature: "v2/auto" })])],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const greenPost = formatDigestTopLevel(greenSummary);
  expect(greenPost).toContain(":large_green_circle:");
  expect(greenPost).toContain("24h Digest");

  const redSummary = summarize(
    [
      makeArtifact([
        makeOutcome({
          signature: "v1/sonnet-4",
          severity: "RED",
          verdict: "FAIL",
        }),
      ]),
    ],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const redPost = formatDigestTopLevel(redSummary);
  expect(redPost).toContain(":rotating_light:");
});
