import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getValidToken } from "./gloo-auth";

export const gloo = createOpenAICompatible({
  name: "gloo",
  baseURL: "https://platform.ai.gloo.com/ai/v2",
  // Dynamic Bearer token via custom fetch (OAuth2, not static API key)
  fetch: async (url, init) => {
    const token = await getValidToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  },
});
