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

provider "aws" {
  region  = var.region
  profile = var.aws_profile
}

# servant.run's Route53 hosted zone lives in a separate AWS account
# (dns_aws_profile) from everything else in this stack (aws_profile). Only
# the zone lookup and the records that write into it use this provider.
provider "aws" {
  alias   = "dns"
  region  = var.region
  profile = var.dns_aws_profile
}
