const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";

type TokenResponse = {
  access_token: string;
  expires_in?: number;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
let pendingTokenRequest: Promise<string> | null = null;

function getCredentials() {
  const clientId = process.env.GLOO_CLIENT_ID;
  const clientSecret = process.env.GLOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GLOO_CLIENT_ID or GLOO_CLIENT_SECRET environment variables"
    );
  }
  return { clientId, clientSecret };
}

async function fetchToken(): Promise<string> {
  const { clientId, clientSecret } = getCredentials();
  const encodedCredentials = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  ).toString("base64");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${encodedCredentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api/access",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;
  const expiresIn = data.expires_in ?? 3600;

  cachedToken = {
    accessToken: data.access_token,
    // Refresh 60 seconds before actual expiry
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };

  return data.access_token;
}

export async function getValidToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  // Request coalescing — prevent thundering herd on cold starts
  if (!pendingTokenRequest) {
    pendingTokenRequest = fetchToken().finally(() => {
      pendingTokenRequest = null;
    });
  }

  return pendingTokenRequest;
}
