# Proxy Lambda behind a Function URL.
#
# The function holds the Gloo API key and does every upstream call, so the
# static frontend ships no credentials. Invoke mode is RESPONSE_STREAM so
# `/api/chat` can stream tokens; the comparison endpoint buffers, which is
# what its side by side view needs anyway.
#
# The Function URL auth type is NONE rather than AWS_IAM with a CloudFront
# origin access control. OAC signs requests with SigV4, and SigV4 over a
# request body requires the caller to supply a payload hash, which CloudFront
# cannot compute for a POST body. Every route here is a POST or a body-less
# GET, so an OAC setup would break the chat endpoint. Instead CloudFront
# injects a shared header on every origin request and the function rejects
# anything without it.

data "archive_file" "api" {
  type        = "zip"
  source_dir  = var.lambda_bundle_path
  output_path = "${path.module}/.terraform-artifacts/api.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
}

# Least privilege: write its own logs, read one secret, and touch one table
# with the three actions it actually issues. No wildcards on resources, and
# no Scan.
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    sid       = "ReadGlooApiKey"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.gloo_api_key.arn]
  }

  statement {
    sid    = "UseDemoTable"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.demo.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.name_prefix}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name_prefix}-api"
  role             = aws_iam_role.api.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  # Upstream completions are capped at 60s in the handler; the extra headroom
  # covers cold start plus the DynamoDB writes that follow the last token.
  timeout     = 90
  memory_size = 512

  environment {
    variables = {
      DEMO_TABLE_NAME        = aws_dynamodb_table.demo.name
      GLOO_API_KEY_SECRET_ID = aws_secretsmanager_secret.gloo_api_key.arn
      ORIGIN_SECRET          = random_password.origin_secret.result
    }
  }

  depends_on = [
    aws_iam_role_policy.api,
    aws_cloudwatch_log_group.api,
  ]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}
