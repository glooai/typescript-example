let cachedApiKey: string | null = null;

/**
 * Reads the Gloo AI WorkOS API key. The key is sent directly as the
 * request's Bearer credential; there is no token exchange step.
 */
export function getApiKey(): string {
  if (cachedApiKey) {
    return cachedApiKey;
  }
  const apiKey = process.env.GLOO_AI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GLOO_AI_API_KEY environment variable");
  }
  cachedApiKey = apiKey;
  return apiKey;
}
