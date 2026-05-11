/**
 * Watchdog runner — verifies that canary-probe wrote at least one GCS artifact
 * in the last WATCHDOG_WINDOW_HOURS (8 days = 192h).
 *
 * Runs Wednesday at 06:00 CT, 48h after the Monday probe window. This gives
 * the probe a comfortable 48h grace window before the watchdog fires.
 *
 * When no probe artifacts are found (probe silent for 8+ days):
 *   - Logs { level: "error", event: "probe_missed" } — Cloud Monitoring
 *     watches this via a log-based metric, triggering the alert policy in
 *     monitoring.tf. Slack is also notified directly so the on-call sees
 *     the alert even if Cloud Monitoring notification channels are not wired.
 *
 * When artifacts are found:
 *   - Logs { level: "info", event: "probe_healthy" } — no Slack noise.
 *
 * See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md
 *      § "Forward-looking guards" item 3
 */

import type { GcsClient } from "../sinks/gcs.js";
import type { SlackClient } from "../sinks/slack.js";
import type { CanaryConfig } from "../config.js";

/**
 * How far back to scan GCS for probe artifacts.
 * Probe is expected once per week (Monday); 8 days gives one full cycle
 * of grace before the watchdog fires.
 */
export const WATCHDOG_WINDOW_HOURS = 192; // 8 days × 24h

/**
 * Build the list of GCS daily-directory prefixes covering the watchdog scan
 * window. One prefix per calendar day from (now − hoursBack) to now.
 *
 * Using daily granularity (not hourly like the digest runner) because
 * the watchdog only cares about presence, not recency within a day.
 */
export function buildWatchdogPrefixes(now: Date, hoursBack: number): string[] {
  const prefixes: string[] = [];
  const earliest = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const cursor = new Date(earliest);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor <= now) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cursor.getUTCDate()).padStart(2, "0");
    prefixes.push(`runs/${y}/${m}/${d}/`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return prefixes;
}

export type WatchdogSummary = {
  artifactsFound: number;
  windowHours: number;
  newestArtifact: string | null;
};

export async function runWatchdog(
  _config: CanaryConfig,
  deps: { gcs: GcsClient; slack: SlackClient }
): Promise<WatchdogSummary> {
  const { gcs, slack } = deps;
  const now = new Date();

  const prefixes = buildWatchdogPrefixes(now, WATCHDOG_WINDOW_HOURS);
  const allPaths: string[] = [];
  for (const prefix of prefixes) {
    const files = await gcs.list(prefix);
    allPaths.push(...files);
  }

  const summary: WatchdogSummary = {
    artifactsFound: allPaths.length,
    windowHours: WATCHDOG_WINDOW_HOURS,
    newestArtifact: allPaths.length > 0 ? allPaths[allPaths.length - 1] : null,
  };

  if (allPaths.length === 0) {
    // Structured sentinel for the Cloud Monitoring log-based metric
    // `canary/probe_missed` — see monitoring.tf.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        event: "probe_missed",
        msg: "No canary probe artifacts found in the last 8 days",
        windowHours: WATCHDOG_WINDOW_HOURS,
      })
    );

    // Direct Slack alert using the same bot token + channel as probe/digest.
    await slack.post({
      text:
        `:rotating_light: *Canary probe silent for 8+ days*\n\n` +
        `No probe artifacts found in GCS for the last ${WATCHDOG_WINDOW_HOURS}h.\n\n` +
        `*Possible causes:*\n` +
        `• Cloud Scheduler misfired — check: Cloud Scheduler → canary-probe-weekly → execution history\n` +
        `• Cloud Run Job exhausted retry budget — check: Cloud Run → Jobs → canary-probe\n` +
        `• Canary image crash-looping before writing GCS artifact\n\n` +
        `*Quick recovery:* Cloud Scheduler → canary-probe-weekly → Force run`,
    });
  } else {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        event: "probe_healthy",
        msg: "Canary probe artifacts confirmed — weekly probe is running",
        windowHours: WATCHDOG_WINDOW_HOURS,
        artifactsFound: allPaths.length,
        newest: summary.newestArtifact,
      })
    );
  }

  return summary;
}
