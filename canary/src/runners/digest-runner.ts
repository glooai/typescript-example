/**
 * Digest runner — summarizes the last 24h of probe runs into one Slack
 * top-level post plus a structured thread.
 *
 * Top-level post shows ONLY the signal:
 *   - Every probe whose worst severity in the window was RED
 *   - Every probe whose worst severity in the window was YELLOW
 *   - One roll-up line counting the fully-green probes
 * The goal is that a reader glancing at the channel can see exactly what
 * needs attention in a few lines, not scroll past 22 identical green
 * bullets to find the two broken ones.
 *
 * Thread replies (posted against the top-level) carry the detail:
 *   - One consolidated "all green" post listing every probe that stayed
 *     fully green in the window (signature + p50/p99)
 *   - One individualized breakdown per YELLOW probe
 *   - One individualized breakdown per RED probe (verdict + status mix,
 *     most recent failure timestamp, full latency distribution)
 *
 * Also reports archival state: object count, oldest age, total bytes.
 * (Actual pruning is handled by the GCS object-lifecycle rule — this
 * function is read-only against the archive.)
 */

import type { CanaryConfig } from "../config.js";
import type { GcsClient, RunArtifact } from "../sinks/gcs.js";
import type { SlackClient } from "../sinks/slack.js";
import type { Severity, Verdict } from "../probes/types.js";

export type DigestDeps = {
  gcs: GcsClient;
  slack: SlackClient;
};

/**
 * One individual outcome in the 24h window. We keep just the fields the
 * per-probe thread reply needs so the digest summary stays compact —
 * the full response payloads already live in the per-failure
 * `Canary RED` top-level alerts and in GCS-archived run artifacts.
 */
export type PerProbeOutcomeSample = {
  verdict: Verdict;
  httpStatus: number | null;
  durationMs: number;
  /** Unix seconds — same as ProbeOutcome.completedAt. */
  completedAt: number;
};

/**
 * Legacy alias. The thread formatters used to be named "failure" because
 * they only rendered RED outcomes; the YELLOW thread formatter shares the
 * same shape, so the underlying type is named more neutrally now. Kept as
 * an alias so downstream imports don't churn.
 */
export type PerProbeFailure = PerProbeOutcomeSample;

export type PerProbeEntry = {
  signature: string;
  label: string;
  total: number;
  passing: number;
  failing: number;
  /** Count of outcomes whose severity was YELLOW (regardless of verdict). */
  yellowing: number;
  p50Ms: number;
  p99Ms: number;
  /**
   * Worst severity observed for this signature across the window. Used
   * to partition probes into the red / yellow / green buckets the top
   * level and threads render.
   */
  worstSeverity: Severity;
  /**
   * RED outcome details for the threaded breakdown — only populated when
   * the probe had at least one RED outcome. Sorted oldest → newest.
   */
  failures: PerProbeOutcomeSample[];
  /**
   * YELLOW outcome details for the threaded breakdown — only populated
   * when the probe had at least one YELLOW outcome. Sorted oldest → newest.
   */
  yellowOutcomes: PerProbeOutcomeSample[];
};

export type DigestSummary = {
  windowStart: string;
  windowEnd: string;
  runsFound: number;
  probesRun: number;
  severityCounts: Record<Severity, number>;
  verdictCounts: Record<Verdict, number>;
  perProbe: PerProbeEntry[];
  archival: {
    objectCount: number;
    oldestAgeDays: number | null;
    totalBytes: number;
  };
};

/** ms in one hour — used for 24h window math. */
const ONE_HOUR_MS = 3_600_000;

/** How far back the digest window looks — the daily-digest promise. */
const WINDOW_HOURS = 24;

/**
 * List run artifacts strictly within the last 24h. We over-fetch hourly
 * prefixes (26 hours covers day-boundary UTC offsets cleanly) and then
 * filter the returned artifacts by their `startedAt` so the digest
 * reflects exactly the promised 24h window, not ~26h.
 */
export async function loadWindow(
  gcs: GcsClient,
  now: Date = new Date()
): Promise<RunArtifact[]> {
  const prefix24h = buildRunPrefixes(now);
  const seen = new Set<string>();
  const artifacts: RunArtifact[] = [];
  const cutoffMs = now.getTime() - WINDOW_HOURS * ONE_HOUR_MS;

  for (const prefix of prefix24h) {
    const names = await gcs.list(prefix);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const payload = await gcs.readJson<RunArtifact>(name);
      if (!payload) continue;
      if (new Date(payload.startedAt).getTime() < cutoffMs) continue;
      artifacts.push(payload);
    }
  }
  return artifacts.sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0
  );
}

/**
 * Build the set of GCS prefixes that cover the last 24h. Because we partition
 * by hour, the worst case is 2 hourly prefixes per day-boundary — we just
 * enumerate the 24 hours ending at `now`.
 */
export function buildRunPrefixes(now: Date): string[] {
  const out = new Set<string>();
  for (let hoursBack = 0; hoursBack < 26; hoursBack++) {
    const t = new Date(now.getTime() - hoursBack * 3_600_000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, "0");
    const d = String(t.getUTCDate()).padStart(2, "0");
    const h = String(t.getUTCHours()).padStart(2, "0");
    out.add(`runs/${y}/${m}/${d}/${h}`);
  }
  return Array.from(out);
}

/** RED > YELLOW > GREEN. Used to bucket probes by their worst window outcome. */
function worstOf(current: Severity, next: Severity): Severity {
  if (current === "RED" || next === "RED") return "RED";
  if (current === "YELLOW" || next === "YELLOW") return "YELLOW";
  return "GREEN";
}

export function summarize(
  artifacts: RunArtifact[],
  archival: DigestSummary["archival"],
  now: Date
): DigestSummary {
  const earliest = artifacts[0]?.startedAt ?? now.toISOString();
  const perProbeAgg = new Map<
    string,
    {
      label: string;
      durations: number[];
      passing: number;
      failing: number;
      yellowing: number;
      worstSeverity: Severity;
      failures: PerProbeOutcomeSample[];
      yellowOutcomes: PerProbeOutcomeSample[];
    }
  >();
  const severityCounts: Record<Severity, number> = {
    RED: 0,
    YELLOW: 0,
    GREEN: 0,
  };
  const verdictCounts: Record<Verdict, number> = {
    PASS: 0,
    FAIL: 0,
    EMPTY_COMPLETION: 0,
    SCHEMA_MISMATCH: 0,
    REFUSAL_REGRESSION: 0,
  };

  let probesRun = 0;
  for (const artifact of artifacts) {
    for (const outcome of artifact.outcomes) {
      probesRun++;
      severityCounts[outcome.severity]++;
      verdictCounts[outcome.verdict]++;
      const entry = perProbeAgg.get(outcome.signature) ?? {
        label: outcome.label,
        durations: [],
        passing: 0,
        failing: 0,
        yellowing: 0,
        worstSeverity: "GREEN" as Severity,
        failures: [],
        yellowOutcomes: [],
      };
      entry.durations.push(outcome.durationMs);
      if (outcome.verdict === "PASS") entry.passing++;
      else entry.failing++;

      entry.worstSeverity = worstOf(entry.worstSeverity, outcome.severity);

      const sample: PerProbeOutcomeSample = {
        verdict: outcome.verdict,
        httpStatus: outcome.httpStatus,
        durationMs: outcome.durationMs,
        completedAt: outcome.completedAt,
      };
      if (outcome.severity === "RED") {
        entry.failures.push(sample);
      } else if (outcome.severity === "YELLOW") {
        entry.yellowing++;
        entry.yellowOutcomes.push(sample);
      }

      perProbeAgg.set(outcome.signature, entry);
    }
  }

  const perProbe: PerProbeEntry[] = Array.from(perProbeAgg.entries()).map(
    ([signature, entry]) => ({
      signature,
      label: entry.label,
      total: entry.durations.length,
      passing: entry.passing,
      failing: entry.failing,
      yellowing: entry.yellowing,
      worstSeverity: entry.worstSeverity,
      p50Ms: percentile(entry.durations, 0.5),
      p99Ms: percentile(entry.durations, 0.99),
      failures: [...entry.failures].sort(
        (a, b) => a.completedAt - b.completedAt
      ),
      yellowOutcomes: [...entry.yellowOutcomes].sort(
        (a, b) => a.completedAt - b.completedAt
      ),
    })
  );
  perProbe.sort((a, b) => a.label.localeCompare(b.label));

  return {
    windowStart: earliest,
    windowEnd: now.toISOString(),
    runsFound: artifacts.length,
    probesRun,
    severityCounts,
    verdictCounts,
    perProbe,
    archival,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(p * n), then -1 for zero-indexing.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[idx];
}

export async function gatherArchivalState(
  gcs: GcsClient,
  now: Date
): Promise<DigestSummary["archival"]> {
  const names = await gcs.list("runs/");
  let oldestCreated: string | null = null;
  let totalBytes = 0;
  for (const name of names) {
    const meta = await gcs.getMetadata(name);
    if (!meta) continue;
    totalBytes += meta.size;
    if (!oldestCreated || meta.createdAt < oldestCreated) {
      oldestCreated = meta.createdAt;
    }
  }
  const oldestAgeDays =
    oldestCreated !== null
      ? Math.floor(
          (now.getTime() - new Date(oldestCreated).getTime()) / 86_400_000
        )
      : null;
  return { objectCount: names.length, totalBytes, oldestAgeDays };
}

export async function runDigest(
  config: CanaryConfig,
  deps: DigestDeps,
  now: Date = new Date()
): Promise<DigestSummary> {
  const artifacts = await loadWindow(deps.gcs, now);
  const archival = await gatherArchivalState(deps.gcs, now);
  const summary = summarize(artifacts, archival, now);

  const topLevel = formatDigestTopLevel(summary);
  const posted = await deps.slack.post({ text: topLevel });

  const greenProbes = summary.perProbe.filter(
    (p) => p.worstSeverity === "GREEN"
  );
  const yellowProbes = summary.perProbe.filter(
    (p) => p.worstSeverity === "YELLOW"
  );
  const redProbes = summary.perProbe.filter((p) => p.worstSeverity === "RED");

  // All-green probes roll up into a single thread reply so the channel
  // stays scannable but the detail is one click away.
  if (greenProbes.length > 0) {
    try {
      await deps.slack.post({
        text: formatAllGreenThread(greenProbes),
        threadTs: posted.ts,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `slack.post (digest all-green thread) failed: ${(error as Error).message}`
      );
    }
  }

  // Individualized thread replies per YELLOW and RED probe. Posted
  // independently so a single bad reply (rate limit, scope missing,
  // transient blip) doesn't skip the rest.
  for (const probe of yellowProbes) {
    try {
      await deps.slack.post({
        text: formatProbeYellowThread(probe),
        threadTs: posted.ts,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `slack.post (digest yellow thread ${probe.signature}) failed: ${(error as Error).message}`
      );
    }
  }
  for (const probe of redProbes) {
    try {
      await deps.slack.post({
        text: formatProbeFailureThread(probe),
        threadTs: posted.ts,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `slack.post (digest red thread ${probe.signature}) failed: ${(error as Error).message}`
      );
    }
  }

  return summary;
}

export function formatDigestTopLevel(summary: DigestSummary): string {
  const red = summary.severityCounts.RED;
  const total = summary.probesRun;
  const emoji = red > 0 ? ":rotating_light:" : ":large_green_circle:";
  const header = `${emoji} *Gloo AI Canary — 24h Digest*`;

  // Only show probes that need attention in the top-level post. Every
  // probe that was fully green in the window gets rolled up into the
  // "fully green" line below — their per-bullet detail lives in the
  // threaded reply so the top-level stays scannable.
  const notableProbes = summary.perProbe.filter(
    (p) => p.worstSeverity !== "GREEN"
  );
  const greenCount = summary.perProbe.length - notableProbes.length;

  const notableLines = notableProbes
    .map((p) => {
      const glyph = p.worstSeverity === "RED" ? "🔴" : "🟡";
      return `• ${glyph} \`${p.signature}\` — ${p.passing}/${p.total} pass · p50 ${p.p50Ms}ms · p99 ${p.p99Ms}ms`;
    })
    .join("\n");

  let notableBlock: string;
  if (notableProbes.length === 0) {
    notableBlock =
      summary.perProbe.length === 0
        ? "_(no probes registered)_"
        : "_All probes fully green — see thread for per-probe details._";
  } else {
    notableBlock = notableLines;
  }

  const greenRollup =
    notableProbes.length > 0 && greenCount > 0
      ? `\n_🟢 ${greenCount} ${greenCount === 1 ? "probe" : "probes"} fully green — see thread for details._`
      : "";

  const archival = summary.archival;
  const archivalLine = `• Archive: ${archival.objectCount} objects, ${humanBytes(archival.totalBytes)}, oldest ${archival.oldestAgeDays ?? "?"}d (auto-pruned @ 90d)`;

  return [
    header,
    `*Window:* ${summary.windowStart} → ${summary.windowEnd}`,
    `*Probes run:* ${total} across ${summary.runsFound} runs`,
    `*Severity:* 🔴 ${summary.severityCounts.RED}  🟡 ${summary.severityCounts.YELLOW}  🟢 ${summary.severityCounts.GREEN}`,
    "",
    "*Needs attention*",
    notableBlock + greenRollup,
    "",
    archivalLine,
  ].join("\n");
}

/**
 * Thread reply summarizing every fully-green probe in the window. One
 * consolidated post instead of N individualized ones — green probes are
 * uninteresting individually; the value is in seeing which probes are
 * collectively healthy.
 */
export function formatAllGreenThread(greenProbes: PerProbeEntry[]): string {
  if (greenProbes.length === 0) {
    return ":large_green_circle: *All-green probes (0)*\n_none_";
  }
  const lines = greenProbes
    .map(
      (p) =>
        `• 🟢 \`${p.signature}\` — ${p.passing}/${p.total} pass · p50 ${p.p50Ms}ms · p99 ${p.p99Ms}ms`
    )
    .join("\n");
  return [
    `:large_green_circle: *All-green probes (${greenProbes.length})* — no RED or YELLOW outcomes in the window`,
    lines,
  ].join("\n");
}

/**
 * Thread-reply text for one failing probe. Expands what "N/M pass"
 * means in the top-level digest: how many runs the probe had in the
 * 24h window, the verdict and HTTP-status mix across the failing
 * runs, and when the most recent failure happened. Response bodies
 * are intentionally omitted — those live in the per-failure
 * `Canary RED` top-level alerts, and duplicating them here would
 * just bloat the thread.
 */
export function formatProbeFailureThread(probe: PerProbeEntry): string {
  const verdictMix = countMix(probe.failures.map((f) => f.verdict));
  const statusMix = countMix(
    probe.failures.map((f) =>
      f.httpStatus === null ? "network error" : String(f.httpStatus)
    )
  );
  const mostRecent = probe.failures[probe.failures.length - 1];
  const mostRecentLine = mostRecent
    ? `• Most recent failure: ${new Date(mostRecent.completedAt * 1000).toISOString()} (${mostRecent.durationMs}ms)`
    : "• Most recent failure: _none recorded_";

  return [
    `🔴 *Breakdown for \`${probe.signature}\`* — ${probe.label}`,
    `• Runs in the 24h window: ${probe.total} (one outcome per probe-runner execution)`,
    `• Passed: ${probe.passing} · Failed: ${probe.failing}`,
    `• Failure verdicts: ${verdictMix || "_none_"}`,
    `• HTTP statuses on failures: ${statusMix || "_none_"}`,
    mostRecentLine,
    `• Latency across all runs: p50 ${probe.p50Ms}ms · p99 ${probe.p99Ms}ms`,
    `_See the top-level \`Canary RED — …\` alerts for this signature for the full response payloads._`,
  ].join("\n");
}

/**
 * Thread-reply text for one YELLOW probe — same shape as the RED
 * breakdown but worded to match the "soft signal / needs a look"
 * semantics of YELLOW (latency anomalies, routing shifts, etc.) rather
 * than an outright failure.
 */
export function formatProbeYellowThread(probe: PerProbeEntry): string {
  const verdictMix = countMix(probe.yellowOutcomes.map((o) => o.verdict));
  const statusMix = countMix(
    probe.yellowOutcomes.map((o) =>
      o.httpStatus === null ? "network error" : String(o.httpStatus)
    )
  );
  const mostRecent = probe.yellowOutcomes[probe.yellowOutcomes.length - 1];
  const mostRecentLine = mostRecent
    ? `• Most recent YELLOW: ${new Date(mostRecent.completedAt * 1000).toISOString()} (${mostRecent.durationMs}ms)`
    : "• Most recent YELLOW: _none recorded_";

  return [
    `🟡 *Breakdown for \`${probe.signature}\`* — ${probe.label}`,
    `• Runs in the 24h window: ${probe.total} (one outcome per probe-runner execution)`,
    `• Passed: ${probe.passing} · Non-pass: ${probe.failing} · YELLOW signals: ${probe.yellowing}`,
    `• YELLOW verdicts: ${verdictMix || "_none_"}`,
    `• HTTP statuses on YELLOW outcomes: ${statusMix || "_none_"}`,
    mostRecentLine,
    `• Latency across all runs: p50 ${probe.p50Ms}ms · p99 ${probe.p99Ms}ms`,
    `_YELLOW is a soft signal — the call succeeded or degraded but not cleanly enough to be GREEN. Follow up if the pattern persists._`,
  ].join("\n");
}

/** Small utility: "FAIL × 3, SCHEMA_MISMATCH × 1". */
export function countMix(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} × ${n}`)
    .join(", ");
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(2)}GB`;
}
