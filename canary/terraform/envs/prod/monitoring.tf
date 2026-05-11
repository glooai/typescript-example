/**
 * Cloud Monitoring — canary probe silence watchdog
 *
 * INTENT (Forward-looking guard #3 from the 2026-05-11 RCA):
 *   Alert when the canary-probe Cloud Run Job has not recorded any execution
 *   for a full weekly cycle (≥ 8 days), catching scheduler misconfigurations,
 *   exhausted retry budgets, and crash-looping images.
 *
 * WHY THIS FILE IS CURRENTLY EMPTY:
 *   GCP Cloud Monitoring imposes a hard API limit: condition_absent.duration
 *   must be ≤ 23h30m (84600s). Attempting to set duration = "691200s" (8 days)
 *   returns: Error 400 — "Durations longer than 23h30m are not supported."
 *   The same limit applies to MQL-based absence conditions. A condition_threshold
 *   with a 7-day alignment_period uses clock-aligned (not rolling) windows and
 *   would produce false positives on any day that falls in a new weekly window
 *   before the probe has had a chance to run.
 *
 * RECOMMENDED FUTURE APPROACH (pick one):
 *   A. Write a small Cloud Function (or a second Cloud Run Job) that runs on
 *      Monday evenings (~18:00 CT). It reads the most recent GCS artifact
 *      timestamp under gs://glooai-canary-results/runs/ and publishes a custom
 *      metric (monitoring.googleapis.com/custom/canary/probe_age_hours).
 *      A standard condition_threshold on that metric (threshold > 168h) works
 *      within all API limits and produces a clean, rolling alert.
 *   B. Use an external uptime-monitoring tool (e.g., Better Uptime, Grafana
 *      Cloud, or PagerDuty Synthetic Checks) pointed at the GCS bucket's most
 *      recent object or a lightweight /healthz endpoint that reads GCS.
 *
 * WHEN IMPLEMENTED:
 *   - Add roles/monitoring.alertPolicyEditor to service_account.tf for the
 *     deployer SA (github-actions-canary-deploy@glooai.iam.gserviceaccount.com)
 *   - Wire var.alert_notification_channels to the new policy
 *
 * See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md § "Forward-looking guards" item 3
 */
