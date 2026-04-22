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

variable "probe_daytime_schedule_cron" {
  description = "Probe-job daytime cron expression (America/Chicago timezone)."
  type        = string
  # Every 15 minutes from 06:00 through 16:45 CT (11h daytime window,
  # 44 runs/day). 17:00 is handed off to the nighttime hourly job.
  default = "*/15 6-16 * * *"
}

variable "probe_nighttime_schedule_cron" {
  description = "Probe-job nighttime cron expression (America/Chicago timezone)."
  type        = string
  # Top-of-hour from 17:00 CT through 05:00 CT (13h nighttime window,
  # 13 runs/day). 06:00 is handed back to the daytime 15-minute job.
  default = "0 17-23,0-5 * * *"
}

variable "digest_schedule_cron" {
  description = "Digest-job cron expression (America/Chicago timezone)."
  type        = string
  # 06:05 CT — 5 minutes after the first probe of the day so it sees fresh data
  default = "5 6 * * *"
}

variable "schedule_timezone" {
  description = "IANA timezone for the scheduler cron entries."
  type        = string
  default     = "America/Chicago"
}
