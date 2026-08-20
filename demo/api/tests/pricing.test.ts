import { describe, expect, it, vi } from "vitest";
import {
  createRegistryLoader,
  estimateCostUsd,
  parseRegistry,
  type PricingIndex,
} from "../src/pricing.js";

/** Shaped like a real `/platform/v2/models` row, trimmed to what we read. */
const registryPayload = {
  object: "list",
  data: [
    {
      id: "gloo-google-gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      family: "Google",
      pricing: {
        input: { rate_per_1m_tokens: "0.300000" },
        output: { rate_per_1m_tokens: "2.500000" },
        cache_read: { rate_per_1m_tokens: "0.030000" },
      },
    },
    {
      id: "gloo-unpriced-model",
      name: "Unpriced",
      family: "Open Source",
      pricing: {},
    },
    { name: "row with no id", family: "Broken" },
    null,
  ],
};

describe("parseRegistry", () => {
  it("normalises string rates to numbers per million tokens", () => {
    const index = parseRegistry(registryPayload);
    const flash = index.get("gloo-google-gemini-2.5-flash");

    expect(flash?.inputRatePerMillion).toBe(0.3);
    expect(flash?.outputRatePerMillion).toBe(2.5);
    expect(flash?.cacheReadRatePerMillion).toBe(0.03);
  });

  it("drops malformed rows instead of discarding the whole registry", () => {
    const index = parseRegistry(registryPayload);
    expect(index.size).toBe(2);
    expect(index.has("gloo-unpriced-model")).toBe(true);
  });

  it("returns an empty index for a payload with no data array", () => {
    expect(parseRegistry({ object: "list" }).size).toBe(0);
    expect(parseRegistry(null).size).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  const index: PricingIndex = parseRegistry(registryPayload);

  it("prices uncached prompt and completion tokens at registry rates", () => {
    const cost = estimateCostUsd(
      "gloo-google-gemini-2.5-flash",
      { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
      index
    );
    expect(cost).toBeCloseTo(2.8, 8);
  });

  it("bills cached prompt tokens at the cache-read rate", () => {
    const cost = estimateCostUsd(
      "gloo-google-gemini-2.5-flash",
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedTokens: 1_000_000,
      },
      index
    );
    expect(cost).toBeCloseTo(0.03, 8);
  });

  it("returns null rather than a fabricated zero for unknown models", () => {
    expect(
      estimateCostUsd(
        "gloo-not-in-registry",
        { promptTokens: 100, completionTokens: 100, cachedTokens: 0 },
        index
      )
    ).toBeNull();
    expect(
      estimateCostUsd(
        null,
        { promptTokens: 100, completionTokens: 100, cachedTokens: 0 },
        index
      )
    ).toBeNull();
  });

  it("returns null when the registry carries no rates for the model", () => {
    expect(
      estimateCostUsd(
        "gloo-unpriced-model",
        { promptTokens: 100, completionTokens: 100, cachedTokens: 0 },
        index
      )
    ).toBeNull();
  });
});

describe("createRegistryLoader", () => {
  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("caches the registry for the TTL and refetches after it expires", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(registryPayload)
    );
    const load = createRegistryLoader({ ttlMs: 1000, fetchImpl });

    await load(0);
    await load(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await load(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the last good index when the registry is unreachable", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(registryPayload);
      }
      throw new Error("network down");
    });
    const load = createRegistryLoader({ ttlMs: 1, fetchImpl });

    const first = await load(0);
    expect(first.size).toBe(2);

    const second = await load(1000);
    expect(second.size).toBe(2);
  });

  it("yields an empty index when the first fetch fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const load = createRegistryLoader({ fetchImpl });

    expect((await load(0)).size).toBe(0);
  });
});
