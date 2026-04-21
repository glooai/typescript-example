import { expect, it } from "vitest";
import {
  buildRunPrefixes,
  collectYellowNotes,
  countMix,
  formatDigestTopLevel,
  formatProbeFailureThread,
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

it("prefixes each per-probe bullet with 🔴/🟢 so failing probes are scannable", () => {
  const summary = summarize(
    [
      makeArtifact([
        makeOutcome({ signature: "v2/good" }),
        makeOutcome({
          signature: "v1/bad",
          severity: "RED",
          verdict: "FAIL",
          httpStatus: 503,
        }),
      ]),
    ],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const post = formatDigestTopLevel(summary);
  // The passing probe renders green.
  expect(post).toMatch(/• 🟢 `v2\/good` — 1\/1 pass/);
  // The failing probe renders red even though the overall line already
  // carries a severity counter — per-bullet emoji is the at-a-glance
  // affordance we just added.
  expect(post).toMatch(/• 🔴 `v1\/bad` — 0\/1 pass/);
});

it("summarize captures per-probe failure details for the threaded breakdown", () => {
  const summary = summarize(
    [
      makeArtifact([
        makeOutcome({ signature: "v1/llama", verdict: "PASS" }),
        makeOutcome({
          signature: "v1/llama",
          verdict: "FAIL",
          severity: "RED",
          httpStatus: 503,
          durationMs: 2643,
          completedAt: 1745000000,
        }),
        makeOutcome({
          signature: "v1/llama",
          verdict: "FAIL",
          severity: "RED",
          httpStatus: 503,
          durationMs: 2804,
          completedAt: 1745010000,
        }),
      ]),
    ],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );

  const llama = summary.perProbe.find((p) => p.signature === "v1/llama");
  expect(llama?.failing).toBe(2);
  expect(llama?.failures).toHaveLength(2);
  // Sorted oldest → newest so the "most recent" lookup in the thread
  // reply can read the last element.
  expect(llama?.failures[0].completedAt).toBe(1745000000);
  expect(llama?.failures[1].completedAt).toBe(1745010000);
  expect(llama?.failures.every((f) => f.httpStatus === 503)).toBe(true);
});

it("countMix produces a stable mostly-frequent-first tally", () => {
  expect(countMix([])).toBe("");
  expect(countMix(["FAIL"])).toBe("FAIL × 1");
  expect(countMix(["FAIL", "FAIL", "SCHEMA_MISMATCH"])).toBe(
    "FAIL × 2, SCHEMA_MISMATCH × 1"
  );
  // Alphabetical tiebreak when counts tie — keeps snapshot stability.
  expect(countMix(["B", "A"])).toBe("A × 1, B × 1");
});

it("formatProbeFailureThread explains what N/M pass means for a red probe", () => {
  const text = formatProbeFailureThread({
    signature: "v1/llama3-70b",
    label: "V1 · llama3-70b",
    total: 8,
    passing: 5,
    failing: 3,
    p50Ms: 2804,
    p99Ms: 3576,
    failures: [
      {
        verdict: "FAIL",
        httpStatus: 503,
        durationMs: 2643,
        completedAt: 1745000000,
      },
      {
        verdict: "FAIL",
        httpStatus: 503,
        durationMs: 2700,
        completedAt: 1745010000,
      },
      {
        verdict: "FAIL",
        httpStatus: null,
        durationMs: 2800,
        completedAt: 1745020000,
      },
    ],
  });

  expect(text).toContain("*Breakdown for `v1/llama3-70b`*");
  expect(text).toContain("Runs in the 24h window: 8");
  expect(text).toContain("Passed: 5 · Failed: 3");
  expect(text).toContain("FAIL × 3");
  // Mix combines 503 (×2) and network error (×1).
  expect(text).toContain("503 × 2");
  expect(text).toContain("network error × 1");
  // Most recent is the last element after sort.
  expect(text).toContain(new Date(1745020000 * 1000).toISOString());
  expect(text).toContain("p50 2804ms");
});
