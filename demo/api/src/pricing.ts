/**
 * Model registry and cost estimation.
 *
 * Gloo publishes pricing on the same unauthenticated endpoint that backs
 * the public supported-models page:
 *   GET https://platform.ai.gloo.com/platform/v2/models
 * Costing against that live feed (rather than a checked-in price table)
 * means the demo's dollar figures cannot drift from the platform, and the
 * "observed cost" view is real arithmetic on real token counts rather than
 * a hardcoded guess.
 */

export const V2_MODELS_URL = "https://platform.ai.gloo.com/platform/v2/models";

/** Registry pricing for one model, normalised to dollars per 1M tokens. */
export type ModelPricing = {
  id: string;
  name: string;
  family: string;
  inputRatePerMillion: number | null;
  outputRatePerMillion: number | null;
  cacheReadRatePerMillion: number | null;
};

export type PricingIndex = Map<string, ModelPricing>;

function parseRate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readRatePerMillion(node: unknown): number | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  return parseRate((node as Record<string, unknown>).rate_per_1m_tokens);
}

/**
 * Map a raw `/platform/v2/models` payload into a pricing index. Entries
 * missing an id are dropped rather than throwing: one malformed row should
 * not cost us the whole registry (the canary package learned this the hard
 * way, see canary/src/fixtures/v2-models.ts).
 */
export function parseRegistry(payload: unknown): PricingIndex {
  const index: PricingIndex = new Map();
  const data =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).data
      : undefined;
  if (!Array.isArray(data)) {
    return index;
  }

  for (const raw of data) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id) {
      continue;
    }
    const pricing =
      entry.pricing && typeof entry.pricing === "object"
        ? (entry.pricing as Record<string, unknown>)
        : {};

    index.set(id, {
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      family: typeof entry.family === "string" ? entry.family : "Unknown",
      inputRatePerMillion: readRatePerMillion(pricing.input),
      outputRatePerMillion: readRatePerMillion(pricing.output),
      cacheReadRatePerMillion: readRatePerMillion(pricing.cache_read),
    });
  }

  return index;
}

export type ObservedUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
};

/**
 * Estimate the dollar cost of one call from observed token counts.
 *
 * Gloo reports `cache_read_input_tokens` as a subset of `prompt_tokens`, so
 * cached tokens are billed at the cache-read rate and the remainder at the
 * full input rate. Returns null when the model is unknown to the registry
 * or the registry omits a rate, so the UI can show "unpriced" instead of a
 * fabricated zero.
 */
export function estimateCostUsd(
  modelId: string | null,
  usage: ObservedUsage,
  index: PricingIndex
): number | null {
  if (!modelId) {
    return null;
  }
  const pricing = index.get(modelId);
  if (
    !pricing ||
    pricing.inputRatePerMillion === null ||
    pricing.outputRatePerMillion === null
  ) {
    return null;
  }

  const cached = Math.max(0, Math.min(usage.cachedTokens, usage.promptTokens));
  const uncachedPrompt = usage.promptTokens - cached;
  const cacheRate =
    pricing.cacheReadRatePerMillion ?? pricing.inputRatePerMillion;

  const dollars =
    (uncachedPrompt * pricing.inputRatePerMillion +
      cached * cacheRate +
      usage.completionTokens * pricing.outputRatePerMillion) /
    1_000_000;

  // Sub-cent costs are the norm here, so keep eight decimal places.
  return Math.round(dollars * 1e8) / 1e8;
}

/**
 * Cold-start-cached registry fetch. A Lambda execution environment handles
 * many requests, so refetching per request would add latency to every call
 * for data that changes on a scale of weeks.
 */
export function createRegistryLoader(
  options: {
    ttlMs?: number;
    fetchImpl?: typeof fetch;
    url?: string;
  } = {}
) {
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? V2_MODELS_URL;

  let cached: PricingIndex = new Map();
  let loadedAt = 0;

  return async function loadRegistry(now = Date.now()): Promise<PricingIndex> {
    if (cached.size > 0 && now - loadedAt < ttlMs) {
      return cached;
    }
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return cached;
      }
      const parsed = parseRegistry(await response.json());
      if (parsed.size > 0) {
        cached = parsed;
        loadedAt = now;
      }
      return cached;
    } catch {
      // A registry outage must not take the demo down: fall back to the
      // last good index (possibly empty, which just means "unpriced").
      return cached;
    }
  };
}
