/**
 * Cloud Scheduler jobs that fire the Cloud Run Jobs on the cron windows:
 *   - probe    — once weekly on Monday at 06:00 CT
 *   - digest   — weekly on Monday at 06:15 CT (15 min after the probe, see variables.tf)
 *   - watchdog — weekly on Wednesday at 06:00 CT (48h after the probe window)
 *
 * Reduced from daily to weekly to minimize Cloud Run + AI token spend.
 * With full_sweep_interval_ms=3600000 (1h) and a 168h probe cadence, every
 * run triggers a Full sweep — all routing modes and direct models exercised.
 *
 * NOTE: Cloud Scheduler free tier allows 3 jobs/account/month. With probe +
 * digest + watchdog we are at the limit. Any additional jobs will require
 * upgrading to a paid tier (~$0.10/job/month beyond the first 3).
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

# IAM: scheduler invoker → watchdog job
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke_watchdog" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.canary_watchdog.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "canary_watchdog" {
  name        = "canary-watchdog-weekly"
  description = "Fire canary-watchdog Cloud Run Job weekly on Wednesday at 06:00 CT (48h after probe)."
  project     = var.project_id
  region      = var.region
  schedule    = var.watchdog_schedule_cron
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.canary_watchdog.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  retry_config {
    retry_count = 1
  }
}
