/**
 * Cloud Scheduler jobs that fire the Cloud Run Jobs on the cron windows
 * Patrick specified:
 *   - probe (daytime)   — every 15 min 06:00–16:45 CT → 44 runs/day
 *   - probe (nighttime) — top-of-hour 17:00–05:00 CT  → 13 runs/day
 *   - digest            — daily at 06:05 CT (right after the first daytime
 *                         probe, so the 24h digest sees fresh data)
 *
 * Two scheduler jobs (daytime + nighttime) are cheaper than a minute-level
 * cron fired 1,440 times/day and gated in-code, and still stay within the
 * Cloud Scheduler free tier (3 jobs/account/month) alongside the digest.
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

resource "google_cloud_scheduler_job" "canary_probe_daytime" {
  name        = "canary-probe-daytime-15m"
  description = "Fire canary-probe Cloud Run Job every 15 min from 06:00–16:45 CT."
  project     = var.project_id
  region      = var.region
  schedule    = var.probe_daytime_schedule_cron
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_probe.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  # retry_count = 0 keeps invocations minimal — the probe itself tolerates
  # transient failures via in-process per-probe try/catch, and the next
  # scheduled run (15 min out in daytime, 1h in nighttime) is our real
  # retry. Paying for retries on top of that is double-billing.
  retry_config {
    retry_count = 0
  }
}

resource "google_cloud_scheduler_job" "canary_probe_nighttime" {
  name        = "canary-probe-nighttime-1h"
  description = "Fire canary-probe Cloud Run Job hourly from 17:00–05:00 CT."
  project     = var.project_id
  region      = var.region
  schedule    = var.probe_nighttime_schedule_cron
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_probe.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  retry_config {
    retry_count = 0
  }
}

resource "google_cloud_scheduler_job" "canary_digest" {
  name        = "canary-digest-daily"
  description = "Fire canary-digest Cloud Run Job daily at 06:05 CT."
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
