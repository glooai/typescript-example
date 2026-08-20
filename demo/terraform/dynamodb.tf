# One table, pay-per-request, TTL driven expiry.
#
# Pay-per-request because demo traffic is bursty and mostly zero, and because
# it removes capacity planning from a proof of concept entirely. DynamoDB
# rather than a relational database specifically because this is fronted by
# Lambda: there is no connection pool to exhaust and no migration step to run
# before a deploy.
#
# Two entity types share the table, both keyed on pk/sk (see
# demo/api/src/ledger.ts for the full key design):
#
#   LEDGER#<date>   one row per proxied Gloo call. Justification: the demo's
#                   cost and latency view is only interesting if it reports
#                   what actually happened, so every call's routing decision,
#                   resolved model, token counts, latency, and derived cost
#                   are persisted and read back.
#
#   SESSION#<id>    one row per chat message. Justification: a demo
#                   conversation surviving a page refresh is the difference
#                   between a toy and something a viewer can walk away from
#                   and come back to.
#
# No secondary indexes: every read is a Query on a known partition key.

resource "aws_dynamodb_table" "demo" {
  name         = "${local.name_prefix}-demo"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Demo data expires on its own rather than needing a cleanup job. The
  # per-item values are set by the Lambda: 7 days for ledger rows, 12 hours
  # for conversations.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }
}
