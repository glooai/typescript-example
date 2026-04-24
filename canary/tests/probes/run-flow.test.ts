/**
 * Exercises the full `run()` path of the V1/V2 probes with mocked fetch so
 * coverage reflects the built-in wrappers, not just the pure assessment
 * helpers.
 */

import { afterEach, expect, it, vi } from "vitest";
import { buildV1Probe } from "../../src/probes/v1-messages.js";
import { buildV2Probe } from "../../src/probes/v2-completions.js";

const CTX = {
  accessToken: "token-xyz",
  runId: "run-abc",
  startedAt: "2026-04-20T18:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("V1 probe issues a POST to the V1 endpoint and returns a PASS on happy-path", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello there" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const probe = buildV1Probe({
    signature: "v1/test",
    label: "V1 · test",
    model: "meta.llama3-70b-instruct-v1:0",
    prompt: "hi",
    benign: true,
  });

  const outcome = await probe.run(CTX);
  expect(outcome.verdict).toBe("PASS");
  expect(outcome.severity).toBe("GREEN");
  expect(outcome.httpStatus).toBe(200);
  expect(calls[0].url).toBe(
    "https://platform.ai.gloo.com/ai/v1/chat/completions"
  );
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.model).toBe("meta.llama3-70b-instruct-v1:0");
});

it("V1 probe surfaces network errors as RED FAIL with null status", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new TypeError("fetch failed");
  });

  const probe = buildV1Probe({
    signature: "v1/test",
    label: "V1 · test",
    model: "x",
    prompt: "hi",
    benign: true,
  });

  const outcome = await probe.run(CTX);
  expect(outcome.verdict).toBe("FAIL");
  expect(outcome.severity).toBe("RED");
  expect(outcome.httpStatus).toBeNull();
  expect(outcome.details.error).toContain("fetch failed");
});

it("V2 probe routes auto_routing requests and passes through routing metadata", async () => {
  const calls: Array<{ init: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    calls.push({ init: init as RequestInit });
    return new Response(
      JSON.stringify({
        model: "gloo-anthropic-claude-sonnet-4.5",
        routing_mechanism: "auto_routing",
        routing_tier: "tier_2",
        choices: [{ message: { content: "ok answer" } }],
      }),
      { status: 200 }
    );
  });

  const probe = buildV2Probe({
    signature: "v2/auto",
    label: "V2 · auto",
    prompt: "hi",
    benign: true,
    routing: { kind: "auto_routing" },
  });

  const outcome = await probe.run(CTX);
  expect(outcome.verdict).toBe("PASS");
  expect(outcome.model).toBe("gloo-anthropic-claude-sonnet-4.5");
  expect(outcome.details.routing_mechanism).toBe("auto_routing");
  const reqBody = JSON.parse(String(calls[0].init.body));
  expect(reqBody.auto_routing).toBe(true);
});

it("V2 probe surfaces AbortError as a YELLOW TIMEOUT with the error name", async () => {
  // Probe-side `AbortSignal.timeout()` firing is a canary-induced
  // latency signal, not a platform outage. We classify as YELLOW /
  // TIMEOUT so the daily digest captures it as a signal instead of
  // paging the channel every 15 min that a slow model is slow.
  // The deeper regression coverage lives in
  // `tests/probes/v2-completions.test.ts`; this test exists to guard
  // the end-to-end probe-builder → fetch → outcome wiring.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  });

  const probe = buildV2Probe({
    signature: "v2/auto",
    label: "V2 · auto",
    prompt: "hi",
    benign: true,
    routing: { kind: "auto_routing" },
    timeoutMs: 100,
  });

  const outcome = await probe.run(CTX);
  expect(outcome.verdict).toBe("TIMEOUT");
  expect(outcome.severity).toBe("YELLOW");
  expect(outcome.details.errorName).toBe("AbortError");
  expect(outcome.details.timeoutMs).toBe(100);
});
