output "site_url" {
  description = "Public URL of the demo (Basic Auth: gloo / ai)"
  value       = "https://${var.domain_name}"
}

output "bucket_name" {
  description = "S3 bucket holding the built SPA"
  value       = aws_s3_bucket.site.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id, used for cache invalidation on deploy"
  value       = aws_cloudfront_distribution.site.id
}

output "lambda_function_url" {
  description = "Lambda Function URL. Only reachable usefully through CloudFront, which adds the origin header."
  value       = aws_lambda_function_url.api.function_url
}

output "dynamodb_table_name" {
  description = "Single demo table (ledger rows and saved conversations)"
  value       = aws_dynamodb_table.demo.name
}

output "gloo_api_key_secret_id" {
  description = "Secrets Manager secret to populate with the Gloo API key before first use"
  value       = aws_secretsmanager_secret.gloo_api_key.name
}

output "origin_secret" {
  description = "Shared header value CloudFront sends to the Lambda. Needed for local dev against the deployed API."
  value       = random_password.origin_secret.result
  sensitive   = true
}
