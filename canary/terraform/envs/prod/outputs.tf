output "canary_runner_service_account" {
  description = "Runtime identity for both Cloud Run jobs."
  value       = google_service_account.canary_runner.email
}

output "scheduler_invoker_service_account" {
  description = "Identity used by Cloud Scheduler to invoke the jobs."
  value       = google_service_account.scheduler_invoker.email
}

output "image_uri" {
  description = "Docker image URI the jobs deploy. Push builds here via CI."
  value       = local.image_uri
}

output "artifact_registry_repo" {
  description = "Artifact Registry repository ID for canary images."
  value       = google_artifact_registry_repository.canary.repository_id
}

output "results_bucket" {
  description = "GCS bucket where run artifacts + state live."
  value       = google_storage_bucket.canary_results.name
}

output "secret_names" {
  description = "Secret Manager secret IDs that must be populated before jobs can run."
  value       = [for s in google_secret_manager_secret.canary : s.secret_id]
}
