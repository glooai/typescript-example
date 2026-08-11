terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# The servant.run hosted zone, the ACM certificate CloudFront needs, and the
# Lambda all live in the same account and region. There is no cross-account
# DNS delegation to work around.
provider "aws" {
  region  = var.region
  profile = var.aws_profile
}
