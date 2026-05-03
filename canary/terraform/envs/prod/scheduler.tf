/**
 * Cloud Scheduler jobs that fire the Cloud Run Jobs on the cron windows:
 *   - probe  — once daily at 06:00 CT
 *   - digest — daily at 06:05 CT (5 min after the probe so it sees fresh data)
 *
 * Reduced from 4x/day to 1x/day to minimize Cloud Run + AI token spend.
 * With full_sweep_interval_ms=3600000 (1h) and a 24h probe cadence, every
 * run triggers a Full sweep — all routing modes and direct models exercised.
 *
 * Two scheduler jobs stay within the Cloud Scheduler free tier
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
  name        = "canary-probe-daily"
  description = "Fire canary-probe Cloud Run Job once daily at 06:00 CT."
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

  # retry_count = 3 — with a 24h cadence a transient invocation failure would
  # otherwise go undetected until the next day. Three retries give the job
  # a fighting chance through brief GCP hiccups without burning budget.
  retry_config {
    retry_count = 3
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
