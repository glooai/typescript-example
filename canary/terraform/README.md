# Canary — Terraform Infrastructure

Provisions the Cloud Run Jobs + Cloud Scheduler + GCS bucket + Secret Manager
resources that run the Gloo AI canary.

## Layout

```
terraform/envs/prod/
├── backend.tf              # GCS-backed state: gs://glooai-canary-tfstate/envs/prod
├── provider.tf             # google provider pinned to project=glooai
├── variables.tf            # schedule, retention, image tag
├── artifact_registry.tf    # Docker image repo
├── service_account.tf      # canary-runner SA (runtime identity)
├── secrets.tf              # 4 Secret Manager entries (payloads injected OOB)
├── storage.tf              # glooai-canary-results bucket + 90-day lifecycle
├── cloud_run_jobs.tf       # canary-probe + canary-digest
├── scheduler.tf            # 2 cron entries (America/Chicago timezone)
└── outputs.tf              # handy identifiers
```

## First-time bootstrap (manual, one-shot)

Before `terraform apply` can work, two things need to exist that aren't
managed by this stack:

### 1. State bucket

Terraform can't manage its own backend, so create it once by hand:

```bash
gcloud storage buckets create gs://glooai-canary-tfstate \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention
gcloud storage buckets update gs://glooai-canary-tfstate --versioning
```

### 2. Secret payloads

Terraform creates the Secret Manager _entries_, but the _values_ are
injected out-of-band so they never hit Git or tfstate. Do this after the
first `terraform apply` (which creates the empty secrets):

```bash
printf '<real-client-id>'      | gcloud secrets versions add gloo-ai-canary-client-id     --data-file=-
printf '<real-client-secret>'  | gcloud secrets versions add gloo-ai-canary-client-secret --data-file=-
printf '<xoxb-slack-token>'    | gcloud secrets versions add alerts-slack-bot-token       --data-file=-
printf 'C0AU2FM2Q86'           | gcloud secrets versions add alerts-slack-channel-id      --data-file=-
```

## Normal apply flow

```bash
cd canary/terraform/envs/prod
terraform init
terraform plan -var="image_tag=$(git rev-parse --short HEAD)"
terraform apply -var="image_tag=$(git rev-parse --short HEAD)"
```

## Cost ceiling

At 6 probe runs + 1 digest run/day × ~60s each, expected monthly cost is
roughly **$3–8**:

- Cloud Run Jobs: free tier covers >180k req-sec/month
- Cloud Scheduler: free tier covers 3 jobs
- Secret Manager: $0.06 per 10k accesses (<$0.05/month)
- GCS Standard storage: ~$0.02/GB-month (lifecycle keeps us well under 1GB)
- Artifact Registry: $0.10/GB-month for image storage
