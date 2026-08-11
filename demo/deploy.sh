#!/usr/bin/env bash
#
# Publish the built SPA to S3 and invalidate CloudFront.
#
# Infrastructure changes go through `terraform apply` in demo/terraform.
# This script only pushes content, and is safe to re-run on every frontend
# change.
set -euo pipefail

cd "$(dirname "$0")"

profile="${AWS_PROFILE:-servant-internal}"

pnpm --filter @glooai/demo-web build

bucket=$(terraform -chdir=terraform output -raw bucket_name)
distribution_id=$(terraform -chdir=terraform output -raw cloudfront_distribution_id)

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
