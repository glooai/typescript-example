/**
 * Better Stack heartbeat sink (GAI-6872).
 *
 * Each canary run reports its overall health to a Better Stack heartbeat
 * monitor: a POST to the bare heartbeat URL means "this component is up",
 * a POST to `<url>/fail` means "this component is down". The status-page
 * component bound to the monitor flips automatically — no human posting
 * required for detection.
 *
 * Two signals in one mechanism:
 *   - Explicit failure: any RED outcome in the run → `/fail` → component
 *     degrades within one run cycle.
 *   - Silent death: the canary crashes / stops being scheduled → no ping
 *     at all → Better Stack raises "missing heartbeat" after the grace
 *     period. This is the dead-canary watchdog that GCP Cloud Monitoring
 *     couldn't express (see terraform/envs/prod/monitoring.tf).
 *
 * The sink is deliberately fail-open: heartbeat delivery problems are
 * logged and swallowed. Monitoring-of-monitoring must never fail (or
 * slow down) the run it's reporting on.
 */

import { withTimeout } from "@glooai/scripts";

const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface HeartbeatClient {
  /** ok=true → bare URL ("up"); ok=false → `<url>/fail` ("down"). */
  report(ok: boolean): Promise<void>;
}

export function createHeartbeatClient(url?: string): HeartbeatClient {
  if (!url) {
    return {
      async report() {
        // Heartbeats not configured for this job — no-op.
      },
    };
  }

  const base = url.replace(/\/+$/, "");
  return {
    async report(ok: boolean): Promise<void> {
      const target = ok ? base : `${base}/fail`;
      const { controller, clearTimer } = withTimeout(HEARTBEAT_TIMEOUT_MS);
      try {
        await fetch(target, { method: "POST", signal: controller.signal });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `heartbeat: delivery failed (non-fatal): ${(error as Error).message}`
        );
      } finally {
        clearTimer();
      }
    },
  };
}
