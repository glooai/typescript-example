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
  updates: Array<{ ts: string; text: string }>;
} {
  let ts = 1700000000;
  const posts: Array<{ text: string; threadTs?: string }> = [];
  const reactions: Array<{ ts: string; emoji: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  return {
    posts,
    reactions,
    updates,
    async post({ text, threadTs }) {
      posts.push({ text, threadTs });
      ts += 1;
      return { ts: `${ts}.000000`, channel: "C" };
    },
    async react(tsVal, emoji) {
      reactions.push({ ts: tsVal, emoji });
    },
    async update({ ts: tsVal, text }) {
      updates.push({ ts: tsVal, text });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("top-level-posts new failures and persists their ts + topLevelText", async () => {
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
  // topLevelText is captured at post time so the future recovery
  // path can reuse it for chat.update without re-synthesizing the
  // text.
  expect(state["v1/sonnet-4"].topLevelText).toContain("Canary RED");
  expect(state["v1/sonnet-4"].topLevelText).toContain("v1/sonnet-4");
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

it("posts a recovery thread + reacts ✅ + updates the top-level post when a failure clears", async () => {
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "FAIL",
        topLevelText:
          ":rotating_light: *Canary RED — V1 · sonnet-4*\n• *Verdict:* FAIL",
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

  // Threaded reply still posted.
  expect(slack.posts[0].text).toContain("Recovered");
  expect(slack.posts[0].threadTs).toBe("1700000001.000000");
  // Reaction on the top-level ts — the persistent emoji badge
  // that's visible from the channel sidebar.
  expect(slack.reactions).toEqual([
    { ts: "1700000001.000000", emoji: "white_check_mark" },
  ]);
  // Top-level post edited to prepend a green-check banner so the
  // channel overview preview tells the "resolved" story at a glance,
  // while the original failure text is preserved below for triage.
  expect(slack.updates).toHaveLength(1);
  expect(slack.updates[0].ts).toBe("1700000001.000000");
  expect(slack.updates[0].text).toContain(":white_check_mark:");
  expect(slack.updates[0].text).toContain("*Recovered*");
  expect(slack.updates[0].text).toContain("Canary RED — V1 · sonnet-4");

  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"]).toBeUndefined();
});

it("recovery still works when the legacy state entry has no stored topLevelText (backcompat)", async () => {
  // State blobs written before `topLevelText` was added must not crash
  // the recovery path — we skip chat.update but still post the thread
  // reply + add the reaction. Without this, an already-open failure
  // from the old code path would stay red in the channel overview
  // forever after recovery.
  const gcs = fakeGcs({
    activeFailures: {
      "v1/legacy": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 3,
        lastVerdict: "FAIL",
        // topLevelText intentionally omitted
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
        signature: "v1/legacy",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts[0].text).toContain("Recovered");
  expect(slack.reactions).toHaveLength(1);
  // No chat.update since we have no original text to preserve.
  expect(slack.updates).toHaveLength(0);
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/legacy"]).toBeUndefined();
});

it("a failed chat.update does not block the recovery — state still clears", async () => {
  // If Slack returns missing_scope or the token lacks chat:write, the
  // recovery path must still delete the signature from active-failures
  // and post the thread reply. Worst case we lose the green-check
  // banner on that one top-level post; better than leaving the
  // failure signature in state forever (which would suppress
  // re-alerts on the next fresh outage).
  const gcs = fakeGcs({
    activeFailures: {
      "v1/update-blocked": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "FAIL",
        topLevelText: "original failure text",
      },
    },
  });
  const slack: SlackClient & {
    posts: Array<{ text: string; threadTs?: string }>;
  } = {
    posts: [],
    async post({ text, threadTs }) {
      this.posts.push({ text, threadTs });
      return { ts: "x", channel: "C" };
    },
    async react() {},
    async update() {
      throw new Error("missing_scope");
    },
  };
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/update-blocked",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/update-blocked"]).toBeUndefined();
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

it("surfaces contentPreview over responsePreview for REFUSAL_REGRESSION alerts", () => {
  // The refusal text is the money info for the on-caller. Before the
  // fix, formatFailureTopLevel only showed the JSON envelope — burying
  // the actual refusal inside a JSON blob.
  const text = formatFailureTopLevel(
    makeOutcome({
      verdict: "REFUSAL_REGRESSION",
      severity: "RED",
      httpStatus: 200,
      responsePreview:
        '{"choices":[{"message":{"content":"I cant help with that. Unsafe drug use is dangerous."}}]}',
      contentPreview: "I cant help with that. Unsafe drug use is dangerous.",
    }),
    CONFIG
  );
  expect(text).toContain("Content:");
  expect(text).toContain("I cant help with that");
  expect(text).not.toContain("Response:"); // responsePreview suppressed when contentPreview is present
});

it("falls back to responsePreview when no contentPreview (5xx / schema failures)", () => {
  const text = formatFailureTopLevel(
    makeOutcome({
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 503,
      responsePreview: '{"detail":"upstream unavailable"}',
      contentPreview: null,
    }),
    CONFIG
  );
  expect(text).toContain("Response:");
  expect(text).toContain("upstream unavailable");
  expect(text).not.toContain("Content:");
});

it("keeps reconciling + persisting state when a Slack post throws (R1)", async () => {
  // Before the fix, a single slack.post() failure would bubble out of
  // reconcileFailures and abort the state-file write — causing every
  // previously-alerted failure to re-post as new on the next run.
  const gcs = fakeGcs({});
  let postCallCount = 0;
  const slack: SlackClient & { posts: Array<{ text: string }> } = {
    posts: [],
    async post({ text }) {
      postCallCount++;
      // First post (new "v1/flaky") throws. Second post (new "v1/ok")
      // succeeds. The state write at the end MUST still happen with
      // "v1/ok" recorded and "v1/flaky" deliberately absent.
      if (postCallCount === 1) {
        throw new Error("slack rate_limited");
      }
      this.posts.push({ text });
      return { ts: "1700000000.000001", channel: "C" };
    },
    async react() {},
    async update() {},
  };
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({ signature: "v1/flaky", verdict: "FAIL", severity: "RED" }),
      makeOutcome({ signature: "v1/ok", verdict: "FAIL", severity: "RED" }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  // State file WAS written despite the first Slack post throwing.
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state).toBeDefined();
  // The successful post landed in state.
  expect(state["v1/ok"]).toBeDefined();
  // The failed post is NOT in state, so next run treats it as new and retries.
  expect(state["v1/flaky"]).toBeUndefined();
});
