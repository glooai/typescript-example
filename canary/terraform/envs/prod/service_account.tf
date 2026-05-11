resource "google_service_account" "canary_runner" {
  account_id   = "canary-runner"
  display_name = "Gloo AI Canary — Cloud Run Job runtime identity"
  project      = var.project_id
}

# Logging (structured logs → Cloud Logging)
resource "google_project_iam_member" "canary_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.canary_runner.email}"
}

# Required for Cloud Run Job execution to read its own runtime identity.
# `roles/run.invoker` goes on Cloud Scheduler's SA, not this one — see scheduler.tf.
