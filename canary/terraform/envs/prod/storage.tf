/**
 * GCS bucket for canary result archives. Object lifecycle handles pruning:
 * anything older than `results_retention_days` is auto-deleted by GCS.
 * No explicit pruning code runs — the daily digest just *reports* state.
 */

resource "google_storage_bucket" "canary_results" {
  name                        = var.results_bucket_name
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning { enabled = false }

  public_access_prevention = "enforced"

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.results_retention_days
    }
  }

  labels = {
    managed_by = "terraform"
    component  = "canary"
  }
}

resource "google_storage_bucket_iam_member" "canary_runner_object_admin" {
  bucket = google_storage_bucket.canary_results.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.canary_runner.email}"
}
