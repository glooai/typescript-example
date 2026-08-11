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

variable "dns_aws_profile" {
  description = "Local AWS profile holding the servant.run Route53 hosted zone, a separate account from aws_profile"
  type        = string
  default     = "personal"
}

variable "origin_domain_name" {
  description = "Hostname that resolves to the shared ALB and that CloudFront uses as its /api/* origin. Separate from domain_name, which is an alias for the distribution itself."
  type        = string
  default     = "glooai-origin.servant.run"
}

variable "shared_alb_name" {
  description = "Existing Application Load Balancer to add a listener rule and target group to. Read via a data source; never managed here."
  type        = string
  default     = "genesis"
}

variable "ecs_cluster_name" {
  description = "Existing ECS cluster to run the API service on. Read via a data source; never managed here."
  type        = string
  default     = "genesis"
}

variable "alb_listener_rule_priority" {
  description = "Priority of the host-based rule added to the shared HTTPS listener. Must not collide with a rule another stack owns."
  type        = number
  default     = 100
}

variable "container_port" {
  description = "Port the API container listens on, matching the convention already set on this cluster"
  type        = number
  default     = 5174
}

variable "image_tag" {
  description = "ECR tag the task definition runs. `latest` with deploy.sh forcing a new deployment keeps image pushes out of Terraform; set a digest or an immutable tag to pin one."
  type        = string
  default     = "latest"
}

variable "task_cpu" {
  description = "Fargate task CPU units. The work is one upstream HTTP call per request, so this is the smallest size Fargate offers."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of tasks. One: this is a demo, and a rolling deploy still starts a second task before stopping the first."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch retention for the API service logs. Short: this is a demo, not an audited system."
  type        = number
  default     = 14
}
