/**
 * Probe fixtures — the surface area we're fuzzing. Each fixture becomes one
 * Probe instance. Extend this file (not the runner) to add coverage.
 *
 * Source for supported V2 model IDs:
 *   .context/guides/gloo/api/supported-models.md
 *
 * Coverage goals:
 *   - Every V1 model we still officially support (+ one known-deprecated
 *     canary for when Gloo removes a V1 alias).
 *   - Every V2 direct-model alias, one probe per alias.
 *   - Every V2 model_family routing mode (auto_routing + 4 families).
 */

import type { V1MessagesFixture } from "../probes/v1-messages.js";
import type { V2CompletionsFixture } from "../probes/v2-completions.js";

// Benign tech-writing prompt — matches the refusal-regression pattern we
// want to keep detecting (see scripts/tests/completions-v2-moderation for
// the external bug report that motivated these probes). Short answer keeps
// per-probe latency low.
const BENIGN_PROMPT =
  "In one sentence, what are three best practices for clear technical writing?";

export const V1_FIXTURES: V1MessagesFixture[] = [
  {
    signature: "v1/llama3-70b",
    label: "V1 Messages · meta.llama3-70b-instruct",
    model: "meta.llama3-70b-instruct-v1:0",
    prompt: BENIGN_PROMPT,
    benign: true,
  },
  {
    signature: "v1/sonnet-4-deprecated",
    label: "V1 Messages · Sonnet 4 (deprecated; will retire 2026-06-15)",
    model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    prompt: BENIGN_PROMPT,
    benign: true,
  },
];

// Supported V2 direct-model aliases per
// .context/guides/gloo/api/supported-models.md.
// Order: anthropic → google → openai → open-source so the Slack digest is
// easy to scan.
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
    signature: "v2/model/anthropic-sonnet-4.5",
    model: "gloo-anthropic-claude-sonnet-4.5",
    label: "V2 · Claude Sonnet 4.5",
  },
  {
    signature: "v2/model/anthropic-opus-4.5",
    model: "gloo-anthropic-claude-opus-4.5",
    label: "V2 · Claude Opus 4.5",
  },
  // Google
  {
    signature: "v2/model/google-gemini-2.5-flash-lite",
    model: "gloo-google-gemini-2.5-flash-lite",
    label: "V2 · Gemini 2.5 Flash Lite",
  },
  {
    signature: "v2/model/google-gemini-2.5-flash",
    model: "gloo-google-gemini-2.5-flash",
    label: "V2 · Gemini 2.5 Flash",
  },
  {
    signature: "v2/model/google-gemini-2.5-pro",
    model: "gloo-google-gemini-2.5-pro",
    label: "V2 · Gemini 2.5 Pro",
  },
  {
    signature: "v2/model/google-gemini-3-pro-preview",
    model: "gloo-google-gemini-3-pro-preview",
    label: "V2 · Gemini 3 Pro (preview)",
  },
  // OpenAI
  {
    signature: "v2/model/openai-gpt-5-nano",
    model: "gloo-openai-gpt-5-nano",
    label: "V2 · GPT-5 Nano",
  },
  {
    signature: "v2/model/openai-gpt-5-mini",
    model: "gloo-openai-gpt-5-mini",
    label: "V2 · GPT-5 Mini",
  },
  {
    signature: "v2/model/openai-gpt-5-pro",
    model: "gloo-openai-gpt-5-pro",
    label: "V2 · GPT-5 Pro",
  },
  {
    signature: "v2/model/openai-gpt-5.2",
    model: "gloo-openai-gpt-5.2",
    label: "V2 · GPT-5.2",
  },
  // Open source
  {
    signature: "v2/model/oss-llama-3.1-8b",
    model: "gloo-meta-llama-3.1-8b-instruct",
    label: "V2 · Llama 3.1 8B Instruct",
  },
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
    signature: "v2/model/oss-gpt-oss-120b",
    model: "gloo-openai-gpt-oss-120b",
    label: "V2 · GPT OSS 120B",
  },
];

// Some models (GPT-5 Pro, Opus 4.5, DeepSeek V3.2 with reasoning) can run
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
