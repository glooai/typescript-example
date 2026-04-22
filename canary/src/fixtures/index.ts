/**
 * Probe fixtures — the surface area we're fuzzing. Each fixture becomes one
 * Probe instance. Extend this file (not the runner) to add coverage.
 *
 * Source of truth for V2 direct-model aliases: the live unauthenticated
 * endpoint
 *   GET https://platform.ai.gloo.com/platform/v2/models
 *
 * That's the same data feed the public supported-models docs page renders
 * from (see `TangoGroup/gloo#2049` — Mintlify was switched to pull from
 * this endpoint dynamically so docs can't drift from the platform registry
 * again). Hydrating the probe list at run time — instead of keeping a
 * checked-in mirror — means the canary can never drift either. Retired
 * models disappear from our probes the same minute they disappear from
 * the registry.
 *
 * Scope:
 *   - V2 Completions is the actively supported surface. We probe every
 *     direct-model alias returned by the live registry PLUS every
 *     routing mode (auto_routing + 4 model_family values). The routing
 *     modes aren't model-specific, so they stay statically declared here.
 *   - V1 Messages is deprecated and maintained for backwards-compat only.
 *     Per Gloo platform team (2026-04-21 triage thread, CC Elio Kazu
 *     Mostero + Jackson Southern): V1 has no cross-provider retry chain
 *     and individual models like `Llama 3 70B Instruct` are explicitly
 *     labeled deprecated in `ai-api`. We deliberately do NOT probe V1 —
 *     every failure would be a design-expected flake, not a platform
 *     outage signal. If a caller needs reliability, they should migrate
 *     to V2.
 */

import type { V1MessagesFixture } from "../probes/v1-messages.js";
import type { V2CompletionsFixture } from "../probes/v2-completions.js";
import { fetchV2Models, type V2ModelSummary } from "./v2-models.js";

// Benign tech-writing prompt — matches the refusal-regression pattern we
// want to keep detecting (see scripts/tests/completions-v2-moderation for
// the external bug report that motivated these probes). Short answer keeps
// per-probe latency low.
const BENIGN_PROMPT =
  "In one sentence, what are three best practices for clear technical writing?";

// Some models (GPT-5.2 Pro, Opus 4.6, DeepSeek R1 with reasoning) can run
// longer than the default 90s — give every direct-model probe 120s so the
// per-probe timeout isn't the bottleneck. Probes still run sequentially so
// the whole batch completes well under the 600s job timeout.
const V2_DIRECT_PROBE_TIMEOUT_MS = 120_000;

// Cap full-sweep probe responses at ~48 tokens (comfortably fits the
// benign reply plus any refusal prefix the detector needs to match)
// — the router + model-selection + safety layer all execute even with
// a short cap, so coverage is preserved while inference spend drops
// materially. See `.context/guides/gloo/api/completions-v2.md` for
// the `max_tokens` contract.
const V2_FULL_PROBE_MAX_TOKENS = 48;

// Pulse-probe prompt — the single probe we fire in the "light" tier
// every 15 min. Minimizes input token budget while still exercising
// auth → router → completion. The benign-prompt reuse would also
// work, but a single-word prompt keeps input billed-weight as low as
// it can go without drifting from realistic usage.
const LIGHT_PULSE_PROMPT = "ping";

// Light-tier cap. The pulse probe doesn't depend on content inspection
// (any 2xx with non-empty `choices[0].message.content` counts as PASS
// — benign:false turns off the refusal detector so we can't
// false-positive a truncated reply). Keep this as small as the
// refusal detector + schema validator both tolerate.
const V2_LIGHT_PROBE_MAX_TOKENS = 4;

/**
 * V1 Messages probes are intentionally empty. V1 is deprecated by design
 * and probing it generates red-herring RED alerts for expected-flaky
 * provider-side behavior. Kept as an empty export so the runner wiring
 * stays stable if we ever decide to add a targeted V1 probe back (for
 * example, a dedicated "confirm V1 returns 'model not supported' after a
 * retirement date" alarm that only alerts on the specific retirement
 * verdict, not on transient 503s).
 */
export const V1_FIXTURES: V1MessagesFixture[] = [];

/**
 * Routing-mode probes — one per mechanism the V2 router exposes.
 * `auto_routing: true` and `model_family=<one-of-four>` are not tied to
 * any specific model id, so they stay statically declared and are not
 * hydrated from `/platform/v2/models`.
 *
 * Keep the `family` string exactly the casing the server canonicalizes
 * to ("Anthropic" | "Google" | "OpenAI" | "Open Source") — if the
 * platform changes the accepted values, that's a breaking contract
 * change we want to surface as a canary RED immediately.
 */
export const V2_ROUTING_FIXTURES: V2CompletionsFixture[] = [
  {
    signature: "v2/auto_routing",
    label: "V2 · auto_routing",
    prompt: BENIGN_PROMPT,
    benign: true,
    maxTokens: V2_FULL_PROBE_MAX_TOKENS,
    routing: { kind: "auto_routing" },
  },
  {
    signature: "v2/family/anthropic",
    label: "V2 · model_family=Anthropic",
    prompt: BENIGN_PROMPT,
    benign: true,
    maxTokens: V2_FULL_PROBE_MAX_TOKENS,
    routing: { kind: "model_family", family: "Anthropic" },
  },
  {
    signature: "v2/family/openai",
    label: "V2 · model_family=OpenAI",
    prompt: BENIGN_PROMPT,
    benign: true,
    maxTokens: V2_FULL_PROBE_MAX_TOKENS,
    routing: { kind: "model_family", family: "OpenAI" },
  },
  {
    signature: "v2/family/google",
    label: "V2 · model_family=Google",
    prompt: BENIGN_PROMPT,
    benign: true,
    maxTokens: V2_FULL_PROBE_MAX_TOKENS,
    routing: { kind: "model_family", family: "Google" },
  },
  {
    signature: "v2/family/open-source",
    label: "V2 · model_family=Open Source",
    prompt: BENIGN_PROMPT,
    benign: true,
    maxTokens: V2_FULL_PROBE_MAX_TOKENS,
    routing: { kind: "model_family", family: "Open Source" },
  },
];

/**
 * Light-tier "pulse" fixture. Exactly one probe, fired on the every-15-min
 * schedule when no failures are active and a full sweep has happened
 * recently. Exercises the full production path (OAuth → router →
 * completion) with the minimum possible request + response weight so
 * steady-state inference spend is measured in single-digit tokens per
 * run.
 *
 * Detection semantics:
 *  - Platform-wide outage (OAuth down, router down, all providers down)
 *    → light probe fails → next scheduled run escalates to Full tier
 *    within 15 min. Well under the 1h awareness target.
 *  - Single-model or single-family outage → NOT caught here (router
 *    dodges unhealthy backends). Covered by the periodic Full sweep
 *    (see `CANARY_FULL_SWEEP_INTERVAL_MS`, default 1h).
 *
 * `benign: false` turns off the refusal detector — a 4-token response
 * can't reasonably be inspected for refusal patterns without false
 * positives, and any non-empty 2xx already proves the full completion
 * path worked. Schema validation + empty-content check still apply.
 */
export const V2_LIGHT_PULSE_FIXTURE: V2CompletionsFixture = {
  signature: "v2/light/auto_routing",
  label: "V2 · light pulse · auto_routing",
  prompt: LIGHT_PULSE_PROMPT,
  benign: false,
  maxTokens: V2_LIGHT_PROBE_MAX_TOKENS,
  routing: { kind: "auto_routing" },
};

/**
 * Build one direct-model fixture per entry in a V2 models response.
 *
 * Signatures are derived deterministically from the model id — `v2/model/<id>`
 * — so they stay stable as long as the platform keeps the id stable, and
 * so we never need a manual slug-mapping table. Labels come straight from
 * the registry's `name` field, which is the same string the Studio Model
 * Explorer shows.
 */
export function buildV2DirectModelFixtures(
  models: V2ModelSummary[]
): V2CompletionsFixture[] {
  return models
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (model): V2CompletionsFixture => ({
        signature: `v2/model/${model.id}`,
        label: `V2 · ${model.name}`,
        prompt: BENIGN_PROMPT,
        benign: true,
        timeoutMs: V2_DIRECT_PROBE_TIMEOUT_MS,
        maxTokens: V2_FULL_PROBE_MAX_TOKENS,
        routing: { kind: "model", model: model.id },
      })
    );
}

export type BuildV2FixturesDeps = {
  /** Injectable for tests — defaults to the live `/platform/v2/models` fetch. */
  loadModels?: () => Promise<V2ModelSummary[]>;
};

/**
 * Routing-mode probes + one direct-model probe per model currently listed
 * in the authoritative registry. Async because the model list is fetched
 * live on every probe-runner invocation.
 */
export async function buildV2Fixtures(
  deps: BuildV2FixturesDeps = {}
): Promise<V2CompletionsFixture[]> {
  const loadModels = deps.loadModels ?? (() => fetchV2Models());
  const models = await loadModels();
  return [...V2_ROUTING_FIXTURES, ...buildV2DirectModelFixtures(models)];
}

/**
 * Signatures the canary is *currently* intended to probe given a list of
 * live model ids. Includes V1 (currently empty), routing-mode (5 static),
 * and one `v2/model/<id>` per live model. The digest uses this to filter
 * archived outcomes for signatures that are no longer in the probe set —
 * e.g., retired-from-registry aliases whose old runs still sit in the
 * 24h window. One definition, one call site, no drift between the probe
 * build path and the digest filter path.
 */
export function currentProbeSignatures(modelIds: string[]): string[] {
  const v1 = V1_FIXTURES.map((f) => f.signature);
  const light = [V2_LIGHT_PULSE_FIXTURE.signature];
  const routing = V2_ROUTING_FIXTURES.map((f) => f.signature);
  const direct = modelIds.map((id) => `v2/model/${id}`);
  return [...v1, ...light, ...routing, ...direct];
}
