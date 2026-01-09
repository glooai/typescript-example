const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";

export type Credentials = {
  clientId: string;
  clientSecret: string;
};

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

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

export function loadCredentials(): Credentials {
  return {
    clientId: requireEnv("GLOO_CLIENT_ID"),
    clientSecret: requireEnv("GLOO_CLIENT_SECRET"),
  };
}

export async function getAccessToken({
  clientId,
  clientSecret,
}: Credentials): Promise<TokenResponse> {
  const encodedCredentials = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  ).toString("base64");

  return fetchJson<TokenResponse>(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${encodedCredentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "api/access",
      }),
    },
    10_000
  );
}
