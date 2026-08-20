import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiKey, fetchJson, withTimeout } from "./auth.js";

export { loadApiKey, fetchJson, withTimeout };

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
  const apiKey = loadApiKey();

  const completion = await getChatCompletion(apiKey, prompt);
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
