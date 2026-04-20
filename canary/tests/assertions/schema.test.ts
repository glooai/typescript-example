import { expect, it } from "vitest";
import {
  ChatCompletionSchema,
  V2CompletionSchema,
  validate,
} from "../../src/assertions/schema.js";

it("accepts a minimal ChatCompletion shape", () => {
  const result = validate(ChatCompletionSchema, {
    choices: [{ message: { role: "assistant", content: "hi" } }],
  });
  expect(result.ok).toBe(true);
});

it("allows nullable content (some models return null instead of empty string)", () => {
  const result = validate(ChatCompletionSchema, {
    choices: [{ message: { content: null } }],
  });
  expect(result.ok).toBe(true);
});

it("fails when choices is missing or empty", () => {
  const missing = validate(ChatCompletionSchema, {});
  expect(missing.ok).toBe(false);
  const empty = validate(ChatCompletionSchema, { choices: [] });
  expect(empty.ok).toBe(false);
});

it("reports field-scoped issues for diagnostics", () => {
  const result = validate(V2CompletionSchema, { choices: "not-an-array" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((i) => i.startsWith("choices"))).toBe(true);
  }
});

it("accepts the V2 envelope with routing metadata", () => {
  const result = validate(V2CompletionSchema, {
    model: "gloo-anthropic-claude-sonnet-4.5",
    routing_mechanism: "auto_routing",
    routing_tier: "tier_2",
    choices: [{ message: { content: "ok" } }],
  });
  expect(result.ok).toBe(true);
});
