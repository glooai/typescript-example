import { expect, it } from "vitest";
import {
  DEFAULT_FULL_SWEEP_INTERVAL_MS,
  decideTier,
  loadAndDecideTier,
  persistTierState,
  resolveFullSweepIntervalMs,
} from "../../src/runners/tier-decision.js";
import {
  ACTIVE_FAILURES_PATH,
  PROBE_TIER_STATE_PATH,
  type ActiveFailures,
  type GcsClient,
  type ProbeTierState,
} from "../../src/sinks/gcs.js";

const NOW = new Date("2026-04-22T12:00:00Z");

const EMPTY_FAILURES: ActiveFailures = {};
const ONE_FAILURE: ActiveFailures = {
  "v2/model/gloo-foo": {
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    slackTs: "1700000000.000001",
    attempts: 1,
    lastVerdict: "FAIL",
  },
};

it("cold-start — no state yet forces a Full sweep", () => {
  // This is the bootstrap case on a fresh bucket or the first run
  // after a bucket reset. We want the cold start to be Full so the
  // next tier decision has everything it needs to choose Light.
  const out = decideTier({
    state: null,
    activeFailures: EMPTY_FAILURES,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("full");
  expect(out.reason).toBe("cold-start");
});

it("unparseable lastFullSweepAt treated as cold-start", () => {
  // If somebody hand-edits the state blob (or a future version
  // changes the schema) we don't want to silently run Light forever
  // on a stale timestamp.
  const state: ProbeTierState = {
    lastFullSweepAt: "not-a-date",
    lastTier: "full",
  };
  const out = decideTier({
    state,
    activeFailures: EMPTY_FAILURES,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("full");
  expect(out.reason).toBe("cold-start");
});

it("active failures force Full regardless of interval", () => {
  // The whole point of escalation: if something is broken, we want
  // full diagnostic coverage on the next tick so the digest has rich
  // data to reason about.
  const state: ProbeTierState = {
    lastFullSweepAt: NOW.toISOString(), // ← just did a Full sweep
    lastTier: "full",
  };
  const out = decideTier({
    state,
    activeFailures: ONE_FAILURE,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("full");
  expect(out.reason).toBe("active-failures");
});

it("healthy + within interval → Light", () => {
  // Most common case during daytime steady-state: all green, last
  // full sweep was 30 min ago, sweep interval is 1h.
  const state: ProbeTierState = {
    lastFullSweepAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    lastTier: "full",
  };
  const out = decideTier({
    state,
    activeFailures: EMPTY_FAILURES,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("light");
  expect(out.reason).toBe("healthy-within-interval");
});

it("healthy + interval elapsed → Full (periodic refresh)", () => {
  // Boundary case: exactly one interval has elapsed. Should go Full
  // so per-model coverage stays ≤1h stale.
  const state: ProbeTierState = {
    lastFullSweepAt: new Date(
      NOW.getTime() - DEFAULT_FULL_SWEEP_INTERVAL_MS
    ).toISOString(),
    lastTier: "light",
  };
  const out = decideTier({
    state,
    activeFailures: EMPTY_FAILURES,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("full");
  expect(out.reason).toBe("full-sweep-interval-elapsed");
});

it("null activeFailures treated the same as empty", () => {
  // readJson returns null when the state blob doesn't exist yet —
  // first run on a fresh bucket before any probe has failed. Must
  // not be treated as "failure present."
  const state: ProbeTierState = {
    lastFullSweepAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    lastTier: "full",
  };
  const out = decideTier({
    state,
    activeFailures: null,
    now: NOW,
    fullSweepIntervalMs: DEFAULT_FULL_SWEEP_INTERVAL_MS,
  });
  expect(out.tier).toBe("light");
});

it("resolveFullSweepIntervalMs parses numeric env vars", () => {
  expect(resolveFullSweepIntervalMs("120000")).toBe(120_000);
});

it("resolveFullSweepIntervalMs falls back on unset / invalid / non-positive values", () => {
  expect(resolveFullSweepIntervalMs(undefined)).toBe(
    DEFAULT_FULL_SWEEP_INTERVAL_MS
  );
  expect(resolveFullSweepIntervalMs("")).toBe(DEFAULT_FULL_SWEEP_INTERVAL_MS);
  expect(resolveFullSweepIntervalMs("abc")).toBe(
    DEFAULT_FULL_SWEEP_INTERVAL_MS
  );
  expect(resolveFullSweepIntervalMs("0")).toBe(DEFAULT_FULL_SWEEP_INTERVAL_MS);
  expect(resolveFullSweepIntervalMs("-500")).toBe(
    DEFAULT_FULL_SWEEP_INTERVAL_MS
  );
});

type FakeGcs = GcsClient & {
  reads: Map<string, unknown>;
  writes: Map<string, unknown>;
};

function fakeGcs(initial: Record<string, unknown> = {}): FakeGcs {
  const reads = new Map<string, unknown>(Object.entries(initial));
  const writes = new Map<string, unknown>();
  return {
    reads,
    writes,
    async writeJson(path, payload) {
      writes.set(path, payload);
      reads.set(path, payload);
    },
    async readJson<T>(path: string): Promise<T | null> {
      return (reads.get(path) as T | undefined) ?? null;
    },
    async list() {
      return [];
    },
    async getMetadata() {
      return null;
    },
  };
}

it("loadAndDecideTier reads both state blobs and returns the decision", async () => {
  // Integration-ish test: happy path where state says healthy + within
  // interval, so we get Light without a model-registry fetch.
  const state: ProbeTierState = {
    lastFullSweepAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    lastTier: "full",
  };
  const gcs = fakeGcs({
    [PROBE_TIER_STATE_PATH]: state,
    [ACTIVE_FAILURES_PATH]: {} as ActiveFailures,
  });
  const decision = await loadAndDecideTier(
    gcs,
    NOW,
    DEFAULT_FULL_SWEEP_INTERVAL_MS
  );
  expect(decision.tier).toBe("light");
});

it("persistTierState resets lastFullSweepAt only on Full runs", async () => {
  // A Light run must NOT reset the sweep clock — otherwise we'd skip
  // the periodic full refresh and per-model outages could go >1h
  // undetected.
  const previous: ProbeTierState = {
    lastFullSweepAt: "2026-04-22T11:30:00.000Z",
    lastTier: "full",
  };
  const gcs = fakeGcs();

  await persistTierState(gcs, { tier: "light", now: NOW, previous });
  const afterLight = gcs.writes.get(PROBE_TIER_STATE_PATH) as ProbeTierState;
  expect(afterLight.lastFullSweepAt).toBe("2026-04-22T11:30:00.000Z");
  expect(afterLight.lastTier).toBe("light");

  await persistTierState(gcs, { tier: "full", now: NOW, previous });
  const afterFull = gcs.writes.get(PROBE_TIER_STATE_PATH) as ProbeTierState;
  expect(afterFull.lastFullSweepAt).toBe(NOW.toISOString());
  expect(afterFull.lastTier).toBe("full");
});

it("persistTierState handles first Light run with no previous state", async () => {
  // Edge case: if a Light run somehow runs first (e.g. operator
  // manually cleared the state blob), we still want to leave behind a
  // parseable record for the next decision.
  const gcs = fakeGcs();
  await persistTierState(gcs, { tier: "light", now: NOW, previous: null });
  const state = gcs.writes.get(PROBE_TIER_STATE_PATH) as ProbeTierState;
  expect(state.lastFullSweepAt).toBe(NOW.toISOString());
  expect(state.lastTier).toBe("light");
});
