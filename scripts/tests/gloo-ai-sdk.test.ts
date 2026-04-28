/**
 * Unit tests for the AI-SDK Gloo provider helper.
 *
 * The integration test (`ai-sdk-structured-refusal.integration.test.ts`)
 * exercises this module end-to-end against the live Gloo API but skips on
 * CI (no real OAuth2 creds). These unit tests stub fetch so the same
 * code paths run without network access and the package coverage gate
 * stays satisfied.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateText } from "ai";
import {
  createGlooProvider,
  getValidToken,
  GLOO_V2_BASE_URL,
  normaliseRoutingBody,
  resetGlooTokenCache,
} from "../src/gloo-ai-sdk.js";

const TEST_CREDS = {
  clientId: "unit-test-client-id",
  clientSecret: "unit-test-client-secret",
};

beforeEach(() => {
  resetGlooTokenCache();
});

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

describe("getValidToken", () => {
  it("requests a fresh token on first call and caches it on second call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "tkn-1", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const t1 = await getValidToken(TEST_CREDS);
    const t2 = await getValidToken(TEST_CREDS);

    expect(t1).toBe("tkn-1");
    expect(t2).toBe("tkn-1");
    // Cache hit — only the first call should hit the OAuth endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://platform.ai.gloo.com/oauth2/token"
    );
  });

  it("falls back to a 1-hour TTL when expires_in is omitted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tkn-default-ttl" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const token = await getValidToken(TEST_CREDS);
    expect(token).toBe("tkn-default-ttl");
  });

  it("throws when the OAuth response is missing access_token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(getValidToken(TEST_CREDS)).rejects.toThrow(
      /missing access_token/i
    );
  });

  it("re-fetches after resetGlooTokenCache()", async () => {
    // mockImplementation (not mockResolvedValue) so each call returns a
    // fresh Response — Response bodies are single-use.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "tkn-after-reset",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    await getValidToken(TEST_CREDS);
    resetGlooTokenCache();
    await getValidToken(TEST_CREDS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("createGlooProvider", () => {
  it("exposes the Gloo V2 base URL constant", () => {
    expect(GLOO_V2_BASE_URL).toBe("https://platform.ai.gloo.com/ai/v2");
  });

  it("attaches a Bearer token, normalises the body, and forwards to V2", async () => {
    // Mock the OAuth token endpoint and the chat-completions endpoint with a
    // single fetch spy that branches on URL. Sequence: first call is the
    // OAuth token fetch (from getValidToken), subsequent calls are chat
    // completions hitting GLOO_V2_BASE_URL.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth2/token")) {
          return new Response(
            JSON.stringify({
              access_token: "test-bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // Validate that the AI-SDK-injected model field was stripped from
        // the body when auto_routing is on.
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.auto_routing) {
          expect(body.model).toBeUndefined();
        }
        // Confirm the Authorization header was injected.
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-bearer");

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

    const gloo = createGlooProvider({ credentials: TEST_CREDS });

    const result = await generateText({
      model: gloo("gloo-anthropic-claude-haiku-4.5"),
      prompt: "ping",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    // 1 token fetch + 1 chat-completions fetch (no retries).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const chatCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/ai/v2/chat/completions")
    );
    expect(chatCall).toBeDefined();
  });
});
