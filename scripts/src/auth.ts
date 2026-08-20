function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

export function withTimeout(initMs: number): {
  controller: AbortController;
  clearTimer: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), initMs);
  timeout.unref();

  return { controller, clearTimer: () => clearTimeout(timeout) };
}

export async function fetchJson<TResponse>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<TResponse> {
  const { controller, clearTimer } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Request to ${url} failed with status ${response.status}: ${text}`
      );
    }
    return (await response.json()) as TResponse;
  } finally {
    clearTimer();
  }
}

/**
 * Reads the WorkOS API key used for all Gloo AI platform calls. The key is
 * sent directly as the request's Bearer credential; there is no token
 * exchange step (API keys replaced the OAuth2 client_credentials flow).
 */
export function loadApiKey(): string {
  return requireEnv("GLOO_AI_API_KEY");
}

export function authHeader(apiKey: string): { Authorization: string } {
  return { Authorization: `Bearer ${apiKey}` };
}
