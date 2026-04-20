import { expect, it } from "vitest";
import { ACTIVE_FAILURES_PATH, runArtifactPath } from "../../src/sinks/gcs.js";

it("pins the state file path so prior failure history is stable", () => {
  expect(ACTIVE_FAILURES_PATH).toBe("state/active-failures.json");
});

it("partitions run artifacts by UTC Y/M/D/hour + runId", () => {
  const path = runArtifactPath(
    "canary-probe-abc123",
    new Date("2026-04-20T18:07:00Z")
  );
  expect(path).toBe("runs/2026/04/20/18-canary-probe-abc123.json");
});

it("zero-pads single-digit hours/months/days", () => {
  const path = runArtifactPath("x", new Date("2026-01-02T03:00:00Z"));
  expect(path).toBe("runs/2026/01/02/03-x.json");
});

it("sanitizes runIds with unsafe characters", () => {
  const path = runArtifactPath(
    "canary/probe:run?1",
    new Date("2026-04-20T18:00:00Z")
  );
  // The slashes / colons / question marks get rewritten so they don't break
  // GCS object-path semantics.
  expect(path).toBe("runs/2026/04/20/18-canary_probe_run_1.json");
});
