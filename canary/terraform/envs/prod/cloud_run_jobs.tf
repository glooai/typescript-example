/**
 * Two Cloud Run Jobs sharing one Docker image. CANARY_MODE picks the
 * entry point at runtime (probe vs digest).
 */

locals {
  # Common env vars + secret mounts shared by both jobs.
  shared_env = [
    {
      name  = "CANARY_RESULTS_BUCKET"
      value = google_storage_bucket.canary_results.name
    },
    {
      # Consumed by runners/tier-decision.ts. Controls the
      # Light→Full escalation cadence in the healthy steady state.
      name  = "CANARY_FULL_SWEEP_INTERVAL_MS"
      value = tostring(var.full_sweep_interval_ms)
    },
  ]
  shared_secrets = [
    {
      env_name   = "GLOO_AI_CLIENT_ID"
      secret_key = "gloo-ai-canary-client-id"
    },
    {
      env_name   = "GLOO_AI_CLIENT_SECRET"
      secret_key = "gloo-ai-canary-client-secret"
    },
    {
      env_name   = "ALERTS_SLACK_BOT_TOKEN"
      secret_key = "alerts-slack-bot-token"
    },
    {
      env_name   = "ALERTS_SLACK_CHANNEL_ID"
      secret_key = "alerts-slack-channel-id"
    },
  ]
}

resource "google_cloud_run_v2_job" "canary_probe" {
  name                = "canary-probe"
  location            = var.region
  project             = var.project_id
  deletion_protection = false

  template {

    template {
      service_account = google_service_account.canary_runner.email
      timeout         = "600s"
      max_retries     = 1

      containers {
        image = local.image_uri

        env {
          name  = "CANARY_MODE"
          value = "probe"
        }

        dynamic "env" {
          for_each = local.shared_env
          content {
            name  = env.value.name
            value = env.value.value
          }
        }

        dynamic "env" {
          for_each = local.shared_secrets
          content {
            name = env.value.env_name
            value_source {
              secret_key_ref {
                secret  = env.value.secret_key
                version = "latest"
              }
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.canary_runner_accessor,
    google_storage_bucket_iam_member.canary_runner_object_admin,
  ]
}

resource "google_cloud_run_v2_job" "canary_digest" {
  name                = "canary-digest"
  location            = var.region
  project             = var.project_id
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.canary_runner.email
      timeout         = "600s"
      max_retries     = 1

      containers {
        image = local.image_uri

        env {
          name  = "CANARY_MODE"
          value = "digest"
        }

        dynamic "env" {
          for_each = local.shared_env
          content {
            name  = env.value.name
            value = env.value.value
          }
        }

        dynamic "env" {
          for_each = local.shared_secrets
          content {
            name = env.value.env_name
            value_source {
              secret_key_ref {
                secret  = env.value.secret_key
                version = "latest"
              }
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.canary_runner_accessor,
    google_storage_bucket_iam_member.canary_runner_object_admin,
  ]
}
