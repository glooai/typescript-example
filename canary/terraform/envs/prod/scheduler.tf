/**
 * Cloud Scheduler jobs that fire the Cloud Run Jobs on the cron windows:
 *   - probe     — once weekly on Monday at 06:00 CT
 *   - digest    — weekly on Monday at 06:15 CT (15 min after the probe, see variables.tf)
 *   - ingestion — every 6 hours (no AI token spend; see variables.tf)
 *
 * Probe/digest were reduced from daily to weekly to minimize Cloud Run + AI
 * token spend. With full_sweep_interval_ms=3600000 (1h) and a 168h probe
 * cadence, every run triggers a Full sweep — all routing modes and direct
 * models exercised.
 *
 * Three scheduler jobs exactly fill the Cloud Scheduler free tier
 * (3 jobs/account/month).
 *
 * Authentication: Scheduler uses its own service account with
 * `roles/run.invoker` scoped just to the target job.
 */

resource "google_service_account" "scheduler_invoker" {
  account_id   = "canary-scheduler"
  display_name = "Gloo AI Canary — Cloud Scheduler invoker"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_probe" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.canary_probe.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_digest" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.canary_digest.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "canary_probe" {
  name        = "canary-probe-weekly"
  description = "Fire canary-probe Cloud Run Job once weekly on Monday at 06:00 CT."
  project     = var.project_id
  region      = var.region
  schedule    = var.probe_schedule_cron
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_probe.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  # retry_count = 3 — with a weekly cadence a transient invocation failure would
  # otherwise go undetected until next Monday. Three retries give the job
  # a fighting chance through brief GCP hiccups without burning budget.
  retry_config {
    retry_count = 3
  }
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_ingestion" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.canary_ingestion.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "canary_ingestion" {
  name        = "canary-ingestion-6h"
  description = "Fire canary-ingestion Cloud Run Job every 6 hours."
  project     = var.project_id
  region      = var.region
  schedule    = var.ingestion_schedule_cron
  time_zone   = var.schedule_timezone
  # Ships paused until the dedicated canary publisher is provisioned —
  # otherwise every tick would burn a doomed Cloud Run execution that
  # fails at config load. Setting ingestion_publisher_id un-pauses it
  # on the next apply.
  paused = var.ingestion_publisher_id == ""

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_ingestion.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  # A missed tick self-heals in 6 hours; one retry covers brief GCP
  # invocation hiccups without re-running the whole pipeline journey
  # multiple times back-to-back.
  retry_config {
    retry_count = 1
  }
}

resource "google_cloud_scheduler_job" "canary_digest" {
  name        = "canary-digest-weekly"
  description = "Fire canary-digest Cloud Run Job weekly on Monday at 06:05 CT."
  project     = var.project_id
  region      = var.region
  schedule    = var.digest_schedule_cron
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_digest.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  retry_config {
    retry_count = 1
  }
}
