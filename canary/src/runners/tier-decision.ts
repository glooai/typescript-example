/**
 * Adaptive probe-tier selector.
 *
 * The canary fires every 15 min during daytime / hourly at night, but the
 * *work* each firing does is decided here. When the platform is healthy
 * we run a single cheap pulse probe; when anything is failing or a
 * periodic refresh is due we run the full fan-out sweep that covers
 * every model + every routing mode.
 *
 * Decision tree (in order; first match wins):
 *   1. No persisted tier state yet             → FULL  (cold start)
 *   2. `active-failures.json` is non-empty     → FULL  (still diagnosing)
 *   3. `now - lastFullSweepAt` ≥ interval cap  → FULL  (periodic refresh)
 *   4. otherwise                                → LIGHT (pulse only)
 *
 * This keeps two bounded detection windows:
 *   - Platform-wide outage → caught by the light pulse within one
 *     scheduler tick (≤15 min daytime / ≤1h nighttime).
 *   - Single-model / single-family outage → caught on the next
 *     periodic Full sweep (≤`CANARY_FULL_SWEEP_INTERVAL_MS`,
 *     default 1h). Recovers automatically without any ops action once
 *     the underlying failure clears.
 *
 * State file (`state/probe-tier.json`) is intentionally tiny and
 * idempotent — the only mutable field is `lastFullSweepAt`. Losing it
 * just forces one Full run on the next tick, which self-heals.
 */

import type {
  ActiveFailures,
  GcsClient,
  ProbeTierState,
} from "../sinks/gcs.js";
import { ACTIVE_FAILURES_PATH, PROBE_TIER_STATE_PATH } from "../sinks/gcs.js";

/** Which probe tier a single run executes. */
export type ProbeTier = "light" | "full";

/**
 * How long a Full sweep stays "fresh" before the tier selector
 * demands another one, regardless of health. 1h keeps per-model
 * detection latency ≤1h (the explicit requirement from Patrick) while
 * still letting the steady-state daytime quarter-hours run Light.
 * Overridable via `CANARY_FULL_SWEEP_INTERVAL_MS` so we can tune
 * without a code redeploy if inference-budget headroom changes.
 */
export const DEFAULT_FULL_SWEEP_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

export type TierDecisionInput = {
  state: ProbeTierState | null;
  activeFailures: ActiveFailures | null;
  now: Date;
  fullSweepIntervalMs: number;
};

export type TierDecision = {
  tier: ProbeTier;
  /** Short machine-friendly tag explaining why — for structured logs. */
  reason:
    | "cold-start"
    | "active-failures"
    | "full-sweep-interval-elapsed"
    | "healthy-within-interval";
};

/**
 * Pure decision function — no IO, fully deterministic given its
 * inputs. Kept pure so tests can exhaustively exercise the truth
 * table without mocking GCS.
 */
export function decideTier(input: TierDecisionInput): TierDecision {
  const { state, activeFailures, now, fullSweepIntervalMs } = input;

  if (!state) {
    return { tier: "full", reason: "cold-start" };
  }

  if (activeFailures && Object.keys(activeFailures).length > 0) {
    return { tier: "full", reason: "active-failures" };
  }

  const last = Date.parse(state.lastFullSweepAt);
  // If the stored timestamp is unparseable the safest thing is to
  // assume we've never done a sweep — fall through to Full.
  if (Number.isNaN(last)) {
    return { tier: "full", reason: "cold-start" };
  }

  if (now.getTime() - last >= fullSweepIntervalMs) {
    return { tier: "full", reason: "full-sweep-interval-elapsed" };
  }

  return { tier: "light", reason: "healthy-within-interval" };
}

/**
 * Convenience wrapper that reads both state blobs from GCS and calls
 * `decideTier`. Lives here (not in the runner) so `index.ts` can make
 * the tier decision *before* deciding whether to hydrate the V2 model
 * registry — Light tier skips that network call entirely.
 */
export async function loadAndDecideTier(
  gcs: GcsClient,
  now: Date,
  fullSweepIntervalMs: number = DEFAULT_FULL_SWEEP_INTERVAL_MS
): Promise<TierDecision> {
  const [state, activeFailures] = await Promise.all([
    gcs.readJson<ProbeTierState>(PROBE_TIER_STATE_PATH),
    gcs.readJson<ActiveFailures>(ACTIVE_FAILURES_PATH),
  ]);
  return decideTier({ state, activeFailures, now, fullSweepIntervalMs });
}

/**
 * Write the tier-state blob. Called at the end of every run so the
 * next firing can make an informed decision. Light runs still update
 * `lastTier` (for debug visibility) but preserve the previous
 * `lastFullSweepAt` — only a Full sweep actually resets the clock.
 */
export async function persistTierState(
  gcs: GcsClient,
  params: {
    tier: ProbeTier;
    now: Date;
    previous: ProbeTierState | null;
  }
): Promise<void> {
  const { tier, now, previous } = params;
  const lastFullSweepAt =
    tier === "full"
      ? now.toISOString()
      : (previous?.lastFullSweepAt ?? now.toISOString());
  const next: ProbeTierState = { lastFullSweepAt, lastTier: tier };
  await gcs.writeJson(PROBE_TIER_STATE_PATH, next);
}

/**
 * Parse `CANARY_FULL_SWEEP_INTERVAL_MS` from the environment, falling
 * back to the default when the variable is unset or invalid. Exported
 * so `index.ts` (and tests) don't need to duplicate the parsing
 * logic.
 */
export function resolveFullSweepIntervalMs(
  raw: string | undefined,
  fallback: number = DEFAULT_FULL_SWEEP_INTERVAL_MS
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
