variable "project_id" {
  description = "GCP project ID where the canary runs."
  type        = string
  default     = "glooai"
}

variable "region" {
  description = "Region for Cloud Run + Artifact Registry."
  type        = string
  default     = "us-central1"
}

variable "image_tag" {
  description = "Docker image tag to deploy. Set by CI after pushing a build."
  type        = string
  default     = "latest"
}

variable "results_bucket_name" {
  description = "GCS bucket for canary result archival."
  type        = string
  default     = "glooai-canary-results"
}

variable "results_retention_days" {
  description = "How long to keep raw result archives before GCS auto-prunes."
  type        = number
  default     = 90
}

variable "probe_schedule_cron" {
  description = "Probe-job cron expression (America/Chicago timezone)."
  type        = string
  # Once weekly on Monday at 06:00 CT. Down from daily to minimize Cloud Run +
  # AI token spend. The weekly digest fires at 06:15 CT on the same Monday.
  default = "0 6 * * 1"
}

variable "digest_schedule_cron" {
  description = "Digest-job cron expression (America/Chicago timezone)."
  type        = string
  # 06:15 CT Monday — 15 minutes after the 06:00 probe. A full sweep with
  # direct-model + family + routing probes takes up to ~10 min end-to-end
  # (OAuth → per-probe HTTP → GCS write). The previous 5-min gap was too
  # tight: the digest's loadWindow query fired before the probe's GCS write
  # completed, surfacing 0 artifacts and posting a misleading "no probes
  # registered" digest. 15 min gives the probe a comfortable margin.
  default = "15 6 * * 1"
}

variable "ingestion_schedule_cron" {
  description = "Ingestion-canary cron expression (America/Chicago timezone)."
  type        = string
  # Every 6 hours — the Platform Health project promises ingestion status
  # "multiple times per day". Unlike the inference probes (dialed to weekly
  # for AI token spend), an ingestion run costs no completion tokens — just
  # one tiny file through the pipeline — so a 4x/day cadence is cheap.
  default = "30 */6 * * *"
}

variable "ingestion_publisher_id" {
  description = <<-EOT
    Dedicated canary publisher for the ingestion E2E probe. Must belong to
    the canary OAuth client's organization, and that org must hold the
    `ingestion_access` entitlement. Leave empty until provisioned — the
    ingestion job then exits non-zero at config load (a loud failure in
    Cloud Run logs) rather than probing the wrong publisher.
  EOT
  type        = string
  default     = ""
}

variable "schedule_timezone" {
  description = "IANA timezone for the scheduler cron entries."
  type        = string
  default     = "America/Chicago"
}

variable "alert_notification_channels" {
  description = <<-EOT
    List of Cloud Monitoring notification channel resource names to receive
    probe-silence alerts. Accepts full resource name strings of the form:
      projects/<project>/notificationChannels/<id>

    Default is empty (alert policy is created but sends no notifications).
    Populate this in a .tfvars file or CI pipeline to wire up email / PD:
      alert_notification_channels = [
        "projects/glooai/notificationChannels/1234567890"
      ]
  EOT
  type        = list(string)
  default     = []
}

variable "full_sweep_interval_ms" {
  description = <<-EOT
    How long a Full tier sweep stays "fresh" before the probe runner
    demands another one regardless of health. With probes running once
    weekly, a value of 3600000 (1h) ensures every probe triggers a Full
    sweep (168h interval > 1h freshness threshold), giving complete model
    coverage on each run. Raise to reduce per-run inference spend at the
    cost of some runs being Light-tier only; lower toward 0 to always
    force Full regardless of interval.
  EOT
  type        = number
  default     = 3600000 # 1 hour — every weekly probe triggers a Full sweep
}
