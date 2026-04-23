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

### 3. GitHub Actions → GCP (Workload Identity Federation)

Required once so `.github/workflows/deploy-canary.yaml` can auth without a
service-account JSON key. Create the pool + provider, a deploy SA, and bind
the WIF principal to that SA:

```bash
PROJECT_ID=glooai
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
REPO="glooai/typescript-example"
SA=github-actions-canary-deploy
SA_EMAIL="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"

# Pool + OIDC provider, constrained to this repo
gcloud iam workload-identity-pools create github-actions \
  --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project="$PROJECT_ID" --location=global \
  --workload-identity-pool=github-actions \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '${REPO}'"

# Deploy SA
gcloud iam service-accounts create "$SA" \
  --project="$PROJECT_ID" --display-name="GitHub Actions — canary deploy"

for ROLE in \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/storage.admin \
  roles/run.admin \
  roles/cloudscheduler.admin \
  roles/secretmanager.admin \
  roles/iam.serviceAccountUser \
  roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$ROLE"
done

# Bind the WIF principal (any workflow in this repo) to the SA
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/${REPO}"
```

Then add these **repository variables** (Settings → Secrets and variables →
Actions → _Variables_ tab — not secrets; they're identifiers, not credentials):

| Variable                         | Value                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`                 | `glooai`                                                                                           |
| `GCP_REGION`                     | `us-central1`                                                                                      |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | `github-actions-canary-deploy@glooai.iam.gserviceaccount.com`                                      |

## Normal deploy flow (CI)

Every merge to `main` that touches `canary/**` triggers
[`.github/workflows/deploy-canary.yaml`](../../.github/workflows/deploy-canary.yaml),
which:

1. Builds the image via `gcloud builds submit` using `canary/cloudbuild.yaml`
   with `_TAG=<short-sha>`.
2. Runs `terraform init && terraform plan -out=tfplan -var="image_tag=<short-sha>"`
   against `envs/prod`.
3. Runs `terraform apply tfplan`.

Manual re-run / rollback: `gh workflow run deploy-canary.yaml --ref <sha>` —
the SHA drives both the image tag and the terraform vars, so dispatching an
older commit redeploys that exact revision.

## Manual apply flow (break-glass only)

If CI is down or you're bootstrapping from scratch, the original local flow
still works:

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
