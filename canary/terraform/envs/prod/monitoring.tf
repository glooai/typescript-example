/**
 * Cloud Monitoring — canary probe silence watchdog alert.
 *
 * Architecture (Guard #3 from the 2026-05-11 RCA):
 *
 *   canary-watchdog Cloud Run Job (Wednesday 06:00 CT)
 *     ↓ scans GCS for probe artifacts in the last 8 days
 *     ↓ if none found → logs { event: "probe_missed", level: "error" }
 *                     → posts :rotating_light: to Slack directly
 *     ↓ if found     → logs { event: "probe_healthy" } — no noise
 *
 *   google_logging_metric.probe_missed  (this file)
 *     ↓ counts log entries matching event="probe_missed" from canary-watchdog
 *
 *   google_monitoring_alert_policy.probe_missed_alert  (this file)
 *     ↓ fires when count > 0 within the last day
 *     ↓ notifies via local.all_notification_channels (notification-channels.tf)
 *
 * Why log-based metric instead of condition_absent?
 *   GCP Cloud Monitoring caps condition_absent.duration at 23h30m.
 *   An 8-day weekly probe requires a much longer window. Log-based
 *   condition_threshold (count > 0) has no such limitation.
 *
 * See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md
 *      § "Forward-looking guards" item 3
 */

# Count occurrences of the probe_missed sentinel log entry emitted by the
# canary-watchdog runner (src/runners/watchdog-runner.ts).
resource "google_logging_metric" "probe_missed" {
  name    = "canary/probe_missed"
  project = var.project_id

  # Filter: Cloud Run Job "canary-watchdog" + jsonPayload.event == "probe_missed"
  filter = join(" AND ", [
    "resource.type=\"cloud_run_job\"",
    "resource.labels.job_name=\"${google_cloud_run_v2_job.canary_watchdog.name}\"",
    "jsonPayload.event=\"probe_missed\"",
  ])

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    display_name = "Canary probe missed (8-day silence)"
    unit         = "1"
  }
}

# Alert when probe_missed count > 0 in any 1-day window.
# A count > 0 means the watchdog ran AND found no probe artifacts.
resource "google_monitoring_alert_policy" "probe_missed_alert" {
  display_name = "Gloo AI Canary — probe job silent for 8+ days"
  project      = var.project_id
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "probe_missed log entry detected by watchdog"

    condition_threshold {
      # Log-based metrics live under logging.googleapis.com/user/<name>
      filter = join(" AND ", [
        "resource.type=\"global\"",
        "metric.type=\"logging.googleapis.com/user/${google_logging_metric.probe_missed.name}\"",
      ])

      # Fire when count > 0 in the alignment window (at least one probe_missed logged)
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s" # fire immediately when threshold is crossed

      aggregations {
        alignment_period     = "86400s" # 1-day window — watchdog fires once/week
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  # Populated by notification-channels.tf → local.all_notification_channels.
  # Includes the email channel (when probe_alert_email is set) plus any
  # manually specified channels via var.alert_notification_channels.
  notification_channels = local.all_notification_channels

  alert_strategy {
    # Auto-close after 2 days if the incident goes un-acknowledged and the
    # probe resumes — prevents stale open incidents.
    auto_close = "172800s" # 2 days
  }

  documentation {
    content   = <<-EOT
      The canary-watchdog job detected that canary-probe has not written any
      GCS artifacts in the last 8 days.

      This alert fires from a log-based metric on the canary-watchdog Cloud Run
      Job (Wednesday 06:00 CT). The watchdog also posts directly to Slack.

      Possible causes:
        1. Cloud Scheduler misfired — check: Cloud Scheduler → canary-probe-weekly → execution history
        2. Cloud Run Job exhausted retry budget — check: Cloud Run → Jobs → canary-probe
        3. Canary image crash-looping before writing GCS artifact

      Recovery steps:
        a. Cloud Scheduler → canary-probe-weekly → Force run to test manually.
        b. Review Cloud Run Job logs for the most recent execution.
        c. If the image is broken: terraform apply -var image_tag=<previous-tag>

      See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md
    EOT
    mime_type = "text/markdown"
  }
}
