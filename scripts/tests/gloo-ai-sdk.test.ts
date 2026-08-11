/**
 * Unit tests for the AI-SDK Gloo provider helper.
 *
 * The integration test (`ai-sdk-structured-refusal.integration.test.ts`)
 * exercises this module end-to-end against the live Gloo API but skips on
 * CI (no real API key). These unit tests stub fetch so the same code paths
 * run without network access and the package coverage gate stays satisfied.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { generateText } from "ai";
import {
  createGlooProvider,
  GLOO_V2_BASE_URL,
  normaliseRoutingBody,
} from "../src/gloo-ai-sdk.js";

const TEST_API_KEY = "unit-test-api-key";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normaliseRoutingBody", () => {
  it("passes through non-string bodies unchanged", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(normaliseRoutingBody(buf)).toBe(buf);
  });

  it("returns an empty string when body is null", () => {
    expect(normaliseRoutingBody(null)).toBe("");
  });

  it("returns an empty string when body is undefined", () => {
    expect(normaliseRoutingBody(undefined)).toBe("");
  });

  it("returns the original string when body is not JSON", () => {
    expect(normaliseRoutingBody("not json")).toBe("not json");
  });

  it("leaves a normal model-routed body untouched", () => {
    const body = JSON.stringify({
      model: "gloo-anthropic-claude-haiku-4.5",
      messages: [],
    });
    expect(normaliseRoutingBody(body)).toBe(body);
  });

  it("strips the AI-SDK-injected model field when auto_routing is set", () => {
    const body = JSON.stringify({
      model: "ignored-placeholder",
      auto_routing: true,
      messages: [],
    });
    const out = JSON.parse(normaliseRoutingBody(body) as string);
    expect(out.model).toBeUndefined();
    expect(out.auto_routing).toBe(true);
  });

  it("strips the AI-SDK-injected model field when model_family is set", () => {
    const body = JSON.stringify({
      model: "ignored-placeholder",
      model_family: "anthropic",
      messages: [],
    });
    const out = JSON.parse(normaliseRoutingBody(body) as string);
    expect(out.model).toBeUndefined();
    expect(out.model_family).toBe("anthropic");
  });
});

describe("createGlooProvider", () => {
  it("exposes the Gloo V2 base URL constant", () => {
    expect(GLOO_V2_BASE_URL).toBe("https://platform.ai.gloo.com/ai/v2");
  });

  it("attaches a Bearer API key, normalises the body, and forwards to V2", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        // Validate that the AI-SDK-injected model field was stripped from
        // the body when auto_routing is on.
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.auto_routing) {
          expect(body.model).toBeUndefined();
        }
        // Confirm the Authorization header was injected.
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);

        return new Response(
          JSON.stringify({
            id: "chatcmpl-unit-test",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gloo-anthropic-claude-haiku-4.5",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "ok" },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 1,
              total_tokens: 11,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

    const gloo = createGlooProvider({ apiKey: TEST_API_KEY });

    const result = await generateText({
      model: gloo("gloo-anthropic-claude-haiku-4.5"),
      prompt: "ping",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const chatCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/ai/v2/chat/completions")
    );
    expect(chatCall).toBeDefined();
  });
});
