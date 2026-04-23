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

import { getAccessToken } from "@glooai/scripts";
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

  // Persist tier state last. Safe to run as a best-effort step — if
  // the write fails we just fall through to "cold-start" on the next
  // run, which is a single extra Full sweep. Better than failing the
  // whole run over a bookkeeping blob.
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
 * "provisional recovery" — silent, no Slack post yet. Only after it's
 * continuously passed for this long do we publish the ✅ recovery
 * reply + banner + reaction and delete the state entry. If the probe
 * fails again inside the window it snaps back to "open" silently.
 *
 * The purpose is aggressive notification coalescing: the user only
 * wants to hear about a probe twice in a day — once on the initial
 * outage and once in the daily digest if it's still open at that
 * time — regardless of how many rounds it fails or how much it flaps
 * in between. The debounce turns the normal Slack-per-run chatter
 * into two posts: incident-opened, incident-confirmed-closed.
 *
 * 60 min was chosen to match the platform's periodic Full sweep
 * interval — a probe that passes for 4 consecutive Light ticks during
 * business hours (or 1 nighttime tick) is safely considered healed.
 * Kept as a module constant (not a config) because tuning this is a
 * code change, not a deployment toggle.
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
  const existing =
    (await deps.gcs.readJson<ActiveFailures>(ACTIVE_FAILURES_PATH)) ?? {};
  const next: ActiveFailures = { ...existing };

  const failuresBySignature = new Map<string, ProbeOutcome>();
  for (const o of artifact.outcomes) {
    if (o.severity === "RED") failuresBySignature.set(o.signature, o);
  }

  // 1. Handle current failures.
  //
  //    Slack failures (only on the top-level post for a brand-new
  //    incident) are non-fatal per-signature so one bad post
  //    (rate-limited, transient network blip, missing scope) doesn't
  //    abort the whole loop and leave the state file unwritten —
  //    which would cause every already-alerted failure to re-post as
  //    new on the next run.
  for (const [signature, outcome] of failuresBySignature) {
    const prior = next[signature];
    if (!prior) {
      // Brand-new incident. This is the single "incident opened"
      // notification for the signature.
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
      // Silent reopen — the signature was in its debounce window and
      // failed again. The banner was never flipped to green (we only
      // do that on *confirmed* recovery), so there's nothing to
      // revert on the top-level post. Just snap back to "open".
      next[signature] = {
        ...prior,
        lastSeenAt: now.toISOString(),
        attempts: prior.attempts + 1,
        lastVerdict: outcome.verdict,
        recoveredAt: undefined,
      };
    } else {
      // Recurring failure on an open incident — silent state update.
      // The user learns about it exactly once per day, via the
      // digest, as long as it stays open.
      next[signature] = {
        ...prior,
        lastSeenAt: now.toISOString(),
        attempts: prior.attempts + 1,
        lastVerdict: outcome.verdict,
      };
    }
  }

  // 2. Handle signatures that are NOT failing this run.
  //    - No prior entry: nothing to do.
  //    - Prior entry, not yet recovered: start the debounce (silent).
  //    - Prior entry, recovering, still inside debounce: silent no-op.
  //    - Prior entry, recovering, past debounce: post confirmed
  //      recovery + banner + reaction, delete state.
  for (const signature of Object.keys(existing)) {
    if (failuresBySignature.has(signature)) continue;
    const prior = next[signature];
    if (!prior) continue;

    if (!prior.recoveredAt) {
      // First pass after failure — start the debounce. Silent.
      next[signature] = {
        ...prior,
        recoveredAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      };
      continue;
    }

    const elapsed = now.getTime() - Date.parse(prior.recoveredAt);
    if (Number.isFinite(elapsed) && elapsed >= RECOVERY_DEBOUNCE_MS) {
      // Debounce expired — publish the confirmed-recovery notification
      // and retire the state entry. Slack failures here are non-fatal:
      // if any call throws we leave the tombstone in place and retry
      // on the next reconcile.
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
    // else: still inside the debounce — silent, no-op, wait for the
    // next reconcile to re-evaluate.
  }

  await deps.gcs.writeJson(ACTIVE_FAILURES_PATH, next);
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
 * Rewrite a top-level failure post's text to carry a "Recovered"
 * banner prefix while preserving all the original diagnostic
 * detail below. Slack's `chat.update` replaces the full text, so
 * we explicitly keep the old body intact — just with a green-check
 * banner prepended — so a future triage reader can still see what
 * the original failure was.
 *
 * Banner format is chosen to keep the channel-sidebar preview
 * obviously green. Slack renders `:white_check_mark:` as the
 * white-check-on-green-box emoji.
 */
export function formatRecoveredTopLevel(
  originalText: string,
  now: Date
): string {
  const banner = `:white_check_mark: *Recovered* at ${now.toISOString()}`;
  return `${banner}\n\n${originalText}`;
}
