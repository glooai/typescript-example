/**
 * Cloud Monitoring notification channels for the probe-silence alert.
 *
 * Which alert does this feed?
 *   google_monitoring_alert_policy.probe_missed_alert  (monitoring.tf)
 *   Fires when: canary-watchdog logs event="probe_missed"
 *   Meaning: the probe did NOT run at all in the last 8 days
 *   Schedule: evaluated every Wednesday at ~06:00 CT
 *
 * Primary alert path (already wired):
 *   The canary-watchdog runner posts directly to the Slack channel configured
 *   via ALERTS_SLACK_BOT_TOKEN + ALERTS_SLACK_CHANNEL_ID in Secret Manager.
 *   No Terraform changes needed for the Slack post itself.
 *
 * Secondary alert path (this file):
 *   Cloud Monitoring email notification — redundant backup for cases where
 *   the Slack post fails or the Slack workspace is unreachable.
 *   Configure var.probe_alert_email in notification-channels.auto.tfvars.
 */

resource "google_monitoring_notification_channel" "probe_alerts_email" {
  # Only created when probe_alert_email is set — defaults to not created.
  count = var.probe_alert_email != "" ? 1 : 0

  type         = "email"
  display_name = "Gloo AI Canary — probe silence alerts (email)"
  project      = var.project_id

  labels = {
    email_address = var.probe_alert_email
  }
}

locals {
  # Merge any manually supplied notification channel resource names
  # (var.alert_notification_channels) with the auto-created email channel.
  # This lets you add PagerDuty, Slack-via-GCP-OAuth, etc. to the list
  # without changing this file.
  all_notification_channels = concat(
    var.alert_notification_channels,
    [for ch in google_monitoring_notification_channel.probe_alerts_email : ch.name]
  )
}
