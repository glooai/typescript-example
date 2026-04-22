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
├── scheduler.tf            # 3 cron entries (America/Chicago timezone)
│                            #   - probe daytime   (*/15 06:00–16:45 CT)
│                            #   - probe nighttime (hourly 17:00–05:00 CT)
│                            #   - digest          (daily 06:05 CT)
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

At 57 probe runs + 1 digest run/day × ~60s each (1 vCPU / 512 MiB),
expected monthly cost is roughly **$6–14**:

- Cloud Run Jobs: ~3,500 req-sec/day stays inside the monthly free
  tier (240k vCPU-sec + 450k GiB-sec); overage is billed at
  $0.000024/vCPU-sec + $0.0000025/GiB-sec
- Cloud Scheduler: 3 jobs (daytime probe, nighttime probe, digest) —
  exactly at the free-tier ceiling
- Secret Manager: $0.06 per 10k accesses (~$0.10/month at 57 runs/day
  × 4 secrets)
- GCS Standard storage: ~$0.02/GB-month (the 90-day lifecycle rule
  keeps the bucket well under 1 GB even at 57 runs/day, since each
  archive is gzipped JSON ~10 KB)
- Artifact Registry: $0.10/GB-month for image storage

Optimisation choices baked into the terraform:

- Two scheduler jobs (daytime + nighttime) instead of one
  minute-level cron fired 1,440×/day and gated in-code — ~25× fewer
  Cloud Run invocations during the quiet window
- `retry_count = 0` on the probe scheduler — probes are idempotent
  and the next scheduled run is the real retry path, so paying for a
  scheduler retry is double-billing
- GCS objects are gzipped JSON (~70–80% compression over raw), which
  keeps storage + egress minimal over the full 90-day window
