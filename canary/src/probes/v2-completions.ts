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
  /**
   * Hard cap on response length. Passed straight through as the V2
   * `max_tokens` request field. Set low (e.g. 4) for pulse probes where
   * only the request succeeding matters; higher (e.g. 48) for probes
   * that rely on the refusal detector / content inspection. Omit to
   * fall back to the server default.
   */
  maxTokens?: number;
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
  const messages = [{ role: "user", content: fixture.prompt }];
  // `max_tokens` is optional per the V2 Completions API reference
  // (.context/guides/gloo/api/completions-v2.md). Only attach it when
  // the fixture declared one so we don't drift from the server default
  // for any probe that hasn't opted in.
  const tokenCap =
    typeof fixture.maxTokens === "number"
      ? { max_tokens: fixture.maxTokens }
      : {};
  switch (fixture.routing.kind) {
    case "auto_routing":
      return { messages, auto_routing: true, ...tokenCap };
    case "model_family":
      return {
        messages,
        auto_routing: false,
        model_family: fixture.routing.family,
        ...tokenCap,
      };
    case "model":
      return {
        messages,
        auto_routing: false,
        model: fixture.routing.model,
        ...tokenCap,
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
