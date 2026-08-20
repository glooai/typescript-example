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

output "api_origin_url" {
  description = "Origin hostname the API is served on. Only reachable usefully through CloudFront, which adds the origin header."
  value       = "https://${var.origin_domain_name}"
}

output "ecr_repository_url" {
  description = "ECR repository the API image is pushed to on deploy"
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  description = "Existing cluster the API service runs on (read, not managed, by this stack)"
  value       = data.aws_ecs_cluster.genesis.cluster_name
}

output "ecs_service_name" {
  description = "API service, redeployed by deploy.sh after an image push"
  value       = aws_ecs_service.api.name
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
  description = "Shared header value CloudFront sends to the API. Needed for local dev against the deployed API."
  value       = random_password.origin_secret.result
  sensitive   = true
}
