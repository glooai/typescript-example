import { expect, it } from "vitest";
import {
  V1_FIXTURES,
  V2_AUTO_ROUTING_FIXTURE,
  V2_LIGHT_PULSE_FIXTURE,
  buildV2DirectModelFixtures,
  buildV2FamilyFixtures,
  buildV2Fixtures,
  buildV2RoutingFixtures,
  currentProbeSignatures,
  extractFamilies,
  familySlug,
} from "../../src/fixtures/index.js";
import type { V2ModelSummary } from "../../src/fixtures/v2-models.js";

const MODELS: V2ModelSummary[] = [
  { id: "gloo-openai-gpt-5.2", family: "OpenAI", name: "GPT-5.2" },
  {
    id: "gloo-anthropic-claude-haiku-4.5",
    family: "Anthropic",
    name: "Claude Haiku 4.5",
  },
  {
    id: "gloo-meta-llama-3.1-8b",
    family: "Open Source",
    name: "Llama 3.1 8B",
  },
];

it("V1_FIXTURES is empty — V1 is deprecated and intentionally not probed", () => {
  expect(V1_FIXTURES).toEqual([]);
});

it("V2_AUTO_ROUTING_FIXTURE is the one statically-declared routing probe", () => {
  expect(V2_AUTO_ROUTING_FIXTURE.signature).toBe("v2/auto_routing");
  expect(V2_AUTO_ROUTING_FIXTURE.routing).toEqual({ kind: "auto_routing" });
  expect(V2_AUTO_ROUTING_FIXTURE.maxTokens).toBe(48);
});

it("familySlug lowercases and hyphenates spaces", () => {
  // Stable across "Open Source", "Anthropic", and hypothetical future
  // multi-word families like "Open Source HPC" → "open-source-hpc".
  expect(familySlug("Open Source")).toBe("open-source");
  expect(familySlug("Anthropic")).toBe("anthropic");
  expect(familySlug("  OpenAI  ")).toBe("openai");
  expect(familySlug("Open Source HPC")).toBe("open-source-hpc");
});

it("extractFamilies returns distinct, sorted, non-empty family strings", () => {
  const fams = extractFamilies([
    ...MODELS,
    // Dupe + empty-string edge cases — extractor must de-dupe and drop
    // the empty string rather than emitting a `v2/family/` signature.
    { id: "gloo-dupe", family: "OpenAI", name: "Dupe" },
    { id: "gloo-empty", family: "", name: "Empty" },
  ]);
  expect(fams).toEqual(["Anthropic", "Open Source", "OpenAI"]);
});

it("buildV2FamilyFixtures produces one fixture per distinct family with canonical casing", () => {
  const fixtures = buildV2FamilyFixtures([
    "OpenAI",
    "Anthropic",
    "Open Source",
  ]);
  // Sorted by family name for stable Slack output.
  expect(fixtures.map((f) => f.signature)).toEqual([
    "v2/family/anthropic",
    "v2/family/open-source",
    "v2/family/openai",
  ]);
  const openSource = fixtures.find(
    (f) => f.signature === "v2/family/open-source"
  );
  // Request body feeds the API the canonical casing verbatim — regression
  // guard for the GAI-5443 open-source hyphen-vs-space validator bug and
  // any future casing change the platform makes.
  expect(openSource?.routing).toEqual({
    kind: "model_family",
    family: "Open Source",
  });
  expect(openSource?.label).toBe("V2 · model_family=Open Source");
  expect(openSource?.maxTokens).toBe(48);
});

it("buildV2RoutingFixtures derives family probes from the live model list, plus auto_routing", () => {
  const fixtures = buildV2RoutingFixtures(MODELS);
  expect(fixtures.map((f) => f.signature)).toEqual([
    "v2/auto_routing",
    "v2/family/anthropic",
    "v2/family/open-source",
    "v2/family/openai",
  ]);
});

it("buildV2RoutingFixtures stays current as the registry gains/loses families", () => {
  // A hypothetical future registry with a new Mistral family — the probe
  // list must grow to match without any code change, which is the entire
  // point of deriving dynamically. The PR #22 hardcoded list would have
  // silently skipped this.
  const fixtures = buildV2RoutingFixtures([
    { id: "gloo-mistral-large", family: "Mistral", name: "Mistral Large" },
    ...MODELS,
  ]);
  expect(fixtures.map((f) => f.signature)).toContain("v2/family/mistral");
});

it("buildV2DirectModelFixtures derives a deterministic fixture per model", () => {
  const fixtures = buildV2DirectModelFixtures([
    {
      id: "gloo-openai-gpt-5.2",
      family: "OpenAI",
      name: "GPT-5.2",
    },
    {
      id: "gloo-anthropic-claude-haiku-4.5",
      family: "Anthropic",
      name: "Claude Haiku 4.5",
    },
  ]);

  // Results are sorted by id so Slack output stays stable regardless of
  // the order the registry returns them in.
  expect(fixtures.map((f) => f.signature)).toEqual([
    "v2/model/gloo-anthropic-claude-haiku-4.5",
    "v2/model/gloo-openai-gpt-5.2",
  ]);

  const haiku = fixtures.find(
    (f) => f.signature === "v2/model/gloo-anthropic-claude-haiku-4.5"
  );
  expect(haiku?.label).toBe("V2 · Claude Haiku 4.5");
  expect(haiku?.routing).toEqual({
    kind: "model",
    model: "gloo-anthropic-claude-haiku-4.5",
  });
  expect(haiku?.benign).toBe(true);
  // Direct-model probes carry an extended timeout so reasoning-heavy
  // models (Opus 4.6, GPT-5.2 Pro, DeepSeek R1) don't wedge on the
  // probe-side 90s default.
  expect(haiku?.timeoutMs).toBeGreaterThanOrEqual(120_000);
  // Every direct-model fixture also caps the response with max_tokens
  // so Full sweeps don't blow the inference budget. Refusal patterns
  // still fit comfortably in this window.
  expect(haiku?.maxTokens).toBe(48);
});

it("V2_LIGHT_PULSE_FIXTURE is a single auto_routing probe with a tiny max_tokens cap", () => {
  // The whole point of the light tier: one request, single-digit
  // output tokens, runs every 15 min. Guards against accidental
  // drift (e.g. somebody flipping benign:true back on and adding a
  // refusal check that needs more tokens to match).
  expect(V2_LIGHT_PULSE_FIXTURE.routing).toEqual({ kind: "auto_routing" });
  expect(V2_LIGHT_PULSE_FIXTURE.maxTokens).toBeLessThanOrEqual(8);
  // benign:false disables the refusal detector — a 4-token response
  // can't be inspected for refusal patterns without false positives.
  expect(V2_LIGHT_PULSE_FIXTURE.benign).toBe(false);
  // Signature namespace is kept distinct so digest filtering doesn't
  // conflate light-pulse runs with full-sweep auto_routing runs.
  expect(V2_LIGHT_PULSE_FIXTURE.signature).toBe("v2/light/auto_routing");
});

it("buildV2Fixtures concatenates routing-mode + direct-model fixtures derived from the same model list", async () => {
  const fixtures = await buildV2Fixtures({
    loadModels: async () => MODELS,
  });

  // Routing fixtures come first, then direct-model fixtures.
  const signatures = fixtures.map((f) => f.signature);
  expect(signatures).toContain("v2/auto_routing");
  expect(signatures).toContain("v2/family/anthropic");
  expect(signatures).toContain("v2/family/open-source");
  expect(signatures).toContain("v2/family/openai");
  expect(signatures).toContain("v2/model/gloo-openai-gpt-5.2");
  // 1 auto_routing + 3 families + 3 direct models = 7
  expect(fixtures.length).toBe(7);
});

it("currentProbeSignatures includes routing + v2/model/<id> for every live model, plus V1 (empty today) and the light pulse", () => {
  const sigs = currentProbeSignatures(
    ["gloo-a", "gloo-b"],
    ["Anthropic", "Open Source"]
  );
  expect(sigs).toContain("v2/auto_routing");
  expect(sigs).toContain("v2/family/anthropic");
  expect(sigs).toContain("v2/family/open-source");
  expect(sigs).toContain("v2/model/gloo-a");
  expect(sigs).toContain("v2/model/gloo-b");
  // Light-tier signature is included so the digest doesn't filter
  // light-pulse runs out of the 24h window as "retired."
  expect(sigs).toContain(V2_LIGHT_PULSE_FIXTURE.signature);
  // No V1 entries because V1_FIXTURES is empty today.
  expect(sigs.every((s) => !s.startsWith("v1/"))).toBe(true);
  // Total = light (1) + auto_routing (1) + 2 families + 2 models = 6
  expect(sigs.length).toBe(6);
});

it("currentProbeSignatures omits family signatures when the snapshot predates the families field (backcompat)", () => {
  // Older snapshot blobs (written before we started persisting
  // families alongside modelIds) pass families=undefined — that must
  // not crash and must fall open rather than emitting bogus family
  // signatures. The digest still gets modelIds and auto_routing
  // coverage, and the next probe run rewrites the snapshot with
  // families included.
  const sigs = currentProbeSignatures(["gloo-a"]);
  expect(sigs).toContain("v2/auto_routing");
  expect(sigs).toContain("v2/model/gloo-a");
  expect(sigs.some((s) => s.startsWith("v2/family/"))).toBe(false);
});

it("currentProbeSignatures produces a known-stable v2/model/<id> slug", () => {
  // Guards the contract between the probe-build path (where signatures
  // are emitted) and the digest-filter path (where signatures are
  // looked up). If either side ever diverges on slug format, this test
  // fails before the digest silently starts suppressing everything.
  expect(currentProbeSignatures(["gloo-foo"])).toContain("v2/model/gloo-foo");
});

it("buildV2Fixtures surfaces loadModels failures so the probe run fails loudly", async () => {
  await expect(
    buildV2Fixtures({
      loadModels: async () => {
        throw new Error("platform/v2/models unreachable");
      },
    })
  ).rejects.toThrow(/platform\/v2\/models unreachable/);
});
