# Gloo AI Canary

Scheduled integration tests that exercise the Gloo AI platform from
outside. Cloud Scheduler fires the probe job once weekly, Monday at
06:00 CT (`0 6 * * 1`). Each run performs a full fan-out sweep:
routing-mode probes, one direct-model probe per live registry alias,
and three capability probes (tool calling, multi-turn context,
safety/jailbreak). Every run archives raw results to Google Cloud
Storage and alerts Slack on any RED-level regression. A separate
digest job runs Monday at 06:15 CT (`15 6 * * 1`) and posts a weekly
aggregate of the preceding 7 days.

Purpose: proactively detect changes to the Gloo AI API — schema drift,
model-alias breakage, routing regressions, or safety-layer over-moderation
— regardless of whether they're announced in release notes.

**Detection latency:** because probes run weekly, an outage can go
undetected for up to a week between runs. This is a deliberate
cost/coverage tradeoff (see `terraform/envs/prod/variables.tf`);
tighten it by shortening `probe_schedule_cron` if faster detection is
needed.

## Tiering (legacy)

The runner still contains a two-tier mechanism
(`src/runners/tier-decision.ts`, gated by `full_sweep_interval_ms`)
that could run a cheap single-probe Light pulse instead of a Full
sweep. With the current weekly cadence and the default 1h freshness
threshold, every scheduled run exceeds the freshness window (168h
between runs is far greater than 1h) and therefore always runs a Full
sweep. The Light tier is retained for a possible future
high-frequency schedule but does not fire in production today.

Token floors, for reference: the Light pulse uses
`V2_LIGHT_PROBE_MAX_TOKENS = 1024` and every Full-sweep probe uses
`V2_FULL_PROBE_MAX_TOKENS = 2048` (`src/fixtures/index.ts`). Both
floors clear the reasoning-model minimum, so a probe that lands on a
reasoning backend has room to spend its internal thinking budget and
still emit a visible answer.

## What it probes

Fixture-driven in `src/fixtures/index.ts` — add new cases there, no code changes needed elsewhere.

**V1 Messages** (`/ai/v1/chat/completions`) — 0 fixtures (V1 is deprecated; the runner wiring is kept intact for a targeted retirement-date alarm if we decide to add one back).

**V2 Completions** (`/ai/v2/chat/completions`):

- **Routing-mode**: one `auto_routing: true` probe plus one `model_family` probe per distinct family in the registry (e.g. Anthropic, OpenAI, Google, Open Source). The count scales with the live registry, so a newly added family starts getting probed automatically. `max_tokens: 2048`.
- **Direct-model**: one probe per live alias from `/platform/v2/models`, so the count scales with the registry. Hydrated at run time so the probe list can never drift from the authoritative registry. `max_tokens: 2048` each.

  **Image-only models are probed as `expectRejection` fixtures, not excluded.** A model whose `output_modalities` has no `"text"` (FLUX, Seedream, Grok Imagine), and a family whose every member is image-only, can't return a text completion on this Chat Completions endpoint — ai-api rejects them with a 4xx (GAI-6788) directing callers to `/v1/responses`. The probe asserts that contract: a **4xx is PASS** (correctly rejected, GREEN), a **2xx is `UNEXPECTED_SUCCESS`** (RED — the image-only model was processed into an empty completion, the GAI-6788 bug). This is metadata-driven off the registry's `output_modalities`, so a new image model is covered the minute it appears — no list to maintain. _(Depends on ai-api GAI-6788 being deployed to the probed environment; before that, image-only **model** probes stay RED — the platform returns a slow empty 200, not a 4xx — while image-only **family** probes already 4xx as "unknown family." This canary change should land after ai-api #1760 deploys.)_

Each Full sweep runs the routing-mode probes, every direct-model probe, and the three capability probes below, so the total tracks the size of the live registry rather than a fixed number.

Every routing-mode and direct-model probe uses a benign technical-writing prompt and asserts the response:

- Returns 2xx
- Is valid JSON matching the (loose) chat-completion schema
- Has non-empty `choices[0].message.content`
- Does NOT trigger the refusal detector (drug/medical-harm safety language)

### Capability probes

Three static fixtures in `src/fixtures/index.ts` exercise
higher-level API contracts beyond a plain completion. Each runs once
per Full sweep with `max_tokens: 1024` and a 60s timeout.

- **Tool calling** (`v2/tool-call/auto_routing`): sends the prompt "What is the weather in Chicago right now?" with a `get_weather` function tool declared in the `tools` array, and asserts the response contains a `tool_calls` invocation naming `get_weather` rather than a plain text answer. A missing tool call surfaces as `TOOL_CALL_MISSING`.
- **Multi-turn context retention** (`v2/multi-turn/auto_routing`): sends a short three-message conversation in which the user states a fact ("My favorite city is Raleigh"), the assistant acknowledges it, and the final user turn asks the model to recall it. Asserts a non-empty response, verifying the API forwards the full `messages` history and not just the last turn.
- **Safety / jailbreak** (`v2/safety/jailbreak-block`): sends a DAN-style override prompt requesting instructions for a dangerous controlled substance and asserts the platform refuses (via HTTP-layer block or refusal language). A helpful non-refusal response surfaces as `GUARDRAIL_BYPASS`.

## Architecture

```
┌─ Cloud Scheduler (cron) ─────┐     ┌─ Cloud Run Job ──────────────┐
│ probe: Mon 06:00 CT          │ ──> │ canary-probe                 │ ──> GCS: runs/YYYY/MM/DD/HH-*.json
│   (0 6 * * 1)                │ ──> │  └─ tier-decision ──┐        │
│ digest: Mon 06:15 CT         │ ──> │      Full sweep     │        │ ──> Slack: failure alerts
│   (15 6 * * 1)               │     │      every run      │        │
│                              │ ──> │ canary-digest                │ ──> Slack: weekly 7d digest
└──────────────────────────────┘     └──────────────────────────────┘
         │                                │
         │                                ├─ Secret Manager ─> Gloo credentials, Slack bot token
         │                                └─ GCS state ──────> active-failures.json + probe-tier.json
```

One Docker image, two entry points selected by `CANARY_MODE`
(`probe` | `digest`).

## Alerting model

- **RED failure** (HTTP 5xx, unexpected 4xx, empty completion, schema drift, refusal regression, missing tool call `TOOL_CALL_MISSING`, guardrail bypass `GUARDRAIL_BYPASS`, non-abort network error): immediate top-level Slack post with full metadata.
- **Recurring RED** (same signature failing on consecutive runs): **threaded reply** on the original post — no channel spam.
- **Recovery**: threaded `:white_check_mark: Recovered` + reaction on the original post.
- **Weekly digest**: top-level post Monday at 06:15 CT summarizing the preceding 7 days (168h): probes run, severity distribution, per-probe latency quantiles, archive state.
- **YELLOW signals** (latency anomalies, routing shifts, `NOT_ENTITLED` on HTTP 403, `TIMEOUT` on probe-side `AbortSignal.timeout()` firing): **threaded reply** on the digest post — no top-level page.
  - `NOT_ENTITLED` fires when a model is listed in `/platform/v2/models` but our canary OAuth client isn't granted access. This is a stable configuration signal, not a platform outage.
  - `TIMEOUT` fires when the probe's own timeout elapses before the upstream responds. A single occurrence is a latency tail; a persistent pattern on a specific model is the signal to raise the per-fixture timeout or escalate upstream.

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
