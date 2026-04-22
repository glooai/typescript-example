# Gloo AI Canary

Scheduled integration tests that exercise the Gloo AI platform from
outside. Cloud Scheduler fires every 15 min during daytime / hourly
at night (57 runs/day), but the work done on each firing is **adaptive**
— a cheap "light" pulse when the platform is healthy, a full fan-out
sweep when anything is failing or the last full sweep is stale. Every
run archives raw results to Google Cloud Storage and alerts Slack on
any RED-level regression. A separate digest job posts a once-a-day
aggregate of the last 24h.

Purpose: proactively detect changes to the Gloo AI API — schema drift,
model-alias breakage, routing regressions, or safety-layer over-moderation
— regardless of whether they're announced in release notes.

## Adaptive tiering (inference-budget aware)

Each firing runs in one of two tiers, selected by `src/runners/tier-decision.ts`:

| Tier      | What runs                                                  | When                                                                                                     | Requests / tick |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------- |
| **Light** | 1 `auto_routing` pulse probe, `max_tokens: 4`              | Steady-state: no active failures AND last Full sweep within `CANARY_FULL_SWEEP_INTERVAL_MS` (default 1h) | 1               |
| **Full**  | All routing-mode + direct-model fixtures, `max_tokens: 48` | Cold start · any active failure · periodic refresh (≥1h since last Full)                                 | ~22             |

Detection windows:

- **Platform-wide outage** (OAuth, router, all providers) → caught by the light pulse on the next tick (≤15 min daytime, ≤1h nighttime).
- **Single-model or single-family outage** → caught by the next periodic Full sweep (≤1h). Auto-recovers the tier cascade back to Light once the failure clears.

Tunable via `CANARY_FULL_SWEEP_INTERVAL_MS` on the Cloud Run Job — no code change needed to dial the per-model coverage window tighter or looser.

## What it probes

Fixture-driven in `src/fixtures/index.ts` — add new cases there, no code changes needed elsewhere.

**V1 Messages** (`/ai/v1/chat/completions`) — 0 fixtures (V1 is deprecated; the runner wiring is kept intact for a targeted retirement-date alarm if we decide to add one back).

**V2 Completions** (`/ai/v2/chat/completions`):

- **Light pulse (1)**: `v2/light/auto_routing`, single-word prompt, `max_tokens: 4`. Runs on every "light" tick.
- **Routing-mode (5)** — `auto_routing: true` + `model_family` in `{Anthropic, OpenAI, Google, Open Source}`. `max_tokens: 48`.
- **Direct-model (~15)** — one per live alias from `/platform/v2/models`. Hydrated at run time so the probe list can never drift from the authoritative registry. `max_tokens: 48` each.

Full sweep total: **~21 probe executions**. Inference spend scales with the tier ratio — a fully-healthy day runs mostly Light ticks and a handful of Full sweeps, dropping request volume by roughly an order of magnitude vs. a firing-every-tick-at-full-coverage policy.

Every probe uses a benign technical-writing prompt and asserts the response:

- Returns 2xx
- Is valid JSON matching the (loose) chat-completion schema
- Has non-empty `choices[0].message.content`
- Does NOT trigger the refusal detector (drug/medical-harm safety language)

## Architecture

```
┌─ Cloud Scheduler (cron) ─────┐     ┌─ Cloud Run Job ──────────────┐
│ */15 06:00–16:45 CT (44/day) │ ──> │ canary-probe                 │ ──> GCS: runs/YYYY/MM/DD/HH-*.json
│ hourly 17:00–05:00 CT (13)   │ ──> │  └─ tier-decision ──┐        │
│ daily @ 06:05 CT             │ ──> │      light: 1 probe │        │ ──> Slack: failure alerts
│                              │     │      full: ~21      │        │
│                              │ ──> │ canary-digest                │ ──> Slack: daily 24h digest
└──────────────────────────────┘     └──────────────────────────────┘
         │                                │
         │                                ├─ Secret Manager ─> Gloo credentials, Slack bot token
         │                                └─ GCS state ──────> active-failures.json + probe-tier.json
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
