/**
 * Unit tests for the pure helpers in `completions-v2-model-family-repro`.
 * We exercise parseResponse / summarize / formatSummaryLine / buildBody and
 * stub `fetch` for callOnce so the test suite stays offline-safe (no live
 * Gloo API calls — the repro script itself is interactive-only).
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildBody,
  callOnce,
  formatSummaryLine,
  MODEL_FAMILY_VARIANTS,
  parseResponse,
  summarize,
  type CallResult,
} from "../src/completions-v2-model-family-repro.js";

describe("buildBody", () => {
  it("includes the messages + auto_routing=false + the requested family verbatim", () => {
    const body = buildBody("Open Source");
    expect(body).toMatchObject({
      auto_routing: false,
      model_family: "Open Source",
      max_tokens: 20,
    });
    // Passes the family string through unchanged — the whole point of the
    // repro is that nothing in this script normalizes or reshapes the input.
    expect(buildBody("open-source").model_family).toBe("open-source");
  });
});

describe("parseResponse", () => {
  it("extracts the routed model from a 200 envelope", () => {
    const text = JSON.stringify({
      choices: [{ message: { content: "Pong." } }],
      model: "gloo-openai-gpt-oss-120b",
    });
    expect(parseResponse(text)).toEqual({
      routedModel: "gloo-openai-gpt-oss-120b",
    });
  });

  it("extracts the echoed model_family + trace_id from a 422 Pydantic envelope", () => {
    const text = JSON.stringify({
      detail: [
        {
          type: "value_error",
          loc: ["body"],
          msg: "Value error, Invalid model family 'open-source'.",
          input: {
            messages: [{ role: "user", content: "ping" }],
            auto_routing: false,
            model_family: "open-source",
          },
          ctx: { error: {} },
          trace_id: "abc123",
        },
      ],
    });
    expect(parseResponse(text)).toEqual({
      echoedFamily: "open-source",
      traceId: "abc123",
    });
  });

  it("extracts trace_id from the platform error envelope shape", () => {
    const text = JSON.stringify({
      detail: "Some other error",
      error: {
        message: "boom",
        trace_id: "xyz789",
      },
    });
    expect(parseResponse(text)).toEqual({ traceId: "xyz789" });
  });

  it("returns an empty object for non-JSON bodies", () => {
    expect(parseResponse("<html>oops</html>")).toEqual({});
    expect(parseResponse("")).toEqual({});
  });

  it("returns an empty object for a JSON primitive (null / string / number)", () => {
    expect(parseResponse("null")).toEqual({});
    expect(parseResponse('"just a string"')).toEqual({});
    expect(parseResponse("42")).toEqual({});
  });
});

describe("summarize", () => {
  const ok: CallResult = {
    status: 200,
    passed: true,
    routedModel: "gloo-openai-gpt-oss-120b",
  };
  const rejected: CallResult = {
    status: 422,
    passed: false,
    echoedFamily: "open-source",
    traceId: "trace-1",
  };

  it("tallies pass/fail, histogram, routed models, echoed families, and the first trace id", () => {
    const s = summarize("Open Source", [ok, ok, rejected, ok]);
    expect(s).toMatchObject({
      variant: "Open Source",
      calls: 4,
      passed: 3,
      failed: 1,
      routedModels: ["gloo-openai-gpt-oss-120b"],
      echoedFamilies: ["open-source"],
      firstTraceId: "trace-1",
    });
    expect(s.statusHistogram[200]).toBe(3);
    expect(s.statusHistogram[422]).toBe(1);
  });

  it("handles the all-pass and all-fail shapes cleanly", () => {
    expect(summarize("x", [ok, ok]).failed).toBe(0);
    expect(summarize("x", [rejected, rejected]).passed).toBe(0);
  });
});

describe("formatSummaryLine", () => {
  it("renders a one-line summary and flags mixed pass/fail as non-deterministic", () => {
    const line = formatSummaryLine({
      variant: "Open Source",
      calls: 4,
      passed: 3,
      failed: 1,
      statusHistogram: { 200: 3, 422: 1 },
      routedModels: ["gloo-openai-gpt-oss-120b"],
      echoedFamilies: ["open-source"],
      firstTraceId: "trace-1",
    });
    expect(line).toContain('"Open Source"');
    expect(line).toContain("3/4 pass");
    expect(line).toContain("200×3");
    expect(line).toContain("422×1");
    expect(line).toContain("gloo-openai-gpt-oss-120b");
    expect(line).toContain('"open-source"');
    expect(line).toContain("MIXED");
  });

  it("omits the MIXED marker when the variant is deterministic", () => {
    const line = formatSummaryLine({
      variant: "open-source",
      calls: 5,
      passed: 0,
      failed: 5,
      statusHistogram: { 422: 5 },
      routedModels: [],
      echoedFamilies: ["open-source"],
    });
    expect(line).not.toContain("MIXED");
  });
});

describe("MODEL_FAMILY_VARIANTS", () => {
  it("covers the three forms from the Keane/canary investigation (canonical, space-lower, hyphen-lower)", () => {
    expect(MODEL_FAMILY_VARIANTS).toContain("Open Source");
    expect(MODEL_FAMILY_VARIANTS).toContain("open source");
    expect(MODEL_FAMILY_VARIANTS).toContain("open-source");
  });
});

describe("callOnce", () => {
  it("POSTs to the V2 endpoint with Bearer auth + the variant in the body", async () => {
    const fakeFetch: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Pong." } }],
            model: "gloo-openai-gpt-oss-120b",
          }),
          { status: 200 }
        )
    );
    const result = await callOnce("test-token", "Open Source", fakeFetch);

    expect(result).toEqual({
      status: 200,
      passed: true,
      routedModel: "gloo-openai-gpt-oss-120b",
      bodyPreview: expect.stringContaining("gloo-openai-gpt-oss-120b"),
    });

    const mockedFetch = vi.mocked(fakeFetch);
    expect(mockedFetch).toHaveBeenCalledOnce();
    const [, init] = mockedFetch.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token"
    );
    const body = JSON.parse(String(init?.body));
    expect(body.model_family).toBe("Open Source");
    expect(body.auto_routing).toBe(false);
  });

  it("flags non-2xx responses as failed and keeps the echoed family", async () => {
    const fakeFetch: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: [
              {
                input: { model_family: "open-source" },
                trace_id: "trace-xyz",
              },
            ],
          }),
          { status: 422 }
        )
    );
    const result = await callOnce("test-token", "open-source", fakeFetch);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(422);
    expect(result.echoedFamily).toBe("open-source");
    expect(result.traceId).toBe("trace-xyz");
  });
});
