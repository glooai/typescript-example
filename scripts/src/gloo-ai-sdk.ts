/**
 * Vercel AI SDK provider wrapper for Gloo AI Completions V2.
 *
 * Mirrors `chatbot/lib/gloo-provider.ts` but lives in the `scripts/` package
 * so the integration tests can exercise the AI SDK code path without
 * cross-importing from the Next.js app.
 *
 * Gloo Completions V2 is OpenAI-shaped, so `@ai-sdk/openai-compatible` fits
 * with one adjustment: the WorkOS API key is sent directly as the Bearer
 * credential (there is no token exchange step).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadApiKey } from "./auth.js";

export const GLOO_V2_BASE_URL = "https://platform.ai.gloo.com/ai/v2";

/**
 * Strip the AI SDK's auto-injected `model` field when the caller chose a
 * different routing mechanism (`auto_routing` or `model_family`). Without
 * this Gloo V2 returns 400 ("only one routing mechanism allowed").
 */
export function normaliseRoutingBody(
  body: BodyInit | null | undefined
): BodyInit {
  if (typeof body !== "string") {
    return body ?? "";
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.auto_routing || parsed.model_family) {
      delete parsed.model;
      return JSON.stringify(parsed);
    }
    return body;
  } catch {
    return body;
  }
}

export type GlooProviderOptions = {
  apiKey?: string;
};

/**
 * The returned provider exposes a chat-model factory: `gloo("model-id")`.
 * When routing via `auto_routing` or `model_family`, pass an arbitrary
 * placeholder id; `normaliseRoutingBody` strips it before the request leaves
 * the process.
 */
export function createGlooProvider(options: GlooProviderOptions = {}) {
  const apiKey = options.apiKey ?? loadApiKey();
  return createOpenAICompatible({
    name: "gloo",
    baseURL: GLOO_V2_BASE_URL,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
      const body = normaliseRoutingBody(init?.body);
      return fetch(url, { ...init, headers, body });
    },
  });
}
