import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  FAILING_V1_MODEL,
  RECOMMENDED_V2_HAIKU_MODEL,
  RECOMMENDED_V2_SONNET_MODEL,
  buildCases,
  extractContent,
  runAllCases,
  runCase,
  verdictFor,
} from "../src/sonnet-4-repro.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

it("pins the exact deprecated V1 model ID under test", () => {
  // The Anthropic Bedrock inference profile for Sonnet 4 was deprecated
  // 2026-04-14. If this string drifts, the repro stops reproducing.
  expect(FAILING_V1_MODEL).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
});

it("uses the Gloo V2 aliases from the supported-models guide", () => {
  expect(RECOMMENDED_V2_SONNET_MODEL).toBe("gloo-anthropic-claude-sonnet-4.5");
  expect(RECOMMENDED_V2_HAIKU_MODEL).toBe("gloo-anthropic-claude-haiku-4.5");
});

it("builds three cases in the documented order — V1 failure, then V2 replacements", () => {
  const cases = buildCases("hello");

  expect(cases).toHaveLength(3);
  expect(cases[0].apiVersion).toBe("v1");
  expect(cases[0].endpoint).toBe(
    "https://platform.ai.gloo.com/ai/v1/chat/completions"
  );
  expect(cases[0].model).toBe(FAILING_V1_MODEL);

  expect(cases[1].apiVersion).toBe("v2");
  expect(cases[1].endpoint).toBe(
    "https://platform.ai.gloo.com/ai/v2/chat/completions"
  );
  expect(cases[1].model).toBe(RECOMMENDED_V2_SONNET_MODEL);
  expect(cases[1].body.auto_routing).toBe(false);

  expect(cases[2].model).toBe(RECOMMENDED_V2_HAIKU_MODEL);
});

it("classifies non-2xx responses as FAIL", () => {
  expect(verdictFor(500, "boom")).toEqual({
    verdict: "FAIL",
    emptyCompletion: false,
  });
  expect(verdictFor(404, '{"error":"not found"}')).toEqual({
    verdict: "FAIL",
    emptyCompletion: false,
  });
});

it("classifies HTTP 200 with no/empty completion content as EMPTY_COMPLETION", () => {
  // One observed failure mode returns HTTP 200 with an empty content string;
  // downstream fallback layers typically surface this as "empty completion".
  const emptyChoice = JSON.stringify({
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  });
  const missingMessage = JSON.stringify({
    choices: [{ finish_reason: "stop" }],
  });

  expect(verdictFor(200, emptyChoice).verdict).toBe("EMPTY_COMPLETION");
  expect(verdictFor(200, missingMessage).verdict).toBe("EMPTY_COMPLETION");
});

it("classifies a well-formed completion as PASS", () => {
  const body = JSON.stringify({
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  });
  expect(verdictFor(200, body)).toEqual({
    verdict: "PASS",
    emptyCompletion: false,
  });
});

it("returns null content when the body is not JSON", () => {
  expect(extractContent("<html>oops</html>")).toBeNull();
});

it("runs the full repro flow with mocked network calls", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ access_token: "token123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
    // V1 returns HTTP 200 with an empty completion — one of the observed
    // failure signatures for the deprecated model ID.
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    // V2 Sonnet 4.5 succeeds.
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: "Use active voice and short sentences." } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    // V2 Haiku 4.5 succeeds.
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Prefer plain language." } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

  const outcomes = await runAllCases({
    clientId: "id",
    clientSecret: "secret",
  });

  expect(outcomes).toHaveLength(3);
  expect(outcomes[0].verdict).toBe("EMPTY_COMPLETION");
  expect(outcomes[0].model).toBe(FAILING_V1_MODEL);
  expect(outcomes[1].verdict).toBe("PASS");
  expect(outcomes[1].contentPreview).toContain("active voice");
  expect(outcomes[2].verdict).toBe("PASS");
  fetchSpy.mockRestore();
});

it("propagates non-2xx errors from individual cases as FAIL verdicts", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
    async () =>
      new Response("bedrock model not found", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      })
  );

  const [v1Case] = buildCases("hi");
  const outcome = await runCase("token123", v1Case);

  expect(outcome.status).toBe(400);
  expect(outcome.verdict).toBe("FAIL");
  expect(outcome.responsePreview).toContain("bedrock model not found");
  fetchSpy.mockRestore();
});
