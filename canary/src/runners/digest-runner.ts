/**
 * Digest runner - summarizes the last 7 days (168h) of probe runs into one
 * Slack top-level post plus a structured thread.
 *
 * The top-level post carries only the probes that need attention plus a
 * roll-up count of the fully-green ones; the per-probe detail lives in
 * thread replies. A reader glancing at the channel should see the two
 * broken probes without scrolling past twenty identical green bullets.
 *
 * Archival state is reported read-only - pruning is handled by the GCS
 * object-lifecycle rule, not by this job.
 */

import type { CanaryConfig } from "../config.js";
import { currentProbeSignatures } from "../fixtures/index.js";
import type { ModelRegistryDelta } from "../fixtures/model-registry-delta.js";
import {
  runHourPrefix,
  type GcsClient,
  type RunArtifact,
} from "../sinks/gcs.js";
import { loadLatestSnapshot } from "../sinks/model-registry-snapshot.js";
import type { SlackClient } from "../sinks/slack.js";
import type { Severity, Verdict } from "../probes/types.js";

export type DigestDeps = {
  gcs: GcsClient;
  slack: SlackClient;
};

/**
 * One outcome in the window, trimmed to the fields the per-probe thread
 * reply needs. Full response payloads already live in the per-failure
 * `Canary RED` alerts and in the GCS-archived run artifacts.
 */
export type PerProbeOutcomeSample = {
  verdict: Verdict;
  httpStatus: number | null;
  durationMs: number;
  /** Unix seconds - same as ProbeOutcome.completedAt. */
  completedAt: number;
};

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
  /** Worst severity across the window - drives the red/yellow/green bucketing. */
  worstSeverity: Severity;
  /** RED outcome details for the threaded breakdown, sorted oldest to newest. */
  failures: PerProbeOutcomeSample[];
  /** YELLOW outcome details for the threaded breakdown, sorted oldest to newest. */
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
  /**
   * Most recent registry-delta event in the window, if any. Only the latest
   * change is surfaced: if the registry toggled mid-window (a model removed
   * then re-added) the latest snapshot is the one that matches what is
   * callable right now.
   */
  latestRegistryDelta: ModelRegistryDelta | null;
  archival: {
    objectCount: number;
    oldestAgeDays: number | null;
    totalBytes: number;
  };
};

const ONE_HOUR_MS = 3_600_000;

/**
 * 168h (7 days) to match the weekly probe cadence. A 24h window would only
 * ever contain the single Monday morning run and would look empty on any
 * other day of the week.
 */
const WINDOW_HOURS = 168;

/**
 * We over-fetch hourly prefixes (WINDOW_HOURS + 2 covers day-boundary UTC
 * offsets and clock skew) and then filter the returned artifacts by their
 * `startedAt` so the digest reflects exactly the promised window.
 */
export async function loadWindow(
  gcs: GcsClient,
  now: Date = new Date()
): Promise<RunArtifact[]> {
  const seen = new Set<string>();
  const artifacts: RunArtifact[] = [];
  const cutoffMs = now.getTime() - WINDOW_HOURS * ONE_HOUR_MS;

  for (const prefix of buildRunPrefixes(now)) {
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

/** Hourly GCS prefixes covering the window, plus a 2h edge buffer. */
export function buildRunPrefixes(now: Date): string[] {
  const out = new Set<string>();
  for (let hoursBack = 0; hoursBack < WINDOW_HOURS + 2; hoursBack++) {
    out.add(runHourPrefix(new Date(now.getTime() - hoursBack * ONE_HOUR_MS)));
  }
  return Array.from(out);
}

/** RED > YELLOW > GREEN. */
function worstOf(current: Severity, next: Severity): Severity {
  if (current === "RED" || next === "RED") return "RED";
  if (current === "YELLOW" || next === "YELLOW") return "YELLOW";
  return "GREEN";
}

export type SummarizeOptions = {
  /**
   * When provided, outcomes whose signature is not in this set are skipped
   * entirely - not counted toward probesRun, severityCounts, verdictCounts,
   * or perProbe. Used to drop retired signatures whose archived outcomes are
   * still inside the window. Pass null to disable filtering (fail-open).
   */
  allowedSignatures?: Set<string> | null;
};

type ProbeAggregate = {
  label: string;
  durations: number[];
  passing: number;
  failing: number;
  yellowing: number;
  worstSeverity: Severity;
  failures: PerProbeOutcomeSample[];
  yellowOutcomes: PerProbeOutcomeSample[];
};

export function summarize(
  artifacts: RunArtifact[],
  archival: DigestSummary["archival"],
  now: Date,
  options: SummarizeOptions = {}
): DigestSummary {
  const earliest = artifacts[0]?.startedAt ?? now.toISOString();
  const allowed = options.allowedSignatures ?? null;
  const perProbeAgg = new Map<string, ProbeAggregate>();
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
    NOT_ENTITLED: 0,
    TIMEOUT: 0,
    TOOL_CALL_MISSING: 0,
    GUARDRAIL_BYPASS: 0,
    UNEXPECTED_SUCCESS: 0,
    SLA_EXCEEDED: 0,
    CLEANUP_FAILED: 0,
  };

  let probesRun = 0;
  for (const artifact of artifacts) {
    // Registry adds/removes count as YELLOW: "something shifted, not
    // necessarily broken". RED stays reserved for probes that target a
    // currently-supported model and fail.
    const delta = artifact.registryDelta;
    if (delta && delta.hasChanges) {
      severityCounts.YELLOW += delta.added.length + delta.removed.length;
    }
    for (const outcome of artifact.outcomes) {
      if (allowed !== null && !allowed.has(outcome.signature)) continue;
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

  const byCompletedAt = (
    a: PerProbeOutcomeSample,
    b: PerProbeOutcomeSample
  ): number => a.completedAt - b.completedAt;

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
      failures: [...entry.failures].sort(byCompletedAt),
      yellowOutcomes: [...entry.yellowOutcomes].sort(byCompletedAt),
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
    latestRegistryDelta: pickLatestRegistryDelta(artifacts),
    archival,
  };
}

/**
 * Most recent delta that is either a first snapshot or has add/remove
 * changes. Steady-state "no change" deltas are ignored so the digest post
 * stays quiet when nothing interesting happened to the registry.
 */
export function pickLatestRegistryDelta(
  artifacts: RunArtifact[]
): ModelRegistryDelta | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const d = artifacts[i].registryDelta;
    if (d && (d.hasChanges || d.isFirstSnapshot)) return d;
  }
  return null;
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

/**
 * Thread replies are posted independently and best-effort: one bad post
 * (rate limit, missing scope, transient blip) must not skip the rest.
 */
async function postThreadReply(
  slack: SlackClient,
  threadTs: string,
  text: string,
  context: string
): Promise<void> {
  try {
    await slack.post({ text, threadTs });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `slack.post (digest ${context} thread) failed: ${(error as Error).message}`
    );
  }
}

export async function runDigest(
  config: CanaryConfig,
  deps: DigestDeps,
  now: Date = new Date()
): Promise<DigestSummary> {
  const artifacts = await loadWindow(deps.gcs, now);
  const archival = await gatherArchivalState(deps.gcs, now);

  // Falls back to null (no filter) when the snapshot blob is missing - e.g.
  // the very first digest after deploy. Fail-open on purpose: a missing
  // snapshot must not silence the canary's top-level alerts.
  const snapshot = await loadLatestSnapshot(deps.gcs);
  const allowedSignatures = snapshot
    ? new Set(
        currentProbeSignatures(snapshot.modelIds, snapshot.families ?? [])
      )
    : null;

  const summary = summarize(artifacts, archival, now, { allowedSignatures });

  const posted = await deps.slack.post({ text: formatDigestTopLevel(summary) });

  const bySeverity = (severity: Severity): PerProbeEntry[] =>
    summary.perProbe.filter((p) => p.worstSeverity === severity);
  const greenProbes = bySeverity("GREEN");

  if (greenProbes.length > 0) {
    await postThreadReply(
      deps.slack,
      posted.ts,
      formatAllGreenThread(greenProbes),
      "all-green"
    );
  }

  for (const probe of bySeverity("YELLOW")) {
    await postThreadReply(
      deps.slack,
      posted.ts,
      formatProbeYellowThread(probe),
      `yellow ${probe.signature}`
    );
  }
  for (const probe of bySeverity("RED")) {
    await postThreadReply(
      deps.slack,
      posted.ts,
      formatProbeFailureThread(probe),
      `red ${probe.signature}`
    );
  }

  return summary;
}

export function formatDigestTopLevel(summary: DigestSummary): string {
  const red = summary.severityCounts.RED;
  const total = summary.probesRun;
  // Watchdog guard: a zero-run digest must NOT render green. A green header
  // with "Probes run: 0" is indistinguishable from a misconfigured scheduler
  // and caused confusion on 2026-05-11 (see RCA).
  const emoji =
    summary.runsFound === 0 || red > 0
      ? ":rotating_light:"
      : ":large_green_circle:";
  const header = `${emoji} *Gloo AI Canary — Weekly Digest*`;

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
    if (summary.runsFound === 0) {
      // Distinguish "the probe job never fired" from "probes ran and all
      // were green" - an on-caller has to tell them apart at a glance.
      notableBlock =
        "_(no probe runs found in the last 24h — check that the probe scheduler is running)_";
    } else {
      notableBlock =
        summary.perProbe.length === 0
          ? "_(probes ran but all outcomes were filtered — check allowedSignatures)_"
          : "_All probes fully green — see thread for per-probe details._";
    }
  } else {
    notableBlock = notableLines;
  }

  const greenRollup =
    notableProbes.length > 0 && greenCount > 0
      ? `\n_🟢 ${greenCount} ${greenCount === 1 ? "probe" : "probes"} fully green — see thread for details._`
      : "";

  const archival = summary.archival;
  const archivalLine = `• Archive: ${archival.objectCount} objects, ${humanBytes(archival.totalBytes)}, oldest ${archival.oldestAgeDays ?? "?"}d (auto-pruned @ 90d)`;

  // Registry changes rank above routine probe failures, so the block goes
  // before "Needs attention". Steady state omits the block entirely rather
  // than rendering "no changes" noise.
  const registryBlock = summary.latestRegistryDelta
    ? formatRegistryDeltaBlock(summary.latestRegistryDelta) + "\n\n"
    : "";

  return [
    header,
    `*Window:* ${summary.windowStart} → ${summary.windowEnd} (last 7 days)`,
    `*Probes run:* ${total} across ${summary.runsFound} runs`,
    `*Severity:* 🔴 ${summary.severityCounts.RED}  🟡 ${summary.severityCounts.YELLOW}  🟢 ${summary.severityCounts.GREEN}`,
    "",
    registryBlock + "*Needs attention*",
    notableBlock + greenRollup,
    "",
    archivalLine,
  ].join("\n");
}

/**
 * The "/platform/v2/models registry changed" block. The first snapshot ever
 * gets a subdued "baseline captured" note so a fresh deploy doesn't scream
 * "something changed!" when it is really just the first measurement.
 */
export function formatRegistryDeltaBlock(delta: ModelRegistryDelta): string {
  if (delta.isFirstSnapshot) {
    const count = delta.added.length;
    return [
      `:memo: *Model registry baseline captured (${count} ${count === 1 ? "model" : "models"})*`,
      `_Future digests will emphasize any additions or removals from \`/platform/v2/models\`._`,
    ].join("\n");
  }

  // YELLOW-flavored: adds/removes are "something shifted", not an outage.
  const lines: string[] = [
    `:large_yellow_circle: *\`/platform/v2/models\` changed since last snapshot*`,
  ];
  for (const id of delta.added) {
    lines.push(`• :heavy_plus_sign: \`${id}\``);
  }
  for (const id of delta.removed) {
    lines.push(`• :heavy_minus_sign: \`${id}\``);
  }
  lines.push(
    `_Previous snapshot: ${delta.previousCapturedAt} · current: ${delta.currentCapturedAt}._`
  );
  return lines.join("\n");
}

/**
 * One consolidated post rather than N individual ones - green probes are
 * uninteresting alone; the value is seeing which probes are collectively
 * healthy.
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

type SampleBreakdown = {
  verdictMix: string;
  statusMix: string;
  mostRecent: PerProbeOutcomeSample | undefined;
};

function breakdownOf(samples: PerProbeOutcomeSample[]): SampleBreakdown {
  return {
    verdictMix: countMix(samples.map((s) => s.verdict)),
    statusMix: countMix(
      samples.map((s) =>
        s.httpStatus === null ? "network error" : String(s.httpStatus)
      )
    ),
    mostRecent: samples[samples.length - 1],
  };
}

/**
 * Thread-reply text for one failing probe. Expands what "N/M pass" means in
 * the top-level digest. Response bodies are omitted on purpose - they live
 * in the per-failure `Canary RED` alerts.
 */
export function formatProbeFailureThread(probe: PerProbeEntry): string {
  const { verdictMix, statusMix, mostRecent } = breakdownOf(probe.failures);
  const mostRecentLine = mostRecent
    ? `• Most recent failure: ${new Date(mostRecent.completedAt * 1000).toISOString()} (${mostRecent.durationMs}ms)`
    : "• Most recent failure: _none recorded_";

  return [
    `🔴 *Breakdown for \`${probe.signature}\`* — ${probe.label}`,
    `• Runs in the weekly window: ${probe.total} (one outcome per probe-runner execution)`,
    `• Passed: ${probe.passing} · Failed: ${probe.failing}`,
    `• Failure verdicts: ${verdictMix || "_none_"}`,
    `• HTTP statuses on failures: ${statusMix || "_none_"}`,
    mostRecentLine,
    `• Latency across all runs: p50 ${probe.p50Ms}ms · p99 ${probe.p99Ms}ms`,
    `_See the top-level \`Canary RED — …\` alerts for this signature for the full response payloads._`,
  ].join("\n");
}

/**
 * Same shape as the RED breakdown, worded for the "soft signal / needs a
 * look" semantics of YELLOW (latency anomalies, routing shifts).
 */
export function formatProbeYellowThread(probe: PerProbeEntry): string {
  const { verdictMix, statusMix, mostRecent } = breakdownOf(
    probe.yellowOutcomes
  );
  const mostRecentLine = mostRecent
    ? `• Most recent YELLOW: ${new Date(mostRecent.completedAt * 1000).toISOString()} (${mostRecent.durationMs}ms)`
    : "• Most recent YELLOW: _none recorded_";

  return [
    `🟡 *Breakdown for \`${probe.signature}\`* — ${probe.label}`,
    `• Runs in the weekly window: ${probe.total} (one outcome per probe-runner execution)`,
    `• Passed: ${probe.passing} · Non-pass: ${probe.failing} · YELLOW signals: ${probe.yellowing}`,
    `• YELLOW verdicts: ${verdictMix || "_none_"}`,
    `• HTTP statuses on YELLOW outcomes: ${statusMix || "_none_"}`,
    mostRecentLine,
    `• Latency across all runs: p50 ${probe.p50Ms}ms · p99 ${probe.p99Ms}ms`,
    `_YELLOW is a soft signal — the call succeeded or degraded but not cleanly enough to be GREEN. Follow up if the pattern persists._`,
  ].join("\n");
}

/** "FAIL × 3, SCHEMA_MISMATCH × 1", most frequent first. */
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
