import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assessV2,
  buildRequestBody,
  buildV2Probe,
  isInsufficientPermissions,
  type V2CompletionsFixture,
} from "../../src/probes/v2-completions.js";

const AUTO: V2CompletionsFixture = {
  signature: "v2/auto",
  label: "V2 · auto",
  prompt: "hi",
  benign: true,
  routing: { kind: "auto_routing" },
};

const FAMILY: V2CompletionsFixture = {
  signature: "v2/family/anthropic",
  label: "V2 · family",
  prompt: "hi",
  benign: true,
  routing: { kind: "model_family", family: "Anthropic" },
};

const DIRECT: V2CompletionsFixture = {
  signature: "v2/model/haiku-4.5",
  label: "V2 · haiku",
  prompt: "hi",
  benign: true,
  routing: { kind: "model", model: "gloo-anthropic-claude-haiku-4.5" },
};

it("builds request bodies that match each routing mode", () => {
  expect(buildRequestBody(AUTO)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: true,
  });
  expect(buildRequestBody(FAMILY)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: false,
    model_family: "Anthropic",
  });
  expect(buildRequestBody(DIRECT)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: false,
    model: "gloo-anthropic-claude-haiku-4.5",
  });
});

it("passes max_tokens through when the fixture declares one", () => {
  const capped: V2CompletionsFixture = { ...AUTO, maxTokens: 4 };
  expect(buildRequestBody(capped)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: true,
    max_tokens: 4,
  });
  const cappedFamily: V2CompletionsFixture = { ...FAMILY, maxTokens: 48 };
  expect(buildRequestBody(cappedFamily)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: false,
    model_family: "Anthropic",
    max_tokens: 48,
  });
  const cappedDirect: V2CompletionsFixture = { ...DIRECT, maxTokens: 48 };
  expect(buildRequestBody(cappedDirect)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: false,
    model: "gloo-anthropic-claude-haiku-4.5",
    max_tokens: 48,
  });
});

it("passes through routing metadata on GREEN responses", () => {
  const body = JSON.stringify({
    model: "gloo-anthropic-claude-haiku-4.5",
    routing_mechanism: "direct_model_selection",
    routing_tier: "tier_1",
    choices: [{ message: { content: "ok" } }],
  });
  const out = assessV2(DIRECT, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("PASS");
  expect(out.model).toBe("gloo-anthropic-claude-haiku-4.5");
  expect(out.details.routing_mechanism).toBe("direct_model_selection");
  expect(out.details.routing_tier).toBe("tier_1");
});

it("returns EMPTY_COMPLETION on successful-but-empty responses", () => {
  const body = JSON.stringify({
    choices: [{ message: { content: "" } }],
  });
  const out = assessV2(AUTO, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("EMPTY_COMPLETION");
  expect(out.severity).toBe("RED");
});

it("flags refusal regressions via the shared refusal detector", () => {
  const body = JSON.stringify({
    choices: [
      { message: { content: "I can't help with addiction treatment advice." } },
    ],
  });
  const out = assessV2(AUTO, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("REFUSAL_REGRESSION");
});

it("marks 5xx as FAIL and captures a body preview", () => {
  const out = assessV2(AUTO, 503, "upstream unavailable", Date.now() - 1);
  expect(out.verdict).toBe("FAIL");
  expect(out.httpStatus).toBe(503);
  expect(out.responsePreview).toContain("upstream unavailable");
});

// --------------------------------------------------------------------
// Regression coverage for the 2026-04-24 canary classification fix:
// 403 "insufficient permissions" is not an outage. It's the canary's
// creds hitting a model listed in `/platform/v2/models` that we haven't
// been granted access to. Before the fix this pathway turned every
// scrape-discovered-but-not-entitled model into a permanent RED alert.
// --------------------------------------------------------------------
it("classifies 403 forbidden-insufficient-permissions as YELLOW / NOT_ENTITLED", () => {
  const body = JSON.stringify({
    error: "Forbidden - insufficient permissions",
    code: "forbidden",
  });
  const out = assessV2(DIRECT, 403, body, Date.now() - 1);
  expect(out.verdict).toBe("NOT_ENTITLED");
  expect(out.severity).toBe("YELLOW");
  expect(out.httpStatus).toBe(403);
  expect(out.details.reason).toBe("forbidden-insufficient-permissions");
  // Model id must be preserved so the digest breakdown can point at the
  // specific alias the entitlement is missing for.
  expect(out.model).toBe("gloo-anthropic-claude-haiku-4.5");
});

it("classifies other 403 shapes as YELLOW / NOT_ENTITLED but tags reason=forbidden", () => {
  // Some gateway layers return raw text or a different envelope for 403
  // — we still want it demoted to YELLOW rather than paging, but the
  // details carry the unrecognized body so a reader can grep for it.
  const out = assessV2(DIRECT, 403, "unexpected body", Date.now() - 1);
  expect(out.verdict).toBe("NOT_ENTITLED");
  expect(out.severity).toBe("YELLOW");
  expect(out.details.reason).toBe("forbidden");
  expect(out.details.body).toBe("unexpected body");
});

it("isInsufficientPermissions matches the real V2 403 body shape", () => {
  expect(
    isInsufficientPermissions(
      JSON.stringify({
        error: "Forbidden - insufficient permissions",
        code: "forbidden",
      })
    )
  ).toBe(true);
  expect(isInsufficientPermissions("not-json")).toBe(false);
  expect(isInsufficientPermissions(JSON.stringify({ code: "other" }))).toBe(
    false
  );
});

// --------------------------------------------------------------------
// Regression coverage for probe-side AbortError classification:
// a probe that exceeds our own `AbortSignal.timeout()` is a latency
// signal, not evidence the platform is down. It must demote to
// YELLOW / TIMEOUT so reasoning-heavy models (gpt-5.4-pro,
// deepseek-chat-v3.1, minimax-m2.5) don't spam the RED alert channel.
// --------------------------------------------------------------------
const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("classifies probe-side AbortError as YELLOW / TIMEOUT", async () => {
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  fetchMock.mockRejectedValue(abort);

  const probe = buildV2Probe({ ...DIRECT, timeoutMs: 5 });
  const out = await probe.run({
    accessToken: "t",
    runId: "r",
    startedAt: "2026-04-24T00:00:00Z",
  });

  expect(out.verdict).toBe("TIMEOUT");
  expect(out.severity).toBe("YELLOW");
  expect(out.httpStatus).toBeNull();
  expect(out.details.errorName).toBe("AbortError");
  expect(out.details.timeoutMs).toBe(5);
  // Keep model on the outcome so digest breakdowns can attribute the
  // TIMEOUT to a specific alias.
  expect(out.model).toBe("gloo-anthropic-claude-haiku-4.5");
});

it("leaves non-abort network errors as RED / FAIL", async () => {
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));

  const probe = buildV2Probe(DIRECT);
  const out = await probe.run({
    accessToken: "t",
    runId: "r",
    startedAt: "2026-04-24T00:00:00Z",
  });

  expect(out.verdict).toBe("FAIL");
  expect(out.severity).toBe("RED");
  expect(out.details.errorName).toBe("TypeError");
  // Non-abort errors don't carry a timeoutMs — this guards against a
  // future refactor accidentally labeling every network error as a
  // canary-induced timeout.
  expect(out.details.timeoutMs).toBeUndefined();
});
