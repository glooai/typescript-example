import { expect, it } from "vitest";
import { computeRegistryDelta } from "../../src/fixtures/model-registry-delta.js";

const T0 = "2026-04-22T12:00:00.000Z";
const T1 = "2026-04-22T16:00:00.000Z";

it("treats a null previous snapshot as the baseline: isFirstSnapshot=true, hasChanges=false", () => {
  const delta = computeRegistryDelta({
    previous: null,
    current: { capturedAt: T0, modelIds: ["gloo-a", "gloo-b"] },
  });
  expect(delta.isFirstSnapshot).toBe(true);
  expect(delta.hasChanges).toBe(false);
  expect(delta.previousCapturedAt).toBeNull();
  expect(delta.currentCapturedAt).toBe(T0);
  // Baseline captures all currently-present ids under `added` for audit.
  expect(delta.added).toEqual(["gloo-a", "gloo-b"]);
  expect(delta.removed).toEqual([]);
});

it("returns hasChanges=false when previous and current model sets are identical", () => {
  const delta = computeRegistryDelta({
    previous: { capturedAt: T0, modelIds: ["gloo-a", "gloo-b", "gloo-c"] },
    current: {
      capturedAt: T1,
      // different order, same set
      modelIds: ["gloo-c", "gloo-a", "gloo-b"],
    },
  });
  expect(delta.isFirstSnapshot).toBe(false);
  expect(delta.hasChanges).toBe(false);
  expect(delta.added).toEqual([]);
  expect(delta.removed).toEqual([]);
});

it("reports a pure addition in `added` and leaves `removed` empty", () => {
  const delta = computeRegistryDelta({
    previous: { capturedAt: T0, modelIds: ["gloo-a", "gloo-b"] },
    current: { capturedAt: T1, modelIds: ["gloo-a", "gloo-b", "gloo-c"] },
  });
  expect(delta.hasChanges).toBe(true);
  expect(delta.added).toEqual(["gloo-c"]);
  expect(delta.removed).toEqual([]);
});

it("reports a pure removal in `removed` and leaves `added` empty", () => {
  const delta = computeRegistryDelta({
    previous: { capturedAt: T0, modelIds: ["gloo-a", "gloo-b", "gloo-c"] },
    current: { capturedAt: T1, modelIds: ["gloo-a", "gloo-c"] },
  });
  expect(delta.hasChanges).toBe(true);
  expect(delta.added).toEqual([]);
  expect(delta.removed).toEqual(["gloo-b"]);
});

it("reports both adds and removes in a single mixed delta, alphabetically sorted", () => {
  const delta = computeRegistryDelta({
    previous: {
      capturedAt: T0,
      modelIds: ["gloo-anthropic", "gloo-google-2", "gloo-google-3-preview"],
    },
    current: {
      capturedAt: T1,
      modelIds: [
        "gloo-anthropic",
        "gloo-google-2",
        "gloo-openai-5",
        "gloo-xai",
      ],
    },
  });
  expect(delta.hasChanges).toBe(true);
  expect(delta.added).toEqual(["gloo-openai-5", "gloo-xai"]);
  expect(delta.removed).toEqual(["gloo-google-3-preview"]);
  expect(delta.previousCapturedAt).toBe(T0);
  expect(delta.currentCapturedAt).toBe(T1);
});
