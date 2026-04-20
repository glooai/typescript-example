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

it("runDigest composes a summary, posts top-level, and threads YELLOW notes", async () => {
  const artifactA: RunArtifact = {
    runId: "run-a",
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
        signature: "v2/auto",
        label: "V2 · auto",
        endpoint: "u",
        apiVersion: "v2",
        httpStatus: 200,
        verdict: "PASS",
        severity: "YELLOW",
        durationMs: 9500,
        details: { note: "latency spike" },
        completedAt: 1700000000,
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

  expect(summary.probesRun).toBe(2);
  expect(summary.severityCounts.YELLOW).toBe(1);

  // 2 posts: the top-level digest + the yellow-notes thread reply
  expect(slack.posts).toHaveLength(2);
  expect(slack.posts[0].threadTs).toBeUndefined();
  expect(slack.posts[1].threadTs).toBeDefined();
  expect(slack.posts[1].text).toContain("Secondary insights");
});

it("runDigest skips the YELLOW thread when there are no yellow notes", async () => {
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
  expect(slack.posts).toHaveLength(1);
});
