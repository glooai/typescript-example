import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  formatFailureRecurring,
  formatFailureTopLevel,
  reconcileFailures,
} from "../../src/runners/probe-runner.js";
import type {
  ActiveFailures,
  GcsClient,
  RunArtifact,
} from "../../src/sinks/gcs.js";
import type { SlackClient } from "../../src/sinks/slack.js";
import type { ProbeOutcome } from "../../src/probes/types.js";
import type { CanaryConfig } from "../../src/config.js";

const NOW = new Date("2026-04-20T18:00:00Z");

const CONFIG: CanaryConfig = {
  mode: "probe",
  gloo: { clientId: "id", clientSecret: "s" },
  slack: { botToken: "xoxb", channelId: "C" },
  storage: { bucket: "b" },
  execution: { runId: "run-abc", startedAt: NOW.toISOString() },
};

function makeOutcome(partial: Partial<ProbeOutcome>): ProbeOutcome {
  return {
    signature: "v1/test",
    label: "V1 · test",
    endpoint: "https://example.com",
    apiVersion: "v1",
    httpStatus: 200,
    verdict: "PASS",
    severity: "GREEN",
    durationMs: 100,
    details: {},
    completedAt: Math.floor(NOW.getTime() / 1000),
    ...partial,
  };
}

function fakeGcs(initial: {
  activeFailures?: ActiveFailures;
}): GcsClient & { writes: Map<string, unknown> } {
  const writes = new Map<string, unknown>();
  return {
    writes,
    async writeJson(path, payload) {
      writes.set(path, payload);
    },
    async readJson<T>(path: string): Promise<T | null> {
      if (path === "state/active-failures.json") {
        return (initial.activeFailures ?? null) as T | null;
      }
      return null;
    },
    async list() {
      return [];
    },
    async getMetadata() {
      return null;
    },
  };
}

function fakeSlack(): SlackClient & {
  posts: Array<{ text: string; threadTs?: string }>;
  reactions: Array<{ ts: string; emoji: string }>;
} {
  let ts = 1700000000;
  const posts: Array<{ text: string; threadTs?: string }> = [];
  const reactions: Array<{ ts: string; emoji: string }> = [];
  return {
    posts,
    reactions,
    async post({ text, threadTs }) {
      posts.push({ text, threadTs });
      ts += 1;
      return { ts: `${ts}.000000`, channel: "C" };
    },
    async react(tsVal, emoji) {
      reactions.push({ ts: tsVal, emoji });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("top-level-posts new failures and persists their ts", async () => {
  const gcs = fakeGcs({});
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 500,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts.length).toBe(1);
  expect(slack.posts[0].threadTs).toBeUndefined();
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"]).toBeDefined();
  expect(state["v1/sonnet-4"].attempts).toBe(1);
});

it("threads recurring failures onto the original post", async () => {
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "FAIL",
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 500,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts[0].threadTs).toBe("1700000001.000000");
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"].attempts).toBe(2);
});

it("posts a recovery thread + reacts ✅ when a failure clears", async () => {
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "FAIL",
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts[0].text).toContain("Recovered");
  expect(slack.posts[0].threadTs).toBe("1700000001.000000");
  expect(slack.reactions).toEqual([
    { ts: "1700000001.000000", emoji: "white_check_mark" },
  ]);
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"]).toBeUndefined();
});

it("formats top-level failure posts with the signature + metadata", () => {
  const text = formatFailureTopLevel(
    makeOutcome({
      signature: "v1/sonnet-4",
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 500,
      responsePreview: '{"detail":"Error generating response."}',
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    }),
    CONFIG
  );
  expect(text).toContain("Canary RED");
  expect(text).toContain("v1/sonnet-4");
  expect(text).toContain("HTTP status:* 500");
  expect(text).toContain("us.anthropic.claude-sonnet-4");
});

it("formats recurring-failure thread replies compactly", () => {
  const text = formatFailureRecurring(
    makeOutcome({ verdict: "FAIL", httpStatus: 500, durationMs: 123 }),
    4
  );
  expect(text).toContain("attempt 4");
  expect(text).toContain("FAIL");
  expect(text).toContain("500");
  expect(text).toContain("123ms");
});
