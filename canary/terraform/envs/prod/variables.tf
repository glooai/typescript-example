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
  # AI token spend. The weekly digest fires at 06:05 CT on the same Monday.
  default = "0 6 * * 1"
}

variable "digest_schedule_cron" {
  description = "Digest-job cron expression (America/Chicago timezone)."
  type        = string
  # 06:05 CT Monday — 5 minutes after the 06:00 probe so the digest sees fresh data
  default = "5 6 * * 1"
}

variable "schedule_timezone" {
  description = "IANA timezone for the scheduler cron entries."
  type        = string
  default     = "America/Chicago"
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
