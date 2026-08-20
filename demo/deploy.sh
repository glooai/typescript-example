#!/usr/bin/env bash
#
# Publish both halves of the demo: the SPA to S3, and the API container image
# to ECR followed by a rolling ECS deployment.
#
# Infrastructure changes still go through `terraform apply` in demo/terraform.
# This script only pushes content and images, and is safe to re-run on every
# frontend or backend change.
set -euo pipefail

cd "$(dirname "$0")"

profile="${AWS_PROFILE:-servant-internal}"
region="${AWS_REGION:-us-east-1}"

bucket=$(terraform -chdir=terraform output -raw bucket_name)
distribution_id=$(terraform -chdir=terraform output -raw cloudfront_distribution_id)
repository=$(terraform -chdir=terraform output -raw ecr_repository_url)
cluster=$(terraform -chdir=terraform output -raw ecs_cluster_name)
service=$(terraform -chdir=terraform output -raw ecs_service_name)

# ---------------------------------------------------------------- API image

# The task definition runs `:latest`, so a deploy is a push plus a forced
# redeployment rather than a Terraform apply. The commit tag is pushed
# alongside it so a running task can be traced back to a commit and so a
# rollback has something to point `image_tag` at.
tag=$(git rev-parse --short HEAD)

aws ecr get-login-password --profile "$profile" --region "$region" |
  docker login --username AWS --password-stdin "${repository%%/*}"

# ARM64 to match the Fargate runtime platform in the task definition. buildx
# handles the cross-build when this runs on an x86 machine.
docker buildx build \
  --platform linux/arm64 \
  --tag "${repository}:${tag}" \
  --tag "${repository}:latest" \
  --push \
  api

aws ecs update-service \
  --profile "$profile" \
  --region "$region" \
  --cluster "$cluster" \
  --service "$service" \
  --force-new-deployment \
  --no-cli-pager \
  --query 'service.deployments[0].{status:status,desired:desiredCount}'

# ------------------------------------------------------------------ SPA

pnpm --filter @glooai/demo-web build

# Hashed assets are immutable; index.html and robots.txt must not be cached
# long or a deploy takes an hour to become visible.
aws s3 sync web/dist/ "s3://${bucket}" \
  --profile "$profile" \
  --delete \
  --exclude "index.html" \
  --exclude "robots.txt" \
  --cache-control "public, max-age=31536000, immutable"

aws s3 sync web/dist/ "s3://${bucket}" \
  --profile "$profile" \
  --exclude "*" \
  --include "index.html" \
  --include "robots.txt" \
  --cache-control "no-cache"

aws cloudfront create-invalidation \
  --profile "$profile" \
  --distribution-id "$distribution_id" \
  --paths "/*"

echo
echo "Pushed ${repository}:${tag}"
echo "Watch the rollout:"
echo "  aws ecs wait services-stable --profile ${profile} --cluster ${cluster} --services ${service}"
