# Gloo AI Canary

Scheduled integration tests that exercise the Gloo AI platform from
outside. Probes run on a business-hours-biased schedule — every 15
minutes from 6am–5pm Central, then hourly from 5pm–6am Central (57
runs/day total). Every run archives raw results to Google Cloud
Storage and alerts Slack on any RED-level regression. A separate
digest job posts a once-a-day aggregate of the last 24h.

Purpose: proactively detect changes to the Gloo AI API — schema drift,
model-alias breakage, routing regressions, or safety-layer over-moderation
— regardless of whether they're announced in release notes.

## What it probes

Fixture-driven in `src/fixtures/index.ts` — add new cases there, no code changes needed elsewhere.

**V1 Messages** (`/ai/v1/chat/completions`) — 2 fixtures:

- `meta.llama3-70b-instruct-v1:0`
- `us.anthropic.claude-sonnet-4-20250514-v1:0` (deprecated; canary for when Gloo removes the V1 alias on / before 2026-06-15)

**V2 Completions** (`/ai/v2/chat/completions`) — 20 fixtures:

- Routing-mode probes (5):
  - `auto_routing: true`
  - `model_family: anthropic | openai | google | open-source`
- Direct-model probes (15) — one per supported alias from `.context/guides/gloo/api/supported-models.md`:
  - **Anthropic:** Haiku 4.5, Sonnet 4.5, Opus 4.5
  - **Google:** Gemini 2.5 Flash Lite, Flash, Pro · Gemini 3 Pro preview
  - **OpenAI:** GPT-5 Nano, Mini, Pro · GPT-5.2
  - **Open source:** Llama 3.1 8B · DeepSeek V3.1 · DeepSeek V3.2 · GPT OSS 120B

Total: **22 probe executions** per scheduled run (57×/day → 1,254 executions/day).

Every probe uses a benign technical-writing prompt and asserts the response:

- Returns 2xx
- Is valid JSON matching the (loose) chat-completion schema
- Has non-empty `choices[0].message.content`
- Does NOT trigger the refusal detector (drug/medical-harm safety language)

## Architecture

```
┌─ Cloud Scheduler (cron) ─────┐     ┌─ Cloud Run Job ──┐
│ */15 06:00–16:45 CT (44/day) │ ──> │ canary-probe     │ ──> GCS: runs/YYYY/MM/DD/HH-*.json
│ hourly 17:00–05:00 CT (13)   │ ──> │ canary-probe     │
│ daily @ 06:05 CT             │ ──> │ canary-digest    │ ──> Slack: daily digest + failure alerts
└──────────────────────────────┘     └──────────────────┘
         │                                │
         │                                ├─ Secret Manager ─> Gloo credentials, Slack bot token
         │                                └─ GCS state ──────> active-failures.json (dedup)
```

One Docker image, two entry points selected by `CANARY_MODE`
(`probe` | `digest`).

## Alerting model

- **RED failure** (HTTP 5xx, 4xx, empty completion, schema drift, refusal regression): immediate top-level Slack post with full metadata.
- **Recurring RED** (same signature failing on consecutive runs): **threaded reply** on the original post — no channel spam.
- **Recovery**: threaded `:white_check_mark: Recovered` + reaction on the original post.
- **Daily digest**: top-level post at 6:05am CT summarizing the preceding 24h — probes run, severity distribution, per-probe latency quantiles, archive state.
- **YELLOW signals** (latency anomalies, routing shifts): **threaded reply** on the digest post.

## Local development

```bash
pnpm install
cp canary/.env.local.example canary/.env.local
# fill in GLOO_AI_*, ALERTS_SLACK_*, CANARY_RESULTS_BUCKET

# Run a single probe-mode invocation against prod
CANARY_MODE=probe pnpm --filter @glooai/canary canary:local

# Or digest-mode
CANARY_MODE=digest pnpm --filter @glooai/canary canary:local
```

## Deployment

See [`terraform/README.md`](terraform/README.md).

## Testing

```bash
pnpm --filter @glooai/canary test          # unit tests (no network)
pnpm --filter @glooai/canary test:coverage # with 70% threshold
pnpm --filter @glooai/canary typecheck
pnpm --filter @glooai/canary lint
```
