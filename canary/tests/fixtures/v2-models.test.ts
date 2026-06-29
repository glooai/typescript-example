import { expect, it } from "vitest";
import {
  fetchV2Models,
  isTextOutputModel,
} from "../../src/fixtures/v2-models.js";

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
  // Neither entry declared output_modalities, so both default to text.
  expect(models).toEqual([
    {
      id: "gloo-anthropic-claude-haiku-4.5",
      family: "Anthropic",
      name: "Claude Haiku 4.5",
      outputModalities: ["text"],
    },
    {
      id: "gloo-openai-gpt-5.2",
      family: "OpenAI",
      name: "GPT-5.2",
      outputModalities: ["text"],
    },
  ]);
});

it("fetchV2Models carries output_modalities through and defaults to text when absent", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      object: "list",
      data: [
        {
          id: "gloo-bfl-flux-2-pro",
          name: "FLUX.2 Pro",
          family: "Black Forest Labs",
          input_modalities: ["text", "image"],
          output_modalities: ["image"],
        },
        {
          // No output_modalities field — must default to ["text"].
          id: "gloo-openai-gpt-5.2",
          name: "GPT-5.2",
          family: "OpenAI",
        },
      ],
    });

  const models = await fetchV2Models({
    modelsUrl: "https://example.test/m",
    fetchImpl,
  });
  const flux = models.find((m) => m.id === "gloo-bfl-flux-2-pro");
  const gpt = models.find((m) => m.id === "gloo-openai-gpt-5.2");
  expect(flux?.outputModalities).toEqual(["image"]);
  expect(gpt?.outputModalities).toEqual(["text"]);
});

it("isTextOutputModel is false for image-only models, true for text and absent-modality models", () => {
  expect(
    isTextOutputModel({
      id: "gloo-bfl-flux-2-pro",
      family: "Black Forest Labs",
      name: "FLUX.2 Pro",
      outputModalities: ["image"],
    })
  ).toBe(false);
  expect(
    isTextOutputModel({
      id: "gloo-openai-gpt-5.2",
      family: "OpenAI",
      name: "GPT-5.2",
      outputModalities: ["text"],
    })
  ).toBe(true);
  // A hypothetical multimodal model that outputs both text and image is
  // still text-capable on V2 — it can return the text completion.
  expect(
    isTextOutputModel({
      id: "gloo-multimodal",
      family: "Anthropic",
      name: "Multimodal",
      outputModalities: ["text", "image"],
    })
  ).toBe(true);
  // Absent modalities default to text-output so the canary doesn't drop
  // every probe if the registry stops advertising the field.
  expect(isTextOutputModel({ id: "gloo-x", family: "OpenAI", name: "X" })).toBe(
    true
  );
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
