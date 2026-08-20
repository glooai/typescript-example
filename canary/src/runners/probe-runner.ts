/**
 * Probe runner — executes one round of probes, archives results to GCS,
 * and posts failure alerts to Slack with dedup via the GCS state file.
 *
 * Expected to be the entry point of the `canary-probe` Cloud Run Job,
 * triggered by Cloud Scheduler on a business-hours-biased cadence:
 * every 15 min 06:00–16:45 CT (daytime) and hourly 17:00–05:00 CT
 * (nighttime) — 57 runs/day total.
 *
 * The runner itself is tier-agnostic — it executes whatever probe list
 * its caller passes in. `index.ts` owns the Light-vs-Full decision via
 * `runners/tier-decision.ts`; this module just records which tier ran
 * so the next decision has fresh state to read.
 */

import type { Probe, ProbeOutcome } from "../probes/types.js";
import type { CanaryConfig } from "../config.js";
import { extractFamilies } from "../fixtures/index.js";
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
  PROBE_TIER_STATE_PATH,
  runArtifactPath,
  type ActiveFailures,
  type GcsClient,
  type ProbeTierState,
  type RunArtifact,
} from "../sinks/gcs.js";
import type { SlackClient } from "../sinks/slack.js";
import { createHeartbeatClient } from "../sinks/heartbeat.js";
import { persistTierState, type ProbeTier } from "./tier-decision.js";

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
  /**
   * Which tier produced `probes`. Threaded through so the runner can
   * persist `lastFullSweepAt` on Full runs without the caller needing
   * to duplicate the write path. Defaults to "full" to preserve the
   * previous behavior of any caller that doesn't opt in.
   */
  tier?: ProbeTier;
  /**
   * GCS blob the failure state is reconciled against. Defaults to the
   * inference canary's `state/active-failures.json`. Ingestion mode
   * passes its own blob — see INGESTION_ACTIVE_FAILURES_PATH for why
   * the streams must not share one file.
   */
  activeFailuresPath?: string;
  /**
   * Set false for modes that don't participate in the adaptive
   * Light/Full tiering (ingestion). Persisting tier state from such a
   * run would tell the next inference tick a Full sweep just happened
   * when it didn't. Defaults to true.
   */
  persistTierState?: boolean;
};

export async function runProbes(
  config: CanaryConfig,
  deps: ProbeRunnerDeps,
  now: Date = new Date()
): Promise<RunArtifact> {
  const outcomes: ProbeOutcome[] = [];
  for (const probe of deps.probes) {
    const outcome = await probe.run({
      accessToken: config.gloo.apiKey,
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

  // Persist tier state last. Safe to run as a best-effort step — if
  // the write fails we just fall through to "cold-start" on the next
  // run, which is a single extra Full sweep. Better than failing the
  // whole run over a bookkeeping blob. Skipped entirely for modes
  // outside the Light/Full cascade (ingestion).
  if (deps.persistTierState !== false) {
    const tier: ProbeTier = deps.tier ?? "full";
    try {
      const previous = await deps.gcs.readJson<ProbeTierState>(
        PROBE_TIER_STATE_PATH
      );
      await persistTierState(deps.gcs, { tier, now, previous });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `probe-tier-state: persist failed (non-fatal): ${(error as Error).message}`
      );
    }
  }

  // Better Stack heartbeat — the status-page component for this job.
  // Any RED outcome reports "down"; YELLOW is a config/latency signal,
  // not an outage, so it still reports "up". Sits at the very end on
  // purpose: a crash anywhere above skips the ping entirely, which
  // Better Stack surfaces as "missing heartbeat" — the dead-canary
  // watchdog. No-op when config.heartbeatUrl is unset.
  const anyRed = outcomes.some((o) => o.severity === "RED");
  await createHeartbeatClient(config.heartbeatUrl).report(!anyRed);

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
  const currentFamilies = extractFamilies(models);
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
      families: currentFamilies,
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
 * Recovery debounce window. A signature that just passed goes into
 * provisional recovery: silent, no Slack post. Only after it has passed
 * continuously for this long do we publish the recovery reply, banner, and
 * reaction and delete the state entry; a re-failure inside the window snaps
 * it back to "open" silently.
 *
 * This is aggressive notification coalescing. However much a probe flaps,
 * the channel sees exactly two posts: incident-opened and
 * incident-confirmed-closed (plus the digest while it stays open).
 *
 * 60 min matches the periodic Full sweep interval, so a probe that passes
 * four consecutive daytime Light ticks (or one nighttime tick) is
 * considered healed. A module constant, not config: tuning it is a code
 * change, not a deployment toggle.
 */
const RECOVERY_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * Walk the results against the previous active-failures map:
 *   - New RED signature → top-level post, record ts + topLevelText.
 *     This is the ONLY Slack post made while an incident is open.
 *   - Previously RED, still RED → silent state update. No Slack noise.
 *   - Previously RED, RED again after a provisional recovery (flap) →
 *     silent. Clear `recoveredAt`, bump attempts. No banner flip (the
 *     banner was never swapped because the recovery wasn't confirmed).
 *   - Previously RED, now GREEN (first pass) → silent. Mark the entry
 *     with `recoveredAt` and wait for the debounce window to confirm.
 *   - Previously RED, still GREEN past debounce → threaded ✅ reply
 *     + ✅ reaction + chat.update banner, delete state. This is the
 *     ONE notification that closes out the incident.
 *
 * The daily digest (a separate job) is where long-running incidents
 * surface on the next day — see digest-runner.ts.
 */
export async function reconcileFailures(
  artifact: RunArtifact,
  deps: ProbeRunnerDeps,
  config: CanaryConfig,
  now: Date
): Promise<void> {
  const statePath = deps.activeFailuresPath ?? ACTIVE_FAILURES_PATH;
  const existing = (await deps.gcs.readJson<ActiveFailures>(statePath)) ?? {};
  const next: ActiveFailures = { ...existing };

  const failuresBySignature = new Map<string, ProbeOutcome>();
  for (const o of artifact.outcomes) {
    if (o.severity === "RED") failuresBySignature.set(o.signature, o);
  }

  // Slack failures are non-fatal per-signature: one bad post (rate limit,
  // network blip, missing scope) must not abort the loop and leave the
  // state file unwritten, which would re-post every already-alerted failure
  // as new on the next run.
  for (const [signature, outcome] of failuresBySignature) {
    const prior = next[signature];
    if (!prior) {
      // The single "incident opened" notification for this signature.
      const topLevelText = formatFailureTopLevel(outcome, config);
      try {
        const posted = await deps.slack.post({ text: topLevelText });
        next[signature] = {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          slackTs: posted.ts,
          attempts: 1,
          lastVerdict: outcome.verdict,
          topLevelText,
        };
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `slack.post (new ${signature}) failed: ${(error as Error).message}`
        );
      }
    } else if (prior.recoveredAt) {
      // Silent reopen: failed again inside the debounce window. The banner
      // was never flipped to green (that only happens on confirmed
      // recovery), so there is nothing to revert on the top-level post.
      next[signature] = {
        ...prior,
        lastSeenAt: now.toISOString(),
        attempts: prior.attempts + 1,
        lastVerdict: outcome.verdict,
        recoveredAt: undefined,
      };
    } else {
      // Recurring failure on an open incident: silent state update. The
      // digest is where it resurfaces while it stays open.
      next[signature] = {
        ...prior,
        lastSeenAt: now.toISOString(),
        attempts: prior.attempts + 1,
        lastVerdict: outcome.verdict,
      };
    }
  }

  for (const signature of Object.keys(existing)) {
    if (failuresBySignature.has(signature)) continue;
    const prior = next[signature];
    if (!prior) continue;

    if (!prior.recoveredAt) {
      // First pass after a failure: start the debounce, silently.
      next[signature] = {
        ...prior,
        recoveredAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      };
      continue;
    }

    const elapsed = now.getTime() - Date.parse(prior.recoveredAt);
    if (Number.isFinite(elapsed) && elapsed >= RECOVERY_DEBOUNCE_MS) {
      // Debounce expired: publish the confirmed-recovery notification and
      // retire the state entry. If any Slack call throws we leave the
      // tombstone in place and retry on the next reconcile.
      try {
        await deps.slack.post({
          text: formatConfirmedRecovery(signature, prior.recoveredAt, now),
          threadTs: prior.slackTs,
        });
        try {
          await deps.slack.react(prior.slackTs, "white_check_mark");
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`reactions.add skipped: ${(error as Error).message}`);
        }
        if (prior.topLevelText) {
          try {
            await deps.slack.update({
              ts: prior.slackTs,
              text: formatRecoveredTopLevel(prior.topLevelText, now),
            });
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`chat.update skipped: ${(error as Error).message}`);
          }
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

  await deps.gcs.writeJson(statePath, next);
}

/**
 * Confirmed-recovery message used once per incident, posted to the
 * thread of the original top-level alert after the debounce window
 * has elapsed with no re-failure. Surfaces the first-pass time so
 * the on-caller can see how long the thing was actually healed
 * before we published.
 */
export function formatConfirmedRecovery(
  signature: string,
  firstPassAt: string,
  now: Date
): string {
  return `:white_check_mark: Recovered — probe \`${signature}\` has been passing continuously since ${firstPassAt} (confirmed ${now.toISOString()}).`;
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

/**
 * Slack's `chat.update` replaces the full text, so the original body is
 * kept verbatim below the banner - a triage reader still needs to see what
 * the failure was. `:white_check_mark:` renders as the green box, which
 * keeps the channel-sidebar preview obviously green.
 */
export function formatRecoveredTopLevel(
  originalText: string,
  now: Date
): string {
  const banner = `:white_check_mark: *Recovered* at ${now.toISOString()}`;
  return `${banner}\n\n${originalText}`;
}
