/**
 * Digest runner — summarizes the last 24h of probe runs into one Slack
 * top-level post. YELLOW-level signals (latency anomalies, routing shifts)
 * go in a thread reply so they don't bloat the channel.
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

export type DigestSummary = {
  windowStart: string;
  windowEnd: string;
  runsFound: number;
  probesRun: number;
  severityCounts: Record<Severity, number>;
  verdictCounts: Record<Verdict, number>;
  perProbe: Array<{
    signature: string;
    label: string;
    total: number;
    passing: number;
    failing: number;
    p50Ms: number;
    p99Ms: number;
  }>;
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

export function summarize(
  artifacts: RunArtifact[],
  archival: DigestSummary["archival"],
  now: Date
): DigestSummary {
  const earliest = artifacts[0]?.startedAt ?? now.toISOString();
  const perProbeAgg = new Map<
    string,
    { label: string; durations: number[]; passing: number; failing: number }
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
      };
      entry.durations.push(outcome.durationMs);
      if (outcome.verdict === "PASS") entry.passing++;
      else entry.failing++;
      perProbeAgg.set(outcome.signature, entry);
    }
  }

  const perProbe = Array.from(perProbeAgg.entries()).map(
    ([signature, entry]) => ({
      signature,
      label: entry.label,
      total: entry.durations.length,
      passing: entry.passing,
      failing: entry.failing,
      p50Ms: percentile(entry.durations, 0.5),
      p99Ms: percentile(entry.durations, 0.99),
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

  const yellowNotes = collectYellowNotes(artifacts);
  if (yellowNotes.length > 0) {
    await deps.slack.post({
      text: `📝 Secondary insights (last 24h):\n${yellowNotes.join("\n")}`,
      threadTs: posted.ts,
    });
  }

  return summary;
}

export function collectYellowNotes(artifacts: RunArtifact[]): string[] {
  const notes: string[] = [];
  for (const a of artifacts) {
    for (const o of a.outcomes) {
      if (o.severity === "YELLOW") {
        notes.push(
          `• ${o.label} — ${o.verdict} (${o.httpStatus ?? "net-err"}) ${o.durationMs}ms`
        );
      }
    }
  }
  return notes;
}

export function formatDigestTopLevel(summary: DigestSummary): string {
  const red = summary.severityCounts.RED;
  const total = summary.probesRun;
  const emoji = red > 0 ? ":rotating_light:" : ":large_green_circle:";
  const header = `${emoji} *Gloo AI Canary — 24h Digest*`;

  const perProbeLines = summary.perProbe
    .map(
      (p) =>
        `• \`${p.signature}\` — ${p.passing}/${p.total} pass · p50 ${p.p50Ms}ms · p99 ${p.p99Ms}ms`
    )
    .join("\n");

  const archival = summary.archival;
  const archivalLine = `• Archive: ${archival.objectCount} objects, ${humanBytes(archival.totalBytes)}, oldest ${archival.oldestAgeDays ?? "?"}d (auto-pruned @ 90d)`;

  return [
    header,
    `*Window:* ${summary.windowStart} → ${summary.windowEnd}`,
    `*Probes run:* ${total} across ${summary.runsFound} runs`,
    `*Severity:* 🔴 ${summary.severityCounts.RED}  🟡 ${summary.severityCounts.YELLOW}  🟢 ${summary.severityCounts.GREEN}`,
    "",
    "*Per-probe breakdown*",
    perProbeLines || "_(no probes registered)_",
    "",
    archivalLine,
  ].join("\n");
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(2)}GB`;
}
