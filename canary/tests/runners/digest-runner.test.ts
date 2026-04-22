import { expect, it } from "vitest";
import {
  buildRunPrefixes,
  countMix,
  formatAllGreenThread,
  formatDigestTopLevel,
  formatProbeFailureThread,
  formatProbeYellowThread,
  formatRegistryDeltaBlock,
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
  expect(auto?.worstSeverity).toBe("GREEN");
  expect(auto?.p50Ms).toBe(100);

  const sonnet = summary.perProbe.find((p) => p.signature === "v1/sonnet-4");
  expect(sonnet?.worstSeverity).toBe("RED");
});

it("summarize assigns worstSeverity = YELLOW when a probe has yellow-only outcomes", () => {
  const artifact = makeArtifact([
    makeOutcome({ signature: "v2/slow", durationMs: 500 }),
    makeOutcome({
      signature: "v2/slow",
      severity: "YELLOW",
      verdict: "PASS",
      durationMs: 9500,
    }),
  ]);
  const summary = summarize(
    [artifact],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const slow = summary.perProbe.find((p) => p.signature === "v2/slow");
  expect(slow?.worstSeverity).toBe("YELLOW");
  expect(slow?.yellowing).toBe(1);
  expect(slow?.yellowOutcomes).toHaveLength(1);
  expect(slow?.yellowOutcomes[0].durationMs).toBe(9500);
});

it("summarize escalates worstSeverity to RED when any outcome is RED", () => {
  const artifact = makeArtifact([
    makeOutcome({ signature: "v2/mixed" }),
    makeOutcome({
      signature: "v2/mixed",
      severity: "YELLOW",
      verdict: "PASS",
      durationMs: 9500,
    }),
    makeOutcome({
      signature: "v2/mixed",
      severity: "RED",
      verdict: "FAIL",
      httpStatus: 503,
    }),
  ]);
  const summary = summarize(
    [artifact],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const mixed = summary.perProbe.find((p) => p.signature === "v2/mixed");
  expect(mixed?.worstSeverity).toBe("RED");
  // Yellow outcome is still captured for the yellow breakdown section.
  expect(mixed?.yellowOutcomes).toHaveLength(1);
  expect(mixed?.failures).toHaveLength(1);
});

it("top-level digest hides fully-green probes behind a roll-up line", () => {
  const summary = summarize(
    [
      makeArtifact([
        // Three fully-green probes.
        makeOutcome({ signature: "v2/a" }),
        makeOutcome({ signature: "v2/b" }),
        makeOutcome({ signature: "v2/c" }),
        // One red probe that should appear in the top-level.
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

  // RED probe surfaces in-line with a glyph.
  expect(post).toMatch(/• 🔴 `v1\/bad` — 0\/1 pass/);
  // The three green probes do NOT appear as individual bullets.
  expect(post).not.toMatch(/`v2\/a`/);
  expect(post).not.toMatch(/`v2\/b`/);
  expect(post).not.toMatch(/`v2\/c`/);
  // …they get rolled up into a single "N fully green — see thread" line.
  expect(post).toContain("🟢 3 probes fully green");
  expect(post).toContain("Needs attention");
});

it("top-level digest surfaces YELLOW probes alongside REDs", () => {
  const summary = summarize(
    [
      makeArtifact([
        makeOutcome({
          signature: "v2/slow",
          severity: "YELLOW",
          verdict: "PASS",
          durationMs: 9500,
        }),
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
  expect(post).toMatch(/• 🟡 `v2\/slow`/);
  expect(post).toMatch(/• 🔴 `v1\/bad`/);
});

it("top-level digest uses an all-green header and a celebratory body when nothing failed", () => {
  const summary = summarize(
    [
      makeArtifact([
        makeOutcome({ signature: "v2/a" }),
        makeOutcome({ signature: "v2/b" }),
      ]),
    ],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW
  );
  const post = formatDigestTopLevel(summary);
  expect(post).toContain(":large_green_circle:");
  expect(post).toContain("All probes fully green");
  // Green probes are detailed in the thread, not in the top-level body.
  expect(post).not.toMatch(/`v2\/a`/);
});

it("top-level digest uses the rotating-light emoji when any probe is RED", () => {
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
  expect(formatDigestTopLevel(redSummary)).toContain(":rotating_light:");
});

it("formatAllGreenThread lists each fully-green probe with its latency bounds", () => {
  const text = formatAllGreenThread([
    {
      signature: "v2/a",
      label: "V2 · A",
      total: 9,
      passing: 9,
      failing: 0,
      yellowing: 0,
      p50Ms: 1000,
      p99Ms: 2000,
      worstSeverity: "GREEN",
      failures: [],
      yellowOutcomes: [],
    },
    {
      signature: "v2/b",
      label: "V2 · B",
      total: 7,
      passing: 7,
      failing: 0,
      yellowing: 0,
      p50Ms: 2500,
      p99Ms: 4000,
      worstSeverity: "GREEN",
      failures: [],
      yellowOutcomes: [],
    },
  ]);
  expect(text).toContain("All-green probes (2)");
  expect(text).toMatch(/• 🟢 `v2\/a` — 9\/9 pass · p50 1000ms · p99 2000ms/);
  expect(text).toMatch(/• 🟢 `v2\/b` — 7\/7 pass · p50 2500ms · p99 4000ms/);
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
    yellowing: 0,
    p50Ms: 2804,
    p99Ms: 3576,
    worstSeverity: "RED",
    yellowOutcomes: [],
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

it("formatProbeYellowThread surfaces the soft-signal breakdown for a yellow probe", () => {
  const text = formatProbeYellowThread({
    signature: "v2/slow",
    label: "V2 · slow",
    total: 8,
    passing: 6,
    failing: 2,
    yellowing: 2,
    p50Ms: 4000,
    p99Ms: 12000,
    worstSeverity: "YELLOW",
    failures: [],
    yellowOutcomes: [
      {
        verdict: "PASS",
        httpStatus: 200,
        durationMs: 9500,
        completedAt: 1745000000,
      },
      {
        verdict: "PASS",
        httpStatus: 200,
        durationMs: 11500,
        completedAt: 1745010000,
      },
    ],
  });
  expect(text).toContain("*Breakdown for `v2/slow`*");
  expect(text).toContain("YELLOW signals: 2");
  expect(text).toContain("PASS × 2");
  expect(text).toContain("200 × 2");
  expect(text).toContain(new Date(1745010000 * 1000).toISOString());
  expect(text).toContain("p50 4000ms");
  expect(text).toContain("soft signal");
});

it("summarize filters outcomes whose signature is not in allowedSignatures", () => {
  const artifact = makeArtifact([
    // In the current probe set — must count.
    makeOutcome({ signature: "v2/model/gloo-a", durationMs: 100 }),
    // Retired from the current probe set — must be dropped entirely.
    makeOutcome({
      signature: "v2/model/gloo-retired",
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 400,
      durationMs: 400,
    }),
    // V1 — also retired; not currently probed. Must be dropped.
    makeOutcome({
      signature: "v1/llama3-70b",
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 503,
      durationMs: 500,
    }),
  ]);

  const summary = summarize(
    [artifact],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW,
    { allowedSignatures: new Set(["v2/model/gloo-a"]) }
  );

  // Only the one allowed outcome contributes.
  expect(summary.probesRun).toBe(1);
  expect(summary.severityCounts.GREEN).toBe(1);
  expect(summary.severityCounts.RED).toBe(0);
  expect(summary.perProbe.map((p) => p.signature)).toEqual(["v2/model/gloo-a"]);
});

it("summarize leaves all outcomes in place when allowedSignatures is null (fail-open)", () => {
  const artifact = makeArtifact([
    makeOutcome({ signature: "v2/model/gloo-a" }),
    makeOutcome({
      signature: "v2/model/gloo-retired",
      severity: "RED",
      verdict: "FAIL",
    }),
  ]);
  const summary = summarize(
    [artifact],
    { objectCount: 0, oldestAgeDays: null, totalBytes: 0 },
    NOW,
    { allowedSignatures: null }
  );
  expect(summary.probesRun).toBe(2);
  expect(summary.severityCounts.RED).toBe(1);
});

it("formatRegistryDeltaBlock renders one bullet per add/remove on its own line (compact)", () => {
  const text = formatRegistryDeltaBlock({
    previousCapturedAt: "2026-04-19T00:00:00.000Z",
    currentCapturedAt: "2026-04-22T12:00:00.000Z",
    added: ["gloo-new-1", "gloo-new-2"],
    removed: ["gloo-gone"],
    isFirstSnapshot: false,
    hasChanges: true,
  });
  // Each add/remove on its own line, icon + id on the same line.
  expect(text).toMatch(/• :heavy_plus_sign: `gloo-new-1`/);
  expect(text).toMatch(/• :heavy_plus_sign: `gloo-new-2`/);
  expect(text).toMatch(/• :heavy_minus_sign: `gloo-gone`/);
  // No nested bullet indentation, no "(count)" heading lines — those
  // were the verbose shape we just replaced.
  expect(text).not.toMatch(/Added \(\d/);
  expect(text).not.toMatch(/Removed \(\d/);
});
