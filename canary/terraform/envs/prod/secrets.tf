/**
 * Secret Manager entries for the canary. Values are populated out-of-band
 * via `gcloud secrets versions add` — Terraform manages the secret metadata
 * + IAM, not the payloads. This keeps secret rotation independent of code
 * deploys and keeps raw values out of tfstate.
 */

locals {
  secrets = {
    "gloo-ai-canary-client-id"     = "Dedicated Gloo AI canary OAuth client_id."
    "gloo-ai-canary-client-secret" = "Dedicated Gloo AI canary OAuth client_secret."
    "alerts-slack-bot-token"       = "Slack xoxb- bot token for posting alerts."
    "alerts-slack-channel-id"      = "Target Slack channel ID (e.g. C0AU2FM2Q86)."
  }
}

resource "google_secret_manager_secret" "canary" {
  for_each  = local.secrets
  project   = var.project_id
  secret_id = each.key

  labels = {
    managed_by = "terraform"
    component  = "canary"
  }

  replication {
    auto {}
  }
}

# Allow the canary runtime SA to read each secret's value.
resource "google_secret_manager_secret_iam_member" "canary_runner_accessor" {
  for_each  = google_secret_manager_secret.canary
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.canary_runner.email}"
}
