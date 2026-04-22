import { expect, it } from "vitest";
import { fetchV2Models } from "../../src/fixtures/v2-models.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

it("fetchV2Models returns the id/family/name subset from a valid response", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      object: "list",
      data: [
        {
          id: "gloo-anthropic-claude-haiku-4.5",
          provider_id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          family: "Anthropic",
          description: "ignored",
          context_window: 200000,
          pricing: { input: { rate_per_1k_tokens: "0.00015" } },
        },
        {
          id: "gloo-openai-gpt-5.2",
          provider_id: "openai/gpt-5.2",
          name: "GPT-5.2",
          family: "OpenAI",
        },
      ],
    });

  const models = await fetchV2Models({
    modelsUrl: "https://example.test/platform/v2/models",
    fetchImpl,
  });
  expect(models).toEqual([
    {
      id: "gloo-anthropic-claude-haiku-4.5",
      family: "Anthropic",
      name: "Claude Haiku 4.5",
    },
    { id: "gloo-openai-gpt-5.2", family: "OpenAI", name: "GPT-5.2" },
  ]);
});

it("fetchV2Models throws when the endpoint returns a non-2xx", async () => {
  const fetchImpl = async () =>
    new Response("Service Unavailable", { status: 503 });

  await expect(
    fetchV2Models({ modelsUrl: "https://example.test/m", fetchImpl })
  ).rejects.toThrow(/failed with status 503/);
});

it("fetchV2Models throws when the response body is not JSON", async () => {
  const fetchImpl = async () =>
    new Response("<html>nginx 502</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  await expect(
    fetchV2Models({ modelsUrl: "https://example.test/m", fetchImpl })
  ).rejects.toThrow(/non-JSON body/);
});

it("fetchV2Models throws when the shape is missing required fields", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      data: [{ id: "ok", family: "OpenAI" /* missing name */ }],
    });

  await expect(
    fetchV2Models({ modelsUrl: "https://example.test/m", fetchImpl })
  ).rejects.toThrow(/expected shape/);
});

it("fetchV2Models throws when data is empty — a canary with zero models is a bug", async () => {
  const fetchImpl = async () => jsonResponse({ data: [] });
  await expect(
    fetchV2Models({ modelsUrl: "https://example.test/m", fetchImpl })
  ).rejects.toThrow(/expected shape/);
});
