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
  # 06:00, 10:00, 14:00, 18:00, 22:00, 02:00 CT — every 4h starting 6am
  default = "0 6,10,14,18,22,2 * * *"
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
