/**
 * Cloud Monitoring alerting policy — canary probe execution silence watchdog.
 *
 * Fires when no successful probe execution has been recorded for the
 * canary-probe Cloud Run Job in the last 8 days (one full weekly window
 * plus a 24h grace period). This catches:
 *   - Cloud Scheduler misconfiguration (e.g. cron expression wiped by TF drift)
 *   - Cloud Run Job execution errors that exhaust all retries
 *   - A mis-deployed image that crashes before writing any GCS artifacts
 *
 * Notification channels are injected via var.alert_notification_channels.
 * Default is an empty list (no notifications), which still creates the
 * alerting policy so it can be wired up from the GCP Console or by
 * populating the variable in a .tfvars file.
 *
 * To add an email channel:
 *   alert_notification_channels = [
 *     google_monitoring_notification_channel.ops_email.name
 *   ]
 *
 * Metric used:
 *   run.googleapis.com/job/completed_execution_count
 *   Filtered to job_name="canary-probe" to avoid false alerts from
 *   the digest job's own execution cadence.
 *
 * References:
 *   RCA 2026-05-11 — canary/context/adrs/2026-05-11-digest-race-condition-rca.md
 *   § "Forward-looking guards" item 3
 */

resource "google_monitoring_alert_policy" "probe_execution_silence" {
  display_name = "Gloo AI Canary — probe job silent for > 8 days"
  project      = var.project_id
  combiner     = "OR"
  enabled      = true

  # Ensure the deployer SA has roles/monitoring.alertPolicyEditor before this
  # resource is created. Without depends_on, Terraform may attempt the API call
  # concurrently with the IAM grant, racing the GCP IAM propagation window.
  depends_on = [google_project_iam_member.deployer_monitoring_editor]

  conditions {
    display_name = "No canary-probe execution recorded in the last 8 days"

    condition_absent {
      # Alert when the probe job has not reported ANY execution (success or
      # failure) in the last 8 days. We intentionally do not filter by
      # result="succeeded" — a consistent failure streak also pages because
      # it means the canary is broken, just noisily rather than silently.
      filter   = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${google_cloud_run_v2_job.canary_probe.name}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\""
      duration = "691200s" # 8 days = 8 × 86400s

      aggregations {
        # Aggregate over 1-day windows. A weekly job produces exactly one
        # data point per window; aligning by day gives the absence detector
        # a clean signal to compare against the 8-day threshold.
        alignment_period     = "86400s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.job_name"]
      }
    }
  }

  notification_channels = var.alert_notification_channels

  alert_strategy {
    # Auto-close the incident after 20 days if the probe resumes and no
    # human acknowledged the alert — prevents stale open incidents.
    auto_close = "1728000s" # 20 days
  }

  documentation {
    content   = <<-EOT
      The canary-probe Cloud Run Job has not recorded any execution in the
      last 8 days. This may mean:

      1. Cloud Scheduler misfired or the scheduler job was misconfigured
         (check: Cloud Scheduler → canary-probe-weekly → execution history).
      2. The Cloud Run Job failed on every retry and exhausted its retry
         budget (check: Cloud Run → Jobs → canary-probe → execution history).
      3. The canary image was replaced with a build that crashes on startup
         before writing its GCS artifact.

      Recovery steps:
        a. Cloud Scheduler → canary-probe-weekly → Force run to test manually.
        b. Review Cloud Run Job logs for the most recent execution.
        c. If the image is broken, roll back via: terraform apply -var image_tag=<previous-tag>

      See: canary/.context/adrs/2026-05-11-digest-race-condition-rca.md
    EOT
    mime_type = "text/markdown"
  }
}
