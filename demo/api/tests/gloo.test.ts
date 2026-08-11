import { describe, expect, it } from "vitest";
import {
  applyChunk,
  createAccumulator,
  parseSseBuffer,
  toMetrics,
} from "../src/gloo.js";
import { parseRegistry } from "../src/pricing.js";

const pricing = parseRegistry({
  data: [
    {
      id: "gloo-google-gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      family: "Google",
      pricing: {
        input: { rate_per_1m_tokens: "0.300000" },
        output: { rate_per_1m_tokens: "2.500000" },
      },
    },
  ],
});

describe("parseSseBuffer", () => {
  it("returns complete frames and keeps the partial tail", () => {
    const { events, rest } = parseSseBuffer(
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":'
    );

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('data: {"c":');
  });

  it("reports the terminal sentinel as null", () => {
    const { events } = parseSseBuffer('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(events).toEqual([{ a: 1 }, null]);
  });

  it("skips non-JSON and non-data lines without failing the stream", () => {
    const { events } = parseSseBuffer(": keep-alive\n\ndata: not json\n\n");
    expect(events).toEqual([]);
  });
});

describe("applyChunk", () => {
  it("accumulates streamed deltas and routing metadata", () => {
    const accumulator = createAccumulator();

    applyChunk(accumulator, {
      model: "gloo-google-gemini-2.5-flash",
      model_family: "Google",
      ttft_ms: 985.74,
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    });
    applyChunk(accumulator, {
      choices: [{ delta: { content: ", world" }, finish_reason: "stop" }],
    });
    applyChunk(accumulator, {
      choices: [],
      usage: {
        prompt_tokens: 1129,
        completion_tokens: 34,
        cache_read_input_tokens: 12,
      },
    });

    expect(accumulator.text).toBe("Hello, world");
    expect(accumulator.model).toBe("gloo-google-gemini-2.5-flash");
    expect(accumulator.family).toBe("Google");
    expect(accumulator.ttftMs).toBeCloseTo(985.74, 2);
    expect(accumulator.promptTokens).toBe(1129);
    expect(accumulator.completionTokens).toBe(34);
    expect(accumulator.cachedTokens).toBe(12);
    expect(accumulator.done).toBe(true);
  });

  it("reads a buffered completion body from the message field", () => {
    const accumulator = createAccumulator();

    applyChunk(accumulator, {
      model: "gloo-anthropic-claude-sonnet-4.5",
      model_family: "Anthropic",
      routing_tier: "tier_2",
      routing_confidence: 0.916,
      choices: [
        { message: { content: "Hi! How can I help?" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1242, completion_tokens: 10 },
    });

    expect(accumulator.text).toBe("Hi! How can I help?");
    expect(accumulator.routingTier).toBe("tier_2");
    expect(accumulator.routingConfidence).toBe(0.916);
  });

  it("ignores payloads that are not objects", () => {
    const accumulator = createAccumulator();
    applyChunk(accumulator, "nonsense");
    expect(accumulator.text).toBe("");
  });
});

describe("toMetrics", () => {
  it("costs the call from observed tokens and the live registry", () => {
    const accumulator = createAccumulator();
    applyChunk(accumulator, {
      model: "gloo-google-gemini-2.5-flash",
      choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    });

    const metrics = toMetrics({
      requestId: "req-1",
      selection: { mode: "auto_routing" },
      accumulator,
      latencyMs: 1234.6,
      pricing,
    });

    expect(metrics.costUsd).toBeCloseTo(2.8, 8);
    expect(metrics.latencyMs).toBe(1235);
    expect(metrics.requested).toBe("auto");
    expect(metrics.routingMechanism).toBe("auto_routing");
    expect(metrics.status).toBe("ok");
  });

  it("carries the error message through on a failed call", () => {
    const metrics = toMetrics({
      requestId: "req-2",
      selection: { mode: "model", model: "gloo-broken" },
      accumulator: createAccumulator(),
      latencyMs: 10,
      pricing,
      status: "error",
      errorMessage: "Gloo returned 503",
    });

    expect(metrics.status).toBe("error");
    expect(metrics.errorMessage).toBe("Gloo returned 503");
    expect(metrics.costUsd).toBeNull();
  });
});
