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
 * RESOLUTION (GAI-6872): approach B, via Better Stack heartbeats.
 *   Every probe/ingestion run POSTs its Better Stack heartbeat URL at the
 *   very end of runProbes (src/sinks/heartbeat.ts): bare URL on green,
 *   `/fail` on any RED. A canary that crashes or stops being scheduled
 *   sends nothing, and Better Stack raises "missing heartbeat" after the
 *   monitor's grace period — a rolling absence alert with no GCP duration
 *   limit. Configure the grace period per monitor in Better Stack:
 *   probe ≈ schedule interval + 1h; ingestion ≈ 6h + 30m.
 *
 *   Enablement is gated on var.heartbeats_enabled (see variables.tf) so
 *   the secret mounts only appear once the heartbeat URLs exist in
 *   Secret Manager.
 *
 * HISTORICAL ALTERNATIVE (kept for reference):
 *   A. A small Cloud Run Job publishing a custom freshness metric
 *      (canary/probe_age_hours) from the newest GCS artifact, alerted via
 *      condition_threshold — works within the 23h30m absence-duration API
 *      limit, but needs an extra job + alertPolicyEditor on the deployer SA.
 *
 * See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md § "Forward-looking guards" item 3
 */
