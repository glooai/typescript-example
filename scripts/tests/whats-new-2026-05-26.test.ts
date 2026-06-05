import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EXPECTED_GA_PROMOTION,
  EXPECTED_NEW_MODELS,
  INVALID_PROBE_MODEL,
  MODELS_REGISTRY_URL,
  assessModelAvailability,
  checkErrorClarity,
  checkModelAvailability,
  checkPromptCache,
  classifyErrorResponse,
  extractErrorMessage,
  fetchModelRegistry,
  findModel,
  main,
  matchesExpectation,
  parseRegistry,
  runWhatsNewChecks,
  summarizeCacheUsage,
  type RegistryModel,
} from "../src/whats-new-2026-05-26.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A registry snapshot with a display name for every expected model. */
function fullRegistry(): RegistryModel[] {
  return [
    {
      id: "gloo-anthropic-claude-opus-4.8",
      name: "Claude Opus 4.8",
      family: "Anthropic",
    },
    {
      id: "gloo-openai-gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      family: "OpenAI",
    },
    {
      id: "gloo-anthropic-claude-opus-4.7-fast",
      name: "Claude Opus 4.7 Fast",
      family: "Anthropic",
    },
    {
      id: "gloo-anthropic-claude-opus-4.6-fast",
      name: "Claude Opus 4.6 Fast",
      family: "Anthropic",
    },
    { id: "gloo-qwen-3.5-plus", name: "Qwen 3.5 Plus", family: "Open Source" },
    { id: "gloo-qwen-3.5-27b", name: "Qwen 3.5 27B", family: "Open Source" },
    {
      id: "gloo-qwen-3-235b-a22b",
      name: "Qwen 3 235B A22B Thinking",
      family: "Open Source",
    },
    {
      id: "gloo-zai-glm-4.7-flash",
      name: "GLM-4.7 Flash",
      family: "Open Source",
    },
    {
      id: "gloo-xiaomi-mimo-v2-flash",
      name: "MiMo V2 Flash",
      family: "Open Source",
    },
    { id: "gloo-xiaomi-mimo-v2.5", name: "MiMo V2.5", family: "Open Source" },
    {
      id: "gloo-google-gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      family: "Google",
    },
  ];
}

// --- Capability 1: model availability -------------------------------------

it("encodes 11 new models plus a separate GA-promotion expectation", () => {
  expect(EXPECTED_NEW_MODELS).toHaveLength(10); // distinct named entries
  expect(EXPECTED_GA_PROMOTION.nameExcludes).toContain("preview");
});

it("matches an expectation only when ALL name substrings are present", () => {
  const model: RegistryModel = {
    id: "x",
    name: "Claude Opus 4.7 Fast",
    family: "Anthropic",
  };
  expect(
    matchesExpectation(model, {
      label: "",
      nameIncludes: ["opus", "4.7", "fast"],
    })
  ).toBe(true);
  // 4.8 base must NOT match the 4.7 fast entry
  expect(
    matchesExpectation(model, { label: "", nameIncludes: ["opus", "4.8"] })
  ).toBe(false);
});

it("honors nameExcludes so a preview build does not satisfy a GA claim", () => {
  const preview: RegistryModel = {
    id: "x",
    name: "Gemini 3.1 Flash Lite Preview",
    family: "Google",
  };
  expect(matchesExpectation(preview, EXPECTED_GA_PROMOTION)).toBe(false);

  const ga: RegistryModel = {
    id: "y",
    name: "Gemini 3.1 Flash Lite",
    family: "Google",
  };
  expect(matchesExpectation(ga, EXPECTED_GA_PROMOTION)).toBe(true);
});

it("findModel returns the first matching entry or null", () => {
  const registry = fullRegistry();
  expect(findModel(registry, EXPECTED_GA_PROMOTION)?.name).toBe(
    "Gemini 3.1 Flash Lite"
  );
  expect(
    findModel(registry, { label: "", nameIncludes: ["does-not-exist"] })
  ).toBeNull();
});

it("assesses every expected model as PRESENT against a full registry", () => {
  const result = assessModelAvailability(fullRegistry(), EXPECTED_NEW_MODELS);
  expect(result).toHaveLength(EXPECTED_NEW_MODELS.length);
  expect(result.every((r) => r.status === "PRESENT")).toBe(true);
  expect(result[0].matchedId).toBe("gloo-anthropic-claude-opus-4.8");
});

it("marks a model ABSENT when the registry lacks it", () => {
  const skinny: RegistryModel[] = [
    { id: "a", name: "Claude Opus 4.8", family: "Anthropic" },
  ];
  const result = assessModelAvailability(skinny, EXPECTED_NEW_MODELS);
  expect(result[0].status).toBe("PRESENT");
  expect(result[1].status).toBe("ABSENT");
  expect(result[1].matchedId).toBeNull();
});

it("parseRegistry narrows valid entries and drops malformed ones", () => {
  const parsed = parseRegistry({
    data: [
      { id: "a", name: "A", family: "f" },
      { id: 1, name: "bad", family: "f" }, // non-string id → dropped
      null, // dropped
      { id: "b", name: "B", family: "f", extra: "ignored" },
    ],
  });
  expect(parsed).toEqual([
    { id: "a", name: "A", family: "f" },
    { id: "b", name: "B", family: "f" },
  ]);
});

it("parseRegistry throws when `data` is not an array", () => {
  expect(() => parseRegistry({})).toThrow(/data/);
  expect(() => parseRegistry(null)).toThrow(/data/);
});

it("fetchModelRegistry pins the authoritative endpoint and parses the body", async () => {
  const calls: Array<string | URL | Request> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    calls.push(url);
    return jsonResponse({ data: fullRegistry() });
  });
  const registry = await fetchModelRegistry();
  expect(calls[0]).toBe(MODELS_REGISTRY_URL);
  expect(registry).toHaveLength(11);
});

it("fetchModelRegistry throws on a non-2xx registry response", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("nope", { status: 503 })
  );
  await expect(fetchModelRegistry()).rejects.toThrow(/status 503/);
});

// --- Capability 2: prompt-cache usage metrics -----------------------------

it("summarizeCacheUsage accepts well-formed cache metrics", () => {
  const summary = summarizeCacheUsage({
    prompt_tokens: 100,
    cache_tokens: 80,
    cache_hit_rate: 0.8,
  });
  expect(summary.status).toBe("METRICS_PRESENT");
  expect(summary.cacheTokens).toBe(80);
  expect(summary.cacheHitRate).toBe(0.8);
  expect(summary.notes).toHaveLength(0);
});

it("summarizeCacheUsage flags absent metrics as MISSING", () => {
  const summary = summarizeCacheUsage({ prompt_tokens: 100 });
  expect(summary.status).toBe("METRICS_MISSING");
  expect(summary.cacheTokens).toBeNull();
  expect(summary.cacheHitRate).toBeNull();
  expect(summary.notes).toContain("cache_tokens absent");
  expect(summary.notes).toContain("cache_hit_rate absent");
});

it("summarizeCacheUsage rejects malformed / out-of-range values", () => {
  const summary = summarizeCacheUsage({
    cache_tokens: -5,
    cache_hit_rate: 1.5,
  });
  expect(summary.status).toBe("METRICS_MISSING");
  expect(summary.notes).toContain("cache_tokens is negative");
  expect(summary.notes).toContain("cache_hit_rate outside [0, 1]");

  const wrongType = summarizeCacheUsage({
    cache_tokens: "80",
    cache_hit_rate: "0.8",
  });
  expect(wrongType.notes).toContain("cache_tokens present but not a number");
  expect(wrongType.notes).toContain("cache_hit_rate present but not a number");
});

it("summarizeCacheUsage tolerates undefined usage", () => {
  expect(summarizeCacheUsage(undefined).status).toBe("METRICS_MISSING");
});

// --- Capability 3: error clarity ------------------------------------------

it("extractErrorMessage reads detail/message/error and nested message", () => {
  expect(extractErrorMessage('{"detail":"bad model"}')).toBe("bad model");
  expect(extractErrorMessage('{"message":"nope"}')).toBe("nope");
  expect(extractErrorMessage('{"error":"invalid"}')).toBe("invalid");
  expect(extractErrorMessage('{"error":{"message":"deep"}}')).toBe("deep");
  expect(extractErrorMessage("not json")).toBeNull();
  expect(extractErrorMessage('{"detail":""}')).toBeNull();
});

it("classifies a 4xx with a structured message as ACTIONABLE_CLIENT_ERROR", () => {
  const r = classifyErrorResponse(400, '{"detail":"Unknown model gloo-nope"}');
  expect(r.classification).toBe("ACTIONABLE_CLIENT_ERROR");
  expect(r.message).toBe("Unknown model gloo-nope");
});

it("classifies a 4xx without a message as OPAQUE_CLIENT_ERROR", () => {
  expect(classifyErrorResponse(400, "").classification).toBe(
    "OPAQUE_CLIENT_ERROR"
  );
});

it("classifies a 5xx as GENERIC_SERVER_ERROR (the regression we guard against)", () => {
  expect(
    classifyErrorResponse(500, '{"detail":"Error generating response."}')
      .classification
  ).toBe("GENERIC_SERVER_ERROR");
});

it("classifies a 2xx as OK", () => {
  expect(classifyErrorResponse(200, "{}").classification).toBe("OK");
});

// --- Live runners (mocked fetch) ------------------------------------------

it("checkModelAvailability returns 11 assessments (10 new + 1 GA)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    jsonResponse({ data: fullRegistry() })
  );
  const result = await checkModelAvailability();
  expect(result).toHaveLength(EXPECTED_NEW_MODELS.length + 1);
  expect(result.at(-1)?.label).toContain("Gemini 3.1 Flash Lite");
  expect(result.every((r) => r.status === "PRESENT")).toBe(true);
});

it("checkPromptCache extracts and validates usage metrics", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    jsonResponse({
      choices: [{ message: { content: "cached." } }],
      usage: { cache_tokens: 12, cache_hit_rate: 0.5 },
    })
  );
  const summary = await checkPromptCache("token");
  expect(summary.status).toBe("METRICS_PRESENT");
  expect(summary.cacheHitRate).toBe(0.5);
});

it("checkPromptCache reports MISSING when the body is unparseable", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("<html>500</html>", { status: 200 })
  );
  const summary = await checkPromptCache("token");
  expect(summary.status).toBe("METRICS_MISSING");
});

it("checkErrorClarity sends the invalid model and classifies the response", async () => {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse({ detail: "Unknown model" }, 400);
  });
  const result = await checkErrorClarity("token");
  expect(result.status).toBe(400);
  expect(result.classification).toBe("ACTIONABLE_CLIENT_ERROR");
  expect(bodies[0]).toContain(INVALID_PROBE_MODEL);
});

it("runWhatsNewChecks stitches token + 3 probes into one report", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(async () => jsonResponse({ access_token: "tok" }))
    .mockImplementationOnce(async () => jsonResponse({ data: fullRegistry() }))
    .mockImplementationOnce(async () =>
      jsonResponse({ usage: { cache_tokens: 5, cache_hit_rate: 0.25 } })
    )
    .mockImplementationOnce(async () =>
      jsonResponse({ detail: "Unknown model" }, 422)
    );

  const report = await runWhatsNewChecks({ clientId: "id", clientSecret: "s" });
  expect(report.models.every((m) => m.status === "PRESENT")).toBe(true);
  expect(report.cache.status).toBe("METRICS_PRESENT");
  expect(report.errorClarity.classification).toBe("ACTIONABLE_CLIENT_ERROR");
});

it("runWhatsNewChecks throws when no access token comes back", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
    jsonResponse({})
  );
  await expect(
    runWhatsNewChecks({ clientId: "id", clientSecret: "s" })
  ).rejects.toThrow(/Access token/);
});

it("main() prints a report and an ABSENT note when models are missing", async () => {
  process.env.GLOO_CLIENT_ID = "id";
  process.env.GLOO_CLIENT_SECRET = "secret";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(async () => jsonResponse({ access_token: "tok" }))
    // skinny registry → most models ABSENT, exercising the note branch
    .mockImplementationOnce(async () =>
      jsonResponse({
        data: [{ id: "a", name: "Claude Opus 4.8", family: "Anthropic" }],
      })
    )
    .mockImplementationOnce(async () => jsonResponse({ usage: {} }))
    .mockImplementationOnce(async () =>
      jsonResponse({ detail: "Unknown model" }, 400)
    );

  await main();

  const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
  expect(printed).toContain("What's New — 2026-05-26");
  expect(printed).toContain("ABSENT");
});
