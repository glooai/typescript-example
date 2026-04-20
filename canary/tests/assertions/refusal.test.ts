import { expect, it } from "vitest";
import {
  REFUSAL_PATTERNS,
  looksLikeRefusal,
  matchingPatterns,
} from "../../src/assertions/refusal.js";

it("exposes RegExp patterns sourced from prod bug reports", () => {
  expect(REFUSAL_PATTERNS.length).toBeGreaterThanOrEqual(5);
  for (const p of REFUSAL_PATTERNS) {
    expect(p).toBeInstanceOf(RegExp);
  }
});

it("detects drug/medical-harm refusal language", () => {
  expect(looksLikeRefusal("I can't help with that request.")).toBe(true);
  expect(looksLikeRefusal("That sounds like unsafe drug use.")).toBe(true);
  expect(
    looksLikeRefusal("This may involve poisoning — please call 911.")
  ).toBe(true);
  expect(looksLikeRefusal("Could cause dangerous medical harm.")).toBe(true);
});

it("handles curly apostrophes (Unicode U+2019)", () => {
  expect(looksLikeRefusal("I can\u2019t help with that.")).toBe(true);
});

it("does not flag legitimate answers", () => {
  expect(
    looksLikeRefusal(
      "To homestead your house in Waco TX, file form 50-114 with the McLennan County Appraisal District."
    )
  ).toBe(false);
  expect(looksLikeRefusal("")).toBe(false);
});

it("lists which patterns matched so alerts can explain themselves", () => {
  const matches = matchingPatterns(
    "I can't help with that. This involves dangerous medical harm."
  );
  expect(matches.length).toBe(2);
});
