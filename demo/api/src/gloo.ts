/**
 * Gloo Completions V2 client used by the proxy service.
 *
 * The API key never leaves this process: the browser talks to the proxy,
 * the proxy talks to Gloo. Same Bearer-credential pattern as
 * `scripts/src/gloo-ai-sdk.ts` and `chatbot/lib/gloo-provider.ts`, minus
 * the AI SDK, because the proxy forwards raw OpenAI-shaped SSE frames
 * rather than re-encoding them.
 */
import type { CallMetrics, RoutingSelection } from "./types.js";
import { buildGlooBody, describeSelection } from "./routing.js";
import { estimateCostUsd, type PricingIndex } from "./pricing.js";

export const GLOO_COMPLETIONS_URL =
  "https://platform.ai.gloo.com/ai/v2/chat/completions";

/**
 * Upper bound on any single upstream call. The ALB and the CloudFront origin
 * both time out after 60s of silence rather than 60s in total, and a stream
 * that is producing tokens is never silent, so this only bites a call that
 * has genuinely stalled.
 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Running totals scraped out of an OpenAI-shaped completion or SSE stream. */
export type StreamAccumulator = {
  text: string;
  model: string | null;
  family: string | null;
  routingTier: string | null;
  routingConfidence: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  ttftMs: number | null;
  done: boolean;
};

export function createAccumulator(): StreamAccumulator {
  return {
    text: "",
    model: null,
    family: null,
    routingTier: null,
    routingConfidence: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    ttftMs: null,
    done: false,
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Fold one parsed SSE payload (or one buffered completion body) into the
 * accumulator. Mutates and returns the accumulator so a streaming loop can
 * call it once per frame without allocating.
 *
 * Gloo sends the usage totals in a dedicated terminal chunk with an empty
 * `choices` array, and reports time-to-first-token as `ttft_ms` on the
 * first content chunk. Both are picked up here.
 */
export function applyChunk(
  accumulator: StreamAccumulator,
  chunk: unknown
): StreamAccumulator {
  if (!chunk || typeof chunk !== "object") {
    return accumulator;
  }
  const payload = chunk as Record<string, unknown>;

  accumulator.model = readString(payload.model) ?? accumulator.model;
  accumulator.family = readString(payload.model_family) ?? accumulator.family;
  accumulator.routingTier =
    readString(payload.routing_tier) ?? accumulator.routingTier;
  accumulator.routingConfidence =
    readNumber(payload.routing_confidence) ?? accumulator.routingConfidence;
  accumulator.ttftMs = readNumber(payload.ttft_ms) ?? accumulator.ttftMs;

  const usage = payload.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    accumulator.promptTokens =
      readNumber(u.prompt_tokens) ?? accumulator.promptTokens;
    accumulator.completionTokens =
      readNumber(u.completion_tokens) ?? accumulator.completionTokens;
    accumulator.cachedTokens =
      readNumber(u.cache_read_input_tokens) ?? accumulator.cachedTokens;
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const message = choice.message as Record<string, unknown> | undefined;
    const text =
      readString(delta?.content) ?? readString(message?.content) ?? null;
    if (text) {
      accumulator.text += text;
    }
    if (readString(choice.finish_reason)) {
      accumulator.done = true;
    }
  }

  return accumulator;
}

/**
 * Split a raw SSE buffer into complete `data:` payloads plus the trailing
 * remainder that has not arrived in full yet. Returns `[DONE]` sentinels to
 * the caller as `null` entries so it can stop without string-matching.
 */
export function parseSseBuffer(buffer: string): {
  events: Array<unknown | null>;
  rest: string;
} {
  const events: Array<unknown | null> = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload.length === 0) {
        continue;
      }
      if (payload === "[DONE]") {
        events.push(null);
        continue;
      }
      try {
        events.push(JSON.parse(payload));
      } catch {
        // A truncated or non-JSON frame is not worth failing the stream over.
      }
    }
  }

  return { events, rest };
}

/** Turn a finished accumulator into the metrics row the UI and ledger share. */
export function toMetrics(options: {
  requestId: string;
  selection: RoutingSelection;
  accumulator: StreamAccumulator;
  latencyMs: number;
  pricing: PricingIndex;
  status?: CallMetrics["status"];
  errorMessage?: string;
}): CallMetrics {
  const { accumulator, selection } = options;
  return {
    requestId: options.requestId,
    routingMechanism: selection.mode,
    requested: describeSelection(selection),
    resolvedModel: accumulator.model,
    resolvedFamily: accumulator.family,
    routingTier: accumulator.routingTier,
    routingConfidence: accumulator.routingConfidence,
    promptTokens: accumulator.promptTokens,
    completionTokens: accumulator.completionTokens,
    cachedTokens: accumulator.cachedTokens,
    latencyMs: Math.round(options.latencyMs),
    ttftMs: accumulator.ttftMs === null ? null : Math.round(accumulator.ttftMs),
    costUsd: estimateCostUsd(
      accumulator.model,
      {
        promptTokens: accumulator.promptTokens,
        completionTokens: accumulator.completionTokens,
        cachedTokens: accumulator.cachedTokens,
      },
      options.pricing
    ),
    status: options.status ?? "ok",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
  };
}

export type GlooClient = ReturnType<typeof createGlooClient>;

export function createGlooClient(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  url?: string;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? GLOO_COMPLETIONS_URL;

  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: (body.stream
          ? "text/event-stream"
          : "application/json") as string,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }

  return {
    /** Streaming call. Yields decoded text deltas; totals land in `accumulator`. */
    async *stream(
      messages: Array<{ role: string; content: string }>,
      selection: RoutingSelection,
      accumulator: StreamAccumulator
    ): AsyncGenerator<string> {
      const response = await post(
        buildGlooBody({ messages, selection, stream: true })
      );
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Gloo returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`
        );
      }

      const decoder = new TextDecoder();
      let buffer = "";

      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;
        for (const event of events) {
          if (event === null) {
            accumulator.done = true;
            continue;
          }
          const before = accumulator.text.length;
          applyChunk(accumulator, event);
          if (accumulator.text.length > before) {
            yield accumulator.text.slice(before);
          }
        }
      }
    },

    /** Buffered call, used by the comparison view where nothing streams. */
    async complete(
      messages: Array<{ role: string; content: string }>,
      selection: RoutingSelection
    ): Promise<StreamAccumulator> {
      const response = await post(
        buildGlooBody({ messages, selection, stream: false })
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Gloo returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`
        );
      }
      const accumulator = createAccumulator();
      applyChunk(accumulator, await response.json());
      accumulator.done = true;
      return accumulator;
    },
  };
}
