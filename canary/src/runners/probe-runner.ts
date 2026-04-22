/**
 * Probe runner — executes one round of probes, archives results to GCS,
 * and posts failure alerts to Slack with dedup via the GCS state file.
 *
 * Expected to be the entry point of the `canary-probe` Cloud Run Job,
 * triggered by Cloud Scheduler on a business-hours-biased cadence:
 * every 15 min 06:00–16:45 CT (daytime) and hourly 17:00–05:00 CT
 * (nighttime) — 57 runs/day total.
 */

import { getAccessToken } from "@glooai/scripts";
import type { Probe, ProbeOutcome } from "../probes/types.js";
import type { CanaryConfig } from "../config.js";
import {
  computeRegistryDelta,
  type ModelRegistryDelta,
} from "../fixtures/model-registry-delta.js";
import type { V2ModelSummary } from "../fixtures/v2-models.js";
import {
  loadLatestSnapshot,
  saveSnapshot,
} from "../sinks/model-registry-snapshot.js";
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
  /**
   * Hydrated list of V2 models used to build the direct-model probes.
   * When present, the probe runner will also diff this list against the
   * previous GCS-archived snapshot and attach the resulting delta to the
   * RunArtifact. Omit to disable the snapshot+diff step entirely.
   */
  v2Models?: V2ModelSummary[];
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

  // Snapshot + diff the live registry BEFORE writing the run artifact so
  // the delta is embedded in the archived JSON — the digest can then
  // aggregate deltas across the 24h window without re-reading GCS
  // state. All snapshot-path errors are logged and swallowed: this is a
  // secondary feature and must never fail the primary probe run.
  const registryDelta = await maybeSnapshotRegistry(deps, now, config);

  const artifact: RunArtifact = {
    runId: config.execution.runId,
    startedAt: config.execution.startedAt,
    completedAt: new Date().toISOString(),
    outcomes,
    ...(registryDelta ? { registryDelta } : {}),
  };

  await deps.gcs.writeJson(
    runArtifactPath(config.execution.runId, now),
    artifact
  );

  await reconcileFailures(artifact, deps, config, now);

  return artifact;
}

async function maybeSnapshotRegistry(
  deps: ProbeRunnerDeps,
  now: Date,
  config: CanaryConfig
): Promise<ModelRegistryDelta | undefined> {
  const models = deps.v2Models;
  if (!models) return undefined;

  const currentIds = models.map((m) => m.id).sort();
  try {
    const previous = await loadLatestSnapshot(deps.gcs);
    const delta = computeRegistryDelta({
      previous: previous
        ? { capturedAt: previous.capturedAt, modelIds: previous.modelIds }
        : null,
      current: { capturedAt: now.toISOString(), modelIds: currentIds },
    });

    // Overwrite the single "latest" blob on every run — the GCS layout
    // mirrors the existing `state/active-failures.json` pattern, so no
    // new infra, no new secrets, and the file is small (one JSON doc).
    await saveSnapshot(deps.gcs, {
      capturedAt: now.toISOString(),
      runId: config.execution.runId,
      modelIds: currentIds,
    });
    return delta;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `model-registry-snapshot: step failed (non-fatal): ${(error as Error).message}`
    );
    return undefined;
  }
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

  // 1. Handle current failures (new or recurring). Slack failures are
  //    non-fatal per-signature so one bad post (rate-limited, transient
  //    network blip, missing scope) doesn't abort the whole loop and
  //    leave the state file unwritten — which would cause every
  //    already-alerted failure to re-post as new on the next run.
  for (const [signature, outcome] of failuresBySignature) {
    const prior = next[signature];
    if (!prior) {
      const topLevelText = formatFailureTopLevel(outcome, config);
      try {
        const posted = await deps.slack.post({ text: topLevelText });
        next[signature] = {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          slackTs: posted.ts,
          attempts: 1,
          lastVerdict: outcome.verdict,
        };
      } catch (error) {
        // Don't record the signature in state — next run treats it as
        // new and retries the top-level alert.
        // eslint-disable-next-line no-console
        console.warn(
          `slack.post (new ${signature}) failed: ${(error as Error).message}`
        );
      }
    } else {
      const recurringText = formatFailureRecurring(outcome, prior.attempts + 1);
      try {
        await deps.slack.post({ text: recurringText, threadTs: prior.slackTs });
        next[signature] = {
          ...prior,
          lastSeenAt: now.toISOString(),
          attempts: prior.attempts + 1,
          lastVerdict: outcome.verdict,
        };
      } catch (error) {
        // Keep prior state unchanged; reconciler will retry the thread
        // reply on the next run.
        // eslint-disable-next-line no-console
        console.warn(
          `slack.post (recurring ${signature}) failed: ${(error as Error).message}`
        );
      }
    }
  }

  // 2. Handle recoveries — signatures previously failing, now passing.
  //    Recovery failures are also non-fatal: leave the state entry in
  //    place so the next run retries the recovery message.
  for (const signature of Object.keys(existing)) {
    if (!failuresBySignature.has(signature)) {
      const priorTs = existing[signature].slackTs;
      try {
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
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `slack.post (recovery ${signature}) failed: ${(error as Error).message}`
        );
      }
    }
  }

  await deps.gcs.writeJson(ACTIVE_FAILURES_PATH, next);
}

export function formatFailureTopLevel(
  outcome: ProbeOutcome,
  config: CanaryConfig
): string {
  const model = outcome.model ? `\n• *Model:* \`${outcome.model}\`` : "";
  // Prefer `contentPreview` when available — for REFUSAL_REGRESSION
  // verdicts it holds the actual refusal text (first ~400 chars), which
  // is the money info for whoever gets paged. Fall back to the raw
  // response envelope for non-content failures (5xx, schema mismatch,
  // empty completion). Probes already truncate both fields, so no
  // secondary slice is needed here.
  let preview = "";
  if (outcome.contentPreview) {
    preview = `\n• *Content:* \`\`\`${outcome.contentPreview}\`\`\``;
  } else if (outcome.responsePreview) {
    preview = `\n• *Response:* \`\`\`${outcome.responsePreview}\`\`\``;
  }
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
