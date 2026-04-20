resource "google_artifact_registry_repository" "canary" {
  project       = var.project_id
  location      = var.region
  repository_id = "canary"
  format        = "DOCKER"
  description   = "Container images for the Gloo AI canary Cloud Run jobs."

  labels = {
    managed_by = "terraform"
    component  = "canary"
  }
}

locals {
  image_uri = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.canary.repository_id}/canary:${var.image_tag}"
}
