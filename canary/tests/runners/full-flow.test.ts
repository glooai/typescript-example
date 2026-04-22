/**
 * End-to-end runner tests — exercises runProbes() and runDigest() with all
 * external dependencies (HTTP, GCS, Slack) stubbed. Gives us coverage for
 * the orchestration path that Cloud Run would run in production.
 */

import { afterEach, expect, it, vi } from "vitest";
import { runProbes } from "../../src/runners/probe-runner.js";
import {
  gatherArchivalState,
  loadWindow,
  runDigest,
} from "../../src/runners/digest-runner.js";
import type { CanaryConfig } from "../../src/config.js";
import type { Probe } from "../../src/probes/types.js";
import type { GcsClient, RunArtifact } from "../../src/sinks/gcs.js";
import type { SlackClient } from "../../src/sinks/slack.js";

const CONFIG: CanaryConfig = {
  mode: "probe",
  gloo: { clientId: "id", clientSecret: "s" },
  slack: { botToken: "xoxb", channelId: "C" },
  storage: { bucket: "b" },
  execution: {
    runId: "run-abc",
    startedAt: "2026-04-20T18:00:00Z",
  },
};

function fakeGcs(overrides?: {
  files?: Record<string, unknown>;
  list?: string[];
}): GcsClient & { writes: Map<string, unknown> } {
  const writes = new Map<string, unknown>();
  const files = overrides?.files ?? {};
  const list = overrides?.list ?? [];
  return {
    writes,
    async writeJson(path, payload) {
      writes.set(path, payload);
    },
    async readJson<T>(path: string): Promise<T | null> {
      return (files[path] as T | undefined) ?? null;
    },
    async list(prefix: string): Promise<string[]> {
      return list.filter((name) => name.startsWith(prefix));
    },
    async getMetadata(objectPath: string) {
      if (!(objectPath in files)) return null;
      return {
        size: 512,
        createdAt: "2026-04-01T00:00:00Z", // ~19 days ago at NOW
      };
    },
  };
}

function fakeSlack(): SlackClient & {
  posts: Array<{ text: string; threadTs?: string }>;
} {
  let ts = 1700000000;
  const posts: Array<{ text: string; threadTs?: string }> = [];
  return {
    posts,
    async post({ text, threadTs }) {
      posts.push({ text, threadTs });
      ts += 1;
      return { ts: `${ts}.000000`, channel: "C" };
    },
    async react() {
      // no-op for tests
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("runProbes fetches a token, executes each probe, archives, and alerts on RED", async () => {
  // Mock the token fetch (getAccessToken hits the real OAuth endpoint).
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "abc" }), {
        status: 200,
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const probe: Probe = {
    signature: "v1/test",
    label: "V1 · test",
    async run() {
      return {
        signature: "v1/test",
        label: "V1 · test",
        endpoint: "https://example.com",
        apiVersion: "v1",
        httpStatus: 500,
        verdict: "FAIL",
        severity: "RED",
        durationMs: 100,
        details: {},
        completedAt: 1700000000,
      };
    },
  };
  const gcs = fakeGcs();
  const slack = fakeSlack();

  const artifact = await runProbes(
    CONFIG,
    { probes: [probe], gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  expect(artifact.outcomes).toHaveLength(1);
  expect(artifact.outcomes[0].verdict).toBe("FAIL");

  // Wrote both the run artifact and the state file.
  expect(gcs.writes.has("state/active-failures.json")).toBe(true);
  const [runPath] = Array.from(gcs.writes.keys()).filter((k) =>
    k.startsWith("runs/")
  );
  expect(runPath).toContain("runs/2026/04/20/18-run-abc.json");

  // Slack got a single top-level failure alert.
  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0].threadTs).toBeUndefined();
});

it("runProbes throws when the OAuth response has no access_token", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ not_a_token: true }), { status: 200 })
  );

  const probe: Probe = {
    signature: "v1/test",
    label: "v1",
    async run() {
      throw new Error("should not be invoked");
    },
  };

  await expect(
    runProbes(CONFIG, { probes: [probe], gcs: fakeGcs(), slack: fakeSlack() })
  ).rejects.toThrow(/Access token missing/);
});

it("loadWindow walks GCS prefixes and returns run artifacts sorted by startedAt", async () => {
  const files: Record<string, unknown> = {
    "runs/2026/04/20/06-run-a.json": {
      runId: "run-a",
      startedAt: "2026-04-20T06:00:00Z",
      completedAt: "2026-04-20T06:00:30Z",
      outcomes: [],
    },
    "runs/2026/04/20/10-run-b.json": {
      runId: "run-b",
      startedAt: "2026-04-20T10:00:00Z",
      completedAt: "2026-04-20T10:00:30Z",
      outcomes: [],
    },
  };
  const gcs = fakeGcs({
    files,
    list: Object.keys(files),
  });

  const artifacts = await loadWindow(gcs, new Date("2026-04-20T18:00:00Z"));
  expect(artifacts.map((a) => a.runId)).toEqual(["run-a", "run-b"]);
});

it("loadWindow filters artifacts older than 24h (R3)", async () => {
  // buildRunPrefixes intentionally spans 26 hours to cover day-boundary
  // UTC quirks. Before the R3 fix, loadWindow returned every artifact
  // matching those prefixes — including runs 25-26h old — so the
  // 'daily digest' could actually cover ~26 hours.
  const now = new Date("2026-04-21T07:00:00Z");
  const files: Record<string, unknown> = {
    // 25h before `now` — OUTSIDE the 24h window, should be excluded.
    "runs/2026/04/20/06-old.json": {
      runId: "old",
      startedAt: "2026-04-20T06:00:00Z",
      completedAt: "2026-04-20T06:00:30Z",
      outcomes: [],
    },
    // 1h before `now` — INSIDE the 24h window, should be included.
    "runs/2026/04/21/06-fresh.json": {
      runId: "fresh",
      startedAt: "2026-04-21T06:00:00Z",
      completedAt: "2026-04-21T06:00:30Z",
      outcomes: [],
    },
  };
  const gcs = fakeGcs({ files, list: Object.keys(files) });

  const artifacts = await loadWindow(gcs, now);
  expect(artifacts.map((a) => a.runId)).toEqual(["fresh"]);
});

it("gatherArchivalState reports object count, bytes, and oldest age", async () => {
  const files: Record<string, unknown> = {
    "runs/2026/04/10/00-old.json": { runId: "old" },
    "runs/2026/04/20/06-recent.json": { runId: "recent" },
  };
  const gcs = fakeGcs({ files, list: Object.keys(files) });

  const state = await gatherArchivalState(
    gcs,
    new Date("2026-04-20T18:00:00Z")
  );
  expect(state.objectCount).toBe(2);
  expect(state.totalBytes).toBe(1024);
  expect(state.oldestAgeDays).toBeGreaterThanOrEqual(19);
});

it("runDigest posts individualized YELLOW threads instead of a batch insights post", async () => {
  // One probe with both a green outcome and a yellow outcome — the probe
  // rolls up to worstSeverity=YELLOW and gets an individualized thread.
  // One probe with a single green outcome — rolls up into the all-green
  // thread post.
  const artifactA: RunArtifact = {
    runId: "run-a",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/slow",
        label: "V2 · slow",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
      {
        signature: "v2/slow",
        label: "V2 · slow",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "YELLOW",
        durationMs: 9500,
        details: { note: "latency spike" },
        completedAt: 1700000000,
      },
      {
        signature: "v2/fast",
        label: "V2 · fast",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 400,
        details: {},
        completedAt: 1700000050,
      },
    ],
  };

  const gcs = fakeGcs({
    files: { "runs/2026/04/20/06-run-a.json": artifactA },
    list: ["runs/2026/04/20/06-run-a.json"],
  });
  const slack = fakeSlack();

  const summary = await runDigest(
    CONFIG,
    { gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  expect(summary.probesRun).toBe(3);
  expect(summary.severityCounts.YELLOW).toBe(1);

  // 3 posts: top-level + all-green roll-up + YELLOW individualized breakdown
  expect(slack.posts).toHaveLength(3);
  expect(slack.posts[0].threadTs).toBeUndefined();

  // Top-level surfaces v2/slow as the yellow probe, hides v2/fast.
  expect(slack.posts[0].text).toMatch(/• 🟡 `v2\/slow`/);
  expect(slack.posts[0].text).not.toMatch(/`v2\/fast`/);
  expect(slack.posts[0].text).toContain("🟢 1 probe fully green");

  // Threaded replies: one all-green roll-up and one yellow breakdown.
  const greenThread = slack.posts[1];
  const yellowThread = slack.posts[2];
  expect(greenThread.threadTs).toBeDefined();
  expect(greenThread.text).toContain("All-green probes (1)");
  expect(greenThread.text).toContain("🟢 `v2/fast`");
  expect(yellowThread.threadTs).toBe(greenThread.threadTs);
  expect(yellowThread.text).toContain("*Breakdown for `v2/slow`*");
});

it("runDigest posts a single all-green thread reply when every probe is GREEN", async () => {
  const artifact: RunArtifact = {
    runId: "r",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/auto",
        label: "V2 · auto",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
    ],
  };

  const gcs = fakeGcs({
    files: { "runs/2026/04/20/06-r.json": artifact },
    list: ["runs/2026/04/20/06-r.json"],
  });
  const slack = fakeSlack();

  await runDigest(CONFIG, { gcs, slack }, new Date("2026-04-20T18:00:00Z"));
  // Top-level post + single all-green roll-up in thread.
  expect(slack.posts).toHaveLength(2);
  expect(slack.posts[0].text).toContain("All probes fully green");
  expect(slack.posts[1].threadTs).toBeDefined();
  expect(slack.posts[1].text).toContain("All-green probes (1)");
});

it("runDigest posts one individualized threaded breakdown per red probe and rolls greens up", async () => {
  // Two failing probes (v1/bad and v2/meh) plus one passing probe.
  // We expect: top-level + all-green thread (for v2/auto) + 2 RED threads.
  const artifact: RunArtifact = {
    runId: "r",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/auto",
        label: "V2 · auto",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
      {
        signature: "v1/bad",
        label: "V1 · bad",
        endpoint: "u",
        apiVersion: "v1",
        httpStatus: 503,
        verdict: "FAIL",
        severity: "RED",
        durationMs: 2643,
        details: {},
        completedAt: 1700000100,
      },
      {
        signature: "v2/meh",
        label: "V2 · meh",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "EMPTY_COMPLETION",
        severity: "RED",
        durationMs: 4000,
        details: {},
        completedAt: 1700000200,
      },
    ],
  };

  const gcs = fakeGcs({
    files: { "runs/2026/04/20/06-r.json": artifact },
    list: ["runs/2026/04/20/06-r.json"],
  });
  const slack = fakeSlack();

  await runDigest(CONFIG, { gcs, slack }, new Date("2026-04-20T18:00:00Z"));

  // 1 top-level + 1 all-green thread + 2 RED thread replies.
  expect(slack.posts).toHaveLength(4);
  expect(slack.posts[0].threadTs).toBeUndefined();
  expect(slack.posts[0].text).toContain("🔴 `v1/bad`");
  expect(slack.posts[0].text).toContain("🔴 `v2/meh`");
  // The green probe is rolled up, not listed individually, in the top-level.
  expect(slack.posts[0].text).not.toMatch(/• 🟢 `v2\/auto`/);
  expect(slack.posts[0].text).toContain("🟢 1 probe fully green");

  // All replies target the digest ts.
  const threadTs = slack.posts[1].threadTs;
  expect(threadTs).toBeDefined();
  expect(slack.posts[2].threadTs).toBe(threadTs);
  expect(slack.posts[3].threadTs).toBe(threadTs);

  // First thread post is the all-green roll-up.
  expect(slack.posts[1].text).toContain("All-green probes (1)");
  expect(slack.posts[1].text).toContain("`v2/auto`");

  // Remaining two are the individualized RED breakdowns, one per probe.
  const redThreads = [slack.posts[2].text, slack.posts[3].text];
  expect(redThreads.some((t) => t.includes("`v1/bad`"))).toBe(true);
  expect(redThreads.some((t) => t.includes("`v2/meh`"))).toBe(true);
});

it("runProbes attaches registryDelta to the artifact when v2Models are provided and the GCS snapshot is missing (first-snapshot case)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "abc" }), {
        status: 200,
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const probe: Probe = {
    signature: "v2/noop",
    label: "V2 · noop",
    async run() {
      return {
        signature: "v2/noop",
        label: "V2 · noop",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 10,
        details: {},
        completedAt: 1700000000,
      };
    },
  };
  const gcs = fakeGcs(); // no seeded files → first snapshot

  const artifact = await runProbes(
    CONFIG,
    {
      probes: [probe],
      gcs,
      slack: fakeSlack(),
      v2Models: [
        { id: "gloo-a", family: "Anthropic", name: "A" },
        { id: "gloo-b", family: "OpenAI", name: "B" },
      ],
    },
    new Date("2026-04-20T18:00:00Z")
  );

  expect(artifact.registryDelta).toBeDefined();
  expect(artifact.registryDelta?.isFirstSnapshot).toBe(true);
  expect(artifact.registryDelta?.hasChanges).toBe(false);
  expect(artifact.registryDelta?.added).toEqual(["gloo-a", "gloo-b"]);

  // The probe runner also persists the new snapshot to GCS for the next run.
  const snapshotWrite = gcs.writes.get("state/model-registry-snapshot.json");
  expect(snapshotWrite).toBeDefined();
  expect((snapshotWrite as { modelIds: string[] }).modelIds).toEqual([
    "gloo-a",
    "gloo-b",
  ]);
});

it("runProbes computes an add/remove delta against a previously persisted snapshot", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "abc" }), {
        status: 200,
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const probe: Probe = {
    signature: "v2/noop",
    label: "V2 · noop",
    async run() {
      return {
        signature: "v2/noop",
        label: "V2 · noop",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 10,
        details: {},
        completedAt: 1700000000,
      };
    },
  };
  const gcs = fakeGcs({
    files: {
      "state/model-registry-snapshot.json": {
        capturedAt: "2026-04-19T18:00:00.000Z",
        runId: "prior-run",
        modelIds: ["gloo-a", "gloo-gone"],
      },
    },
  });

  const artifact = await runProbes(
    CONFIG,
    {
      probes: [probe],
      gcs,
      slack: fakeSlack(),
      v2Models: [
        { id: "gloo-a", family: "Anthropic", name: "A" },
        { id: "gloo-new", family: "OpenAI", name: "N" },
      ],
    },
    new Date("2026-04-20T18:00:00Z")
  );

  const delta = artifact.registryDelta;
  expect(delta).toBeDefined();
  expect(delta?.isFirstSnapshot).toBe(false);
  expect(delta?.hasChanges).toBe(true);
  expect(delta?.added).toEqual(["gloo-new"]);
  expect(delta?.removed).toEqual(["gloo-gone"]);
  expect(delta?.previousCapturedAt).toBe("2026-04-19T18:00:00.000Z");
});

it("runProbes does not attach registryDelta when v2Models are not passed", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ access_token: "abc" }), { status: 200 })
  );
  const probe: Probe = {
    signature: "v1/x",
    label: "x",
    async run() {
      return {
        signature: "v1/x",
        label: "x",
        endpoint: "u",
        apiVersion: "v1",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1,
        details: {},
        completedAt: 1,
      };
    },
  };
  const gcs = fakeGcs();
  const artifact = await runProbes(
    CONFIG,
    { probes: [probe], gcs, slack: fakeSlack() },
    new Date("2026-04-20T18:00:00Z")
  );
  expect(artifact.registryDelta).toBeUndefined();
  // And no snapshot blob was written.
  expect(gcs.writes.has("state/model-registry-snapshot.json")).toBe(false);
});

it("runDigest renders the registry delta as a YELLOW-flavored block in the top-level post", async () => {
  const artifact: RunArtifact = {
    runId: "r",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/auto",
        label: "V2 · auto",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
    ],
    registryDelta: {
      previousCapturedAt: "2026-04-19T18:00:00.000Z",
      currentCapturedAt: "2026-04-20T06:00:00.000Z",
      added: ["gloo-new-model"],
      removed: ["gloo-retired"],
      isFirstSnapshot: false,
      hasChanges: true,
    },
  };
  const gcs = fakeGcs({
    files: { "runs/2026/04/20/06-r.json": artifact },
    list: ["runs/2026/04/20/06-r.json"],
  });
  const slack = fakeSlack();

  const summary = await runDigest(
    CONFIG,
    { gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  // Top-level post mentions the registry change with a YELLOW-flavored
  // emoji and lists the added/removed ids. No :rotating_light: in the
  // block itself — RED is reserved for failing probes.
  expect(slack.posts[0].text).toContain(":large_yellow_circle:");
  expect(slack.posts[0].text).toContain("`/platform/v2/models` changed");
  expect(slack.posts[0].text).toContain("gloo-new-model");
  expect(slack.posts[0].text).toContain("gloo-retired");

  // Each add + each remove bumps the YELLOW severity counter.
  expect(summary.severityCounts.YELLOW).toBe(2);
});

it("runDigest filters outcomes against the current snapshot — retired signatures drop from the digest", async () => {
  const artifact: RunArtifact = {
    runId: "mixed",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      // A currently-probed model that passed.
      {
        signature: "v2/model/gloo-a",
        label: "V2 · A",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
      // A retired-from-registry model that failed in a pre-deploy run —
      // should NOT contribute to "Needs attention" because it isn't in
      // the current probe set.
      {
        signature: "v2/model/gloo-retired",
        label: "V2 · Retired",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 400,
        verdict: "FAIL",
        severity: "RED",
        durationMs: 400,
        details: {},
        completedAt: 1700000100,
      },
      // A V1 probe that's no longer in our fixture set.
      {
        signature: "v1/llama3-70b",
        label: "V1 · llama3-70b",
        endpoint: "u",
        apiVersion: "v1",
        httpStatus: 503,
        verdict: "FAIL",
        severity: "RED",
        durationMs: 500,
        details: {},
        completedAt: 1700000200,
      },
    ],
  };

  const gcs = fakeGcs({
    files: {
      "runs/2026/04/20/06-mixed.json": artifact,
      // Snapshot lists only gloo-a — so gloo-retired and v1/llama3-70b
      // should both drop out of the digest.
      "state/model-registry-snapshot.json": {
        capturedAt: "2026-04-20T06:30:00Z",
        runId: "some-run",
        modelIds: ["gloo-a"],
      },
    },
    list: ["runs/2026/04/20/06-mixed.json"],
  });
  const slack = fakeSlack();

  const summary = await runDigest(
    CONFIG,
    { gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  // Retired signatures are filtered out before aggregation.
  expect(summary.probesRun).toBe(1);
  expect(summary.severityCounts.RED).toBe(0);
  expect(summary.perProbe.map((p) => p.signature)).toEqual(["v2/model/gloo-a"]);

  // And the top-level digest post correctly reads "all green" rather
  // than surfacing the retired signatures in "Needs attention".
  expect(slack.posts[0].text).not.toContain("gloo-retired");
  expect(slack.posts[0].text).not.toContain("v1/llama3-70b");
  expect(slack.posts[0].text).toContain("All probes fully green");
});

it("runDigest falls open when the snapshot blob is missing (no filter)", async () => {
  const artifact: RunArtifact = {
    runId: "r",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/model/whatever",
        label: "x",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 500,
        verdict: "FAIL",
        severity: "RED",
        durationMs: 10,
        details: {},
        completedAt: 1,
      },
    ],
  };
  const gcs = fakeGcs({
    // Deliberately NO snapshot — emulates a very-first-digest-ever run.
    files: { "runs/2026/04/20/06-r.json": artifact },
    list: ["runs/2026/04/20/06-r.json"],
  });
  const slack = fakeSlack();

  const summary = await runDigest(
    CONFIG,
    { gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  // No filtering applied — the single RED outcome still surfaces.
  expect(summary.probesRun).toBe(1);
  expect(summary.severityCounts.RED).toBe(1);
});

it("runDigest renders a subdued baseline note on the first-snapshot case", async () => {
  const artifact: RunArtifact = {
    runId: "r",
    startedAt: "2026-04-20T06:00:00Z",
    completedAt: "2026-04-20T06:00:30Z",
    outcomes: [
      {
        signature: "v2/auto",
        label: "V2 · auto",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "GREEN",
        durationMs: 1000,
        details: {},
        completedAt: 1700000000,
      },
    ],
    registryDelta: {
      previousCapturedAt: null,
      currentCapturedAt: "2026-04-20T06:00:00.000Z",
      added: ["gloo-a", "gloo-b"],
      removed: [],
      isFirstSnapshot: true,
      hasChanges: false,
    },
  };
  const gcs = fakeGcs({
    files: { "runs/2026/04/20/06-r.json": artifact },
    list: ["runs/2026/04/20/06-r.json"],
  });
  const slack = fakeSlack();

  const summary = await runDigest(
    CONFIG,
    { gcs, slack },
    new Date("2026-04-20T18:00:00Z")
  );

  expect(slack.posts[0].text).toContain(":memo:");
  expect(slack.posts[0].text).toContain("baseline captured");
  // Baseline should NOT contribute to the YELLOW counter — it's not a
  // change, it's the first measurement.
  expect(summary.severityCounts.YELLOW).toBe(0);
});
