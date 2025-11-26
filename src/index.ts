import { config as loadEnv } from "dotenv";
import { decode as decodeJwt, JwtPayload } from "jsonwebtoken";
import { fileURLToPath } from "node:url";

loadEnv({ path: ".env.local" });

const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";
const CHAT_URL = "https://platform.ai.gloo.com/ai/v1/chat/completions";
const MODEL = "meta.llama3-70b-instruct-v1:0";

type Credentials = {
  clientId: string;
  clientSecret: string;
};

type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  [key: string]: unknown;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

function withTimeout(initMs: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), initMs).unref();
  return controller;
}

async function fetchJson<TResponse>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<TResponse> {
  const controller = withTimeout(timeoutMs);
  const response = await fetch(url, { ...init, signal: controller.signal });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Request to ${url} failed with status ${response.status}: ${text}`
    );
  }
  return (await response.json()) as TResponse;
}

export function loadCredentials(): Credentials {
  return {
    clientId: requireEnv("GLOO_AI_CLIENT_ID"),
    clientSecret: requireEnv("GLOO_AI_CLIENT_SECRET"),
  };
}

export async function getAccessToken({
  clientId,
  clientSecret,
}: Credentials): Promise<TokenResponse> {
  const encodedCredentials = Buffer.from(
    `${clientId}:${clientSecret}`
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

export function describeExpiration(accessToken: string): number | null {
  const decoded = decodeJwt(accessToken) as JwtPayload | null;
  if (!decoded || typeof decoded.exp !== "number") {
    return null;
  }
  return decoded.exp;
}

export async function getChatCompletion(
  accessToken: string,
  prompt: string
): Promise<ChatCompletionResponse> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a human-flourishing assistant.",
    },
    { role: "user", content: prompt },
  ];

  return fetchJson<ChatCompletionResponse>(
    CHAT_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
      }),
    },
    30_000
  );
}

export async function runExample(
  prompt = "How do I discover my purpose?"
): Promise<void> {
  const { clientId, clientSecret } = loadCredentials();
  const tokenResponse = await getAccessToken({ clientId, clientSecret });
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  const expiration = describeExpiration(accessToken);
  console.log(
    `Token expires at (unix seconds): ${expiration ?? "unknown (missing exp)"}`
  );

  const completion = await getChatCompletion(accessToken, prompt);
  console.log(JSON.stringify(completion, null, 2));
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  runExample().catch((error) => {
    console.error("Error running chat example:", error);
    process.exitCode = 1;
  });
}
