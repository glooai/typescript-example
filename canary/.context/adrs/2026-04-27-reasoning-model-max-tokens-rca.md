---
type: postmortem
status: active
created: 2026-04-27
tags: [canary, gloo-ai, reasoning-models, max_tokens, false-positive, rca]
---

# RCA — Canary V2 probe `max_tokens=48` cap synthesized 5+ days of false-RED 503s on reasoning models

## TL;DR

The canary's V2 Completions probes ran with `max_tokens = 48` (Full
sweep) and `max_tokens = 4` (Light pulse). Reasoning models — Gemini
2.5 Pro, GPT-OSS 120B, and at least one Open Source family member that
auto-routes there — spend their entire token budget on internal
thinking before any user-visible output is emitted. With a 48-token
cap (or 4-token cap on the light pulse), every reasoning-model probe
exhausted the cap on thinking, produced an empty completion, and the
Gloo platform converted that into HTTP 503 with the
`service_unavailable_error` envelope (`fault: provider`,
`retryable: true`).

The canary correctly classified that envelope as RED. But the request
itself was malformed for the model class. Every RED on a reasoning
model across the last ~5 days of digests was a self-inflicted false
positive — and three of them were filed as bug reports against the
Gloo platform team this morning before Jackson Southern from that team
caught the parameter issue and replied in-thread.

This PR raises both probe caps above the reasoning-model thinking-budget
floor (Full: 48 → 2048; Light: 4 → 1024), adds a regression test that
hard-fails any future fixture below the floor, and documents the
follow-on guards we want next.

## What happened

### Timeline (CDT)

- **~2026-04-22 → 2026-04-27**: 5+ consecutive days of digests carry
  RED entries on `gloo-google-gemini-2.5-pro` (19 RED postings inside
  the most recent digest window), `gloo-openai-gpt-oss-120b` (16 RED
  postings), and `v2/family/open-source` (~30 RED postings — that
  family auto-routes onto GPT-OSS 120B as a current member). The
  canary's recurring-RED debouncing kept the channel quiet, but the
  digest thread surfaced the pattern every morning.
- **2026-04-27 ~07:15–07:27**: Three bug reports filed in
  `#support-gloo-ai` (channel `C08QPAK2QAX`) — one each for Gemini
  2.5 Pro, GPT-OSS 120B, and the Open Source family. All three frame
  the failure as platform-side provider unavailability. Linear
  GAI-5477 is referenced as the parent ticket.
- **2026-04-27 ~mid-morning**: Jackson Southern (Gloo AI platform
  team) replies on the thread:
  https://servant-io.slack.com/archives/C08QPAK2QAX/p1777317538741619?thread_ts=1777292126.160679&cid=C08QPAK2QAX

  > Gemini 2.5-pro is a reasoning model, thus it spends a non-trivial
  > amount of tokens on thinking. Thus, if max_tokens is only 48, it
  > will spend all of the allotted tokens on thinking and return an
  > empty response, returning a 503. Increasing max_tokens resolves
  > the issue. This is why I was also unable to reproduce the issue
  > through casual usage where I did not specify max_tokens. The
  > example prompt given would require at minimum a max_tokens value
  > of 1024.

- **2026-04-27 (this PR)**: Mitigation shipped.

### The technical chain

1. The canary builds V2 fixtures from the live registry at
   `https://platform.ai.gloo.com/platform/v2/models` — every
   direct-model probe and every family-mode probe gets `max_tokens:
   V2_FULL_PROBE_MAX_TOKENS` (= 48). The Light pulse probe gets
   `max_tokens: V2_LIGHT_PROBE_MAX_TOKENS` (= 4) and uses
   `auto_routing: true`, which can route to any model in the registry
   including reasoning models.
2. A reasoning model receives the request, allocates the entire 48
   (or 4) tokens to internal thinking, and emits no user-visible
   output before the cap is hit.
3. The platform's Completions V2 layer sees the empty completion,
   classifies it as a provider failure, and returns HTTP 503 with
   `{"error":{"type":"service_unavailable_error","code":2006,"fault":"provider","retryable":true}}`.
4. The canary's `assessV2()` correctly maps a 5xx to `verdict: FAIL`
   / `severity: RED`. The classification is right; the input was
   wrong.

The probe codepath at
`canary/src/probes/v2-completions.ts:189–198` is doing exactly what
it was designed to do — flag any non-2xx as RED with the body preview
so triage has the envelope to look at. Nothing in the probe layer
changes; only the fixture-side caps move.

## Why the canary kept firing

The signal pattern looked exactly like a flapping platform fault:

- Same model families failing across multiple consecutive digest
  windows, but not 100% (auto_routing sometimes lands on a
  non-reasoning backend, which succeeds, so the family-mode probes
  weren't always RED).
- The 503 envelope is the same shape Gloo emits for genuine upstream
  provider outages, so the canary couldn't distinguish "the request
  was malformed" from "the upstream is down".
- Direct-model probes against `gloo-google-gemini-2.5-pro` were
  uniformly RED (no auto-routing dodge possible), which made it
  *look* like a single-model regression — the kind the Full sweep is
  specifically designed to catch.

From the canary's vantage, the failure is indistinguishable from a
real outage without prior knowledge of which models are reasoning
models.

## Why the bug-report loop slipped

Three bug reports were filed in `#support-gloo-ai` this morning
before Jackson's reply, all framing this as a platform-side provider
failure rooted in canary signal:

1. The `service_unavailable_error` envelope strongly resembles real
   upstream provider failures the canary has caught before — the
   bug-report author (and the canary's drafting flow) had no reason
   to suspect the request itself.
2. The reproducer payload (a benign one-sentence technical-writing
   prompt with `max_tokens=48`) didn't visibly implicate the
   parameters, because failure surface is a generic 503 — there's no
   400 / `validation_error` carrying back "max_tokens too low for
   this model class" to point at.
3. Jackson's manual reproduction attempt didn't catch it because
   casual Studio usage doesn't pin `max_tokens` — the platform
   defaults aren't 48.
4. The canary's existing `EMPTY_COMPLETION` verdict path
   (`canary/src/probes/v2-completions.ts:235–247`) only fires on a
   2xx with empty content. Once the platform translated the empty
   completion into a 5xx, the more specific verdict was bypassed in
   favor of the generic `FAIL`/RED path, which doesn't carry the
   "empty content" hint.

## How we found out

Jackson Southern from the Gloo AI platform team replied on the
in-flight bug-report thread (Slack link above) with the explanation,
and pointed out that the example prompt requires at minimum
`max_tokens = 1024` for a reasoning model.

Credit where it's due — that catch saved us from a multi-day
goose-chase on a phantom platform regression.

## Mitigations shipped (this PR)

| Constant | Old | New | Where | Rationale |
|---|---|---|---|---|
| `V2_FULL_PROBE_MAX_TOKENS` | 48 | **2048** | `canary/src/fixtures/index.ts` | Jackson's stated minimum is 1024. We pick 2048 for headroom against future reasoning models with deeper thinking budgets, and to leave room for refusal-pattern matching on `benign:true` probes. |
| `V2_LIGHT_PROBE_MAX_TOKENS` | 4 | **1024** | `canary/src/fixtures/index.ts` | Light pulse uses `auto_routing: true`, so any tick can land on a reasoning model. 4 was a guaranteed false-RED whenever it did. 1024 is the floor; we don't go higher because the light pulse is content-blind (`benign: false`) so we don't need the refusal-pattern headroom. |

We chose Option A (bump the global constant) over Option B (per-model
override based on a `is_reasoning` registry flag) because:

- Option B requires either a platform-side schema change on
  `/platform/v2/models` (no `is_reasoning` field today — see
  forward-looking section) or a hardcoded reasoning-model allowlist
  in the canary, which is exactly the drift problem the
  registry-hydrated fixtures were built to avoid.
- Option A's only cost is a bounded increase in inference spend on
  Full sweeps, and the cap is just that — a *cap*, not actual emitted
  output. Non-reasoning models still produce one short sentence and
  bill accordingly. Reasoning models pay for their thinking budget
  whether or not we cap them, so the marginal cost is the
  user-visible answer they emit after thinking, which is small.
- Full sweeps fire ~22 probes once per hour at most (the rest of the
  ticks are Light pulses), so the daily ceiling stays well within
  budget.

### Tests added

- `canary/tests/fixtures/index.test.ts` now hard-fails any fixture
  (Full-tier or Light pulse) whose `maxTokens` falls below the
  reasoning-model floor (`REASONING_MODEL_MIN_MAX_TOKENS = 1024`).
  This is the primary forward-looking guard — if anyone ever drops
  the cap back to "save tokens", the test fails before merge.
- Existing per-fixture assertions (`maxTokens === 48`, `maxTokens
  <= 8`) were rewritten to `>= 1024` floors so they continue to
  reflect the new contract.

## Forward-looking guards

Things this RCA recommends but does NOT ship in this PR. Each is
small enough to file as a follow-up if we want belt-and-suspenders
coverage.

1. **Add an `EMPTY_COMPLETION`-shaped 503 hint to the digest's
   "Needs attention" section.** A 503 with `fault: provider`, very
   short latency (<1s, characteristic of a thinking-budget exit),
   and a known-reasoning model family is a strong fingerprint for
   the next instance of this same class of bug. The digest already
   surfaces these — it just doesn't currently flag the
   probably-self-inflicted shape distinctly. Worth a follow-up issue.

2. **Ask the Gloo platform team for an `is_reasoning: bool` field on
   `/platform/v2/models`.** Today the canary has no programmatic way
   to know which models are reasoning. A registry-side flag would
   let us tier `max_tokens` correctly per-model without hardcoding
   an allowlist in the canary. The schema is already
   client-tolerant of new fields (`v2-models.ts` consumes `id`,
   `family`, `name` and ignores everything else), so adding a field
   is non-breaking. **Action: surface this as a feature request via
   `/gloo-feature-request` after this PR merges.**

3. **Update the canary's bug-report drafting flow** (the
   `gloo-bug-report` skill at `.claude/skills/gloo-bug-report/`) to
   include a pre-filing checklist note: *"before filing a Gloo bug
   report sourced from canary signal, sanity-check that the request
   parameters are valid for the model class — in particular,
   max_tokens ≥ 1024 for reasoning models (Gemini 2.5 Pro, GPT-OSS
   120B, DeepSeek R1, etc.). The 503 / service_unavailable_error
   envelope is indistinguishable between a real upstream outage and
   a thinking-budget exhaustion, so the parameter check has to
   happen at draft time."* This is a process fix, not a code fix,
   and lives outside this repo.

4. **Consider a probe-level "reasoning-model smoke test"** that
   intentionally probes a known-reasoning model with both a too-low
   and a sufficient max_tokens, to confirm the platform's behavior
   stays consistent (both that low max_tokens still surfaces as 503,
   and that high max_tokens succeeds). This would catch regressions
   in either direction. Probably overkill — the assertion test we
   added is enough — but worth filing as a deferred enhancement.

## What this RCA is NOT

- Not a bug in the canary's classification logic. `assessV2()`
  correctly mapped 5xx → RED. The fix is at the fixture layer.
- Not a bug in the Gloo platform. The platform's behavior is
  documented (max_tokens is per-call, the model bills thinking
  tokens against the cap, and an empty-completion → 503 is the
  contractual surface). The canary just didn't honor the
  reasoning-model contract.
- Not a deployment / Terraform / Cloud Run issue. No infra moves.

## Acknowledgements

Thanks to Jackson Southern (Gloo AI platform team) for catching this
in-thread on the support channel and for the precise 1024-token
minimum guidance. Saved an open-ended platform investigation that
would have come up empty.

## References

- Slack thread (Jackson's diagnosis):
  https://servant-io.slack.com/archives/C08QPAK2QAX/p1777317538741619?thread_ts=1777292126.160679&cid=C08QPAK2QAX
- Linear GAI-5477 — referenced as parent ticket on the three
  morning bug reports.
- Probe code: `canary/src/probes/v2-completions.ts`
- Fixture caps: `canary/src/fixtures/index.ts`
- Regression tests: `canary/tests/fixtures/index.test.ts`
- V2 Completions API reference (max_tokens contract):
  `.context/guides/gloo/api/completions-v2.md`
