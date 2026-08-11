variable "domain_name" {
  description = "Fully qualified domain name the demo is served at"
  type        = string
  default     = "glooai.servant.run"
}

variable "root_zone_name" {
  description = "Existing Route53 public hosted zone that owns domain_name"
  type        = string
  default     = "servant.run"
}

variable "region" {
  description = "AWS region. Must be us-east-1: CloudFront only accepts ACM certificates issued there."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS profile used for apply"
  type        = string
  default     = "servant-internal"
}

variable "lambda_bundle_path" {
  description = "Directory holding the built Lambda bundle (produced by `pnpm --filter @glooai/demo-api build`)"
  type        = string
  default     = "../api/dist/lambda"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the proxy Lambda. Short: this is a demo, not an audited system."
  type        = number
  default     = 14
}
