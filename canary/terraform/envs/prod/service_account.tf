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

# Grant the GitHub Actions deployer SA the Cloud Monitoring AlertPolicy editor
# role so `terraform apply` can create/update/delete the probe-silence alert
# policy defined in monitoring.tf.
#
# The deployer SA email is stable (set once at GCP bootstrap); hardcoding it
# here avoids a circular variable dependency between this binding and the
# Workload Identity configuration that lives outside Terraform.
resource "google_project_iam_member" "deployer_monitoring_editor" {
  project = var.project_id
  role    = "roles/monitoring.alertPolicyEditor"
  member  = "serviceAccount:github-actions-canary-deploy@${var.project_id}.iam.gserviceaccount.com"
}
