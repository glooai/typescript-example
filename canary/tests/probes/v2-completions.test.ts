import { expect, it } from "vitest";
import {
  assessV2,
  buildRequestBody,
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
  routing: { kind: "model_family", family: "anthropic" },
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
    model_family: "anthropic",
  });
  expect(buildRequestBody(DIRECT)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    auto_routing: false,
    model: "gloo-anthropic-claude-haiku-4.5",
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
