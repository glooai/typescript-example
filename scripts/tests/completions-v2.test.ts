import { expect, it, vi, afterEach } from "vitest";
import {
  COMPLETIONS_V2_URL,
  REFUSAL_PATTERNS,
  looksLikeRefusal,
  postCompletionsV2,
  type CompletionsV2Request,
  type CompletionsV2Response,
} from "../src/completions-v2.js";

type FetchCall = {
  url?: string | URL | Request;
  init?: RequestInit;
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("pins the production Completions V2 URL", () => {
  expect(COMPLETIONS_V2_URL).toBe(
    "https://platform.ai.gloo.com/ai/v2/chat/completions"
  );
});

it("posts a chat request with the Bearer token and JSON body", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      const body: CompletionsV2Response = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "gloo-anthropic-claude-haiku-4.5",
        routing_mechanism: "auto_routing",
        routing_tier: "tier_1",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "hello" },
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

  const request: CompletionsV2Request = {
    messages: [{ role: "user", content: "hi" }],
    auto_routing: true,
  };

  const response = await postCompletionsV2("token-xyz", request);

  expect(response.choices[0].message.content).toBe("hello");
  expect(response.routing_mechanism).toBe("auto_routing");
  expect(calls.url).toBe(COMPLETIONS_V2_URL);
  expect(calls.init?.method).toBe("POST");
  expect(calls.init?.headers).toMatchObject({
    Authorization: "Bearer token-xyz",
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const parsedBody = JSON.parse(String(calls.init?.body ?? "{}"));
  expect(parsedBody).toEqual(request);
  fetchSpy.mockRestore();
});

it("propagates HTTP errors from the platform", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response('{"error":"Content policy"}', {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  });

  await expect(
    postCompletionsV2("token-xyz", {
      messages: [{ role: "user", content: "hi" }],
      auto_routing: true,
    })
  ).rejects.toThrow(/status 400/);
});

it("accepts a custom timeout without mutating the request", async () => {
  const calls: FetchCall = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.init = init;
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const request: CompletionsV2Request = {
    messages: [{ role: "user", content: "hi" }],
    model: "gloo-anthropic-claude-haiku-4.5",
  };
  await postCompletionsV2("token-xyz", request, 90_000);

  // Ensure the body is the exact request (no middleware mutation).
  expect(JSON.parse(String(calls.init?.body ?? "{}"))).toEqual(request);
  // AbortSignal should be attached for the timeout.
  expect(calls.init?.signal).toBeInstanceOf(AbortSignal);
});

it("has refusal patterns sourced from the actual bug-report screenshot", () => {
  expect(REFUSAL_PATTERNS.length).toBeGreaterThanOrEqual(5);
  // Every entry should be a RegExp so looksLikeRefusal can apply .test().
  for (const pattern of REFUSAL_PATTERNS) {
    expect(pattern).toBeInstanceOf(RegExp);
  }
});

it("flags refusals that cite drug / medical-harm safety language", () => {
  expect(
    looksLikeRefusal(
      "I can't help with that. If you're thinking about unsafe drug use, please contact a professional."
    )
  ).toBe(true);
  expect(
    looksLikeRefusal(
      "This may involve poisoning or overdose — please call 911."
    )
  ).toBe(true);
  expect(looksLikeRefusal("That could cause dangerous medical harm.")).toBe(
    true
  );
  expect(looksLikeRefusal("Please seek addiction treatment.")).toBe(true);
});

it("handles curly apostrophes in refusals (copy-pasted from chat UIs)", () => {
  // Real-world assistant replies often use the Unicode curly apostrophe U+2019
  // rather than a straight apostrophe. The pattern must match both.
  expect(looksLikeRefusal("I can\u2019t help with that.")).toBe(true);
  expect(looksLikeRefusal("I can't help with that.")).toBe(true);
});

it("does NOT flag legitimate answers as refusals", () => {
  expect(
    looksLikeRefusal(
      "To homestead your house in Waco TX, file form 50-114 with the McLennan County Appraisal District."
    )
  ).toBe(false);
  expect(looksLikeRefusal("")).toBe(false);
  expect(
    looksLikeRefusal("Here is a thoughtful answer about your taxes.")
  ).toBe(false);
});
