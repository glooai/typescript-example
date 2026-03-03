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

    // Gloo V2 requires exactly one routing mechanism (auto_routing, model,
    // or model_family). The AI SDK always sends `model`, so strip it when
    // a different routing mechanism is active.
    let body = init?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (parsed.auto_routing || parsed.model_family) {
          delete parsed.model;
          body = JSON.stringify(parsed);
        }
      } catch {
        // leave body unchanged if it's not JSON
      }
    }

    return fetch(url, { ...init, headers, body });
  },
});
