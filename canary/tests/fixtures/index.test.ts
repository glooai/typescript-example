import { expect, it } from "vitest";
import {
  V1_FIXTURES,
  V2_ROUTING_FIXTURES,
  buildV2DirectModelFixtures,
  buildV2Fixtures,
} from "../../src/fixtures/index.js";

it("V1_FIXTURES is empty — V1 is deprecated and intentionally not probed", () => {
  expect(V1_FIXTURES).toEqual([]);
});

it("V2_ROUTING_FIXTURES covers auto_routing + one fixture per model_family accepted value", () => {
  const signatures = V2_ROUTING_FIXTURES.map((f) => f.signature).sort();
  expect(signatures).toEqual(
    [
      "v2/auto_routing",
      "v2/family/anthropic",
      "v2/family/google",
      "v2/family/open-source",
      "v2/family/openai",
    ].sort()
  );

  // Every routing-mode fixture uses the canonical "Title Case" family
  // string the server expects. Regression guard for the open-source
  // hyphen-vs-space validator bug we reported in GAI-5443.
  const families = V2_ROUTING_FIXTURES.filter(
    (f) => f.routing.kind === "model_family"
  ).map((f) => (f.routing.kind === "model_family" ? f.routing.family : ""));
  expect(families.sort()).toEqual(
    ["Anthropic", "Google", "OpenAI", "Open Source"].sort()
  );
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
});

it("buildV2Fixtures concatenates routing-mode + injected direct-model fixtures", async () => {
  const fixtures = await buildV2Fixtures({
    loadModels: async () => [
      { id: "gloo-openai-gpt-5.2", family: "OpenAI", name: "GPT-5.2" },
    ],
  });

  // Routing fixtures come first, then direct-model fixtures.
  const signatures = fixtures.map((f) => f.signature);
  expect(signatures).toContain("v2/auto_routing");
  expect(signatures).toContain("v2/family/anthropic");
  expect(signatures).toContain("v2/model/gloo-openai-gpt-5.2");
  expect(fixtures.length).toBe(V2_ROUTING_FIXTURES.length + 1);
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
