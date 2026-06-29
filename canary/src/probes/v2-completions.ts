import { withTimeout } from "@glooai/scripts";
import { validate, V2CompletionSchema } from "../assertions/schema.js";
import {
  looksLikeRefusal,
  looksLikeSafetyRefusal,
  matchingPatterns,
} from "../assertions/refusal.js";
import type { Probe, ProbeContext, ProbeOutcome } from "./types.js";

const V2_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type V2CompletionsFixture = {
  signature: string;
  label: string;
  prompt: string;
  benign: boolean;
  timeoutMs?: number;
  /**
   * Hard cap on response length. Passed straight through as the V2
   * `max_tokens` request field. Set low (e.g. 4) for pulse probes where
   * only the request succeeding matters; higher (e.g. 48) for probes
   * that rely on the refusal detector / content inspection. Omit to
   * fall back to the server default.
   */
  maxTokens?: number;
  /**
   * Multi-turn override: when set, this array is sent as the `messages`
   * body field instead of `[{ role: "user", content: prompt }]`. The
   * `prompt` field is still required (used in error messages and
   * signatures) but is not transmitted in the HTTP request body.
   */
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /**
   * Tool definitions for tool-calling probes. When set, the request body
   * includes `tools` and `tool_choice: "auto"` and the response is
   * assessed for a valid tool-call invocation rather than plain content.
   */
  tools?: ToolDefinition[];
  /**
   * When set, the probe expects `finish_reason === "tool_calls"` and a
   * tool-call entry whose `function.name` matches this value. A plain-
   * text response (no tool call) is classified as `TOOL_CALL_MISSING`
   * (RED). Ignored unless `tools` is also set.
   */
  expectToolCall?: string;
  /**
   * When true, the probe expects a safety refusal (e.g. jailbreak test).
   * A response that looks like a refusal — or any 4xx rejection at the
   * HTTP layer — is `PASS` (GREEN). A helpful non-refusal response is
   * `GUARDRAIL_BYPASS` (RED). Takes precedence over `benign` when set.
   */
  expectRefusal?: boolean;
  /**
   * When true, the probe expects the platform to REJECT the request with a
   * 4xx — used for image-only models/families (output_modalities without
   * "text"), which cannot produce a text completion and must be sent to
   * `/v1/responses` instead (ai-api GAI-6788). A 4xx is `PASS` (GREEN): the
   * platform correctly refused. A 2xx is `UNEXPECTED_SUCCESS` (RED): the
   * image-only model was processed on the text endpoint (the bug GAI-6788
   * fixes — a slow, billable, empty completion). 5xx stays a server-fault
   * RED. Takes precedence over the content/refusal paths when set.
   */
  expectRejection?: boolean;
  routing:
    | { kind: "auto_routing" }
    | {
        kind: "model_family";
        // Family string is typed `string` so the probe list can be
        // hydrated directly from the live `/platform/v2/models`
        // registry (distinct `family` values). That way a new family
        // ("Mistral", "xAI", …) starts getting probed the same minute
        // it shows up in the registry, and a retired family stops
        // getting probed the same minute it disappears — same
        // no-drift property the direct-model probes already have.
        //
        // The V2 Completions API validates case-insensitively against
        // the currently-accepted list and returns the canonical
        // casing (e.g. "Open Source" not "open source"). Feeding the
        // registry's canonical casing through verbatim keeps the
        // request body in lock-step with whatever the platform
        // currently accepts.
        family: string;
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
        // AbortError = our own `AbortSignal.timeout()` fired before the
        // upstream answered. Classify as YELLOW / TIMEOUT so it flows
        // into the daily-digest thread instead of paging as an outage.
        // Everything else (DNS failure, TCP reset, TLS error, etc.) is
        // still a hard RED — those genuinely mean "we could not reach
        // the platform at all".
        const isAbort = (error as Error).name === "AbortError";
        const timeoutMs = fixture.timeoutMs ?? 90_000;
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

export function buildRequestBody(
  fixture: V2CompletionsFixture
): Record<string, unknown> {
  // Multi-turn: use the supplied messages array verbatim; otherwise
  // wrap the single prompt as a user message.
  const messages = fixture.messages ?? [
    { role: "user", content: fixture.prompt },
  ];

  // `max_tokens` is optional per the V2 Completions API reference
  // (.context/guides/gloo/api/completions-v2.md). Only attach it when
  // the fixture declared one so we don't drift from the server default
  // for any probe that hasn't opted in.
  const tokenCap =
    typeof fixture.maxTokens === "number"
      ? { max_tokens: fixture.maxTokens }
      : {};

  // Tool definitions: when present, request tool_choice:"auto" so the
  // model will call the tool if it decides to, rather than being forced.
  const toolFields = fixture.tools
    ? { tools: fixture.tools, tool_choice: "auto" }
    : {};

  switch (fixture.routing.kind) {
    case "auto_routing":
      return { messages, auto_routing: true, ...tokenCap, ...toolFields };
    case "model_family":
      return {
        messages,
        auto_routing: false,
        model_family: fixture.routing.family,
        ...tokenCap,
        ...toolFields,
      };
    case "model":
      return {
        messages,
        auto_routing: false,
        model: fixture.routing.model,
        ...tokenCap,
        ...toolFields,
      };
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

  // Safety / jailbreak probes: any 4xx HTTP rejection means the platform
  // correctly blocked the request before generating output. Treat 4xx as
  // PASS so an overly-strict HTTP error path doesn't mask a working guard.
  // 5xx is still a server fault regardless of the probe type.
  if (fixture.expectRefusal && status >= 400 && status < 500) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "PASS",
      severity: "GREEN",
      contentPreview: null,
      details: {
        reason: "guardrail-rejected-at-http-layer",
        httpStatus: status,
      },
    };
  }

  // Image-only model/family probe: the platform MUST reject it on the text
  // endpoint. Any 4xx is the correct outcome (PASS) — a pinned image-only
  // model 400s via the GAI-6788 text-output guard; an all-image family 400s
  // as an unknown text family. A 2xx means the image-only model was actually
  // processed (UNEXPECTED_SUCCESS, RED — the GAI-6788 bug). 5xx falls through
  // to the server-fault path below. Checked before the 403/non-2xx branches
  // so an entitlement 403 on an image-only model still reads as a valid
  // rejection rather than NOT_ENTITLED.
  if (fixture.expectRejection && status >= 400 && status < 500) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "PASS",
      severity: "GREEN",
      contentPreview: null,
      details: {
        reason: "image-only-correctly-rejected",
        httpStatus: status,
      },
    };
  }
  if (fixture.expectRejection && status >= 200 && status < 300) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "UNEXPECTED_SUCCESS",
      severity: "RED",
      contentPreview: null,
      details: {
        reason: "image-only-model-not-rejected-on-text-endpoint",
        httpStatus: status,
        body: rawBody.slice(0, 500),
      },
    };
  }

  // HTTP 403 "forbidden — insufficient permissions" is the canary's own
  // credentials hitting a model they aren't entitled to call. This is a
  // stable configuration signal (the model is listed in
  // `/platform/v2/models` but our OAuth client wasn't granted access)
  // rather than a platform outage. Classify as YELLOW / NOT_ENTITLED so
  // it flows into the daily digest's YELLOW thread instead of paging the
  // channel as a fresh red incident every time the registry is scraped.
  //
  // Two-layer match: fast path on `{"code":"forbidden"}` in the parsed
  // body, fall-open to `status === 403` so any other 403 shape still
  // demotes to YELLOW rather than over-paging. A genuinely-revoked
  // canary token would have failed the OAuth step upstream in
  // `probe-runner.ts` with a 401 and never reached a per-probe 403 — by
  // construction, any 403 we see here is per-model entitlement, not
  // global auth.
  if (status === 403) {
    return {
      ...base,
      model: modelFromFixture,
      verdict: "NOT_ENTITLED",
      severity: "YELLOW",
      contentPreview: null,
      details: {
        reason: isInsufficientPermissions(rawBody)
          ? "forbidden-insufficient-permissions"
          : "forbidden",
        body: rawBody.slice(0, 500),
      },
    };
  }

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

  // Type-cast includes tool_calls so we can inspect it for tool-call
  // probes without widening the base schema (which is kept loose
  // intentionally to tolerate additive changes from the platform).
  type ToolCall = { function?: { name?: string } };
  const shaped = parsed as {
    choices: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      finish_reason?: string;
    }>;
    model?: string;
    routing_mechanism?: string;
    routing_tier?: string;
  };

  const choice = shaped.choices[0];
  const content = choice?.message?.content ?? "";
  const modelFromResponse = shaped.model ?? modelFromFixture;

  // ── Tool-call path ─────────────────────────────────────────────────
  // Must run before the empty-content guard because tool-call responses
  // legitimately have `content: null` — they'd be misclassified as
  // EMPTY_COMPLETION without this early branch.
  if (fixture.expectToolCall) {
    const toolCalls = choice?.message?.tool_calls ?? [];
    const finishReason = choice?.finish_reason;
    const matched = toolCalls.some(
      (tc) => tc.function?.name === fixture.expectToolCall
    );

    if (!matched) {
      return {
        ...base,
        model: modelFromResponse,
        verdict: "TOOL_CALL_MISSING",
        severity: "RED",
        contentPreview: content.slice(0, 200) || null,
        details: {
          reason: "expected-tool-call-missing",
          expectedFunction: fixture.expectToolCall,
          finishReason,
          toolCalls: JSON.stringify(toolCalls).slice(0, 400),
          content: content.slice(0, 200),
        },
      };
    }

    return {
      ...base,
      model: modelFromResponse,
      verdict: "PASS",
      severity: "GREEN",
      contentPreview: JSON.stringify(toolCalls).slice(0, 200),
      details: {
        finishReason,
        matchedFunction: fixture.expectToolCall,
        routing_mechanism: shaped.routing_mechanism,
        routing_tier: shaped.routing_tier,
      },
    };
  }

  // ── Safety / jailbreak path ────────────────────────────────────────
  // For probes that expect a refusal: a response matching the broader
  // safety-refusal patterns is PASS (guardrail working correctly). An
  // empty response is also considered a correct block. A helpful
  // non-refusal response is GUARDRAIL_BYPASS (RED).
  if (fixture.expectRefusal) {
    if (content.length === 0 || looksLikeSafetyRefusal(content)) {
      return {
        ...base,
        model: modelFromResponse,
        verdict: "PASS",
        severity: "GREEN",
        contentPreview: content.slice(0, 200) || null,
        details: {
          reason:
            content.length === 0
              ? "guardrail-blocked-empty-response"
              : "guardrail-correctly-refused",
          routing_mechanism: shaped.routing_mechanism,
        },
      };
    }
    return {
      ...base,
      model: modelFromResponse,
      verdict: "GUARDRAIL_BYPASS",
      severity: "RED",
      contentPreview: content.slice(0, 400),
      details: {
        reason: "expected-refusal-but-got-content",
        fullContent: content,
        routing_mechanism: shaped.routing_mechanism,
        routing_tier: shaped.routing_tier,
      },
    };
  }

  // ── Standard content path ──────────────────────────────────────────

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

/**
 * True if a raw HTTP 403 body looks like the V2 Completions "not
 * entitled" shape — JSON with `code: "forbidden"`. We parse defensively
 * because the shape is external contract and we don't want a
 * classification regression to throw mid-probe and cascade the outcome
 * into the catch-block RED path.
 */
export function isInsufficientPermissions(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "code" in parsed &&
      (parsed as { code: unknown }).code === "forbidden"
    ) {
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}
