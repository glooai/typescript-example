import { config as loadEnv } from "dotenv";
import jwt from "jsonwebtoken";
import type { JwtPayload, Secret, VerifyOptions } from "jsonwebtoken";
import { fileURLToPath } from "node:url";
import {
  loadCredentials,
  getAccessToken,
  fetchJson,
  type Credentials,
  type TokenResponse,
} from "./auth.js";

export {
  loadCredentials,
  getAccessToken,
  type Credentials,
  type TokenResponse,
};

const CHAT_URL = "https://platform.ai.gloo.com/ai/v1/chat/completions";
const MODEL = "meta.llama3-70b-instruct-v1:0";

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

/**
 * Returns the exp claim from an access token.
 * When no verification key is provided the value is informational only.
 * Pass verification options (algorithms/issuer/audience, etc.) to constrain
 * which tokens will be accepted when a verification key is supplied.
 */
export function describeExpiration(
  accessToken: string,
  verificationKey?: Secret,
  verificationOptions?: VerifyOptions
): number | null {
  try {
    const payload = verificationKey
      ? (jwt.verify(
          accessToken,
          verificationKey,
          verificationOptions
        ) as JwtPayload)
      : (jwt.decode(accessToken) as JwtPayload | null);

    if (!payload || typeof payload.exp !== "number") {
      return null;
    }

    return payload.exp;
  } catch {
    return null;
  }
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
    `Token expires at (unix seconds, not verified): ${
      expiration ?? "unknown (missing exp)"
    }`
  );

  const completion = await getChatCompletion(accessToken, prompt);
  console.log(JSON.stringify(completion, null, 2));
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  runExample().catch((error) => {
    console.error("Error running chat example:", error);
    process.exitCode = 1;
  });
}
