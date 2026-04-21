/**
 * Probe fixtures — the surface area we're fuzzing. Each fixture becomes one
 * Probe instance. Extend this file (not the runner) to add coverage.
 *
 * Source of truth for V2 model IDs: the live, unauthenticated endpoint
 *   GET https://platform.ai.gloo.com/platform/v2/models
 *
 * That's the same data feed the public supported-models docs page renders
 * from (see `TangoGroup/gloo#2049` — Mintlify was switched to pull from
 * this endpoint dynamically so docs can't drift from the platform registry
 * again).
 *
 * Scope:
 *   - V2 Completions is the actively supported surface. We probe every
 *     direct-model alias in the authoritative list + every routing mode
 *     (auto_routing + 4 model_family values).
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

// Benign tech-writing prompt — matches the refusal-regression pattern we
// want to keep detecting (see scripts/tests/completions-v2-moderation for
// the external bug report that motivated these probes). Short answer keeps
// per-probe latency low.
const BENIGN_PROMPT =
  "In one sentence, what are three best practices for clear technical writing?";

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
 * Every currently-supported V2 direct-model alias per the authoritative
 * endpoint. Ordered alphabetically within family (Anthropic, Google,
 * Open Source, OpenAI) so the Slack digest stays scannable. Keep this
 * list in lockstep with `/platform/v2/models`; if Gloo adds or removes a
 * model, update here in the same PR that touches the platform.
 */
const V2_DIRECT_MODELS: Array<{
  signature: string;
  model: string;
  label: string;
}> = [
  // Anthropic
  {
    signature: "v2/model/anthropic-haiku-4.5",
    model: "gloo-anthropic-claude-haiku-4.5",
    label: "V2 · Claude Haiku 4.5",
  },
  {
    signature: "v2/model/anthropic-opus-4.5",
    model: "gloo-anthropic-claude-opus-4.5",
    label: "V2 · Claude Opus 4.5",
  },
  {
    signature: "v2/model/anthropic-opus-4.6",
    model: "gloo-anthropic-claude-opus-4.6",
    label: "V2 · Claude Opus 4.6",
  },
  {
    signature: "v2/model/anthropic-sonnet-4",
    model: "gloo-anthropic-claude-sonnet-4",
    label: "V2 · Claude Sonnet 4",
  },
  {
    signature: "v2/model/anthropic-sonnet-4.5",
    model: "gloo-anthropic-claude-sonnet-4.5",
    label: "V2 · Claude Sonnet 4.5",
  },
  {
    signature: "v2/model/anthropic-sonnet-4.6",
    model: "gloo-anthropic-claude-sonnet-4.6",
    label: "V2 · Claude Sonnet 4.6",
  },
  // Google
  {
    signature: "v2/model/google-gemini-2.5-flash",
    model: "gloo-google-gemini-2.5-flash",
    label: "V2 · Gemini 2.5 Flash",
  },
  {
    signature: "v2/model/google-gemini-2.5-flash-lite",
    model: "gloo-google-gemini-2.5-flash-lite",
    label: "V2 · Gemini 2.5 Flash Lite",
  },
  {
    signature: "v2/model/google-gemini-2.5-pro",
    model: "gloo-google-gemini-2.5-pro",
    label: "V2 · Gemini 2.5 Pro",
  },
  // Open source
  {
    signature: "v2/model/oss-deepseek-v3.1",
    model: "gloo-deepseek-chat-v3.1",
    label: "V2 · DeepSeek Chat V3.1",
  },
  {
    signature: "v2/model/oss-deepseek-v3.2",
    model: "gloo-deepseek-v3.2",
    label: "V2 · DeepSeek V3.2",
  },
  {
    signature: "v2/model/oss-deepseek-r1",
    model: "gloo-deepseek-r1",
    label: "V2 · DeepSeek R1",
  },
  {
    signature: "v2/model/oss-gpt-oss-120b",
    model: "gloo-openai-gpt-oss-120b",
    label: "V2 · GPT OSS 120B",
  },
  {
    signature: "v2/model/oss-llama-3.1-8b",
    model: "gloo-meta-llama-3.1-8b-instruct",
    label: "V2 · Llama 3.1 8B Instruct",
  },
  {
    signature: "v2/model/oss-llama-4-maverick",
    model: "gloo-meta-llama-4-maverick",
    label: "V2 · Llama 4 Maverick",
  },
  // OpenAI
  {
    signature: "v2/model/openai-gpt-4.1",
    model: "gloo-openai-gpt-4.1",
    label: "V2 · GPT-4.1",
  },
  {
    signature: "v2/model/openai-gpt-4.1-mini",
    model: "gloo-openai-gpt-4.1-mini",
    label: "V2 · GPT-4.1 Mini",
  },
  {
    signature: "v2/model/openai-gpt-5-mini",
    model: "gloo-openai-gpt-5-mini",
    label: "V2 · GPT-5 Mini",
  },
  {
    signature: "v2/model/openai-gpt-5-nano",
    model: "gloo-openai-gpt-5-nano",
    label: "V2 · GPT-5 Nano",
  },
  {
    signature: "v2/model/openai-gpt-5.2",
    model: "gloo-openai-gpt-5.2",
    label: "V2 · GPT-5.2",
  },
  {
    signature: "v2/model/openai-gpt-5.2-pro",
    model: "gloo-openai-gpt-5.2-pro",
    label: "V2 · GPT-5.2 Pro",
  },
  {
    signature: "v2/model/openai-gpt-5.4",
    model: "gloo-openai-gpt-5.4",
    label: "V2 · GPT-5.4",
  },
];

// Some models (GPT-5.2 Pro, Opus 4.6, DeepSeek R1 with reasoning) can run
// longer than the default 90s — give every direct-model probe 120s so the
// per-probe timeout isn't the bottleneck. Probes still run sequentially so
// the whole batch completes well under the 600s job timeout.
const V2_DIRECT_PROBE_TIMEOUT_MS = 120_000;

export const V2_FIXTURES: V2CompletionsFixture[] = [
  // --- Routing-mode probes: one per mechanism ---
  {
    signature: "v2/auto_routing",
    label: "V2 · auto_routing",
    prompt: BENIGN_PROMPT,
    benign: true,
    routing: { kind: "auto_routing" },
  },
  {
    signature: "v2/family/anthropic",
    label: "V2 · model_family=Anthropic",
    prompt: BENIGN_PROMPT,
    benign: true,
    routing: { kind: "model_family", family: "Anthropic" },
  },
  {
    signature: "v2/family/openai",
    label: "V2 · model_family=OpenAI",
    prompt: BENIGN_PROMPT,
    benign: true,
    routing: { kind: "model_family", family: "OpenAI" },
  },
  {
    signature: "v2/family/google",
    label: "V2 · model_family=Google",
    prompt: BENIGN_PROMPT,
    benign: true,
    routing: { kind: "model_family", family: "Google" },
  },
  {
    signature: "v2/family/open-source",
    label: "V2 · model_family=Open Source",
    prompt: BENIGN_PROMPT,
    benign: true,
    routing: { kind: "model_family", family: "Open Source" },
  },
  // --- Direct-model probes: one per supported alias ---
  ...V2_DIRECT_MODELS.map(
    ({ signature, model, label }): V2CompletionsFixture => ({
      signature,
      label,
      prompt: BENIGN_PROMPT,
      benign: true,
      timeoutMs: V2_DIRECT_PROBE_TIMEOUT_MS,
      routing: { kind: "model", model },
    })
  ),
];
