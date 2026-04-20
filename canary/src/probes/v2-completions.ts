import { withTimeout } from "@glooai/scripts";
import { validate, V2CompletionSchema } from "../assertions/schema.js";
import { looksLikeRefusal, matchingPatterns } from "../assertions/refusal.js";
import type { Probe, ProbeContext, ProbeOutcome } from "./types.js";

const V2_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

export type V2CompletionsFixture = {
  signature: string;
  label: string;
  prompt: string;
  benign: boolean;
  timeoutMs?: number;
  routing:
    | { kind: "auto_routing" }
    | {
        kind: "model_family";
        // Accepted values per the V2 Completions API error response:
        // "Anthropic, Google, OpenAI, Open Source (case-insensitive)".
        // We pin the exact server-canonical casing so any change the
        // platform makes to the accepted values list surfaces as a
        // canary RED immediately.
        family: "Anthropic" | "Google" | "OpenAI" | "Open Source";
      }
    | { kind: "model"; model: string };
};

export function buildV2Probe(fixture: V2CompletionsFixture): Probe {
  return {
    signature: fixture.signature,
    label: fixture.label,
    async run(ctx: ProbeContext): Promise<ProbeOutcome> {
      const started = Date.now();
      const { controller, clearTimer } = withTimeout(
        fixture.timeoutMs ?? 90_000
      );

      try {
        const response = await fetch(V2_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.accessToken}`,
          },
          body: JSON.stringify(buildRequestBody(fixture)),
          signal: controller.signal,
        });

        const rawBody = await response.text();
        return assessV2(fixture, response.status, rawBody, started);
      } catch (error) {
        return {
          signature: fixture.signature,
          label: fixture.label,
          endpoint: V2_URL,
          apiVersion: "v2",
          model:
            fixture.routing.kind === "model"
              ? fixture.routing.model
              : undefined,
          httpStatus: null,
          verdict: "FAIL",
          severity: "RED",
          durationMs: Date.now() - started,
          details: {
            error: (error as Error).message,
            errorName: (error as Error).name,
          },
          completedAt: Math.floor(Date.now() / 1000),
        };
      } finally {
        clearTimer();
      }
    },
  };
}

export function buildRequestBody(
  fixture: V2CompletionsFixture
): Record<string, unknown> {
  const messages = [{ role: "user", content: fixture.prompt }];
  switch (fixture.routing.kind) {
    case "auto_routing":
      return { messages, auto_routing: true };
    case "model_family":
      return {
        messages,
        auto_routing: false,
        model_family: fixture.routing.family,
      };
    case "model":
      return { messages, auto_routing: false, model: fixture.routing.model };
  }
}

export function assessV2(
  fixture: V2CompletionsFixture,
  status: number,
  rawBody: string,
  started: number
): ProbeOutcome {
  const durationMs = Date.now() - started;
  const modelFromFixture =
    fixture.routing.kind === "model" ? fixture.routing.model : undefined;

  const base = {
    signature: fixture.signature,
    label: fixture.label,
    endpoint: V2_URL,
    apiVersion: "v2" as const,
    httpStatus: status,
    durationMs,
    responsePreview: rawBody.slice(0, 400),
    completedAt: Math.floor(Date.now() / 1000),
  };

  if (status < 200 || status >= 300) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "FAIL",
      severity: "RED",
      contentPreview: null,
      details: { reason: "non-2xx", body: rawBody.slice(0, 1000) },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "SCHEMA_MISMATCH",
      severity: "RED",
      contentPreview: null,
      details: { reason: "invalid-json" },
    };
  }

  const schema = validate(V2CompletionSchema, parsed);
  if (!schema.ok) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "SCHEMA_MISMATCH",
      severity: "RED",
      contentPreview: null,
      details: { schema: schema.issues },
    };
  }

  const shaped = parsed as {
    choices: Array<{ message?: { content?: string | null } }>;
    model?: string;
    routing_mechanism?: string;
    routing_tier?: string;
  };
  const content = shaped.choices[0]?.message?.content ?? "";
  const modelFromResponse = shaped.model ?? modelFromFixture;

  if (content.length === 0) {
    return {
      ...base,
      model: modelFromResponse,
      verdict: "EMPTY_COMPLETION",
      severity: "RED",
      contentPreview: null,
      details: {
        reason: "empty-content",
        routing_mechanism: shaped.routing_mechanism,
      },
    };
  }

  if (fixture.benign && looksLikeRefusal(content)) {
    return {
      ...base,
      model: modelFromResponse,
      verdict: "REFUSAL_REGRESSION",
      severity: "RED",
      contentPreview: content.slice(0, 400),
      details: {
        matchedPatterns: matchingPatterns(content),
        fullContent: content,
        routing_mechanism: shaped.routing_mechanism,
        routing_tier: shaped.routing_tier,
      },
    };
  }

  return {
    ...base,
    model: modelFromResponse,
    verdict: "PASS",
    severity: "GREEN",
    contentPreview: content.slice(0, 200),
    details: {
      routing_mechanism: shaped.routing_mechanism,
      routing_tier: shaped.routing_tier,
    },
  };
}
