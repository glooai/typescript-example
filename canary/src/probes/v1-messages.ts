import { withTimeout } from "@glooai/scripts";
import { validate, ChatCompletionSchema } from "../assertions/schema.js";
import { looksLikeRefusal, matchingPatterns } from "../assertions/refusal.js";
import type { Probe, ProbeContext, ProbeOutcome } from "./types.js";

const V1_URL = "https://platform.ai.gloo.com/ai/v1/chat/completions";

export type V1MessagesFixture = {
  signature: string;
  label: string;
  model: string;
  prompt: string;
  /** If true, a refusal regression flips this to RED. */
  benign: boolean;
  /** Expected response timeout in ms. */
  timeoutMs?: number;
};

export function buildV1Probe(fixture: V1MessagesFixture): Probe {
  return {
    signature: fixture.signature,
    label: fixture.label,
    async run(ctx: ProbeContext): Promise<ProbeOutcome> {
      const started = Date.now();
      const { controller, clearTimer } = withTimeout(
        fixture.timeoutMs ?? 30_000
      );

      try {
        const response = await fetch(V1_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.accessToken}`,
          },
          body: JSON.stringify({
            model: fixture.model,
            messages: [
              { role: "system", content: "You are a concise assistant." },
              { role: "user", content: fixture.prompt },
            ],
          }),
          signal: controller.signal,
        });

        const rawBody = await response.text();
        return assessV1(fixture, response.status, rawBody, started);
      } catch (error) {
        // AbortError = our own `AbortSignal.timeout()` fired before the
        // upstream answered. Classify as YELLOW / TIMEOUT so it flows
        // into the daily-digest thread instead of paging as an outage.
        // Kept symmetric with the V2 probe so any future V1 fixture
        // (currently none; V1 is deprecated) inherits the same
        // classification rules. Non-abort exceptions — DNS, TCP reset,
        // TLS — stay RED.
        const isAbort = (error as Error).name === "AbortError";
        const timeoutMs = fixture.timeoutMs ?? 30_000;
        return {
          signature: fixture.signature,
          label: fixture.label,
          endpoint: V1_URL,
          apiVersion: "v1",
          model: fixture.model,
          httpStatus: null,
          verdict: isAbort ? "TIMEOUT" : "FAIL",
          severity: isAbort ? "YELLOW" : "RED",
          durationMs: Date.now() - started,
          details: {
            error: (error as Error).message,
            errorName: (error as Error).name,
            ...(isAbort ? { timeoutMs } : {}),
          },
          completedAt: Math.floor(Date.now() / 1000),
        };
      } finally {
        clearTimer();
      }
    },
  };
}

export function assessV1(
  fixture: V1MessagesFixture,
  status: number,
  rawBody: string,
  started: number
): ProbeOutcome {
  const durationMs = Date.now() - started;
  const base = {
    signature: fixture.signature,
    label: fixture.label,
    endpoint: V1_URL,
    apiVersion: "v1" as const,
    model: fixture.model,
    httpStatus: status,
    durationMs,
    responsePreview: rawBody.slice(0, 400),
    completedAt: Math.floor(Date.now() / 1000),
  };

  if (status < 200 || status >= 300) {
    return {
      ...base,
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
      verdict: "SCHEMA_MISMATCH",
      severity: "RED",
      contentPreview: null,
      details: { reason: "invalid-json" },
    };
  }

  const schema = validate(ChatCompletionSchema, parsed);
  if (!schema.ok) {
    return {
      ...base,
      verdict: "SCHEMA_MISMATCH",
      severity: "RED",
      contentPreview: null,
      details: { schema: schema.issues },
    };
  }

  const shaped = parsed as {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const content = shaped.choices[0]?.message?.content ?? "";

  if (content.length === 0) {
    return {
      ...base,
      verdict: "EMPTY_COMPLETION",
      severity: "RED",
      contentPreview: null,
      details: { reason: "empty-content" },
    };
  }

  if (fixture.benign && looksLikeRefusal(content)) {
    return {
      ...base,
      verdict: "REFUSAL_REGRESSION",
      severity: "RED",
      contentPreview: content.slice(0, 400),
      details: {
        matchedPatterns: matchingPatterns(content),
        fullContent: content,
      },
    };
  }

  return {
    ...base,
    verdict: "PASS",
    severity: "GREEN",
    contentPreview: content.slice(0, 200),
    details: {},
  };
}
