/**
 * Three Cloud Run Jobs sharing one Docker image. CANARY_MODE picks the
 * entry point at runtime (probe vs digest vs ingestion).
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

        # Better Stack heartbeat for the Inference status-page component.
        # Gated — see var.heartbeats_enabled for why.
        dynamic "env" {
          for_each = var.heartbeats_enabled ? [true] : []
          content {
            name = "CANARY_HEARTBEAT_URL"
            value_source {
              secret_key_ref {
                secret  = "canary-heartbeat-url-probe"
                version = "latest"
              }
            }
          }
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

resource "google_cloud_run_v2_job" "canary_ingestion" {
  name                = "canary-ingestion"
  location            = var.region
  project             = var.project_id
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.canary_runner.email
      # The probe polls the pipeline for up to CANARY_INGESTION_SLA_MS
      # (default 10 min) before declaring SLA_EXCEEDED, plus submit
      # retries + verification + cleanup — give the job comfortable
      # headroom over the SLA budget.
      timeout     = "900s"
      max_retries = 1

      containers {
        image = local.image_uri

        env {
          name  = "CANARY_MODE"
          value = "ingestion"
        }

        env {
          # Dedicated canary publisher (owned by the canary client's
          # org, which must hold the `ingestion_access` entitlement).
          # Until this is provisioned and set, the job fails fast at
          # config load — see variables.tf.
          name  = "CANARY_INGESTION_PUBLISHER_ID"
          value = var.ingestion_publisher_id
        }

        # Better Stack heartbeat for the Data Engine / Ingestion
        # status-page component. Gated — see var.heartbeats_enabled.
        dynamic "env" {
          for_each = var.heartbeats_enabled ? [true] : []
          content {
            name = "CANARY_HEARTBEAT_URL"
            value_source {
              secret_key_ref {
                secret  = "canary-heartbeat-url-ingestion"
                version = "latest"
              }
            }
          }
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
