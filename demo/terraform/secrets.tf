# The Gloo API key.
#
# Terraform creates the container but never the value: there is no
# `aws_secretsmanager_secret_version` here and no Terraform variable holding
# the key, so the credential never lands in the state file or in a plan. A
# human populates it once after the first apply:
#
#   aws secretsmanager put-secret-value \
#     --profile servant-internal \
#     --secret-id <this secret's name> \
#     --secret-string 'gloo-api-key-value'
#
# The Lambda reads it at cold start with GetSecretValue, scoped to this ARN
# alone.

resource "aws_secretsmanager_secret" "gloo_api_key" {
  name        = "${local.name_prefix}/gloo-ai-api-key"
  description = "Gloo AI WorkOS API key used by the ${var.domain_name} demo proxy"

  # Demo infrastructure should be destroyable and re-creatable the same day.
  recovery_window_in_days = 0
}

# Shared value CloudFront attaches to every origin request so the Lambda can
# reject traffic that did not come through the distribution. This is not a
# user credential and gates no data, only inference spend, so keeping it in
# Terraform state (which is local and gitignored) is an acceptable trade
# against the Gloo key, which is not in state at all.
resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

# Salt for the client IP hash the proxy writes onto ledger rows. The demo
# stores a salted, truncated hash rather than the address itself: correlating
# calls from one client and spotting one client hammering the demo both work
# off a hash, and nothing here needs to recover an address. One value per
# deployment means the hashes are not reversible with a precomputed table and
# do not correlate across a rebuild.
resource "random_password" "visitor_salt" {
  length  = 48
  special = false
}
