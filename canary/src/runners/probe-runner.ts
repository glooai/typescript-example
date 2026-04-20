/**
 * Probe runner — executes one round of probes, archives results to GCS,
 * and posts failure alerts to Slack with dedup via the GCS state file.
 *
 * Expected to be the entry point of the `canary-probe` Cloud Run Job,
 * triggered by Cloud Scheduler every 4h.
 */

import { getAccessToken } from "@glooai/scripts";
import type { Probe, ProbeOutcome } from "../probes/types.js";
import type { CanaryConfig } from "../config.js";
import {
  ACTIVE_FAILURES_PATH,
  runArtifactPath,
  type ActiveFailures,
  type GcsClient,
  type RunArtifact,
} from "../sinks/gcs.js";
import type { SlackClient } from "../sinks/slack.js";

export type ProbeRunnerDeps = {
  probes: Probe[];
  gcs: GcsClient;
  slack: SlackClient;
};

export async function runProbes(
  config: CanaryConfig,
  deps: ProbeRunnerDeps,
  now: Date = new Date()
): Promise<RunArtifact> {
  const tokenResponse = await getAccessToken({
    clientId: config.gloo.clientId,
    clientSecret: config.gloo.clientSecret,
  });
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from Gloo token response.");
  }

  const outcomes: ProbeOutcome[] = [];
  for (const probe of deps.probes) {
    const outcome = await probe.run({
      accessToken,
      runId: config.execution.runId,
      startedAt: config.execution.startedAt,
    });
    outcomes.push(outcome);
  }

  const artifact: RunArtifact = {
    runId: config.execution.runId,
    startedAt: config.execution.startedAt,
    completedAt: new Date().toISOString(),
    outcomes,
  };

  await deps.gcs.writeJson(
    runArtifactPath(config.execution.runId, now),
    artifact
  );

  await reconcileFailures(artifact, deps, config, now);

  return artifact;
}

/**
 * Walk the results against the previous active-failures map:
 *   - New RED signature → top-level post, record ts
 *   - Previously RED signature, still RED → threaded reply, increment attempts
 *   - Previously RED signature, now GREEN → threaded ✅ + reaction, drop from map
 */
export async function reconcileFailures(
  artifact: RunArtifact,
  deps: ProbeRunnerDeps,
  config: CanaryConfig,
  now: Date
): Promise<void> {
  const existing =
    (await deps.gcs.readJson<ActiveFailures>(ACTIVE_FAILURES_PATH)) ?? {};
  const next: ActiveFailures = { ...existing };

  const failuresBySignature = new Map<string, ProbeOutcome>();
  for (const o of artifact.outcomes) {
    if (o.severity === "RED") failuresBySignature.set(o.signature, o);
  }

  // 1. Handle current failures (new or recurring).
  for (const [signature, outcome] of failuresBySignature) {
    const prior = next[signature];
    if (!prior) {
      const topLevelText = formatFailureTopLevel(outcome, config);
      const posted = await deps.slack.post({ text: topLevelText });
      next[signature] = {
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        slackTs: posted.ts,
        attempts: 1,
        lastVerdict: outcome.verdict,
      };
    } else {
      const recurringText = formatFailureRecurring(outcome, prior.attempts + 1);
      await deps.slack.post({ text: recurringText, threadTs: prior.slackTs });
      next[signature] = {
        ...prior,
        lastSeenAt: now.toISOString(),
        attempts: prior.attempts + 1,
        lastVerdict: outcome.verdict,
      };
    }
  }

  // 2. Handle recoveries — signatures previously failing, now passing.
  for (const signature of Object.keys(existing)) {
    if (!failuresBySignature.has(signature)) {
      const priorTs = existing[signature].slackTs;
      await deps.slack.post({
        text: `:white_check_mark: Recovered — probe \`${signature}\` is passing again as of ${now.toISOString()}.`,
        threadTs: priorTs,
      });
      try {
        await deps.slack.react(priorTs, "white_check_mark");
      } catch (error) {
        // Already-reacted or missing scope — not fatal.
        // eslint-disable-next-line no-console
        console.warn(`reactions.add skipped: ${(error as Error).message}`);
      }
      delete next[signature];
    }
  }

  await deps.gcs.writeJson(ACTIVE_FAILURES_PATH, next);
}

export function formatFailureTopLevel(
  outcome: ProbeOutcome,
  config: CanaryConfig
): string {
  const model = outcome.model ? `\n• *Model:* \`${outcome.model}\`` : "";
  const preview = outcome.responsePreview
    ? `\n• *Response:* \`\`\`${outcome.responsePreview.slice(0, 500)}\`\`\``
    : "";
  return [
    `:rotating_light: *Canary RED — ${outcome.label}*`,
    `• *Signature:* \`${outcome.signature}\``,
    `• *Verdict:* ${outcome.verdict}`,
    `• *Endpoint:* \`${outcome.endpoint}\``,
    `• *HTTP status:* ${outcome.httpStatus ?? "network error"}`,
    `• *Latency:* ${outcome.durationMs}ms`,
    `• *Run:* \`${config.execution.runId}\` @ ${config.execution.startedAt}${model}${preview}`,
  ].join("\n");
}

export function formatFailureRecurring(
  outcome: ProbeOutcome,
  attempt: number
): string {
  return [
    `↻ Still failing (attempt ${attempt}) — \`${outcome.verdict}\``,
    `• HTTP ${outcome.httpStatus ?? "net-error"} in ${outcome.durationMs}ms`,
  ].join("\n");
}
