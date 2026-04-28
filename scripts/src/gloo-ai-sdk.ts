/**
 * Vercel AI SDK provider wrapper for Gloo AI Completions V2.
 *
 * Mirrors `chatbot/lib/gloo-provider.ts` but lives in the `scripts/` package
 * so the integration tests can exercise the AI SDK code path without
 * cross-importing from the Next.js app.
 *
 * - Uses `@ai-sdk/openai-compatible` (Gloo Completions V2 is OpenAI-shaped).
 * - Resolves an OAuth2 client_credentials access token per-request via
 *   `getAccessToken` from `./auth.ts`. The token cache is intentionally
 *   tiny so repro tests don't share state across files.
 * - Strips the AI SDK's auto-injected `model` field when callers route via
 *   `auto_routing` or `model_family`. The Gloo V2 contract requires exactly
 *   one routing mechanism.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getAccessToken, loadCredentials, type Credentials } from "./auth.js";

export const GLOO_V2_BASE_URL = "https://platform.ai.gloo.com/ai/v2";

type CachedToken = { accessToken: string; expiresAt: number };

let cachedToken: CachedToken | null = null;

export async function getValidToken(creds: Credentials): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }
  const token = await getAccessToken(creds);
  if (!token.access_token) {
    throw new Error("Gloo OAuth2 token response missing access_token.");
  }
  const expiresIn = token.expires_in ?? 3600;
  cachedToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
  return token.access_token;
}

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
  credentials?: Credentials;
};

/**
 * Build an AI-SDK-compatible Gloo provider. The returned provider exposes a
 * chat-model factory: `gloo("model-id")` or `gloo("auto-routing")`. When
 * routing via `auto_routing` or `model_family`, pass an arbitrary placeholder
 * id — `normaliseRoutingBody` strips it before the request leaves the
 * process.
 */
export function createGlooProvider(options: GlooProviderOptions = {}) {
  const creds = options.credentials ?? loadCredentials();
  return createOpenAICompatible({
    name: "gloo",
    baseURL: GLOO_V2_BASE_URL,
    fetch: async (url, init) => {
      const token = await getValidToken(creds);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const body = normaliseRoutingBody(init?.body);
      return fetch(url, { ...init, headers, body });
    },
  });
}

/**
 * Reset the in-process token cache. Tests use this to start from a clean
 * slate so a stale token from a previous suite can't bleed into the next.
 */
export function resetGlooTokenCache(): void {
  cachedToken = null;
}
